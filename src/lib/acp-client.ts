/**
 * ACP (Agent Client Protocol) client for Cursor CLI.
 * Spawns `agent acp` and communicates via JSON-RPC over stdio.
 * See https://cursor.com/docs/cli/acp and https://agentclientprotocol.com/
 */

import * as readline from "node:readline";
import { spawn } from "node:child_process";

export type AcpRunOptions = {
  cwd: string;
  timeoutMs: number;
  env?: Record<string, string | undefined>;
};

export type AcpSyncResult = {
  code: number;
  stdout: string;
  stderr: string;
};

export type AcpStreamResult = {
  code: number;
  stderr: string;
};

function sendRequest(
  stdin: NodeJS.WritableStream,
  nextId: { current: number },
  method: string,
  params: object,
  pending: Map<
    number,
    { resolve: (value: unknown) => void; reject: (err: Error) => void }
  >,
): Promise<unknown> {
  const id = nextId.current++;
  const line =
    JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
  stdin.write(line, "utf8");
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
  });
}

function respond(stdin: NodeJS.WritableStream, id: number, result: object): void {
  const line = JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n";
  stdin.write(line, "utf8");
}

/**
 * Run a single prompt via ACP and return the full response (sync).
 */
export function runAcpSync(
  agentBin: string,
  prompt: string,
  opts: AcpRunOptions,
): Promise<AcpSyncResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(agentBin, ["acp"], {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stderr = "";
    let accumulated = "";
    let resolved = false;

    const finish = (code: number) => {
      if (resolved) return;
      resolved = true;
      try {
        child.stdin?.end();
        child.kill();
      } catch {
        /* ignore */
      }
      resolve({
        code,
        stdout: accumulated.trim(),
        stderr: stderr.trim(),
      });
    };

    const timeout =
      opts.timeoutMs > 0
        ? setTimeout(() => {
            finish(124); // timeout exit code
          }, opts.timeoutMs)
        : undefined;

    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => (stderr += chunk));

    const nextId = { current: 1 };
    const pending = new Map<
      number,
      { resolve: (value: unknown) => void; reject: (err: Error) => void }
    >();

    const rl = readline.createInterface({ input: child.stdout! });
    rl.on("line", (line: string) => {
      try {
        const msg = JSON.parse(line) as {
          id?: number;
          method?: string;
          params?: { update?: { sessionUpdate?: string; content?: { text?: string } } };
          result?: unknown;
          error?: { message?: string };
        };

        if (msg.id != null && (msg.result !== undefined || msg.error !== undefined)) {
          const waiter = pending.get(msg.id);
          if (waiter) {
            pending.delete(msg.id);
            if (msg.error) {
              waiter.reject(new Error(msg.error.message ?? "ACP error"));
            } else {
              waiter.resolve(msg.result);
            }
          }
          return;
        }

        if (msg.method === "session/update") {
          const update = msg.params?.update;
          if (
            update?.sessionUpdate === "agent_message_chunk" &&
            typeof update.content?.text === "string"
          ) {
            accumulated += update.content.text;
          }
          return;
        }

        if (msg.method === "session/request_permission") {
          if (msg.id != null && child.stdin) {
            respond(child.stdin, msg.id, {
              outcome: { outcome: "selected", optionId: "allow-once" },
            });
          }
          return;
        }
      } catch {
        /* ignore parse errors */
      }
    });

    child.on("error", (err) => {
      if (timeout) clearTimeout(timeout);
      if (!resolved) {
        resolved = true;
        reject(err);
      }
    });

    child.on("close", (code) => {
      if (timeout) clearTimeout(timeout);
      finish(code ?? 1);
    });

    const run = async () => {
      if (!child.stdin) {
        finish(1);
        return;
      }
      try {
        await sendRequest(child.stdin, nextId, "initialize", {
          protocolVersion: 1,
          clientCapabilities: {
            fs: { readTextFile: false, writeTextFile: false },
            terminal: false,
          },
          clientInfo: { name: "cursor-api-proxy", version: "0.1.0" },
        }, pending);

        await sendRequest(child.stdin, nextId, "authenticate", {
          methodId: "cursor_login",
        }, pending);

        const sessionResult = (await sendRequest(
          child.stdin,
          nextId,
          "session/new",
          { cwd: opts.cwd, mcpServers: [] },
          pending,
        )) as { sessionId?: string };
        const sessionId = sessionResult?.sessionId;
        if (!sessionId) {
          finish(1);
          return;
        }

        await sendRequest(child.stdin, nextId, "session/prompt", {
          sessionId,
          prompt: [{ type: "text", text: prompt }],
        }, pending);
        finish(0);
      } catch {
        if (timeout) clearTimeout(timeout);
        if (!resolved) {
          resolved = true;
          finish(1);
        }
      }
    };

    run();
  });
}

/**
 * Run a single prompt via ACP and stream response chunks via onChunk.
 */
export function runAcpStream(
  agentBin: string,
  prompt: string,
  opts: AcpRunOptions,
  onChunk: (text: string) => void,
): Promise<AcpStreamResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(agentBin, ["acp"], {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stderr = "";
    let resolved = false;

    const finish = (code: number) => {
      if (resolved) return;
      resolved = true;
      try {
        child.stdin?.end();
        child.kill();
      } catch {
        /* ignore */
      }
      resolve({ code, stderr: stderr.trim() });
    };

    const timeout =
      opts.timeoutMs > 0
        ? setTimeout(() => finish(124), opts.timeoutMs)
        : undefined;

    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => (stderr += chunk));

    const nextId = { current: 1 };
    const pending = new Map<
      number,
      { resolve: (value: unknown) => void; reject: (err: Error) => void }
    >();

    const rl = readline.createInterface({ input: child.stdout! });
    rl.on("line", (line: string) => {
      try {
        const msg = JSON.parse(line) as {
          id?: number;
          method?: string;
          params?: { update?: { sessionUpdate?: string; content?: { text?: string } } };
          result?: unknown;
          error?: { message?: string };
        };

        if (msg.id != null && (msg.result !== undefined || msg.error !== undefined)) {
          const waiter = pending.get(msg.id);
          if (waiter) {
            pending.delete(msg.id);
            if (msg.error) {
              waiter.reject(new Error(msg.error.message ?? "ACP error"));
            } else {
              waiter.resolve(msg.result);
            }
          }
          return;
        }

        if (msg.method === "session/update") {
          const update = msg.params?.update;
          if (
            update?.sessionUpdate === "agent_message_chunk" &&
            typeof update.content?.text === "string"
          ) {
            onChunk(update.content.text);
          }
          return;
        }

        if (msg.method === "session/request_permission") {
          if (msg.id != null && child.stdin) {
            respond(child.stdin, msg.id, {
              outcome: { outcome: "selected", optionId: "allow-once" },
            });
          }
          return;
        }
      } catch {
        /* ignore */
      }
    });

    child.on("error", (err) => {
      if (timeout) clearTimeout(timeout);
      if (!resolved) {
        resolved = true;
        reject(err);
      }
    });

    child.on("close", (code) => {
      if (timeout) clearTimeout(timeout);
      finish(code ?? 1);
    });

    const run = async () => {
      if (!child.stdin) {
        finish(1);
        return;
      }
      try {
        await sendRequest(child.stdin, nextId, "initialize", {
          protocolVersion: 1,
          clientCapabilities: {
            fs: { readTextFile: false, writeTextFile: false },
            terminal: false,
          },
          clientInfo: { name: "cursor-api-proxy", version: "0.1.0" },
        }, pending);

        await sendRequest(child.stdin, nextId, "authenticate", {
          methodId: "cursor_login",
        }, pending);

        const sessionResult = (await sendRequest(
          child.stdin,
          nextId,
          "session/new",
          { cwd: opts.cwd, mcpServers: [] },
          pending,
        )) as { sessionId?: string };
        const sessionId = sessionResult?.sessionId;
        if (!sessionId) {
          finish(1);
          return;
        }

        await sendRequest(child.stdin, nextId, "session/prompt", {
          sessionId,
          prompt: [{ type: "text", text: prompt }],
        }, pending);
        finish(0);
      } catch {
        if (timeout) clearTimeout(timeout);
        if (!resolved) {
          resolved = true;
          finish(1);
        }
      }
    };

    run();
  });
}
