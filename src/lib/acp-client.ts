/**
 * ACP (Agent Client Protocol) client for Cursor CLI.
 * Spawns `agent acp` and communicates via JSON-RPC over stdio.
 * See https://cursor.com/docs/cli/acp and https://agentclientprotocol.com/
 */

import * as readline from "node:readline";
import { spawn } from "node:child_process";
import { debuglog } from "node:util";

import {
  ACP_CLIENT_CAPABILITIES,
  acpFailureText,
  acpModelSelectionError,
  applyAcpModelPlan,
  formatAcpRpcError,
  planAcpModelSelection,
  type AcpCatalogModel,
  type AcpModelOptions,
} from "./acp-model.js";
import { trackChildProcess } from "./process.js";
import { DETACH_CHILDREN, killProcessTree } from "./process-tree-kill.js";
import type { AcpPromptBlock } from "./media-input.js";

const debugAcp = debuglog("cursor-api-proxy:acp");

export type AcpRunOptions = AcpModelOptions & {
  /** Optional validated media blocks appended to the text prompt. */
  mediaBlocks?: AcpPromptBlock[];
  cwd: string;
  timeoutMs: number;
  env?: Record<string, string | undefined>;
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
  /** Assistant message text only (never includes agent_thought_chunk). */
  stdout: string;
  stderr: string;
  /**
   * Concatenated agent_thought_chunk text for this turn.
   * Present when any thought arrived; callers decide drop vs reasoning_content.
   */
  reasoning?: string;
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
  error?: { message?: string; data?: { message?: string } | string };
};

/** Normalise CRLF / stray CR so JSON-RPC lines parse on Windows (avoids silent hangs). */
function parseAcpStdoutLine(line: string): AcpParsedMsg | null {
  const t = line.replace(/\r$/, "").trim();
  if (!t) return null;
  try {
    return JSON.parse(t) as AcpParsedMsg;
  } catch {
    return null;
  }
}

/** Extract text payload from an ACP session/update content field. */
export function extractAcpUpdateText(
  content:
    | { text?: string }
    | Array<{ content?: { text?: string }; text?: string }>
    | undefined
    | null,
): string {
  if (
    typeof content === "object" &&
    content !== null &&
    !Array.isArray(content) &&
    typeof (content as { text?: string }).text === "string"
  ) {
    return (content as { text: string }).text;
  }
  if (Array.isArray(content)) {
    return content
      .map((c: { content?: { text?: string }; text?: string }) =>
        typeof c?.content?.text === "string"
          ? c.content.text
          : typeof c?.text === "string"
            ? c.text
            : "",
      )
      .join("");
  }
  return "";
}

/**
 * Handle ACP server→client notifications (session/update chunks, permissions, cursor/*).
 * Returns true if the message was consumed as a notification.
 *
 * Thought and message are separate channels: callers must not mix them into content.
 */
function handleAcpNotification(
  msg: AcpParsedMsg,
  opts: {
    stdin: NodeJS.WritableStream | null | undefined;
    onAgentTextChunk?: (text: string) => void;
    onAgentThoughtChunk?: (text: string) => void;
  },
): boolean {
  if (msg.method === "session/update") {
    const update = (msg.params?.update ?? msg.params) as {
      sessionUpdate?: string;
      content?: { text?: string } | Array<{ content?: { text?: string }; text?: string }>;
    } | undefined;
    const content = update?.content;
    const text = extractAcpUpdateText(content);
    const sessionUpdate = update?.sessionUpdate;
    if (sessionUpdate === "agent_message_chunk" && text) {
      opts.onAgentTextChunk?.(text);
    } else if (sessionUpdate === "agent_thought_chunk" && text) {
      opts.onAgentThoughtChunk?.(text);
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

function appendAcpFailure(stderr: string, error: unknown): string {
  const message = acpFailureText(error);
  if (!message) return stderr;
  return stderr.trim() ? `${stderr.trim()}\n${message}` : message;
}

const MAX_STDOUT_NOISE = 4000;

/** The CLI prints startup failures (auth, keychain) as plain text on stdout, not JSON-RPC. */
function appendStdoutNoise(noise: string, line: string): string {
  const t = line.replace(/\r$/, "").trim();
  if (!t) return noise;
  const next = noise ? `${noise}\n${t}` : t;
  return next.length > MAX_STDOUT_NOISE ? next.slice(-MAX_STDOUT_NOISE) : next;
}

function describeAcpExit(
  stderr: string,
  stdoutNoise: string,
  code: number,
  awaitingResponse: boolean,
): string {
  let out = stderr;
  if (stdoutNoise && !out.includes(stdoutNoise)) {
    out = appendAcpFailure(out, stdoutNoise);
  }
  if (awaitingResponse) {
    out = appendAcpFailure(out, `ACP child exited with code ${code} before responding`);
  }
  return out;
}

async function configureAcpModel(
  stdin: NodeJS.WritableStream,
  nextId: { current: number },
  pending: Map<
    number,
    {
      resolve: (value: unknown) => void;
      reject: (err: Error) => void;
      timerId?: ReturnType<typeof setTimeout>;
    }
  >,
  requestTimeoutMs: number,
  sessionId: string,
  requested: string | undefined,
  availableModels: AcpCatalogModel[] | undefined,
  aliases: readonly string[] | undefined,
  strictModel: boolean | undefined,
): Promise<void> {
  if (!requested) return;
  const plan = planAcpModelSelection(requested, availableModels, aliases);
  if (plan.action === "missing") {
    debugAcp(
      "ACP model: no catalog match for display name %j",
      requested,
    );
    if (strictModel && requested !== "default") {
      throw new Error(acpModelSelectionError(requested, plan.candidates));
    }
    return;
  }
  if (plan.action === "skip") {
    debugAcp(
      "ACP step: session/set_config_option (model) — skipped, using session default",
    );
    return;
  }
  // Pass the public CLI id so option-level errors can name both the request
  // and the matched ACP base row.
  await applyAcpModelPlan(plan, (configId, value) => {
    debugAcp("ACP step: session/set_config_option (%s)", configId);
    return sendRequest(
      stdin,
      nextId,
      "session/set_config_option",
      { sessionId, configId, value },
      pending,
      requestTimeoutMs,
    );
  }, requested);
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
      detached: DETACH_CHILDREN,
    });

    trackChildProcess(child);

    let stderr = "";
    let stdoutNoise = "";
    let accumulated = "";
    let accumulatedThought = "";
    let resolved = false;

    const onAbort = () => {
      killProcessTree(child, "SIGTERM");
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
      } catch {
        /* ignore */
      }
      killProcessTree(child, "SIGKILL");
      const reasoning = accumulatedThought.trim();
      resolve({
        code,
        stdout: accumulated.trim(),
        stderr: stderr.trim(),
        ...(reasoning ? { reasoning } : {}),
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
        const msg = parseAcpStdoutLine(line);
        if (!msg) {
          stdoutNoise = appendStdoutNoise(stdoutNoise, line);
          return;
        }

        if (msg.id != null && (msg.result !== undefined || msg.error !== undefined)) {
          const reqId = typeof msg.id === "number" ? msg.id : Number(msg.id);
          const waiter = Number.isFinite(reqId) ? pending.get(reqId) : undefined;
          if (waiter) {
            pending.delete(reqId);
            if (msg.error) {
              waiter.reject(new Error(formatAcpRpcError(msg.error)));
            } else {
              waiter.resolve(msg.result);
            }
          }
          return;
        }

        handleAcpNotification(msg, {
          stdin: child.stdin,
          onAgentTextChunk: (text) => {
            accumulated += text;
          },
          onAgentThoughtChunk: (text) => {
            accumulatedThought += text;
          },
        });
      } catch {
        /* ignore notification handler errors */
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
      const exitCode = code ?? 1;
      if (!resolved && exitCode !== 0) {
        stderr = describeAcpExit(stderr, stdoutNoise, exitCode, pending.size > 0);
      }
      finish(exitCode);
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
          clientCapabilities: ACP_CLIENT_CAPABILITIES,
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
        )) as {
          sessionId?: string;
          models?: { availableModels?: AcpCatalogModel[] };
        };
        const sessionId = sessionResult?.sessionId;
        if (!sessionId) {
          stderr = appendAcpFailure(stderr, "ACP session/new returned no sessionId");
          finish(1);
          return;
        }

        await configureAcpModel(
          child.stdin,
          nextId,
          pending,
          requestTimeoutMs,
          sessionId,
          opts.model,
          sessionResult.models?.availableModels,
          opts.modelAliases,
          opts.strictModel,
        );

        debugAcp("ACP step: session/prompt");
        await sendRequest(child.stdin, nextId, "session/prompt", {
          sessionId,
          prompt: [{ type: "text", text: prompt }, ...(opts.mediaBlocks ?? [])],
        }, pending, requestTimeoutMs);
        if (accumulated.length === 0) {
          debugAcp("ACP sync: no content accumulated; stderr tail: %s", stderr.slice(-500));
        }
        finish(0);
      } catch (err) {
        stderr = appendAcpFailure(stderr, err);
        if (timeout) clearTimeout(timeout);
        if (!resolved) {
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
      detached: DETACH_CHILDREN,
    });

    trackChildProcess(child);

    let stderr = "";
    let stdoutNoise = "";
    let resolved = false;

    const onAbort = () => {
      killProcessTree(child, "SIGTERM");
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
      } catch {
        /* ignore */
      }
      killProcessTree(child, "SIGKILL");
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
        const msg = parseAcpStdoutLine(line);
        if (!msg) {
          stdoutNoise = appendStdoutNoise(stdoutNoise, line);
          return;
        }

        if (msg.id != null && (msg.result !== undefined || msg.error !== undefined)) {
          const reqId = typeof msg.id === "number" ? msg.id : Number(msg.id);
          const waiter = Number.isFinite(reqId) ? pending.get(reqId) : undefined;
          if (waiter) {
            pending.delete(reqId);
            if (msg.error) {
              waiter.reject(new Error(formatAcpRpcError(msg.error)));
            } else {
              waiter.resolve(msg.result);
            }
          }
          return;
        }

        handleAcpNotification(msg, {
          stdin: child.stdin,
          onAgentTextChunk: onChunk,
        });
      } catch {
        /* ignore notification handler errors */
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
      const exitCode = code ?? 1;
      if (!resolved && exitCode !== 0) {
        stderr = describeAcpExit(stderr, stdoutNoise, exitCode, pending.size > 0);
      }
      finish(exitCode);
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
          clientCapabilities: ACP_CLIENT_CAPABILITIES,
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
        )) as {
          sessionId?: string;
          models?: { availableModels?: AcpCatalogModel[] };
        };
        const sessionId = sessionResult?.sessionId;
        if (!sessionId) {
          stderr = appendAcpFailure(stderr, "ACP session/new returned no sessionId");
          finish(1);
          return;
        }

        await configureAcpModel(
          child.stdin,
          nextId,
          pending,
          requestTimeoutMs,
          sessionId,
          opts.model,
          sessionResult.models?.availableModels,
          opts.modelAliases,
          opts.strictModel,
        );

        debugAcp("ACP step: session/prompt");
        await sendRequest(child.stdin, nextId, "session/prompt", {
          sessionId,
          prompt: [{ type: "text", text: prompt }, ...(opts.mediaBlocks ?? [])],
        }, pending, requestTimeoutMs);
        finish(0);
      } catch (err) {
        stderr = appendAcpFailure(stderr, err);
        if (timeout) clearTimeout(timeout);
        if (!resolved) {
          finish(1);
        }
      }
    };

    run();
  });
}
