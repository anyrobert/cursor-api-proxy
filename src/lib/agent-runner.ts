import * as fs from "node:fs";

import { runAcpStream, runAcpSync } from "./acp-client.js";
import type { BridgeConfig } from "./config.js";
import { run, runStreaming } from "./process.js";
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

function acpArgsWithWorkspace(acpArgs: string[], workspaceDir: string): string[] {
  const i = acpArgs.indexOf("acp");
  if (i === -1) return acpArgs;
  return [...acpArgs.slice(0, i), "--workspace", workspaceDir, ...acpArgs.slice(i)];
}

function extractModelFromCmdArgs(cmdArgs: string[]): string | undefined {
  const i = cmdArgs.indexOf("--model");
  return i >= 0 && i + 1 < cmdArgs.length ? cmdArgs[i + 1] : undefined;
}

export function runAgentSync(
  config: BridgeConfig,
  workspaceDir: string,
  cmdArgs: string[],
  tempDir?: string,
  stdinPrompt?: string,
  configDir?: string,
  signal?: AbortSignal,
): Promise<AgentRunResult> {
  if (config.useAcp && typeof stdinPrompt === "string") {
    const acpModel = extractModelFromCmdArgs(cmdArgs);
    let args = acpArgsWithWorkspace(config.acpArgs, workspaceDir);
    args = acpModel ? acpArgsWithModel(args, acpModel) : args;
    const acpEnv = { ...config.acpEnv };
    if (config.chatOnlyWorkspace) {
      Object.assign(acpEnv, getChatOnlyEnvOverrides(workspaceDir, configDir));
    }
    return runAcpSync(config.acpCommand, args, stdinPrompt, {
      cwd: workspaceDir,
      timeoutMs: config.timeoutMs,
      env: acpEnv,
      model: acpModel,
      requestTimeoutMs: 60_000,
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
  const runEnvOverrides = config.chatOnlyWorkspace
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
  cmdArgs: string[],
  onLine: StreamLineHandler,
  tempDir?: string,
  stdinPrompt?: string,
  configDir?: string,
  signal?: AbortSignal,
): Promise<{ code: number; stderr: string }> {
  if (config.useAcp && typeof stdinPrompt === "string") {
    const acpModel = extractModelFromCmdArgs(cmdArgs);
    let args = acpArgsWithWorkspace(config.acpArgs, workspaceDir);
    args = acpModel ? acpArgsWithModel(args, acpModel) : args;
    const acpEnv = { ...config.acpEnv };
    if (config.chatOnlyWorkspace) {
      Object.assign(acpEnv, getChatOnlyEnvOverrides(workspaceDir, configDir));
    }
    return runAcpStream(
      config.acpCommand,
      args,
      stdinPrompt,
      {
        cwd: workspaceDir,
        timeoutMs: config.timeoutMs,
        env: acpEnv,
        model: acpModel,
        requestTimeoutMs: 60_000,
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
  const streamEnvOverrides = config.chatOnlyWorkspace
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
