import * as http from "node:http";
import * as https from "node:https";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { startBridgeServer } from "./server.js";
import type { BridgeConfig } from "./config.js";

vi.mock("./cursor-cli.js", () => ({
  listCursorCliModels: vi.fn().mockResolvedValue([
    { id: "claude-3-opus", name: "Claude 3 Opus" },
    { id: "claude-3-sonnet", name: "Claude 3 Sonnet" },
  ]),
}));

vi.mock("./process.js", () => ({
  killAllChildProcesses: vi.fn(),
  run: vi.fn().mockResolvedValue({
    code: 0,
    stdout: "Hello from agent",
    stderr: "",
  }),
  runStreaming: vi.fn().mockImplementation((_cmd, _args, opts) => {
    // Simulate streaming response
    if (opts.onLine) {
      opts.onLine(
        JSON.stringify({
          type: "assistant",
          message: { content: [{ type: "text", text: "Hello" }] },
        }),
      );
      opts.onLine(JSON.stringify({ type: "result", subtype: "success" }));
    }
    return Promise.resolve({ code: 0, stderr: "" });
  }),
}));

vi.mock("./request-log.js", () => ({
  logIncoming: vi.fn(),
  logTrafficRequest: vi.fn(),
  logTrafficResponse: vi.fn(),
  logAgentError: vi.fn().mockReturnValue("agent error"),
  appendSessionLine: vi.fn(),
  logAccountAssigned: vi.fn(),
  logAccountStats: vi.fn(),
}));

const tmpLogPath = "/tmp/cursor-proxy-test-sessions.log";

function createTestConfig(overrides: Partial<BridgeConfig> = {}): BridgeConfig {
  return {
    agentBin: "agent",
    acpCommand: "agent",
    acpArgs: ["acp"],
    acpEnv: {},
    host: "127.0.0.1",
    port: 0, // Let OS assign a free port
    defaultModel: "default",
    mode: "ask",
    force: false,
    approveMcps: false,
    strictModel: true,
    workspace: process.cwd(),
    timeoutMs: 30_000,
    sessionsLogPath: tmpLogPath,
    chatOnlyWorkspace: true,
    verbose: false,
    maxMode: false,
    promptViaStdin: false,
    useAcp: false,
    acpSkipAuthenticate: false,
    acpRawDebug: false,
    configDirs: overrides.configDirs ?? [],
    multiPort: overrides.multiPort ?? false,
    winCmdlineMax: 30_000,
    ...overrides,
  };
}

async function fetchServer(
  server: http.Server,
  path: string,
  options: {
    method?: string;
    body?: string;
    headers?: Record<string, string>;
  } = {},
): Promise<{ status: number; body: string }> {
  const port = (server.address() as { port: number })?.port;
  const url = `http://127.0.0.1:${port}${path}`;

  return new Promise((resolve, reject) => {
    const req = http.request(
      url,
      {
        method: options.method ?? "GET",
        headers: options.headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    req.on("error", reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

describe("startBridgeServer", () => {
  let servers: (http.Server | https.Server)[] = [];

  afterEach(async () => {
    for (const s of servers) {
      await new Promise((r) => s.close(r));
    }
    servers = [];
  });

  it("responds 200 on GET /health", async () => {
    servers = startBridgeServer({
      version: "1.0.0",
      config: createTestConfig(),
    });
    await new Promise<void>((resolve) =>
      servers[0].on("listening", () => resolve()),
    );

    const { status, body } = await fetchServer(servers[0], "/health");
    expect(status).toBe(200);
    const data = JSON.parse(body);
    expect(data.ok).toBe(true);
    expect(data.version).toBe("1.0.0");
    expect(data.defaultModel).toBe("default");
  });

  it("responds 200 on GET /v1/models", async () => {
    servers = startBridgeServer({
      version: "1.0.0",
      config: createTestConfig(),
    });
    await new Promise<void>((resolve) =>
      servers[0].on("listening", () => resolve()),
    );

    const { status, body } = await fetchServer(servers[0], "/v1/models");
    expect(status).toBe(200);
    const data = JSON.parse(body);
    expect(data.object).toBe("list");
    expect(data.data).toHaveLength(2);
    expect(data.data[0].id).toBe("claude-3-opus");
  });

  it("returns 401 when requiredKey is set and Authorization is missing", async () => {
    servers = startBridgeServer({
      version: "1.0.0",
      config: createTestConfig({ requiredKey: "secret123" }),
    });
    await new Promise<void>((resolve) =>
      servers[0].on("listening", () => resolve()),
    );

    const { status, body } = await fetchServer(servers[0], "/health");
    expect(status).toBe(401);
    const data = JSON.parse(body);
    expect(data.error.message).toBe("Invalid API key");
  });

  it("returns 200 when requiredKey matches Authorization", async () => {
    servers = startBridgeServer({
      version: "1.0.0",
      config: createTestConfig({ requiredKey: "secret123" }),
    });
    await new Promise<void>((resolve) =>
      servers[0].on("listening", () => resolve()),
    );

    const { status } = await fetchServer(servers[0], "/health", {
      headers: { Authorization: "Bearer secret123" },
    });
    expect(status).toBe(200);
  });

  it("returns 404 for unknown path", async () => {
    servers = startBridgeServer({
      version: "1.0.0",
      config: createTestConfig(),
    });
    await new Promise<void>((resolve) =>
      servers[0].on("listening", () => resolve()),
    );

    const { status, body } = await fetchServer(servers[0], "/unknown");
    expect(status).toBe(404);
    const data = JSON.parse(body);
    expect(data.error.code).toBe("not_found");
  });

  it("returns 200 for POST /v1/chat/completions (non-streaming)", async () => {
    servers = startBridgeServer({
      version: "1.0.0",
      config: createTestConfig(),
    });
    await new Promise<void>((resolve) =>
      servers[0].on("listening", () => resolve()),
    );

    const { status, body } = await fetchServer(
      servers[0],
      "/v1/chat/completions",
      {
        method: "POST",
        body: JSON.stringify({
          model: "claude-3-opus",
          messages: [{ role: "user", content: "Hi" }],
        }),
      },
    );
    expect(status).toBe(200);
    const data = JSON.parse(body);
    expect(data.object).toBe("chat.completion");
    expect(data.choices[0].message.content).toBe("Hello from agent");
  });

  it("returns display model when request is default and defaultModel is set", async () => {
    servers = startBridgeServer({
      version: "0.1.0",
      config: createTestConfig({ defaultModel: "composer-1.5" }),
    });
    await new Promise<void>((resolve) =>
      servers[0].on("listening", () => resolve()),
    );

    const { status, body } = await fetchServer(
      servers[0],
      "/v1/chat/completions",
      {
        method: "POST",
        body: JSON.stringify({
          model: "default",
          messages: [{ role: "user", content: "Hi" }],
        }),
      },
    );
    expect(status).toBe(200);
    const data = JSON.parse(body);
    expect(data.model).toBe("composer-1.5");
  });

  it("echoes default when request is default and defaultModel is unset", async () => {
    servers = startBridgeServer({
      version: "0.1.0",
      config: createTestConfig({ defaultModel: "default" }),
    });
    await new Promise<void>((resolve) =>
      servers[0].on("listening", () => resolve()),
    );

    const { status, body } = await fetchServer(
      servers[0],
      "/v1/chat/completions",
      {
        method: "POST",
        body: JSON.stringify({
          model: "default",
          messages: [{ role: "user", content: "Hi" }],
        }),
      },
    );
    expect(status).toBe(200);
    const data = JSON.parse(body);
    expect(data.model).toBe("default");
  });

  it("should spawn multiple servers when multiPort is true", async () => {
    servers = startBridgeServer({
      version: "1.0.0",
      config: createTestConfig({
        configDirs: ["/dir1", "/dir2"],
        multiPort: true,
        port: 10000,
      }),
    });

    expect(servers.length).toBe(2);

    await Promise.all(
      servers.map(
        (s) => new Promise<void>((resolve) => s.on("listening", resolve)),
      ),
    );

    const res1 = await fetchServer(servers[0], "/health");
    const res2 = await fetchServer(servers[1], "/health");

    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);
  });
});
