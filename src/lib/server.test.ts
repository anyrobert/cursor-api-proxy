import * as http from "node:http";
import * as https from "node:https";
import * as fs from "node:fs";
import { describe, it, expect, vi, afterEach } from "vitest";
import { startBridgeServer } from "./server.js";
import { appendSessionLine } from "./request-log.js";
import { run, runStreaming } from "./process.js";
import type { BridgeConfig } from "./config.js";

vi.mock("./cursor-cli.js", () => ({
  listCursorCliModels: vi.fn().mockResolvedValue([
    { id: "claude-3-opus", name: "Claude 3 Opus" },
    { id: "claude-3-sonnet", name: "Claude 3 Sonnet" },
    { id: "gpt-5.6-sol-low", name: "GPT-5.6 Sol Low" },
    { id: "gpt-5.6-sol-high", name: "GPT-5.6 Sol High" },
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
  logModelResolution: vi.fn(),
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
    chatOnlyWorkspaceExplicit: false,
    verbose: false,
    maxMode: false,
    promptViaStdin: false,
    useAcp: false,
    acpSkipAuthenticate: false,
    acpRawDebug: false,
    configDirs: overrides.configDirs ?? [],
    multiPort: overrides.multiPort ?? false,
    winCmdlineMax: 30_000,
    contextPreamble: true,
    bridgePackageVersion: "0.0.0-test",
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
    expect(data.mode).toBe("ask");
    expect(data.perRequestMode).toBe(true);
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
    expect(data.data).toHaveLength(4);
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

  it("GET /healthz bypasses requiredKey", async () => {
    servers = startBridgeServer({
      version: "1.0.0",
      config: createTestConfig({ requiredKey: "secret123" }),
    });
    await new Promise<void>((resolve) =>
      servers[0].on("listening", () => resolve()),
    );

    const { status, body } = await fetchServer(servers[0], "/healthz");
    expect(status).toBe(200);
    expect(body).toBe("ok\n");
  });

  it("serves dashboard GET / without Authorization when requiredKey is set", async () => {
    servers = startBridgeServer({
      version: "1.0.0",
      config: createTestConfig({ requiredKey: "secret123" }),
    });
    await new Promise<void>((resolve) =>
      servers[0].on("listening", () => resolve()),
    );

    const { status, body } = await fetchServer(servers[0], "/");
    expect(status).toBe(200);
    expect(body).toContain("cursor-api-proxy");
  });

  it("does not append session logs for dashboard /api/status and /api/log polling", async () => {
    const appendSessionLineMock = vi.mocked(appendSessionLine);
    appendSessionLineMock.mockClear();
    servers = startBridgeServer({
      version: "1.0.0",
      config: createTestConfig(),
    });
    await new Promise<void>((resolve) =>
      servers[0].on("listening", () => resolve()),
    );

    const statusRes = await fetchServer(servers[0], "/api/status");
    expect(statusRes.status).toBe(200);

    const logRes = await fetchServer(servers[0], "/api/log");
    expect(logRes.status).toBe(200);

    // finish handlers run after response completion; flush microtasks before assert.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(appendSessionLineMock).not.toHaveBeenCalled();
  });

  it("POST /api/log/clear archives and truncates sessions log", async () => {
    servers = startBridgeServer({
      version: "1.0.0",
      config: createTestConfig(),
    });
    await new Promise<void>((resolve) =>
      servers[0].on("listening", () => resolve()),
    );

    // Ensure starting state.
    try {
      fs.unlinkSync(tmpLogPath);
    } catch {
      /* ignore */
    }
    fs.writeFileSync(
      tmpLogPath,
      [
        `${new Date("2026-01-01T00:00:00.000Z").toISOString()} GET /v1/chat/completions ::1 200`,
        `${new Date("2026-01-01T00:00:01.000Z").toISOString()} GET /health ::1 200`,
      ].join("\n") + "\n",
      "utf8",
    );

    const { status, body } = await fetchServer(servers[0], "/api/log/clear", {
      method: "POST",
      body: JSON.stringify({}),
      headers: { "content-type": "application/json" },
    });

    expect(status).toBe(200);
    const data = JSON.parse(body);
    expect(typeof data.archivePath).toBe("string");
    expect(fs.existsSync(data.archivePath)).toBe(true);

    const archived = fs.readFileSync(data.archivePath, "utf8");
    expect(archived).toContain("GET /v1/chat/completions");

    const live = fs.readFileSync(tmpLogPath, "utf8");
    expect(live).toBe("");

    // Clean up archive so other tests won't see it.
    try {
      fs.unlinkSync(data.archivePath);
    } catch {
      /* ignore */
    }

    try {
      fs.unlinkSync(tmpLogPath);
    } catch {
      /* ignore */
    }
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

  it("returns OpenAI Responses shape for POST /v1/responses", async () => {
    servers = startBridgeServer({
      version: "1.0.0",
      config: createTestConfig(),
    });
    await new Promise<void>((resolve) =>
      servers[0].on("listening", () => resolve()),
    );

    const { status, body } = await fetchServer(servers[0], "/v1/responses", {
      method: "POST",
      body: JSON.stringify({
        model: "claude-3-opus",
        instructions: "Be helpful.",
        input: "Hi",
      }),
    });
    expect(status).toBe(200);
    const data = JSON.parse(body);
    expect(data.object).toBe("response");
    expect(data.status).toBe("completed");
    expect(data.output[0].type).toBe("message");
    expect(data.output[0].content[0].type).toBe("output_text");
    expect(data.output[0].content[0].text).toBe("Hello from agent");
    expect(data.output_text).toBe("Hello from agent");
    expect(data.usage.input_tokens).toBeGreaterThan(0);
    expect(data.usage.output_tokens).toBeGreaterThan(0);
  });

  it("maps Chat Completions reasoning_effort to a Cursor model variant", async () => {
    const runMock = vi.mocked(run);
    runMock.mockClear();
    servers = startBridgeServer({
      version: "1.0.0",
      config: createTestConfig(),
    });
    await new Promise<void>((resolve) =>
      servers[0].on("listening", () => resolve()),
    );

    const { status } = await fetchServer(servers[0], "/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({
        model: "gpt-5.6-sol",
        reasoning_effort: "high",
        messages: [{ role: "user", content: "Hi" }],
      }),
    });
    expect(status).toBe(200);
    const [, args] = runMock.mock.calls[0];
    expect(args).toContain("gpt-5.6-sol-high");
  });

  it("maps Responses reasoning.effort to a Cursor model variant", async () => {
    const runMock = vi.mocked(run);
    runMock.mockClear();
    servers = startBridgeServer({
      version: "1.0.0",
      config: createTestConfig(),
    });
    await new Promise<void>((resolve) =>
      servers[0].on("listening", () => resolve()),
    );

    const { status } = await fetchServer(servers[0], "/v1/responses", {
      method: "POST",
      body: JSON.stringify({
        model: "gpt-5.6-sol",
        reasoning: { effort: "low" },
        input: "Hi",
      }),
    });
    expect(status).toBe(200);
    const [, args] = runMock.mock.calls[0];
    expect(args).toContain("gpt-5.6-sol-low");
  });

  it("rejects reasoning effort unavailable for the model family", async () => {
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
          reasoning_effort: "max",
          messages: [{ role: "user", content: "Hi" }],
        }),
      },
    );
    expect(status).toBe(400);
    expect(JSON.parse(body).error.code).toBe("unsupported_reasoning_effort");
  });

  it("streams OpenAI Responses semantic SSE events", async () => {
    servers = startBridgeServer({
      version: "1.0.0",
      config: createTestConfig(),
    });
    await new Promise<void>((resolve) =>
      servers[0].on("listening", () => resolve()),
    );

    const { status, body } = await fetchServer(servers[0], "/v1/responses", {
      method: "POST",
      body: JSON.stringify({
        model: "claude-3-opus",
        input: "Hi",
        stream: true,
      }),
    });
    expect(status).toBe(200);
    expect(body).toContain("event: response.created");
    expect(body).toContain("event: response.output_text.delta");
    expect(body).toContain('"delta":"Hello"');
    expect(body).toContain("event: response.completed");
    expect(body).toContain("data: [DONE]");
  });

  it("keeps the prompt out of argv and passes it via stdin when promptViaStdin is true (non-streaming)", async () => {
    const runMock = vi.mocked(run);
    runMock.mockClear();
    servers = startBridgeServer({
      version: "1.0.0",
      config: createTestConfig({ promptViaStdin: true }),
    });
    await new Promise<void>((resolve) =>
      servers[0].on("listening", () => resolve()),
    );

    const marker = "UNIQUE_PROMPT_MARKER_argv_e2big";
    const { status } = await fetchServer(servers[0], "/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({
        model: "claude-3-opus",
        messages: [{ role: "user", content: marker }],
      }),
    });
    expect(status).toBe(200);
    expect(runMock).toHaveBeenCalledTimes(1);
    const [, args, opts] = runMock.mock.calls[0];
    // Prompt must NOT be in argv (would blow ARG_MAX / spawn E2BIG on long prompts).
    expect(args.some((a: string) => a.includes(marker))).toBe(false);
    // Prompt must be delivered via stdin instead.
    expect(opts?.stdinContent).toContain(marker);
  });

  it("appends the prompt to argv (no stdin) when promptViaStdin is false (non-streaming)", async () => {
    const runMock = vi.mocked(run);
    runMock.mockClear();
    servers = startBridgeServer({
      version: "1.0.0",
      config: createTestConfig({ promptViaStdin: false }),
    });
    await new Promise<void>((resolve) =>
      servers[0].on("listening", () => resolve()),
    );

    const marker = "UNIQUE_PROMPT_MARKER_argv_default";
    const { status } = await fetchServer(servers[0], "/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({
        model: "claude-3-opus",
        messages: [{ role: "user", content: marker }],
      }),
    });
    expect(status).toBe(200);
    expect(runMock).toHaveBeenCalledTimes(1);
    const [, args, opts] = runMock.mock.calls[0];
    expect(args.some((a: string) => a.includes(marker))).toBe(true);
    expect(opts?.stdinContent).toBeUndefined();
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

  it("returns 400 for invalid body.mode on POST /v1/chat/completions", async () => {
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
          mode: "bogus",
          messages: [{ role: "user", content: "Hi" }],
        }),
      },
    );
    expect(status).toBe(400);
    const data = JSON.parse(body);
    expect(data.error.code).toBe("invalid_mode");
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
