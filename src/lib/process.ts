import { spawn, type ChildProcess } from "node:child_process";
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
  /** Env overrides for the child (e.g. HOME, CURSOR_CONFIG_DIR to isolate from global rules). */
  envOverrides?: Record<string, string>;
  /** Custom config dir for round-robin account rotation */
  configDir?: string;
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
    try {
      child.kill("SIGTERM");
    } catch {
      /* already exited */
    }
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

function spawnChild(
  cmd: string,
  args: string[],
  opts?: {
    cwd?: string;
    maxMode?: boolean;
    stdinContent?: string;
    envOverrides?: Record<string, string>;
    configDir?: string;
  },
) {
  const resolved = resolveAgentCommand(cmd, args);

  if (opts?.maxMode) {
    runMaxModePreflight(resolved.agentScriptPath, opts?.configDir);
  }

  const env = { ...resolved.env };
  if (opts?.configDir) {
    env.CURSOR_CONFIG_DIR = opts.configDir;
  } else if (resolved.configDir && !env.CURSOR_CONFIG_DIR) {
    env.CURSOR_CONFIG_DIR = resolved.configDir;
  }
  if (opts?.envOverrides) {
    Object.assign(env, opts.envOverrides);
  }

  const useStdin = typeof opts?.stdinContent === "string";
  const child = spawn(resolved.command, resolved.args, {
    cwd: opts?.cwd,
    env,
    stdio: useStdin ? ["pipe", "pipe", "pipe"] : ["ignore", "pipe", "pipe"],
    windowsVerbatimArguments: resolved.windowsVerbatimArguments,
  });

  if (useStdin && opts!.stdinContent !== undefined && child.stdin) {
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
    const child = spawnChild(cmd, args, {
      cwd: opts.cwd,
      maxMode: opts.maxMode,
      stdinContent: opts.stdinContent,
      envOverrides: opts.envOverrides,
      configDir: opts.configDir,
    });

    activeChildren.add(child);

    const timeoutMs = opts.timeoutMs;
    const timeout =
      typeof timeoutMs === "number" && timeoutMs > 0
        ? setTimeout(() => {
            child.kill("SIGKILL");
          }, timeoutMs)
        : undefined;

    // Abort signal support — kill child when client disconnects
    const onAbort = () => child.kill("SIGTERM");
    if (opts.signal) {
      if (opts.signal.aborted) {
        child.kill("SIGTERM");
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
      if (lineBuffer.trim()) opts.onLine(lineBuffer.trim());
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
    const child = spawnChild(cmd, args, {
      cwd: opts.cwd,
      maxMode: opts.maxMode,
      stdinContent: opts.stdinContent,
      envOverrides: opts.envOverrides,
      configDir: opts.configDir,
    });

    activeChildren.add(child);

    const timeoutMs = opts.timeoutMs;
    const timeout =
      typeof timeoutMs === "number" && timeoutMs > 0
        ? setTimeout(() => {
            child.kill("SIGKILL");
          }, timeoutMs)
        : undefined;

    const onAbort = () => child.kill("SIGTERM");
    if (opts.signal) {
      if (opts.signal.aborted) {
        child.kill("SIGTERM");
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
      resolve({ code: code ?? (signal ? -1 : 0), stdout, stderr });
    });
  });
}
