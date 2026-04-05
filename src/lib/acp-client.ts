/**
 * ACP (Agent Client Protocol) client for Cursor CLI.
 * Spawns `agent acp` and communicates via JSON-RPC over stdio.
 * See https://cursor.com/docs/cli/acp and https://agentclientprotocol.com/
 */

import * as readline from "node:readline";
import { spawn } from "node:child_process";
import { debuglog } from "node:util";

import { trackChildProcess } from "./process.js";

const debugAcp = debuglog("cursor-api-proxy:acp");

export type AcpRunOptions = {
  cwd: string;
  timeoutMs: number;
  env?: Record<string, string | undefined>;
  /** When set, call session/set_config_option for "model" after session/new (ACP session config). */
  model?: string;
  /** Per-request timeout in ms (default 60000). Rejects and clears pending on timeout. */
  requestTimeoutMs?: number;
  /** Spawn options (e.g. windowsVerbatimArguments for cmd.exe fallback on Windows). */
  spawnOptions?: { windowsVerbatimArguments?: boolean };
  /** When true, skip authenticate step (use when pre-authenticated via --api-key or agent login). */
  skipAuthenticate?: boolean;
  /** When true, log every raw JSON-RPC line from ACP stdout (very verbose). */
  rawDebug?: boolean;
  /** When aborted, the ACP child is killed (same as CLI path). */
  signal?: AbortSignal;
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

const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;

/** Avoid passing the entire parent environment into ACP children (may contain unrelated secrets). */
function buildAcpSpawnEnv(
  extra?: Record<string, string | undefined>,
): NodeJS.ProcessEnv {
  const inheritKeys = [
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
  ];
  const out: NodeJS.ProcessEnv = {};
  for (const k of inheritKeys) {
    const v = process.env[k];
    if (v !== undefined) out[k] = v;
  }
  if (extra) {
    for (const [k, v] of Object.entries(extra)) {
      if (v !== undefined) out[k] = v;
    }
  }
  return out;
}

type AcpParsedMsg = {
  id?: number;
  method?: string;
  params?: { update?: { sessionUpdate?: string; content?: { text?: string } } };
  result?: unknown;
  error?: { message?: string };
};

/**
 * Handle ACP server→client notifications (session/update chunks, permissions, cursor/*).
 * Returns true if the message was consumed as a notification.
 */
function handleAcpNotification(
  msg: AcpParsedMsg,
  opts: {
    rawDebug?: boolean;
    stdin: NodeJS.WritableStream | null | undefined;
    onAgentTextChunk?: (text: string) => void;
  },
): boolean {
  if (msg.method === "session/update") {
    const update = (msg.params?.update ?? msg.params) as {
      sessionUpdate?: string;
      content?: { text?: string } | Array<{ content?: { text?: string }; text?: string }>;
    } | undefined;
    const content = update?.content;
    const text =
      typeof content === "object" && content !== null && !Array.isArray(content) && typeof (content as { text?: string }).text === "string"
        ? (content as { text: string }).text
        : Array.isArray(content)
          ? content
              .map((c: { content?: { text?: string }; text?: string }) =>
                typeof c?.content?.text === "string"
                  ? c.content.text
                  : typeof c?.text === "string"
                    ? c.text
                    : "",
              )
              .join("")
          : "";
    const sessionUpdate = update?.sessionUpdate;
    if (
      (sessionUpdate === "agent_message_chunk" || sessionUpdate === "agent_thought_chunk") &&
      text
    ) {
      opts.onAgentTextChunk?.(text);
    } else if (
      sessionUpdate &&
      sessionUpdate !== "agent_thought_chunk" &&
      sessionUpdate !== "available_commands_update" &&
      sessionUpdate !== "tool_call" &&
      sessionUpdate !== "tool_call_update"
    ) {
      debugAcp(
        "session/update (unhandled): %s",
        JSON.stringify({
          sessionUpdate,
          hasContent: !!content,
          contentKeys: content && typeof content === "object" && !Array.isArray(content) ? Object.keys(content) : [],
        }),
      );
    }
    return true;
  }

  if (msg.method === "session/request_permission") {
    if (msg.id != null && opts.stdin) {
      respond(opts.stdin, msg.id, {
        outcome: { outcome: "selected", optionId: "reject-once" },
      });
    }
    return true;
  }

  if (msg.id != null && msg.method && opts.stdin) {
    const method = String(msg.method);
    if (method.startsWith("cursor/")) {
      const params = msg.params as Record<string, unknown> | undefined;
      if (method === "cursor/ask_question" && params?.options && Array.isArray(params.options)) {
        const options = params.options as Array<{ id?: string; label?: string }>;
        const first = options[0];
        console.warn(
          "[cursor-api-proxy:acp] cursor/ask_question auto-selecting first option: id=%s (total=%d)",
          first?.id ?? "(none)",
          options.length,
        );
        respond(opts.stdin, msg.id, { selectedId: first?.id ?? "" });
      } else if (method === "cursor/create_plan") {
        respond(opts.stdin, msg.id, { approved: true });
      } else {
        console.warn(
          "[cursor-api-proxy:acp] auto-responding to unknown %s with empty result",
          method,
        );
        respond(opts.stdin, msg.id, {});
      }
      return true;
    }
  }

  return false;
}

function sendRequest(
  stdin: NodeJS.WritableStream,
  nextId: { current: number },
  method: string,
  params: object,
  pending: Map<
    number,
    { resolve: (value: unknown) => void; reject: (err: Error) => void; timerId?: ReturnType<typeof setTimeout> }
  >,
  requestTimeoutMs: number = DEFAULT_REQUEST_TIMEOUT_MS,
): Promise<unknown> {
  const id = nextId.current++;
  const line =
    JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
  stdin.write(line, "utf8");
  return new Promise((resolve, reject) => {
    let timerId: ReturnType<typeof setTimeout> | undefined;
    if (requestTimeoutMs > 0) {
      timerId = setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          reject(new Error(`ACP ${method} timed out after ${requestTimeoutMs}ms`));
        }
      }, requestTimeoutMs);
    }
    pending.set(id, {
      resolve: (v) => {
        if (timerId) clearTimeout(timerId);
        resolve(v);
      },
      reject: (e) => {
        if (timerId) clearTimeout(timerId);
        reject(e);
      },
      timerId,
    });
  });
}

function respond(stdin: NodeJS.WritableStream, id: number, result: object): void {
  const line = JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n";
  stdin.write(line, "utf8");
}

/**
 * Run a single prompt via ACP and return the full response (sync).
 * Uses pre-resolved command + args (e.g. node + script on Windows) to avoid spawn EINVAL and DEP0190.
 */
export function runAcpSync(
  command: string,
  args: string[],
  prompt: string,
  opts: AcpRunOptions,
): Promise<AcpSyncResult> {
  const requestTimeoutMs = opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: opts.cwd,
      env: buildAcpSpawnEnv(opts.env),
      stdio: ["pipe", "pipe", "pipe"],
      windowsVerbatimArguments: opts.spawnOptions?.windowsVerbatimArguments,
    });

    trackChildProcess(child);

    let stderr = "";
    let accumulated = "";
    let resolved = false;

    const onAbort = () => {
      try {
        child.kill("SIGTERM");
      } catch {
        /* ignore */
      }
    };
    if (opts.signal) {
      if (opts.signal.aborted) onAbort();
      else opts.signal.addEventListener("abort", onAbort, { once: true });
    }

    const finish = (code: number) => {
      if (resolved) return;
      resolved = true;
      opts.signal?.removeEventListener("abort", onAbort);
      const exitErr = new Error(`ACP child exited with code ${code}`);
      for (const [id, waiter] of Array.from(pending.entries())) {
        pending.delete(id);
        if (waiter.timerId) clearTimeout(waiter.timerId);
        waiter.reject(exitErr);
      }
      try {
        child.stdin?.end();
        child.kill("SIGKILL");
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
      { resolve: (value: unknown) => void; reject: (err: Error) => void; timerId?: ReturnType<typeof setTimeout> }
    >();

    const rl = readline.createInterface({ input: child.stdout! });
    rl.on("line", (line: string) => {
      try {
        if (opts.rawDebug) {
          debugAcp("ACP raw: %s", line);
        }
        const msg = JSON.parse(line) as AcpParsedMsg;

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

        handleAcpNotification(msg, {
          rawDebug: opts.rawDebug,
          stdin: child.stdin,
          onAgentTextChunk: (text) => {
            accumulated += text;
          },
        });
      } catch {
        /* ignore parse errors */
      }
    });

    child.on("error", (err) => {
      if (timeout) clearTimeout(timeout);
      opts.signal?.removeEventListener("abort", onAbort);
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
        debugAcp("ACP step: initialize");
        await sendRequest(child.stdin, nextId, "initialize", {
          protocolVersion: 1,
          clientCapabilities: {
            fs: { readTextFile: false, writeTextFile: false },
            terminal: false,
          },
          clientInfo: { name: "cursor-api-proxy", version: "0.1.0" },
        }, pending, requestTimeoutMs);

        if (!opts.skipAuthenticate) {
          debugAcp("ACP step: authenticate");
          await sendRequest(child.stdin, nextId, "authenticate", {
            methodId: "cursor_login",
          }, pending, requestTimeoutMs);
        } else {
          debugAcp("ACP step: authenticate (skipped, pre-authenticated)");
        }

        debugAcp("ACP step: session/new");
        const sessionResult = (await sendRequest(
          child.stdin,
          nextId,
          "session/new",
          { cwd: opts.cwd, mcpServers: [] },
          pending,
          requestTimeoutMs,
        )) as { sessionId?: string };
        const sessionId = sessionResult?.sessionId;
        if (!sessionId) {
          finish(1);
          return;
        }

        if (opts.model) {
          debugAcp("ACP step: session/set_config_option (model)");
          await sendRequest(
            child.stdin,
            nextId,
            "session/set_config_option",
            { sessionId, option: "model", value: opts.model },
            pending,
            requestTimeoutMs,
          );
        }

        debugAcp("ACP step: session/prompt");
        await sendRequest(child.stdin, nextId, "session/prompt", {
          sessionId,
          prompt: [{ type: "text", text: prompt }],
        }, pending, requestTimeoutMs);
        if (accumulated.length === 0) {
          debugAcp("ACP sync: no content accumulated; stderr tail: %s", stderr.slice(-500));
        }
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
  command: string,
  args: string[],
  prompt: string,
  opts: AcpRunOptions,
  onChunk: (text: string) => void,
): Promise<AcpStreamResult> {
  const requestTimeoutMs = opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: opts.cwd,
      env: buildAcpSpawnEnv(opts.env),
      stdio: ["pipe", "pipe", "pipe"],
      windowsVerbatimArguments: opts.spawnOptions?.windowsVerbatimArguments,
    });

    trackChildProcess(child);

    let stderr = "";
    let resolved = false;

    const onAbort = () => {
      try {
        child.kill("SIGTERM");
      } catch {
        /* ignore */
      }
    };
    if (opts.signal) {
      if (opts.signal.aborted) onAbort();
      else opts.signal.addEventListener("abort", onAbort, { once: true });
    }

    const finish = (code: number) => {
      if (resolved) return;
      resolved = true;
      opts.signal?.removeEventListener("abort", onAbort);
      const exitErr = new Error(`ACP child exited with code ${code}`);
      for (const [id, waiter] of Array.from(pending.entries())) {
        pending.delete(id);
        if (waiter.timerId) clearTimeout(waiter.timerId);
        waiter.reject(exitErr);
      }
      try {
        child.stdin?.end();
        child.kill("SIGKILL");
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
      { resolve: (value: unknown) => void; reject: (err: Error) => void; timerId?: ReturnType<typeof setTimeout> }
    >();

    const rl = readline.createInterface({ input: child.stdout! });
    rl.on("line", (line: string) => {
      try {
        if (opts.rawDebug) {
          debugAcp("ACP raw: %s", line);
        }
        const msg = JSON.parse(line) as AcpParsedMsg;

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

        handleAcpNotification(msg, {
          rawDebug: opts.rawDebug,
          stdin: child.stdin,
          onAgentTextChunk: onChunk,
        });
      } catch {
        /* ignore */
      }
    });

    child.on("error", (err) => {
      if (timeout) clearTimeout(timeout);
      opts.signal?.removeEventListener("abort", onAbort);
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
        debugAcp("ACP step: initialize");
        await sendRequest(child.stdin, nextId, "initialize", {
          protocolVersion: 1,
          clientCapabilities: {
            fs: { readTextFile: false, writeTextFile: false },
            terminal: false,
          },
          clientInfo: { name: "cursor-api-proxy", version: "0.1.0" },
        }, pending, requestTimeoutMs);

        if (!opts.skipAuthenticate) {
          debugAcp("ACP step: authenticate");
          await sendRequest(child.stdin, nextId, "authenticate", {
            methodId: "cursor_login",
          }, pending, requestTimeoutMs);
        } else {
          debugAcp("ACP step: authenticate (skipped, pre-authenticated)");
        }

        debugAcp("ACP step: session/new");
        const sessionResult = (await sendRequest(
          child.stdin,
          nextId,
          "session/new",
          { cwd: opts.cwd, mcpServers: [] },
          pending,
          requestTimeoutMs,
        )) as { sessionId?: string };
        const sessionId = sessionResult?.sessionId;
        if (!sessionId) {
          finish(1);
          return;
        }

        if (opts.model) {
          debugAcp("ACP step: session/set_config_option (model)");
          await sendRequest(
            child.stdin,
            nextId,
            "session/set_config_option",
            { sessionId, option: "model", value: opts.model },
            pending,
            requestTimeoutMs,
          );
        }

        debugAcp("ACP step: session/prompt");
        await sendRequest(child.stdin, nextId, "session/prompt", {
          sessionId,
          prompt: [{ type: "text", text: prompt }],
        }, pending, requestTimeoutMs);
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
