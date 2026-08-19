import * as fs from "node:fs";

import { runAcpStream, runAcpSync } from "./acp-client.js";
import { AcpToolSession } from "./acp-tool-session.js";
import type { BridgeConfig } from "./config.js";
import type { CursorExecutionMode } from "./execution-mode.js";
import { run, runStreaming } from "./process.js";
import type { ClientToolDefinition } from "./tool-types.js";
import { getChatOnlyEnvOverrides } from "./workspace.js";
import { readKeychainToken, writeCachedToken } from "./token-cache.js";

function cacheTokenForAccount(configDir?: string): void {
  if (!configDir) return;
  const token = readKeychainToken();
  if (token) writeCachedToken(configDir, token);
}

export type AgentRunResult = {
  code: number;
  stdout: string;
  stderr: string;
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

function acpInvocation(
  config: BridgeConfig,
  workspaceDir: string,
  effectiveChatOnly: boolean,
  cmdArgs: string[],
  configDir?: string,
): {
  args: string[];
  env: Record<string, string | undefined>;
  model?: string;
} {
  const model = extractModelFromCmdArgs(cmdArgs);
  const mode = extractModeFromCmdArgs(cmdArgs);
  let args = acpArgsWithWorkspace(config.acpArgs, workspaceDir);
  args = model ? acpArgsWithModel(args, model) : args;
  args = acpArgsWithMode(args, mode);
  const env = { ...config.acpEnv };
  if (effectiveChatOnly) {
    Object.assign(env, getChatOnlyEnvOverrides(workspaceDir, configDir));
  } else if (configDir) {
    env.CURSOR_CONFIG_DIR = configDir;
  }
  return { args, env, model };
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
): Promise<AgentRunResult> {
  if (config.useAcp && typeof stdinPrompt === "string") {
    const invocation = acpInvocation(
      config,
      workspaceDir,
      effectiveChatOnly,
      cmdArgs,
      configDir,
    );
    return runAcpSync(config.acpCommand, invocation.args, stdinPrompt, {
      cwd: workspaceDir,
      timeoutMs: config.timeoutMs,
      env: invocation.env,
      model: invocation.model,
      modelAliases: modelDisplayName ? [modelDisplayName] : undefined,
      strictModel: config.strictModel,
      requestTimeoutMs: config.timeoutMs,
      spawnOptions: config.acpSpawnOptions,
      skipAuthenticate: config.acpSkipAuthenticate,
      rawDebug: config.acpRawDebug,
      signal,
    }).then((out) => {
      cacheTokenForAccount(configDir);
      if (tempDir) {
        try {
          fs.rmSync(tempDir, { recursive: true, force: true });
        } catch {
          /* ignore */
        }
      }
      return out;
    });
  }
  const runEnvOverrides = effectiveChatOnly
    ? getChatOnlyEnvOverrides(workspaceDir, configDir)
    : undefined;
  return run(config.agentBin, cmdArgs, {
    cwd: workspaceDir,
    timeoutMs: config.timeoutMs,
    maxMode: config.maxMode,
    stdinContent: stdinPrompt,
    envOverrides: runEnvOverrides,
    configDir,
    signal,
  }).then((out) => {
    cacheTokenForAccount(configDir);
    if (tempDir) {
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
    return out;
  });
}

export type StreamLineHandler = (line: string) => void;

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
): Promise<{ code: number; stderr: string }> {
  if (config.useAcp && typeof stdinPrompt === "string") {
    const invocation = acpInvocation(
      config,
      workspaceDir,
      effectiveChatOnly,
      cmdArgs,
      configDir,
    );
    return runAcpStream(
      config.acpCommand,
      invocation.args,
      stdinPrompt,
      {
        cwd: workspaceDir,
        timeoutMs: config.timeoutMs,
        env: invocation.env,
        model: invocation.model,
        modelAliases: modelDisplayName ? [modelDisplayName] : undefined,
        strictModel: config.strictModel,
        requestTimeoutMs: config.timeoutMs,
        spawnOptions: config.acpSpawnOptions,
        skipAuthenticate: config.acpSkipAuthenticate,
        rawDebug: config.acpRawDebug,
        signal,
      },
      onLine,
    ).then((result) => {
      cacheTokenForAccount(configDir);
      if (tempDir) {
        try {
          fs.rmSync(tempDir, { recursive: true, force: true });
        } catch {
          /* ignore */
        }
      }
      return result;
    });
  }
  const streamEnvOverrides = effectiveChatOnly
    ? getChatOnlyEnvOverrides(workspaceDir, configDir)
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
  }).then((result) => {
    cacheTokenForAccount(configDir);
    if (tempDir) {
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
    return result;
  });
}

export async function startAgentToolSession(opts: {
  config: BridgeConfig;
  workspaceDir: string;
  effectiveChatOnly: boolean;
  cmdArgs: string[];
  prompt: string;
  tools: readonly ClientToolDefinition[];
  tempDir?: string;
  configDir?: string;
  signal?: AbortSignal;
  modelDisplayName?: string;
  requireToolCall?: boolean;
  maxParallelToolCalls?: number;
}): Promise<AcpToolSession> {
  if (!opts.config.useAcp) {
    throw new Error("Structured tool passthrough requires ACP mode");
  }
  const invocation = acpInvocation(
    opts.config,
    opts.workspaceDir,
    opts.effectiveChatOnly,
    opts.cmdArgs,
    opts.configDir,
  );
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    cacheTokenForAccount(opts.configDir);
    if (opts.tempDir) {
      try {
        fs.rmSync(opts.tempDir, { recursive: true, force: true });
      } catch {
        // best effort
      }
    }
  };
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
    modelCandidates: [
      invocation.model,
      opts.modelDisplayName,
    ].filter((value): value is string => Boolean(value)),
    strictModel: opts.config.strictModel,
    tools: opts.tools,
    requireToolCall: opts.requireToolCall,
    maxParallelToolCalls: opts.maxParallelToolCalls,
    onClose: cleanup,
  });
  try {
    await session.start(opts.prompt);
    return session;
  } catch (error) {
    cleanup();
    throw error;
  }
}
