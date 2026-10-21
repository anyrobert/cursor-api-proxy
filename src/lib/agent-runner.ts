import { runAcpStream, runAcpSync, type AcpRunOptions } from "./acp-client.js";
import {
  createRunConfigDir,
  cursorConfigDir,
  type RunConfigDir,
} from "./acp-config-dir.js";
import type { AcpModelOptions } from "./acp-model.js";
import { buildAcpSpawnEnv } from "./acp-spawn.js";
import type { AcpPromptBlock } from "./media-input.js";
import { AcpToolSession } from "./acp-tool-session.js";
import type { BridgeConfig } from "./config.js";
import type { CursorExecutionMode } from "./execution-mode.js";
import { run, runStreaming } from "./process.js";
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

/** What every ACP run is started from. */
type AcpRunContext = {
  config: BridgeConfig;
  workspaceDir: string;
  effectiveChatOnly: boolean;
  cmdArgs: string[];
  /** Account pool config dir. */
  configDir?: string;
  /** Chat-only isolation root, owned by the run once it is handed over. */
  tempDir?: string;
};

type AcpInvocation = {
  args: string[];
  env: Record<string, string | undefined>;
  model?: string;
  /** Remove the run's private dirs; call once its agent is gone. */
  release: () => void;
};

/**
 * Args and env for one `agent acp` run. The CLI saves each model choice in
 * its config dir (#63), so the run always gets a config dir of its own: the
 * chat-only temp home when there is no account pool, else a copy of the
 * account's (or the user's) config dir. On failure it removes `tempDir`.
 */
function acpInvocation(ctx: AcpRunContext): AcpInvocation {
  const { config, workspaceDir, effectiveChatOnly, cmdArgs, configDir, tempDir } = ctx;
  const model = extractModelFromCmdArgs(cmdArgs);
  const mode = extractModeFromCmdArgs(cmdArgs);
  let args = acpArgsWithWorkspace(config.acpArgs, workspaceDir);
  args = model ? acpArgsWithModel(args, model) : args;
  args = acpArgsWithMode(args, mode);
  const env = { ...config.acpEnv };
  if (effectiveChatOnly) {
    Object.assign(
      env,
      getChatOnlyEnvOverrides(chatOnlyHomeDir(workspaceDir, tempDir), configDir),
    );
  } else if (configDir) {
    env.CURSOR_CONFIG_DIR = configDir;
  }
  if (effectiveChatOnly && !configDir) {
    return { args, env, model, release: () => removeChatOnlyTempDir(tempDir) };
  }
  let runConfig: RunConfigDir;
  try {
    runConfig = createRunConfigDir(cursorConfigDir(buildAcpSpawnEnv(env)));
  } catch (error) {
    removeChatOnlyTempDir(tempDir);
    throw error;
  }
  env.CURSOR_CONFIG_DIR = runConfig.dir;
  return {
    args,
    env,
    model,
    release: () => {
      runConfig.dispose();
      removeChatOnlyTempDir(tempDir);
    },
  };
}

/** Run one plain ACP turn; its dirs are released however it ends. */
function withAcpRun<T>(
  ctx: AcpRunContext,
  run: (invocation: AcpInvocation) => Promise<T>,
): Promise<T> {
  let invocation: AcpInvocation;
  try {
    invocation = acpInvocation(ctx);
  } catch (error) {
    return Promise.reject(error);
  }
  return run(invocation)
    .then((out) => {
      cacheTokenForAccount(ctx.configDir);
      return out;
    })
    .finally(invocation.release);
}

function acpRunOptions(
  ctx: AcpRunContext,
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
  if (config.useAcp && typeof stdinPrompt === "string") {
    const ctx = { config, workspaceDir, effectiveChatOnly, cmdArgs, configDir, tempDir };
    return withAcpRun(ctx, (invocation) =>
      runAcpSync(
        config.acpCommand,
        invocation.args,
        stdinPrompt,
        acpRunOptions(ctx, invocation, { signal, modelDisplayName, mediaBlocks }),
      ),
    );
  }
  const runEnvOverrides = effectiveChatOnly
    ? getChatOnlyEnvOverrides(chatOnlyHomeDir(workspaceDir, tempDir), configDir)
    : undefined;
  return run(config.agentBin, cmdArgs, {
    cwd: workspaceDir,
    timeoutMs: config.timeoutMs,
    maxMode: config.maxMode,
    stdinContent: stdinPrompt,
    envOverrides: runEnvOverrides,
    configDir,
    signal,
  })
    .then((out) => {
      cacheTokenForAccount(configDir);
      return out;
    })
    .finally(() => removeChatOnlyTempDir(tempDir));
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
  if (config.useAcp && typeof stdinPrompt === "string") {
    const ctx = { config, workspaceDir, effectiveChatOnly, cmdArgs, configDir, tempDir };
    return withAcpRun(ctx, (invocation) =>
      runAcpStream(
        config.acpCommand,
        invocation.args,
        stdinPrompt,
        acpRunOptions(ctx, invocation, { signal, modelDisplayName, mediaBlocks }),
        onLine,
      ),
    );
  }
  const streamEnvOverrides = effectiveChatOnly
    ? getChatOnlyEnvOverrides(chatOnlyHomeDir(workspaceDir, tempDir), configDir)
    : undefined;
  return runStreaming(config.agentBin, cmdArgs, {
    cwd: workspaceDir,
    timeoutMs: config.timeoutMs,
    maxMode: config.maxMode,
    onLine,
    stdinContent: stdinPrompt,
    envOverrides: streamEnvOverrides,
    configDir,
    signal,
  })
    .then((result) => {
      cacheTokenForAccount(configDir);
      return result;
    })
    .finally(() => removeChatOnlyTempDir(tempDir));
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
