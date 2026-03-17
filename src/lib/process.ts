import { spawn } from "node:child_process";
import { resolveAgentCommand } from "./env.js";
import { runMaxModePreflight } from "./max-mode-preflight.js";

export type RunResult = {
  code: number;
  stdout: string;
  stderr: string;
};

export type RunOptions = {
  cwd?: string;
  timeoutMs?: number;
  /** Enable Cursor Max Mode (preflight writes maxMode to cli-config.json). */
  maxMode?: boolean;
  /** When set, pass this string to the child process stdin and close it (avoids long prompt in argv on Windows). */
  stdinContent?: string;
};

export type RunStreamingOptions = RunOptions & {
  onLine: (line: string) => void;
};

function spawnChild(
  cmd: string,
  args: string[],
  opts?: { cwd?: string; maxMode?: boolean; stdinContent?: string },
) {
  const resolved = resolveAgentCommand(cmd, args);

  if (opts?.maxMode && resolved.agentScriptPath) {
    runMaxModePreflight(resolved.agentScriptPath);
  }

  const env = { ...resolved.env };
  if (resolved.configDir && !env.CURSOR_CONFIG_DIR) {
    env.CURSOR_CONFIG_DIR = resolved.configDir;
  }

  const useStdin = typeof opts?.stdinContent === "string";
  const child = spawn(resolved.command, resolved.args, {
    cwd: opts?.cwd,
    env,
    stdio: useStdin ? ["pipe", "pipe", "pipe"] : ["ignore", "pipe", "pipe"],
    windowsVerbatimArguments: resolved.windowsVerbatimArguments,
  });

  if (useStdin && opts.stdinContent !== undefined && child.stdin) {
    child.stdin.write(opts.stdinContent, "utf8");
    child.stdin.end();
  }

  return child;
}

export function runStreaming(
  cmd: string,
  args: string[],
  opts: RunStreamingOptions,
): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawnChild(cmd, args, {
      cwd: opts.cwd,
      maxMode: opts.maxMode,
      stdinContent: opts.stdinContent,
    });

    const timeoutMs = opts.timeoutMs;
    const timeout =
      typeof timeoutMs === "number" && timeoutMs > 0
        ? setTimeout(() => {
            child.kill("SIGKILL");
          }, timeoutMs)
        : undefined;

    let stderr = "";
    let lineBuffer = "";

    child.stderr!.setEncoding("utf8");
    child.stderr!.on("data", (c) => (stderr += c));

    child.stdout!.setEncoding("utf8");
    child.stdout!.on("data", (chunk: string) => {
      lineBuffer += chunk;
      const lines = lineBuffer.split("\n");
      lineBuffer = lines.pop() ?? "";
      for (const line of lines) {
        if (line.trim()) opts.onLine(line);
      }
    });

    child.on("error", (err: NodeJS.ErrnoException) => {
      if (timeout) clearTimeout(timeout);
      if (err?.code === "ENOENT") {
        reject(
          new Error(
            `Command not found: ${cmd}. Install Cursor CLI (agent) or set CURSOR_AGENT_BIN to its path.`,
          ),
        );
        return;
      }
      reject(err);
    });

    child.on("close", (code) => {
      if (timeout) clearTimeout(timeout);
      if (lineBuffer.trim()) opts.onLine(lineBuffer.trim());
      resolve({ code: code ?? 0, stderr });
    });
  });
}

export function run(cmd: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawnChild(cmd, args, {
      cwd: opts.cwd,
      maxMode: opts.maxMode,
      stdinContent: opts.stdinContent,
    });

    const timeoutMs = opts.timeoutMs;
    const timeout =
      typeof timeoutMs === "number" && timeoutMs > 0
        ? setTimeout(() => {
            child.kill("SIGKILL");
          }, timeoutMs)
        : undefined;

    let stdout = "";
    let stderr = "";

    child.stdout!.setEncoding("utf8");
    child.stderr!.setEncoding("utf8");
    child.stdout!.on("data", (c) => (stdout += c));
    child.stderr!.on("data", (c) => (stderr += c));

    child.on("error", (err: NodeJS.ErrnoException) => {
      if (timeout) clearTimeout(timeout);
      if (err?.code === "ENOENT") {
        reject(
          new Error(
            `Command not found: ${cmd}. Install Cursor CLI (agent) or set CURSOR_AGENT_BIN to its path.`,
          ),
        );
        return;
      }
      reject(err);
    });

    child.on("close", (code) => {
      if (timeout) clearTimeout(timeout);
      resolve({ code: code ?? 0, stdout, stderr });
    });
  });
}
