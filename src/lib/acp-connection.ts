/**
 * JSON-RPC connection to one `agent acp` child (Agent Client Protocol over
 * stdio). Both ACP paths run on it: plain one-shot turns (acp-client) and
 * client-tool turns (acp-tool-session).
 * See https://cursor.com/docs/cli/acp and https://agentclientprotocol.com/
 */

import type { ChildProcess } from "node:child_process";
import * as readline from "node:readline";
import { debuglog } from "node:util";

import {
  ACP_CLIENT_CAPABILITIES,
  acpFailureText,
  configureAcpSessionModel,
  formatAcpRpcError,
  type AcpModelOptions,
  type AcpModelPlan,
  type AcpSessionModelState,
} from "./acp-model.js";
import { spawnAcpChild, type AcpSpawnOptions } from "./acp-spawn.js";
import { AcpTrailerFilter } from "./acp-text-trailer.js";
import type { AcpPromptBlock } from "./media-input.js";
import { killProcessTree } from "./process-tree-kill.js";

const debugAcp = debuglog("cursor-api-proxy:acp");

export type AcpMcpServer =
  | {
      type: "http";
      name: string;
      url: string;
      headers?: Array<{ name: string; value: string }>;
    }
  | {
      type?: "stdio";
      name: string;
      command: string;
      args?: string[];
      env?: Array<{ name: string; value: string }>;
    };

export type AcpInitializeResult = {
  protocolVersion?: number;
  agentCapabilities?: {
    mcpCapabilities?: { http?: boolean; sse?: boolean };
    [key: string]: unknown;
  };
};

export type AcpSessionResult = { sessionId?: string } & AcpSessionModelState;

export type AcpPermissionParams = {
  sessionId?: string;
  toolCall?: Record<string, unknown>;
  options?: Array<{
    optionId?: string;
    name?: string;
    kind?: string;
  }>;
};

type JsonRpcMessage = {
  id?: number | string | null;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: {
    code?: number;
    message?: string;
    data?: { message?: string } | string;
  };
};

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
};

export type AcpConnectionOptions = AcpSpawnOptions & {
  requestTimeoutMs?: number;
  rawDebug?: boolean;
  /** When aborted, the connection closes and the child gets SIGTERM. */
  signal?: AbortSignal;
  /**
   * Agent message text without the CLI's end-of-turn error trailer
   * (acp-text-trailer.ts); text that could be that trailer comes late.
   */
  onAgentTextChunk?: (text: string) => void;
  onAgentThoughtChunk?: (text: string) => void;
  /** Every session/update as the CLI sent it, text chunks included. */
  onSessionUpdate?: (update: Record<string, unknown>) => void;
  onPermission?: (
    params: AcpPermissionParams,
  ) => string | undefined | Promise<string | undefined>;
  /**
   * Log the CLI's output tail when the child exits on its own (default
   * true). Callers that log AcpChildExitError.diagnostics themselves turn
   * it off.
   */
  logUnexpectedExit?: boolean;
};

export type AcpSessionOptions = AcpModelOptions & {
  cwd: string;
  mcpServers?: readonly AcpMcpServer[];
  /** Skip `authenticate` (pre-authenticated via --api-key or agent login). */
  skipAuthenticate?: boolean;
};

/**
 * The ACP child exited on its own (bad flag, auth failure, crash at startup)
 * while the proxy still needed it. The message is safe to show clients;
 * `diagnostics` (the CLI's stderr and stdout noise) is for server logs only.
 */
export class AcpChildExitError extends Error {
  constructor(
    readonly exitCode: number,
    readonly diagnostics: string,
  ) {
    super(
      `The Cursor agent process exited with code ${exitCode} before responding. See server logs for details.`,
    );
    this.name = "AcpChildExitError";
  }
}

const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
const MAX_STDOUT_NOISE = 4000;
const MAX_LOGGED_DIAGNOSTICS = 4000;

/** Updates the proxy consumes without needing their text, kept out of debug logs. */
const QUIET_SESSION_UPDATES = new Set([
  "agent_message_chunk",
  "agent_thought_chunk",
  "available_commands_update",
  "tool_call",
  "tool_call_update",
]);

/** Normalise CRLF / stray CR so JSON-RPC lines parse on Windows (avoids silent hangs). */
function parseLine(line: string): JsonRpcMessage | null {
  const trimmed = line.replace(/\r$/, "").trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed) as JsonRpcMessage;
  } catch {
    return null;
  }
}

/** The CLI prints startup failures (auth, keychain) as plain text on stdout, not JSON-RPC. */
function appendStdoutNoise(noise: string, line: string): string {
  const trimmed = line.replace(/\r$/, "").trim();
  if (!trimmed) return noise;
  const next = noise ? `${noise}\n${trimmed}` : trimmed;
  return next.length > MAX_STDOUT_NOISE ? next.slice(-MAX_STDOUT_NOISE) : next;
}

/** Add a proxy-side failure line to server-side diagnostics. */
export function appendAcpFailure(stderr: string, error: unknown): string {
  const message = acpFailureText(error);
  if (!message) return stderr;
  return stderr.trim() ? `${stderr.trim()}\n${message}` : message;
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

/** Server-side record of an unexpected exit, as logAgentError keeps for CLI runs. */
function logChildExit(exit: AcpChildExitError): void {
  const output =
    exit.diagnostics.length > MAX_LOGGED_DIAGNOSTICS
      ? `…${exit.diagnostics.slice(-MAX_LOGGED_DIAGNOSTICS)}`
      : exit.diagnostics || "(no output)";
  console.error(
    `[${new Date().toISOString()}] Agent error: Cursor ACP agent exited with code ${exit.exitCode}: ${output}`,
  );
}

/** Extract the text payload from an ACP session/update `content` field. */
export function extractAcpUpdateText(content: unknown): string {
  if (
    content &&
    typeof content === "object" &&
    !Array.isArray(content) &&
    typeof (content as { text?: unknown }).text === "string"
  ) {
    return (content as { text: string }).text;
  }
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (!part || typeof part !== "object") return "";
      const record = part as {
        text?: unknown;
        content?: { text?: unknown };
      };
      if (typeof record.content?.text === "string") {
        return record.content.text;
      }
      return typeof record.text === "string" ? record.text : "";
    })
    .join("");
}

/**
 * cursor/* methods the CLI sends as requests but documents as notifications:
 * it ignores the reply, so they need no answer beyond an empty result.
 */
const CURSOR_PROGRESS_REQUESTS = new Set([
  "cursor/update_todos",
  "cursor/task",
  "cursor/generate_image",
]);

/** The CLI hands this to the agent as the reason its questions went unanswered. */
const NO_USER_TO_ASK =
  "No interactive user is available to answer; proceed with your best judgement and state your assumptions.";

/** `id "prompt"` for each question, for the server log. */
function describeQuestions(questions: unknown): string {
  if (!Array.isArray(questions) || questions.length === 0) {
    return "(no questions)";
  }
  return questions
    .map((question) => {
      const { id, prompt } = (question ?? {}) as { id?: unknown; prompt?: unknown };
      const label = typeof id === "string" ? id : "(no id)";
      return typeof prompt === "string" ? `${label} ${JSON.stringify(prompt)}` : label;
    })
    .join(", ");
}

/**
 * Answer Cursor's own requests in the shapes documented at
 * cursor.com/docs/cli/acp, on both ACP paths. Nobody can answer a turn
 * interactively, so questions are skipped with a reason that tells the
 * agent to go on with its own judgement (choosing an option would invent
 * the user's decision), and a plan is accepted (the CLI then saves it to
 * ~/.cursor/plans itself).
 */
function answerCursorRequest(
  method: string,
  params: Record<string, unknown>,
): Record<string, unknown> {
  if (method === "cursor/ask_question") {
    console.warn(
      "[cursor-api-proxy:acp] cursor/ask_question skipped, no interactive user to answer: %s",
      describeQuestions(params.questions),
    );
    return { outcome: { outcome: "skipped", reason: NO_USER_TO_ASK } };
  }
  if (method === "cursor/create_plan") {
    debugAcp("cursor/create_plan: accepting the plan");
    return { outcome: { outcome: "accepted" } };
  }
  if (CURSOR_PROGRESS_REQUESTS.has(method)) {
    debugAcp("%s: acknowledged", method);
  } else {
    console.warn(
      "[cursor-api-proxy:acp] auto-responding to unknown %s with empty result",
      method,
    );
  }
  return {};
}

function selectedOption(
  params: AcpPermissionParams,
  preferredKind: string,
  fallbackId: string,
): string {
  return (
    params.options?.find((option) => option.kind === preferredKind)?.optionId ??
    params.options?.find((option) => option.optionId === fallbackId)?.optionId ??
    fallbackId
  );
}

export class AcpConnection {
  readonly child: ChildProcess;
  readonly #opts: AcpConnectionOptions;
  readonly #pending = new Map<number, PendingRequest>();
  readonly #lineReader: readline.Interface;
  readonly #exitPromise: Promise<number>;
  #resolveExit!: (code: number) => void;
  #nextId = 1;
  #stderr = "";
  #stdoutNoise = "";
  #closed = false;
  /** Why the connection stopped on its own; later requests reject with it. */
  #failure?: Error;
  #abortHandler?: () => void;
  readonly #agentText = new AcpTrailerFilter((text) => {
    try {
      this.#opts.onAgentTextChunk?.(text);
    } catch (error) {
      debugAcp("ACP text listener failed: %s", acpFailureText(error));
    }
  });

  constructor(
    command: string,
    args: readonly string[],
    opts: AcpConnectionOptions,
  ) {
    this.#opts = opts;
    this.child = spawnAcpChild(command, args, opts);

    this.#exitPromise = new Promise<number>((resolve) => {
      this.#resolveExit = resolve;
    });

    this.child.stderr?.setEncoding("utf8");
    this.child.stderr?.on("data", (chunk: string) => {
      this.#stderr += chunk;
    });

    this.#lineReader = readline.createInterface({
      input: this.child.stdout!,
    });
    this.#lineReader.on("line", (line) => this.#handleLine(line));

    this.child.once("error", (error) => {
      this.#failure ??= error;
      this.#failPending(error);
    });
    // A CLI that exits while a request is being written emits EPIPE on
    // stdin, not on the ChildProcess. Without this listener Node terminates
    // the entire proxy instead of failing just the affected request.
    this.child.stdin?.on("error", (error) => {
      this.#failure ??= error;
      this.#failPending(error);
      void this.close();
    });
    this.child.once("close", (code) => this.#handleExit(code ?? 1));

    this.#abortHandler = () => {
      void this.close("SIGTERM");
    };
    if (opts.signal) {
      if (opts.signal.aborted) this.#abortHandler();
      else {
        opts.signal.addEventListener("abort", this.#abortHandler, {
          once: true,
        });
      }
    }
  }

  get stderr(): string {
    return this.#stderr.trim();
  }

  async initialize(): Promise<AcpInitializeResult> {
    debugAcp("ACP step: initialize");
    return (await this.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: ACP_CLIENT_CAPABILITIES,
      clientInfo: { name: "cursor-api-proxy", version: "1.0.0" },
    })) as AcpInitializeResult;
  }

  async authenticate(): Promise<void> {
    debugAcp("ACP step: authenticate");
    await this.request("authenticate", { methodId: "cursor_login" });
  }

  async newSession(
    cwd: string,
    mcpServers: readonly AcpMcpServer[],
  ): Promise<AcpSessionResult> {
    debugAcp("ACP step: session/new");
    return (await this.request("session/new", {
      cwd,
      mcpServers,
    })) as AcpSessionResult;
  }

  /** Pick the session model through the decision the plain path shares. */
  configureSessionModel(
    sessionId: string,
    request: AcpModelOptions,
    session: AcpSessionModelState,
  ): Promise<AcpModelPlan> {
    return configureAcpSessionModel(request, session, (configId, value) =>
      this.request("session/set_config_option", { sessionId, configId, value }),
    );
  }

  /**
   * initialize → authenticate → session/new → model selection, the setup
   * every turn needs before its prompt. Returns the new session id.
   */
  async openSession(opts: AcpSessionOptions): Promise<string> {
    const mcpServers = opts.mcpServers ?? [];
    const initialized = await this.initialize();
    if (
      mcpServers.some((server) => server.type === "http") &&
      initialized?.agentCapabilities?.mcpCapabilities?.http !== true
    ) {
      throw new Error(
        "Installed Cursor ACP agent does not support HTTP MCP servers",
      );
    }
    if (opts.skipAuthenticate) {
      debugAcp("ACP step: authenticate (skipped, pre-authenticated)");
    } else {
      await this.authenticate();
    }
    const session = await this.newSession(opts.cwd, mcpServers);
    const sessionId = session?.sessionId;
    if (!sessionId) throw new Error("ACP session/new returned no sessionId");
    await this.configureSessionModel(sessionId, opts, session);
    return sessionId;
  }

  prompt(
    sessionId: string,
    prompt: string,
    timeoutMs?: number,
    mediaBlocks?: AcpPromptBlock[],
  ): Promise<unknown> {
    debugAcp("ACP step: session/prompt");
    return this.request(
      "session/prompt",
      {
        sessionId,
        prompt: [{ type: "text", text: prompt }, ...(mediaBlocks ?? [])],
      },
      timeoutMs,
    ).finally(() => this.#agentText.end());
  }

  request(
    method: string,
    params: Record<string, unknown>,
    timeoutMs = this.#opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
  ): Promise<unknown> {
    const stdin = this.child.stdin;
    if (!stdin || this.#closed) {
      return Promise.reject(
        this.#failure ?? new Error("ACP connection is closed"),
      );
    }
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      const pending: PendingRequest = { resolve, reject };
      if (timeoutMs > 0) {
        pending.timer = setTimeout(() => {
          if (!this.#pending.delete(id)) return;
          reject(new Error(`ACP ${method} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }
      this.#pending.set(id, pending);
      stdin.write(
        `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`,
        "utf8",
        (error) => {
          if (!error) return;
          const waiter = this.#pending.get(id);
          if (!waiter) return;
          this.#pending.delete(id);
          if (waiter.timer) clearTimeout(waiter.timer);
          waiter.reject(error);
        },
      );
    });
  }

  async cancelSession(sessionId: string): Promise<void> {
    this.#notify("session/cancel", { sessionId });
  }

  /**
   * Signal the child's process tree but keep the connection open: its exit
   * is reported like any other, so pending requests reject with
   * AcpChildExitError.
   */
  kill(signal: NodeJS.Signals): void {
    if (this.#closed) return;
    killProcessTree(this.child, signal);
  }

  async close(signal: NodeJS.Signals = "SIGKILL"): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#detachAbort();
    this.#agentText.end();
    this.#failPending(new Error("ACP connection closed"));
    try {
      this.child.stdin?.end();
    } catch {
      // best effort
    }
    killProcessTree(this.child, signal);
    await Promise.race([
      this.#exitPromise,
      new Promise<void>((resolve) => setTimeout(resolve, 1_000)),
    ]);
  }

  #handleExit(code: number): void {
    const unexpected = !this.#closed;
    this.#closed = true;
    this.#lineReader.close();
    this.#detachAbort();
    this.#agentText.end();
    if (unexpected) {
      // The CLI's helpers can outlive it inside its process group.
      killProcessTree(this.child, "SIGKILL");
      // A spawn error, if any, stays the reported failure.
      if (!this.#failure) {
        const exit = new AcpChildExitError(
          code,
          describeAcpExit(
            this.stderr,
            this.#stdoutNoise,
            code,
            this.#pending.size > 0,
          ),
        );
        if (this.#opts.logUnexpectedExit !== false) logChildExit(exit);
        this.#failure = exit;
      }
      this.#failPending(this.#failure);
    }
    this.#resolveExit(code);
  }

  #handleLine(line: string): void {
    if (this.#opts.rawDebug) debugAcp("ACP raw: %s", line);
    const message = parseLine(line);
    if (!message) {
      this.#stdoutNoise = appendStdoutNoise(this.#stdoutNoise, line);
      return;
    }
    try {
      this.#dispatch(message);
    } catch (error) {
      // An exception thrown from a readline listener would crash the proxy.
      debugAcp("ACP message handler failed: %s", acpFailureText(error));
    }
  }

  #dispatch(message: JsonRpcMessage): void {
    if (
      message.id != null &&
      (message.result !== undefined || message.error !== undefined) &&
      message.method === undefined
    ) {
      const id =
        typeof message.id === "number" ? message.id : Number(message.id);
      const waiter = Number.isFinite(id) ? this.#pending.get(id) : undefined;
      if (!waiter) return;
      this.#pending.delete(id);
      if (waiter.timer) clearTimeout(waiter.timer);
      if (message.error) {
        waiter.reject(new Error(formatAcpRpcError(message.error)));
      } else {
        waiter.resolve(message.result);
      }
      return;
    }

    if (message.method === "session/update") {
      this.#handleSessionUpdate(message);
      return;
    }

    if (message.method === "session/request_permission" && message.id != null) {
      void this.#handlePermission(message);
      return;
    }

    if (message.id != null && message.method?.startsWith("cursor/")) {
      this.#respond(
        message.id,
        answerCursorRequest(message.method, message.params ?? {}),
      );
    }
  }

  /** The one place agent text and thought chunks enter the proxy. */
  #handleSessionUpdate(message: JsonRpcMessage): void {
    const update = (message.params?.update ?? message.params) as
      | Record<string, unknown>
      | undefined;
    if (!update) return;
    const type = update.sessionUpdate;
    // Text followed by a tool call is not the end of the turn.
    if (type === "tool_call") this.#agentText.flush();
    this.#opts.onSessionUpdate?.(update);
    const text = extractAcpUpdateText(update.content);
    if (type === "agent_message_chunk" && text) {
      this.#agentText.push(text);
    } else if (type === "agent_thought_chunk" && text) {
      this.#opts.onAgentThoughtChunk?.(text);
    } else if (typeof type === "string" && !QUIET_SESSION_UPDATES.has(type)) {
      const content = update.content;
      debugAcp(
        "session/update (unhandled): %s",
        JSON.stringify({
          sessionUpdate: type,
          hasContent: !!content,
          contentKeys:
            content && typeof content === "object" && !Array.isArray(content)
              ? Object.keys(content)
              : [],
        }),
      );
    }
  }

  async #handlePermission(message: JsonRpcMessage): Promise<void> {
    const params = (message.params ?? {}) as AcpPermissionParams;
    let optionId: string | undefined;
    try {
      optionId = await this.#opts.onPermission?.(params);
    } catch {
      optionId = undefined;
    }
    optionId ??= selectedOption(params, "reject_once", "reject-once");
    this.#respond(message.id!, {
      outcome: { outcome: "selected", optionId },
    });
  }

  #notify(method: string, params: Record<string, unknown>): void {
    const stdin = this.child.stdin;
    if (!stdin || this.#closed) return;
    stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  }

  #respond(id: number | string, result: Record<string, unknown>): void {
    const stdin = this.child.stdin;
    if (!stdin || this.#closed) return;
    stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
  }

  #detachAbort(): void {
    if (this.#abortHandler) {
      this.#opts.signal?.removeEventListener("abort", this.#abortHandler);
    }
  }

  #failPending(error: Error): void {
    for (const [id, waiter] of this.#pending) {
      this.#pending.delete(id);
      if (waiter.timer) clearTimeout(waiter.timer);
      waiter.reject(error);
    }
  }
}

export function permissionOption(
  params: AcpPermissionParams,
  kind: "allow_once" | "reject_once",
): string {
  return selectedOption(
    params,
    kind,
    kind === "allow_once" ? "allow-once" : "reject-once",
  );
}
