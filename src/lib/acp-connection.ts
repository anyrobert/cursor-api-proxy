import { spawn, type ChildProcess } from "node:child_process";
import * as readline from "node:readline";
import { debuglog } from "node:util";

import { trackChildProcess } from "./process.js";
import { DETACH_CHILDREN, killProcessTree } from "./process-tree-kill.js";

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

export type AcpAvailableModel = { modelId: string; name: string };

export type AcpInitializeResult = {
  protocolVersion?: number;
  agentCapabilities?: {
    mcpCapabilities?: { http?: boolean; sse?: boolean };
    [key: string]: unknown;
  };
};

export type AcpSessionResult = {
  sessionId?: string;
  models?: { availableModels?: AcpAvailableModel[] };
};

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
  error?: { code?: number; message?: string };
};

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
};

export type AcpConnectionOptions = {
  cwd: string;
  env?: Record<string, string | undefined>;
  requestTimeoutMs?: number;
  spawnOptions?: { windowsVerbatimArguments?: boolean };
  rawDebug?: boolean;
  signal?: AbortSignal;
  onAgentTextChunk?: (text: string) => void;
  onAgentThoughtChunk?: (text: string) => void;
  onSessionUpdate?: (update: Record<string, unknown>) => void;
  onPermission?: (
    params: AcpPermissionParams,
  ) => string | undefined | Promise<string | undefined>;
};

const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;

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
  for (const key of inheritKeys) {
    const value = process.env[key];
    if (value !== undefined) out[key] = value;
  }
  for (const [key, value] of Object.entries(extra ?? {})) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

function parseLine(line: string): JsonRpcMessage | null {
  const trimmed = line.replace(/\r$/, "").trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed) as JsonRpcMessage;
  } catch {
    return null;
  }
}

export function extractAcpContentText(content: unknown): string {
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
  readonly #nextId = { current: 1 };
  readonly #lineReader: readline.Interface;
  readonly #exitPromise: Promise<number>;
  #resolveExit!: (code: number) => void;
  #stderr = "";
  #closed = false;
  #spawnError?: Error;
  #abortHandler?: () => void;

  constructor(
    command: string,
    args: readonly string[],
    opts: AcpConnectionOptions,
  ) {
    this.#opts = opts;
    this.child = spawn(command, [...args], {
      cwd: opts.cwd,
      env: buildAcpSpawnEnv(opts.env),
      stdio: ["pipe", "pipe", "pipe"],
      windowsVerbatimArguments: opts.spawnOptions?.windowsVerbatimArguments,
      detached: DETACH_CHILDREN,
    });
    trackChildProcess(this.child);

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
      this.#spawnError = error;
      this.#failPending(error);
    });
    this.child.once("close", (code) => {
      this.#closed = true;
      this.#lineReader.close();
      this.#opts.signal?.removeEventListener("abort", this.#abortHandler!);
      this.#failPending(
        this.#spawnError ??
          new Error(`ACP child exited with code ${code ?? 1}`),
      );
      this.#resolveExit(code ?? 1);
    });

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

  get closed(): boolean {
    return this.#closed;
  }

  async initialize(): Promise<AcpInitializeResult> {
    debugAcp("ACP step: initialize");
    return (await this.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      },
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

  async setSessionModel(sessionId: string, value: string): Promise<void> {
    debugAcp("ACP step: session/set_config_option (model)");
    await this.request("session/set_config_option", {
      sessionId,
      configId: "model",
      value,
    });
  }

  prompt(
    sessionId: string,
    prompt: string,
    timeoutMs?: number,
  ): Promise<unknown> {
    debugAcp("ACP step: session/prompt");
    return this.request(
      "session/prompt",
      {
        sessionId,
        prompt: [{ type: "text", text: prompt }],
      },
      timeoutMs,
    );
  }

  notify(method: string, params: Record<string, unknown>): void {
    const stdin = this.child.stdin;
    if (!stdin || this.#closed) return;
    stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  }

  request(
    method: string,
    params: Record<string, unknown>,
    timeoutMs = this.#opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
  ): Promise<unknown> {
    const stdin = this.child.stdin;
    if (!stdin || this.#closed) {
      return Promise.reject(new Error("ACP connection is closed"));
    }
    const id = this.#nextId.current++;
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
    this.notify("session/cancel", { sessionId });
  }

  waitForExit(): Promise<number> {
    return this.#exitPromise;
  }

  async close(signal: NodeJS.Signals = "SIGKILL"): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#opts.signal?.removeEventListener("abort", this.#abortHandler!);
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

  #handleLine(line: string): void {
    if (this.#opts.rawDebug) debugAcp("ACP raw: %s", line);
    const message = parseLine(line);
    if (!message) return;

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
        waiter.reject(new Error(message.error.message ?? "ACP error"));
      } else {
        waiter.resolve(message.result);
      }
      return;
    }

    if (message.method === "session/update") {
      const update = (message.params?.update ?? message.params) as
        | Record<string, unknown>
        | undefined;
      if (!update) return;
      this.#opts.onSessionUpdate?.(update);
      const type = update.sessionUpdate;
      const text = extractAcpContentText(update.content);
      if (type === "agent_message_chunk" && text) {
        this.#opts.onAgentTextChunk?.(text);
      } else if (type === "agent_thought_chunk" && text) {
        this.#opts.onAgentThoughtChunk?.(text);
      }
      return;
    }

    if (message.method === "session/request_permission" && message.id != null) {
      void this.#handlePermission(message);
      return;
    }

    if (message.id != null && message.method?.startsWith("cursor/")) {
      this.#handleCursorExtension(message);
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

  #handleCursorExtension(message: JsonRpcMessage): void {
    const params = message.params ?? {};
    if (message.method === "cursor/ask_question") {
      const questions = Array.isArray(params.questions)
        ? (params.questions as Array<Record<string, unknown>>)
        : [];
      this.#respond(message.id!, {
        outcome: {
          outcome: "answered",
          answers: questions.map((question) => {
            const options = Array.isArray(question.options)
              ? (question.options as Array<Record<string, unknown>>)
              : [];
            return {
              questionId: String(question.id ?? ""),
              selectedOptionIds:
                options.length > 0 ? [String(options[0]?.id ?? "")] : [],
            };
          }),
        },
      });
      return;
    }
    if (message.method === "cursor/create_plan") {
      this.#respond(message.id!, { outcome: { outcome: "accepted" } });
      return;
    }
    this.#respond(message.id!, {});
  }

  #respond(id: number | string, result: Record<string, unknown>): void {
    const stdin = this.child.stdin;
    if (!stdin || this.#closed) return;
    stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
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
