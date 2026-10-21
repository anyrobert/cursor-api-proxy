import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import * as http from "node:http";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";

import {
  callIdentity,
  type ClientToolDefinition,
  type ClientToolOutput,
  type PendingClientToolCall,
} from "./tool-types.js";

type ToolCallResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

/** One tools/call request from the agent, waiting on a parked call. */
type AgentRequest = {
  resolve: (result: ToolCallResult) => void;
  reject: (error: Error) => void;
};

type ParkedCall = PendingClientToolCall & {
  /** Handed to the API caller in a tool_calls turn. */
  exposed: boolean;
  /** Tool name plus canonical arguments: what a retry of this call repeats. */
  retryKey: string;
  /** Requests the agent still waits on: the original, then any retries. */
  requests: Set<AgentRequest>;
};

export type AcpHttpMcpServer = {
  type: "http";
  name: string;
  url: string;
  headers: Array<{ name: string; value: string }>;
};

const LOOPBACK_ADDRESSES = new Set([
  "127.0.0.1",
  "::1",
  "::ffff:127.0.0.1",
]);

function pendingView(call: ParkedCall): PendingClientToolCall {
  return {
    callId: call.callId,
    itemId: call.itemId,
    name: call.name,
    arguments: call.arguments,
    ...callIdentity(call),
  };
}

function safeTokenEqual(actual: string, expected: string): boolean {
  const a = Buffer.from(actual);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** JSON with object keys sorted, so equal arguments give equal text. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const fields = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);
    return `{${fields.join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function retryKeyOf(name: string, args: unknown): string {
  return `${JSON.stringify(name)}:${canonicalJson(args)}`;
}

/**
 * Per-agent-turn MCP server. It exposes caller-provided schemas but never
 * executes them. tools/call is parked until the HTTP API caller submits the
 * corresponding tool result.
 *
 * Cursor's MCP client gives up on a tools/call after 60 s (the MCP SDK
 * default request timeout; ACP-supplied servers get no other limit), sends
 * notifications/cancelled, and the model usually retries the same call. It
 * sends no progress token, so nothing the bridge sends can extend that
 * timeout. A retry therefore must not reach the API caller as a new call: it
 * waits on the call it repeats and gets that call's output (#64).
 */
export class ClientToolBridge {
  readonly serverName: string;

  readonly #definitions: ReadonlyMap<string, ClientToolDefinition>;
  readonly #token = randomBytes(32).toString("base64url");
  readonly #path = `/mcp/${randomUUID()}`;
  readonly #mcp: Server;
  readonly #transport: StreamableHTTPServerTransport;
  readonly #httpServer: http.Server;
  readonly #pending = new Map<string, ParkedCall>();
  readonly #callListeners = new Set<() => void>();
  /** The call the agent's latest tools/call request went to. */
  #latest?: ParkedCall;
  /** Output of the latest call that arrived after the agent gave up on it. */
  #unclaimed?: { retryKey: string; result: ToolCallResult };
  #url?: string;
  #closed = false;
  #listed = false;
  #totalCalls = 0;

  constructor(definitions: readonly ClientToolDefinition[]) {
    this.#definitions = new Map(definitions.map((tool) => [tool.name, tool]));
    this.serverName = `cursor-api-proxy-${randomUUID().slice(0, 8)}`;

    this.#mcp = new Server(
      { name: this.serverName, version: "1.0.0" },
      { capabilities: { tools: {} } },
    );
    this.#transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      enableJsonResponse: true,
    });

    this.#mcp.setRequestHandler(ListToolsRequestSchema, async () => {
      this.#listed = true;
      return {
        tools: [...this.#definitions.values()].map((tool) => ({
          name: tool.name,
          ...(tool.description ? { description: tool.description } : {}),
          inputSchema: tool.inputSchema,
        })),
      };
    });

    this.#mcp.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
      const { name, arguments: args } = request.params;
      const definition = this.#definitions.get(name);
      if (!definition) {
        throw new McpError(ErrorCode.InvalidParams, `Unknown tool: ${name}`);
      }
      if (this.#closed) {
        throw new McpError(ErrorCode.InternalError, "Tool bridge is closed");
      }

      const callId = `call_${randomUUID().replace(/-/g, "")}`;
      const itemId = `fc_${randomUUID().replace(/-/g, "")}`;
      let argumentsJson = "{}";
      try {
        argumentsJson = JSON.stringify(args ?? {});
      } catch {
        throw new McpError(
          ErrorCode.InvalidParams,
          `Arguments for ${name} are not JSON serializable`,
        );
      }

      const retryKey = retryKeyOf(name, args ?? {});

      return new Promise<ToolCallResult>((resolve, reject) => {
        const agentRequest = { resolve, reject };
        if (this.#serveRetry(retryKey, agentRequest, extra.signal)) return;
        this.#totalCalls += 1;
        const call: ParkedCall = {
          callId,
          itemId,
          name,
          arguments: argumentsJson,
          ...callIdentity(definition),
          exposed: false,
          retryKey,
          requests: new Set(),
        };
        this.#pending.set(callId, call);
        this.#attach(call, agentRequest, extra.signal);
        for (const listener of this.#callListeners) listener();
      });
    });

    this.#httpServer = http.createServer((req, res) => {
      const remote = req.socket.remoteAddress ?? "";
      if (!LOOPBACK_ADDRESSES.has(remote)) {
        res.writeHead(403).end("Forbidden");
        return;
      }
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const auth = req.headers.authorization ?? "";
      if (
        url.pathname !== this.#path ||
        !safeTokenEqual(auth, `Bearer ${this.#token}`)
      ) {
        res.writeHead(404).end("Not found");
        return;
      }
      void this.#transport.handleRequest(req, res).catch((error) => {
        if (!res.headersSent) {
          res.writeHead(500, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              jsonrpc: "2.0",
              id: null,
              error: {
                code: -32603,
                message:
                  error instanceof Error ? error.message : "MCP bridge error",
              },
            }),
          );
        } else if (!res.writableEnded) {
          res.end();
        }
      });
    });
  }

  async start(): Promise<void> {
    if (this.#url) return;
    await this.#mcp.connect(this.#transport);
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        this.#httpServer.off("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        this.#httpServer.off("error", onError);
        resolve();
      };
      this.#httpServer.once("error", onError);
      this.#httpServer.once("listening", onListening);
      this.#httpServer.listen(0, "127.0.0.1");
    });
    const address = this.#httpServer.address();
    if (!address || typeof address === "string") {
      await this.close();
      throw new Error("Failed to bind client-tool MCP bridge");
    }
    this.#url = `http://127.0.0.1:${address.port}${this.#path}`;
  }

  get mcpServer(): AcpHttpMcpServer {
    if (!this.#url) throw new Error("Client-tool MCP bridge has not started");
    return {
      type: "http",
      name: this.serverName,
      url: this.#url,
      headers: [
        { name: "Authorization", value: `Bearer ${this.#token}` },
      ],
    };
  }

  onCall(listener: () => void): () => void {
    this.#callListeners.add(listener);
    return () => this.#callListeners.delete(listener);
  }

  pendingCalls(): PendingClientToolCall[] {
    return [...this.#pending.values()].map(pendingView);
  }

  markExposed(callIds: readonly string[]): void {
    for (const callId of callIds) {
      const call = this.#pending.get(callId);
      if (call) call.exposed = true;
    }
  }

  has(callId: string): boolean {
    return this.#pending.has(callId);
  }

  get listed(): boolean {
    return this.#listed;
  }

  get totalCalls(): number {
    return this.#totalCalls;
  }

  resolveOutputs(outputs: readonly ClientToolOutput[]): void {
    for (const output of outputs) {
      const call = this.#pending.get(output.callId);
      if (!call) throw new Error(`Unknown tool call_id: ${output.callId}`);
    }
    for (const output of outputs) {
      const call = this.#pending.get(output.callId);
      if (!call) continue;
      this.#pending.delete(output.callId);
      const result: ToolCallResult = {
        content: [{ type: "text", text: output.output }],
        ...(output.isError ? { isError: true } : {}),
      };
      for (const request of call.requests) request.resolve(result);
      // Nobody took the output, and the agent has made no other call since
      // it gave up: keep the output for the retry it usually sends next.
      if (call.requests.size === 0 && this.#latest === call) {
        this.#unclaimed = { retryKey: call.retryKey, result };
      }
    }
  }

  rejectAll(error: Error): void {
    for (const call of this.#pending.values()) {
      for (const request of call.requests) request.reject(error);
    }
    this.#pending.clear();
    this.#latest = undefined;
    this.#unclaimed = undefined;
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.rejectAll(new Error("Client-tool bridge closed"));
    this.#callListeners.clear();
    await this.#transport.close().catch(() => undefined);
    await this.#mcp.close().catch(() => undefined);
    if (typeof this.#httpServer.closeAllConnections === "function") {
      this.#httpServer.closeAllConnections();
    }
    if (this.#httpServer.listening) {
      await new Promise<void>((resolve) => {
        this.#httpServer.close(() => resolve());
      });
    }
  }

  /**
   * Serve a tools/call that retries a call the agent gave up on, so the API
   * caller never runs it twice. False means it is a new call.
   *
   * A retry has the same tool name and arguments as a pending call that
   * either nobody waits on any more or the API caller already has. Cursor
   * runs one call per MCP server at a time, so a repeat of a handed-out call
   * means its first request is over even if the cancellation was lost. The
   * retry joins that call, or takes its output if the output came after the
   * agent gave up and the agent has called nothing else since. The same call
   * made before the caller has the first one (a parallel duplicate) or after
   * its output reached the agent (polling, a re-run) is a new call.
   */
  #serveRetry(
    retryKey: string,
    request: AgentRequest,
    signal: AbortSignal,
  ): boolean {
    const unclaimed = this.#unclaimed;
    this.#unclaimed = undefined;
    if (unclaimed?.retryKey === retryKey) {
      this.#latest = undefined;
      request.resolve(unclaimed.result);
      return true;
    }
    for (const call of this.#pending.values()) {
      const repeated = call.exposed || call.requests.size === 0;
      if (call.retryKey === retryKey && repeated) {
        this.#attach(call, request, signal);
        return true;
      }
    }
    return false;
  }

  /** Wait `request` on `call` until the agent cancels it (MCP timeout). */
  #attach(call: ParkedCall, request: AgentRequest, signal: AbortSignal): void {
    this.#latest = call;
    call.requests.add(request);
    const giveUp = () => {
      call.requests.delete(request);
      // The SDK answers nothing for a cancelled request; this only ends it.
      request.reject(new Error("The agent cancelled the tool call"));
    };
    if (signal.aborted) giveUp();
    else signal.addEventListener("abort", giveUp, { once: true });
  }
}
