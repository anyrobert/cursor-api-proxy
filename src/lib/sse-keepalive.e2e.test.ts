import * as fs from "node:fs";
import * as http from "node:http";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { BridgeConfig } from "./config.js";
import {
  setDefaultSseKeepaliveIntervalMsForTests,
} from "./http.js";
import { runStreaming } from "./process.js";
import { startBridgeServer } from "./server.js";

vi.mock("./cursor-cli.js", () => ({
  listCursorCliModels: vi.fn().mockResolvedValue([
    { id: "claude-3-opus", name: "Claude 3 Opus" },
    { id: "gpt-4", name: "gpt-4" },
  ]),
}));

vi.mock("./process.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./process.js")>();
  return {
    ...actual,
    killAllChildProcesses: vi.fn(),
    run: vi.fn().mockResolvedValue({
      code: 0,
      stdout: "Hello from agent",
      stderr: "",
    }),
    runStreaming: vi.fn(),
  };
});

// Every chat-only temp dir the handlers create, so teardown can check that
// each one was removed (parked tool sessions remove theirs on close).
const chatOnlyTempDirs = vi.hoisted(() => new Set<string>());

vi.mock("./workspace.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./workspace.js")>();
  return {
    ...actual,
    resolveWorkspace: (...args: Parameters<typeof actual.resolveWorkspace>) => {
      const ws = actual.resolveWorkspace(...args);
      if (ws.tempDir) chatOnlyTempDirs.add(ws.tempDir);
      return ws;
    },
  };
});

vi.mock("./request-log.js", () => ({
  logIncoming: vi.fn(),
  logTrafficRequest: vi.fn(),
  logTrafficResponse: vi.fn(),
  logModelResolution: vi.fn(),
  logToolSession: vi.fn(),
  logAgentError: vi.fn().mockReturnValue("agent error"),
  logTurnFailure: vi.fn(),
  appendSessionLine: vi.fn(),
  logAccountAssigned: vi.fn(),
  logAccountStats: vi.fn(),
}));

const fakeServerPath = join(
  process.cwd(),
  "src",
  "lib",
  "__tests__",
  "fake-acp-server.mjs",
);

const servers: http.Server[] = [];
const KEEPALIVE_MS = 40;
const AGENT_SILENCE_MS = 130;

function baseConfig(overrides: Partial<BridgeConfig> = {}): BridgeConfig {
  return {
    agentBin: "agent",
    acpCommand: process.execPath,
    acpArgs: [fakeServerPath],
    acpEnv: {},
    host: "127.0.0.1",
    port: 0,
    defaultModel: "gpt-4",
    mode: "ask",
    force: false,
    approveMcps: false,
    strictModel: true,
    workspace: process.cwd(),
    timeoutMs: 10_000,
    sessionsLogPath: "/tmp/cursor-api-proxy-keepalive-e2e.log",
    chatOnlyWorkspace: true,
    chatOnlyWorkspaceExplicit: false,
    verbose: false,
    maxMode: false,
    promptViaStdin: false,
    useAcp: false,
    acpSkipAuthenticate: true,
    acpRawDebug: false,
    configDirs: [],
    multiPort: false,
    winCmdlineMax: 30_000,
    contextPreamble: false,
    bridgePackageVersion: "0.0.0-test",
    ...overrides,
  };
}

async function start(config: BridgeConfig): Promise<string> {
  const [server] = startBridgeServer({ version: "test", config });
  servers.push(server as http.Server);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No port");
  return `http://127.0.0.1:${address.port}`;
}

async function postStream(base: string, path: string, body: unknown) {
  const response = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return {
    status: response.status,
    text: await response.text(),
  };
}

function chatDeltas(text: string): Record<string, unknown>[] {
  return text
    .split(/\r?\n\r?\n/)
    .filter((event) => event.startsWith("data: {"))
    .map((event) => JSON.parse(event.slice("data: ".length)))
    .filter((event) => event.object === "chat.completion.chunk")
    .map((event) => event.choices[0].delta);
}

const ASSISTANT_ROLE_DELTA = { role: "assistant", content: "" };

function mockSlowCliStream() {
  vi.mocked(runStreaming).mockImplementation(async (_cmd, _args, opts) => {
    await new Promise((resolve) => setTimeout(resolve, AGENT_SILENCE_MS));
    opts.onLine?.(
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "text", text: "Hello" }] },
      }),
    );
    opts.onLine?.(JSON.stringify({ type: "result", subtype: "success" }));
    return { code: 0, stderr: "" };
  });
}

beforeEach(() => {
  setDefaultSseKeepaliveIntervalMsForTests(KEEPALIVE_MS);
  mockSlowCliStream();
});

afterEach(async () => {
  setDefaultSseKeepaliveIntervalMsForTests();
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => server.close(() => resolve())),
    ),
  );
  // Closing the server closes parked tool sessions in the background; wait
  // for them so no temp dir outlives the test file.
  await vi.waitFor(() => {
    expect([...chatOnlyTempDirs].filter((dir) => fs.existsSync(dir))).toEqual(
      [],
    );
  });
  chatOnlyTempDirs.clear();
});

describe("SSE keepalive e2e (CLI stream)", () => {
  it("emits keepalive comments on /v1/responses during agent silence", async () => {
    const base = await start(baseConfig());
    const { status, text } = await postStream(base, "/v1/responses", {
      model: "claude-3-opus",
      input: "Hi",
      stream: true,
    });
    expect(status).toBe(200);
    expect(text).toMatch(/: keepalive\r?\n\r?\n/);
    expect(text).toContain("event: response.created");
    expect(text).toContain("event: response.output_text.delta");
    expect(text).toContain("data: [DONE]");
  });

  it("emits keepalive comments on /v1/chat/completions during agent silence", async () => {
    const base = await start(baseConfig());
    const { status, text } = await postStream(base, "/v1/chat/completions", {
      model: "claude-3-opus",
      messages: [{ role: "user", content: "Hi" }],
      stream: true,
    });
    expect(status).toBe(200);
    expect(text).toMatch(/: keepalive\r?\n\r?\n/);
    expect(chatDeltas(text).slice(0, 2)).toEqual([
      ASSISTANT_ROLE_DELTA,
      { content: "Hello" },
    ]);
    expect(text).toContain("data: [DONE]");
  });

  it("opens /v1/chat/completions with the assistant role when the agent emits no text", async () => {
    vi.mocked(runStreaming).mockImplementationOnce(async (_cmd, _args, opts) => {
      opts.onLine?.(JSON.stringify({ type: "result", subtype: "success" }));
      return { code: 0, stderr: "" };
    });
    const base = await start(baseConfig());
    const { status, text } = await postStream(base, "/v1/chat/completions", {
      model: "claude-3-opus",
      messages: [{ role: "user", content: "Hi" }],
      stream: true,
    });
    expect(status).toBe(200);
    expect(chatDeltas(text)).toEqual([ASSISTANT_ROLE_DELTA, {}]);
    expect(text).toContain("data: [DONE]");
  });

  it("emits keepalive comments on /v1/messages during agent silence", async () => {
    const base = await start(baseConfig());
    const { status, text } = await postStream(base, "/v1/messages", {
      model: "claude-3-opus",
      max_tokens: 64,
      messages: [{ role: "user", content: "Hi" }],
      stream: true,
    });
    expect(status).toBe(200);
    expect(text).toMatch(/: keepalive\r?\n\r?\n/);
    expect(text).toContain("message_start");
    expect(text).toContain("content_block_delta");
    expect(text).toContain("message_stop");
  });
});

describe("SSE keepalive e2e (ACP structured stream)", () => {
  it("emits keepalive comments while ACP is silent before first text", async () => {
    const base = await start(
      baseConfig({
        useAcp: true,
        acpEnv: { FAKE_ACP_SCENARIO: "slow_text" },
      }),
    );
    const { status, text } = await postStream(base, "/v1/responses", {
      model: "gpt-4",
      input: "Hi",
      stream: true,
    });
    expect(status).toBe(200);
    expect(text).toMatch(/: keepalive\r?\n\r?\n/);
    expect(text).toContain("event: response.created");
    expect(text).toContain("Hello from fake ACP");
    expect(text).toContain("data: [DONE]");
  });

  it("emits keepalive on ACP chat completions stream", async () => {
    const base = await start(
      baseConfig({
        useAcp: true,
        acpEnv: { FAKE_ACP_SCENARIO: "slow_text" },
      }),
    );
    const { status, text } = await postStream(base, "/v1/chat/completions", {
      model: "gpt-4",
      messages: [{ role: "user", content: "Hi" }],
      stream: true,
    });
    expect(status).toBe(200);
    expect(text).toMatch(/: keepalive\r?\n\r?\n/);
    expect(chatDeltas(text).slice(0, 2)).toEqual([
      ASSISTANT_ROLE_DELTA,
      { content: "Hello from fake ACP" },
    ]);
    expect(text).toContain("data: [DONE]");
  });

  it("opens ACP chat completions with the assistant role when the agent exits before any text", async () => {
    const base = await start(
      baseConfig({
        useAcp: true,
        acpEnv: { FAKE_ACP_SCENARIO: "process_exit" },
      }),
    );
    const { status, text } = await postStream(base, "/v1/chat/completions", {
      model: "gpt-4",
      messages: [{ role: "user", content: "Hi" }],
      stream: true,
    });
    expect(status).toBe(200);
    expect(chatDeltas(text)).toEqual([ASSISTANT_ROLE_DELTA]);
    expect(text).toContain('"code":"cursor_cli_error"');
    expect(text).toContain("data: [DONE]");
  });

  it("emits keepalive on ACP anthropic messages stream", async () => {
    const base = await start(
      baseConfig({
        useAcp: true,
        acpEnv: { FAKE_ACP_SCENARIO: "slow_text" },
      }),
    );
    const { status, text } = await postStream(base, "/v1/messages", {
      model: "gpt-4",
      max_tokens: 64,
      messages: [{ role: "user", content: "Hi" }],
      stream: true,
    });
    expect(status).toBe(200);
    expect(text).toMatch(/: keepalive\r?\n\r?\n/);
    expect(text).toContain("Hello from fake ACP");
    expect(text).toContain("message_stop");
  });

  it("emits keepalive on ACP tool-turn stream before first tool call", async () => {
    const base = await start(
      baseConfig({
        useAcp: true,
        acpEnv: { FAKE_ACP_SCENARIO: "tool_delay" },
      }),
    );
    const { status, text } = await postStream(base, "/v1/responses", {
      model: "gpt-4",
      stream: true,
      input: "Weather?",
      tools: [
        {
          type: "function",
          name: "weather",
          description: "Get weather",
          parameters: {
            type: "object",
            properties: { city: { type: "string" } },
          },
        },
      ],
    });
    expect(status).toBe(200);
    expect(text).toMatch(/: keepalive\r?\n\r?\n/);
    expect(text).toContain("event: response.created");
    expect(text).toContain("function_call");
    expect(text).toContain("data: [DONE]");
  });
});
