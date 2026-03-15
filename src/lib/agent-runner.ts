import * as fs from "node:fs";

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
): Promise<AgentRunResult> {
  return run(config.agentBin, cmdArgs, {
    cwd: workspaceDir,
    timeoutMs: config.timeoutMs,
    maxMode: config.maxMode,
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
): Promise<{ code: number; stderr: string }> {
  return runStreaming(config.agentBin, cmdArgs, {
    cwd: workspaceDir,
    timeoutMs: config.timeoutMs,
    maxMode: config.maxMode,
    onLine,
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
