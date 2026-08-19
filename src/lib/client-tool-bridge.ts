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

import type {
  ClientToolDefinition,
  ClientToolOutput,
  PendingClientToolCall,
} from "./tool-types.js";

type ToolCallResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

type ParkedCall = PendingClientToolCall & {
  exposed: boolean;
  resolve: (result: ToolCallResult) => void;
  reject: (error: Error) => void;
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

function safeTokenEqual(actual: string, expected: string): boolean {
  const a = Buffer.from(actual);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Per-agent-turn MCP server. It exposes caller-provided schemas but never
 * executes them. tools/call is parked until the HTTP API caller submits the
 * corresponding tool result.
 */
export class ClientToolBridge {
  readonly serverName: string;

  readonly #definitions: ClientToolDefinition[];
  readonly #definitionNames: Set<string>;
  readonly #token = randomBytes(32).toString("base64url");
  readonly #path = `/mcp/${randomUUID()}`;
  readonly #mcp: Server;
  readonly #transport: StreamableHTTPServerTransport;
  readonly #httpServer: http.Server;
  readonly #pending = new Map<string, ParkedCall>();
  readonly #callListeners = new Set<() => void>();
  #url?: string;
  #closed = false;
  #listed = false;
  #totalCalls = 0;

  constructor(definitions: readonly ClientToolDefinition[]) {
    this.#definitions = [...definitions];
    this.#definitionNames = new Set(definitions.map((tool) => tool.name));
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
        tools: this.#definitions.map((tool) => ({
          name: tool.name,
          ...(tool.description ? { description: tool.description } : {}),
          inputSchema: tool.inputSchema,
        })),
      };
    });

    this.#mcp.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;
      if (!this.#definitionNames.has(name)) {
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

      return new Promise<ToolCallResult>((resolve, reject) => {
        this.#totalCalls += 1;
        this.#pending.set(callId, {
          callId,
          itemId,
          name,
          arguments: argumentsJson,
          exposed: false,
          resolve,
          reject,
        });
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
    return [...this.#pending.values()].map(
      ({ callId, itemId, name, arguments: args }) => ({
        callId,
        itemId,
        name,
        arguments: args,
      }),
    );
  }

  unexposedCalls(): PendingClientToolCall[] {
    return [...this.#pending.values()]
      .filter((call) => !call.exposed)
      .map(({ callId, itemId, name, arguments: args }) => ({
        callId,
        itemId,
        name,
        arguments: args,
      }));
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
      call.resolve({
        content: [{ type: "text", text: output.output }],
        ...(output.isError ? { isError: true } : {}),
      });
    }
  }

  rejectAll(error: Error): void {
    for (const call of this.#pending.values()) call.reject(error);
    this.#pending.clear();
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
}
