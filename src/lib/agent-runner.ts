import { runAcpStream, runAcpSync, type AcpRunOptions } from "./acp-client.js";
import type { AcpModelOptions } from "./acp-model.js";
import { buildAcpSpawnEnv } from "./acp-spawn.js";
import type { AcpPromptBlock } from "./media-input.js";
import { AcpToolSession } from "./acp-tool-session.js";
import type { BridgeConfig } from "./config.js";
import { agentChildEnv, resolveAgentCommand } from "./env.js";
import type { CursorExecutionMode } from "./execution-mode.js";
import { enableMaxMode } from "./max-mode-preflight.js";
import { run, runStreaming } from "./process.js";
import {
  createRunConfigDir,
  cursorConfigDir,
  type RunConfigDir,
} from "./run-config-dir.js";
import type { ClientToolDefinition } from "./tool-types.js";
import {
  chatOnlyHomeDir,
  getChatOnlyEnvOverrides,
  removeChatOnlyTempDir,
} from "./workspace.js";
import { readKeychainToken, writeCachedToken } from "./token-cache.js";

function cacheTokenForAccount(configDir?: string): void {
  if (!configDir) return;
  const token = readKeychainToken();
  if (token) writeCachedToken(configDir, token);
}

type AgentRunResult = {
  code: number;
  stdout: string;
  stderr: string;
  /** Client-safe failure reason; set by the ACP path (see AcpStreamResult). */
  error?: string;
};

function acpArgsWithModel(acpArgs: string[], model: string): string[] {
  const i = acpArgs.indexOf("acp");
  if (i === -1) return acpArgs;
  return [...acpArgs.slice(0, i + 1), "--model", model, ...acpArgs.slice(i + 1)];
}

function acpArgsWithMode(acpArgs: string[], mode: CursorExecutionMode): string[] {
  const i = acpArgs.indexOf("acp");
  if (i === -1) return acpArgs;
  // cursor-agent only accepts --mode plan|ask; agent mode is the default.
  if (mode === "agent") return acpArgs;
  return [...acpArgs.slice(0, i + 1), "--mode", mode, ...acpArgs.slice(i + 1)];
}

function acpArgsWithWorkspace(acpArgs: string[], workspaceDir: string): string[] {
  const i = acpArgs.indexOf("acp");
  if (i === -1) return acpArgs;
  return [...acpArgs.slice(0, i), "--workspace", workspaceDir, ...acpArgs.slice(i)];
}

/** One model request for every ACP path, so plain and tool turns agree. */
function acpModelOptions(
  config: BridgeConfig,
  model: string | undefined,
  displayName: string | undefined,
): AcpModelOptions {
  return {
    model,
    modelAliases: displayName ? [displayName] : undefined,
    strictModel: config.strictModel,
  };
}

function extractModelFromCmdArgs(cmdArgs: string[]): string | undefined {
  const i = cmdArgs.indexOf("--model");
  return i >= 0 && i + 1 < cmdArgs.length ? cmdArgs[i + 1] : undefined;
}

function extractModeFromCmdArgs(cmdArgs: string[]): CursorExecutionMode {
  const i = cmdArgs.indexOf("--mode");
  const m =
    i >= 0 && i + 1 < cmdArgs.length ? cmdArgs[i + 1] : undefined;
  if (m === "agent" || m === "ask" || m === "plan") return m;
  return "ask";
}

/** What every agent run, plain CLI or ACP, is started from. */
type RunContext = {
  config: BridgeConfig;
  workspaceDir: string;
  effectiveChatOnly: boolean;
  cmdArgs: string[];
  /** Account pool config dir. */
  configDir?: string;
  /** Chat-only isolation root, owned by the run once it is handed over. */
  tempDir?: string;
};

/** The private dirs one agent run owns until `release`. */
type RunDirs = {
  /** Variables the run sets on its agent child. */
  env: Record<string, string> & { CURSOR_CONFIG_DIR: string };
  /** Remove the run's private dirs; call once its agent is gone. */
  release: () => void;
};

/**
 * The config dir an agent run's child gets, for the plain CLI and ACP alike.
 * The CLI saves each model choice in its config dir, `agent acp` (#63) and
 * the chat command (#87) both, so every run gets a config dir of its own:
 * the chat-only temp home when there is no account pool, else a private
 * copy of the dir the child would have used (the account's, or the user's).
 * `childEnv` turns the run's variables into the child's whole env, the way
 * its spawn path does. On failure it removes `tempDir`.
 */
function runDirs(
  ctx: RunContext,
  childEnv: (env: Record<string, string>) => NodeJS.ProcessEnv,
): RunDirs {
  const { workspaceDir, effectiveChatOnly, configDir, tempDir } = ctx;
  const env: Record<string, string> = effectiveChatOnly
    ? getChatOnlyEnvOverrides(chatOnlyHomeDir(workspaceDir, tempDir), configDir)
    : configDir
      ? { CURSOR_CONFIG_DIR: configDir }
      : {};
  let runConfig: RunConfigDir;
  try {
    const source = cursorConfigDir(childEnv(env));
    runConfig =
      effectiveChatOnly && !configDir
        ? { dir: source, dispose: () => {} }
        : createRunConfigDir(source);
  } catch (error) {
    removeChatOnlyTempDir(tempDir);
    throw error;
  }
  return {
    env: { ...env, CURSOR_CONFIG_DIR: runConfig.dir },
    release: () => {
      runConfig.dispose();
      removeChatOnlyTempDir(tempDir);
    },
  };
}

/** One plain CLI run's dirs; with max mode on, its config dir gets maxMode. */
function cliRunDirs(ctx: RunContext): RunDirs {
  const { config, cmdArgs } = ctx;
  const command = resolveAgentCommand(config.agentBin, cmdArgs);
  const dirs = runDirs(ctx, (env) => agentChildEnv(command, env));
  if (config.maxMode) enableMaxMode(dirs.env.CURSOR_CONFIG_DIR);
  return dirs;
}

type AcpInvocation = {
  args: string[];
  env: Record<string, string | undefined>;
  model?: string;
  /** Remove the run's private dirs; call once its agent is gone. */
  release: () => void;
};

/** Args and env for one `agent acp` run, on its own dirs (see runDirs). */
function acpInvocation(ctx: RunContext): AcpInvocation {
  const { config, workspaceDir, cmdArgs } = ctx;
  const model = extractModelFromCmdArgs(cmdArgs);
  const mode = extractModeFromCmdArgs(cmdArgs);
  let args = acpArgsWithWorkspace(config.acpArgs, workspaceDir);
  args = model ? acpArgsWithModel(args, model) : args;
  args = acpArgsWithMode(args, mode);
  const acpEnv = (env: Record<string, string>) => ({ ...config.acpEnv, ...env });
  const dirs = runDirs(ctx, (env) => buildAcpSpawnEnv(acpEnv(env)));
  return { args, env: acpEnv(dirs.env), model, release: dirs.release };
}

/**
 * Run one plain turn on the dirs `prepare` makes for it. They are released
 * however the turn ends, also when `start` throws.
 */
function withRun<D extends { release: () => void }, T>(
  ctx: RunContext,
  prepare: (ctx: RunContext) => D,
  start: (dirs: D) => Promise<T>,
): Promise<T> {
  let dirs: D | undefined;
  let running: Promise<T>;
  try {
    dirs = prepare(ctx);
    running = start(dirs);
  } catch (error) {
    dirs?.release();
    return Promise.reject(error);
  }
  return running
    .then((out) => {
      cacheTokenForAccount(ctx.configDir);
      return out;
    })
    .finally(dirs.release);
}

function acpRunOptions(
  ctx: RunContext,
  invocation: AcpInvocation,
  request: {
    signal?: AbortSignal;
    modelDisplayName?: string;
    mediaBlocks?: AcpPromptBlock[];
  },
): AcpRunOptions {
  const { config } = ctx;
  return {
    cwd: ctx.workspaceDir,
    timeoutMs: config.timeoutMs,
    env: invocation.env,
    ...acpModelOptions(config, invocation.model, request.modelDisplayName),
    requestTimeoutMs: config.timeoutMs,
    spawnOptions: config.acpSpawnOptions,
    skipAuthenticate: config.acpSkipAuthenticate,
    rawDebug: config.acpRawDebug,
    signal: request.signal,
    mediaBlocks: request.mediaBlocks,
  };
}

export function runAgentSync(
  config: BridgeConfig,
  workspaceDir: string,
  effectiveChatOnly: boolean,
  cmdArgs: string[],
  tempDir?: string,
  stdinPrompt?: string,
  configDir?: string,
  signal?: AbortSignal,
  modelDisplayName?: string,
  mediaBlocks?: AcpPromptBlock[],
): Promise<AgentRunResult> {
  if (mediaBlocks?.length && !config.useAcp) {
    removeChatOnlyTempDir(tempDir);
    return Promise.reject(new Error("multimodal input requires Cursor ACP mode"));
  }
  const ctx = { config, workspaceDir, effectiveChatOnly, cmdArgs, configDir, tempDir };
  if (config.useAcp && typeof stdinPrompt === "string") {
    return withRun(ctx, acpInvocation, (invocation) =>
      runAcpSync(
        config.acpCommand,
        invocation.args,
        stdinPrompt,
        acpRunOptions(ctx, invocation, { signal, modelDisplayName, mediaBlocks }),
      ),
    );
  }
  return withRun(ctx, cliRunDirs, (dirs) =>
    run(config.agentBin, cmdArgs, {
      cwd: workspaceDir,
      timeoutMs: config.timeoutMs,
      stdinContent: stdinPrompt,
      envOverrides: dirs.env,
      signal,
    }),
  );
}

type StreamLineHandler = (line: string) => void;

export function runAgentStream(
  config: BridgeConfig,
  workspaceDir: string,
  effectiveChatOnly: boolean,
  cmdArgs: string[],
  onLine: StreamLineHandler,
  tempDir?: string,
  stdinPrompt?: string,
  configDir?: string,
  signal?: AbortSignal,
  modelDisplayName?: string,
  mediaBlocks?: AcpPromptBlock[],
): Promise<Omit<AgentRunResult, "stdout">> {
  if (mediaBlocks?.length && !config.useAcp) {
    removeChatOnlyTempDir(tempDir);
    return Promise.reject(new Error("multimodal input requires Cursor ACP mode"));
  }
  const ctx = { config, workspaceDir, effectiveChatOnly, cmdArgs, configDir, tempDir };
  if (config.useAcp && typeof stdinPrompt === "string") {
    return withRun(ctx, acpInvocation, (invocation) =>
      runAcpStream(
        config.acpCommand,
        invocation.args,
        stdinPrompt,
        acpRunOptions(ctx, invocation, { signal, modelDisplayName, mediaBlocks }),
        onLine,
      ),
    );
  }
  return withRun(ctx, cliRunDirs, (dirs) =>
    runStreaming(config.agentBin, cmdArgs, {
      cwd: workspaceDir,
      timeoutMs: config.timeoutMs,
      onLine,
      stdinContent: stdinPrompt,
      envOverrides: dirs.env,
      signal,
    }),
  );
}

export async function startAgentToolSession(opts: {
  config: BridgeConfig;
  workspaceDir: string;
  effectiveChatOnly: boolean;
  cmdArgs: string[];
  prompt: string;
  mediaBlocks?: AcpPromptBlock[];
  tools: readonly ClientToolDefinition[];
  tempDir?: string;
  configDir?: string;
  signal?: AbortSignal;
  modelDisplayName?: string;
  requireToolCall?: boolean;
  maxParallelToolCalls?: number;
}): Promise<AcpToolSession> {
  if (!opts.config.useAcp) {
    removeChatOnlyTempDir(opts.tempDir);
    throw new Error("Structured tool passthrough requires ACP mode");
  }
  const invocation = acpInvocation(opts);
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    cacheTokenForAccount(opts.configDir);
    invocation.release();
  };
  try {
    const session = new AcpToolSession({
      command: opts.config.acpCommand,
      args: invocation.args,
      cwd: opts.workspaceDir,
      env: invocation.env,
      timeoutMs: opts.config.timeoutMs,
      spawnOptions: opts.config.acpSpawnOptions,
      skipAuthenticate: opts.config.acpSkipAuthenticate,
      rawDebug: opts.config.acpRawDebug,
      signal: opts.signal,
      ...acpModelOptions(opts.config, invocation.model, opts.modelDisplayName),
      tools: opts.tools,
      requireToolCall: opts.requireToolCall,
      maxParallelToolCalls: opts.maxParallelToolCalls,
      onClose: cleanup,
    });
    await session.start(opts.prompt, opts.mediaBlocks);
    return session;
  } catch (error) {
    cleanup();
    throw error;
  }
}
