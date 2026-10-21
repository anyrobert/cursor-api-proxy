import { spawn, type ChildProcess } from "node:child_process";
import { agentChildEnv, resolveAgentCommand } from "./env.js";
import { DETACH_CHILDREN, killProcessTree } from "./process-tree-kill.js";

export type RunResult = {
  code: number;
  stdout: string;
  stderr: string;
};

export type RunOptions = {
  cwd?: string;
  timeoutMs?: number;
  /** When set, pass this string to the child process stdin and close it (avoids long prompt in argv on Windows). */
  stdinContent?: string;
  /** Env overrides for the child (e.g. HOME, CURSOR_CONFIG_DIR to isolate from global rules). */
  envOverrides?: Record<string, string>;
  /** Abort signal — when aborted, the child process is killed immediately */
  signal?: AbortSignal;
};

export type RunStreamingOptions = RunOptions & {
  onLine: (line: string) => void;
};

// ---------------------------------------------------------------------------
// Global child process registry — used for graceful shutdown
// ---------------------------------------------------------------------------

const activeChildren = new Set<ChildProcess>();

/** Kill all in-flight agent child processes. Called on server shutdown. */
export function killAllChildProcesses(): void {
  for (const child of activeChildren) {
    killProcessTree(child, "SIGTERM");
  }
  activeChildren.clear();
}

/** Register a child (e.g. ACP) for graceful shutdown; removed on close. */
export function trackChildProcess(child: ChildProcess): void {
  activeChildren.add(child);
  child.once("close", () => {
    activeChildren.delete(child);
  });
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function spawnChild(cmd: string, args: string[], opts: RunOptions) {
  const resolved = resolveAgentCommand(cmd, args);
  const useStdin = typeof opts.stdinContent === "string";
  const child = spawn(resolved.command, resolved.args, {
    cwd: opts.cwd,
    env: agentChildEnv(resolved, opts.envOverrides),
    stdio: useStdin ? ["pipe", "pipe", "pipe"] : ["ignore", "pipe", "pipe"],
    windowsVerbatimArguments: resolved.windowsVerbatimArguments,
    detached: DETACH_CHILDREN,
  });

  if (useStdin && opts.stdinContent !== undefined && child.stdin) {
    child.stdin.write(opts.stdinContent, "utf8");
    child.stdin.end();
  }

  return child;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function runStreaming(
  cmd: string,
  args: string[],
  opts: RunStreamingOptions,
): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawnChild(cmd, args, opts);

    activeChildren.add(child);

    const timeoutMs = opts.timeoutMs;
    const timeout =
      typeof timeoutMs === "number" && timeoutMs > 0
        ? setTimeout(() => {
            killProcessTree(child, "SIGKILL");
          }, timeoutMs)
        : undefined;

    // Abort signal support — kill child when client disconnects
    const onAbort = () => killProcessTree(child, "SIGTERM");
    if (opts.signal) {
      if (opts.signal.aborted) {
        killProcessTree(child, "SIGTERM");
      } else {
        opts.signal.addEventListener("abort", onAbort, { once: true });
      }
    }

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
      opts.signal?.removeEventListener("abort", onAbort);
      activeChildren.delete(child);
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

    child.on("close", (code, signal) => {
      if (timeout) clearTimeout(timeout);
      opts.signal?.removeEventListener("abort", onAbort);
      activeChildren.delete(child);
      killProcessTree(child, "SIGKILL");
      if (lineBuffer.trim()) opts.onLine(lineBuffer.trim());
      if (signal) {
        const signalNote = `terminated by signal ${signal}`;
        stderr = stderr.trim() ? `${stderr.trim()}\n${signalNote}` : signalNote;
      }
      resolve({ code: code ?? (signal ? -1 : 0), stderr });
    });
  });
}

export function run(
  cmd: string,
  args: string[],
  opts: RunOptions = {},
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawnChild(cmd, args, opts);

    activeChildren.add(child);

    const timeoutMs = opts.timeoutMs;
    const timeout =
      typeof timeoutMs === "number" && timeoutMs > 0
        ? setTimeout(() => {
            killProcessTree(child, "SIGKILL");
          }, timeoutMs)
        : undefined;

    const onAbort = () => killProcessTree(child, "SIGTERM");
    if (opts.signal) {
      if (opts.signal.aborted) {
        killProcessTree(child, "SIGTERM");
      } else {
        opts.signal.addEventListener("abort", onAbort, { once: true });
      }
    }

    let stdout = "";
    let stderr = "";

    child.stdout!.setEncoding("utf8");
    child.stderr!.setEncoding("utf8");
    child.stdout!.on("data", (c) => (stdout += c));
    child.stderr!.on("data", (c) => (stderr += c));

    child.on("error", (err: NodeJS.ErrnoException) => {
      if (timeout) clearTimeout(timeout);
      opts.signal?.removeEventListener("abort", onAbort);
      activeChildren.delete(child);
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

    child.on("close", (code, signal) => {
      if (timeout) clearTimeout(timeout);
      opts.signal?.removeEventListener("abort", onAbort);
      activeChildren.delete(child);
      killProcessTree(child, "SIGKILL");
      if (signal) {
        const signalNote = `terminated by signal ${signal}`;
        stderr = stderr.trim() ? `${stderr.trim()}\n${signalNote}` : signalNote;
      }
      resolve({ code: code ?? (signal ? -1 : 0), stdout, stderr });
    });
  });
}
