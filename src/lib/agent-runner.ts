import * as fs from "node:fs";

import { runAcpStream, runAcpSync } from "./acp-client.js";
import type { BridgeConfig } from "./config.js";
import { run, runStreaming } from "./process.js";

export type AgentRunResult = {
  code: number;
  stdout: string;
  stderr: string;
};

export function runAgentSync(
  config: BridgeConfig,
  workspaceDir: string,
  cmdArgs: string[],
  tempDir?: string,
  stdinPrompt?: string,
): Promise<AgentRunResult> {
  if (config.useAcp && typeof stdinPrompt === "string") {
    return runAcpSync(config.agentBin, stdinPrompt, {
      cwd: workspaceDir,
      timeoutMs: config.timeoutMs,
    }).then((out) => {
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
  return run(config.agentBin, cmdArgs, {
    cwd: workspaceDir,
    timeoutMs: config.timeoutMs,
    maxMode: config.maxMode,
    stdinContent: stdinPrompt,
  }).then((out) => {
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
): Promise<{ code: number; stderr: string }> {
  if (config.useAcp && typeof stdinPrompt === "string") {
    return runAcpStream(
      config.agentBin,
      stdinPrompt,
      { cwd: workspaceDir, timeoutMs: config.timeoutMs },
      onLine,
    ).then((result) => {
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
  return runStreaming(config.agentBin, cmdArgs, {
    cwd: workspaceDir,
    timeoutMs: config.timeoutMs,
    maxMode: config.maxMode,
    onLine,
    stdinContent: stdinPrompt,
  }).then((result) => {
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
