import { spawn } from "node:child_process";

export type RunResult = {
  code: number;
  stdout: string;
  stderr: string;
};

export type RunOptions = {
  cwd?: string;
  timeoutMs?: number;
};

export type RunStreamingOptions = RunOptions & {
  onLine: (line: string) => void;
};

function spawnChild(cmd: string, args: string[], cwd?: string) {
  if (process.platform === "win32") {
    const nodeBin = process.env.CURSOR_AGENT_NODE;
    const agentScript = process.env.CURSOR_AGENT_SCRIPT;
    if (nodeBin && agentScript) {
      return spawn(nodeBin, [agentScript, ...args], {
        cwd,
        env: { ...process.env, CURSOR_INVOKED_AS: "agent.cmd" },
        stdio: ["ignore", "pipe", "pipe"],
      });
    }
    if (/\.cmd$/i.test(cmd)) {
      const quotedArgs = args.map((a) => (a.includes(" ") ? `"${a}"` : a)).join(" ");
      const cmdLine = `""${cmd}" ${quotedArgs}"`;
      return spawn(process.env.COMSPEC || "cmd.exe", ["/d", "/s", "/c", cmdLine], {
        cwd,
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
        windowsVerbatimArguments: true,
      });
    }
  }
  return spawn(cmd, args, {
    cwd,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

export function runStreaming(
  cmd: string,
  args: string[],
  opts: RunStreamingOptions,
): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawnChild(cmd, args, opts.cwd);

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
    const child = spawnChild(cmd, args, opts.cwd);

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
