import { spawn, type ChildProcess } from "node:child_process";

import { trackChildProcess } from "./process.js";
import { DETACH_CHILDREN } from "./process-tree-kill.js";

/** Parent variables an ACP child needs to start (paths, temp dirs, home). */
const INHERITED_ENV_KEYS = [
  "PATH",
  "PATHEXT",
  "SystemRoot",
  "WINDIR",
  "COMSPEC",
  "TEMP",
  "TMP",
  "USERPROFILE",
  "USERNAME",
  "HOME",
  "HOMEDRIVE",
  "HOMEPATH",
  "APPDATA",
  "LOCALAPPDATA",
  "PROGRAMFILES",
  "PROGRAMFILES(X86)",
  "PROGRAMDATA",
  "PUBLIC",
  "NODE_OPTIONS",
] as const;

export type AcpSpawnOptions = {
  cwd: string;
  /** Request-specific variables (config dir, chat-only home) layered on top. */
  env?: Record<string, string | undefined>;
  /** e.g. windowsVerbatimArguments for the cmd.exe fallback on Windows. */
  spawnOptions?: { windowsVerbatimArguments?: boolean };
};

/**
 * Avoid passing the entire parent environment into ACP children (it may
 * contain unrelated secrets): inherit only the allowlist, then apply `extra`.
 */
export function buildAcpSpawnEnv(
  extra?: Record<string, string | undefined>,
): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const key of INHERITED_ENV_KEYS) {
    const value = process.env[key];
    if (value !== undefined) out[key] = value;
  }
  for (const [key, value] of Object.entries(extra ?? {})) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

/**
 * Start `agent acp`. Every ACP child (plain and tool turns) is spawned here,
 * with the env agent-runner built for its run (including the run's private
 * config dir, see acp-config-dir.ts). Children lead their own process group
 * so killProcessTree can reap the CLI's helpers.
 */
export function spawnAcpChild(
  command: string,
  args: readonly string[],
  opts: AcpSpawnOptions,
): ChildProcess {
  const child = spawn(command, [...args], {
    cwd: opts.cwd,
    env: buildAcpSpawnEnv(opts.env),
    stdio: ["pipe", "pipe", "pipe"],
    windowsVerbatimArguments: opts.spawnOptions?.windowsVerbatimArguments,
    detached: DETACH_CHILDREN,
  });
  trackChildProcess(child);
  return child;
}
