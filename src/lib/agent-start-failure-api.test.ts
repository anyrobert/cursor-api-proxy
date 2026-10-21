import * as fs from "node:fs";
import * as http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from "vitest";

import type { BridgeConfig } from "./config.js";
import { listCursorCliModels } from "./cursor-cli.js";
import { startBridgeServer } from "./server.js";

// Issue #100: an agent that cannot be started answers 500 cursor_cli_error
// on every path (plain or tool, sync or stream), and no error text that can
// name paths on the proxy host reaches the client: it stays in the logs.

vi.mock("./cursor-cli.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./cursor-cli.js")>()),
  // The model check passes, so the turn is what fails. No test runs an agent.
  listCursorCliModels: vi.fn(),
}));

const AGENT_START =
  "The Cursor agent could not be started. See server logs for details.";
const TOOL_TURN = "The client-tool turn failed. See server logs for details.";
const INTERNAL =
  "The proxy could not handle the request. See server logs for details.";

const fakeAcpServer = join(process.cwd(), "src", "lib", "__tests__", "fake-acp-server.mjs");

let workDir: string;
let missingAgent: string;
let unrunnableAgent: string;
let sessionsLog: string;
let consoleError: MockInstance<typeof console.error>;
const servers: http.Server[] = [];

beforeAll(() => {
  workDir = fs.mkdtempSync(join(tmpdir(), "agent-start-failure-api-"));
  missingAgent = join(workDir, "no-such-agent");
  // A script without the execute bit: spawning it fails with EACCES.
  unrunnableAgent = join(workDir, "agent-not-executable");
  fs.writeFileSync(unrunnableAgent, "#!/bin/sh\necho never\n", { mode: 0o644 });
});

afterAll(() => {
  fs.rmSync(workDir, { recursive: true, force: true });
});

beforeEach(() => {
  sessionsLog = join(workDir, `sessions-${Date.now()}-${Math.random()}.log`);
  vi.mocked(listCursorCliModels).mockResolvedValue([{ id: "gpt-4", name: "gpt-4" }]);
  consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
          server.closeAllConnections();
        }),
    ),
  );
});

function config(overrides: Partial<BridgeConfig>): BridgeConfig {
  return {
    agentBin: missingAgent,
    acpCommand: missingAgent,
    acpArgs: [],
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
    sessionsLogPath: sessionsLog,
    // Each run's config dir is the chat-only temp home, never ~/.cursor.
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

async function start(overrides: Partial<BridgeConfig>): Promise<string> {
  const [server] = startBridgeServer({ version: "test", config: config(overrides) });
  servers.push(server as http.Server);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No port");
  return `http://127.0.0.1:${address.port}`;
}

const weather = { type: "object", properties: { city: { type: "string" } } };

const REQUESTS = {
  chat: {
    path: "/v1/chat/completions",
    plain: { messages: [{ role: "user", content: "Hi" }] },
    tool: {
      messages: [{ role: "user", content: "Weather?" }],
      tools: [{ type: "function", function: { name: "weather", parameters: weather } }],
    },
  },
  responses: {
    path: "/v1/responses",
    plain: { input: "Hi" },
    tool: {
      input: "Weather?",
      tools: [{ type: "function", name: "weather", parameters: weather }],
    },
  },
  anthropic: {
    path: "/v1/messages",
    plain: { max_tokens: 64, messages: [{ role: "user", content: "Hi" }] },
    tool: {
      max_tokens: 64,
      messages: [{ role: "user", content: "Weather?" }],
      tools: [{ name: "weather", input_schema: weather }],
    },
  },
} as const;

type Api = keyof typeof REQUESTS;
const APIS = ["chat", "responses", "anthropic"] as const;

async function post(base: string, api: Api, body: Record<string, unknown>) {
  const response = await fetch(`${base}${REQUESTS[api].path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "gpt-4", ...body }),
  });
  return { status: response.status, text: await response.text() };
}

/** The error body each API's clients parse for a 500. */
function errorBody(api: Api, code: string, message: string) {
  if (api === "anthropic") {
    return { type: "error", error: { type: "api_error", message, code } };
  }
  return { error: { message, type: "server_error", param: null, code } };
}

/** The error in a stream's terminal event, in each API's own shape. */
function streamError(api: Api, text: string): unknown {
  const events = text
    .split(/\n\n/)
    .map((block) => block.split("\n"))
    .filter((lines) => lines.some((line) => line.startsWith("data: ")))
    .map((lines) => ({
      event: lines.find((line) => line.startsWith("event: "))?.slice(7),
      data: lines.find((line) => line.startsWith("data: "))!.slice(6),
    }));
  const last = events[events.length - 1];
  if (api === "chat") {
    expect(last.data).toBe("[DONE]");
    return JSON.parse(events[events.length - 2].data).error;
  }
  if (api === "responses") {
    expect(last.event).toBe("response.failed");
    return JSON.parse(last.data).response.error;
  }
  expect(last.event).toBe("error");
  return JSON.parse(last.data).error;
}

/** `errorBody`'s error as a stream carries it (Responses: code and message). */
function streamErrorOf(api: Api, code: string, message: string) {
  if (api === "responses") return { code, message };
  return api === "anthropic"
    ? { type: "api_error", message, code }
    : { message, type: "server_error", param: null, code };
}

function consoleErrors(): string {
  return consoleError.mock.calls.map((call) => call.map(String).join(" ")).join("\n");
}

function sessionErrorLines(): string[] {
  if (!fs.existsSync(sessionsLog)) return [];
  return fs
    .readFileSync(sessionsLog, "utf8")
    .split("\n")
    .filter((line) => line.includes(" ERROR "));
}

/** Nothing that names the proxy host's files or Node's spawn error. */
function expectNoLeak(text: string, agent: string): void {
  for (const secret of [workDir, agent, "ENOENT", "EACCES", "spawn", "Command not found"]) {
    expect(text).not.toContain(secret);
  }
}

/** The cause is in the console and in the sessions log's ERROR line. */
function expectLogged(api: Api, code: string, detail: string): void {
  expect(consoleErrors()).toContain(detail);
  const [line, ...rest] = sessionErrorLines();
  expect(rest).toEqual([]);
  expect(line).toContain(` ERROR POST ${REQUESTS[api].path} `);
  expect(line).toContain(` ${code} `);
  expect(line).toContain(detail);
}

const AGENTS = [
  ["missing", () => missingAgent, "ENOENT"],
  ["not executable", () => unrunnableAgent, "EACCES"],
] as const;

describe.each(AGENTS)("agent binary that is %s", (_, agentPath, errno) => {
  describe.each(APIS)("%s", (api) => {
    describe.each([
      ["CLI", false],
      ["ACP", true],
    ] as const)("%s plain turn", (_mode, useAcp) => {
      const agentConfig = () =>
        useAcp ? { useAcp, acpCommand: agentPath() } : { useAcp, agentBin: agentPath() };

      it("answers 500 cursor_cli_error and logs the cause", async () => {
        const base = await start(agentConfig());
        const { status, text } = await post(base, api, REQUESTS[api].plain);

        expect(status).toBe(500);
        expect(JSON.parse(text)).toEqual(errorBody(api, "cursor_cli_error", AGENT_START));
        expectNoLeak(text, agentPath());
        expectLogged(api, "cursor_cli_error", agentPath());
      });

      it("ends the stream with cursor_cli_error and logs the cause", async () => {
        const base = await start(agentConfig());
        const { status, text } = await post(base, api, {
          ...REQUESTS[api].plain,
          stream: true,
        });

        expect(status).toBe(200);
        expect(streamError(api, text)).toEqual(
          streamErrorOf(api, "cursor_cli_error", AGENT_START),
        );
        expectNoLeak(text, agentPath());
        expectLogged(api, "cursor_cli_error", agentPath());
      });
    });

    describe("tool turn", () => {
      it.each([false, true])(
        "stream=%s answers 500 cursor_cli_error and logs the spawn error",
        async (stream) => {
          const base = await start({ useAcp: true, acpCommand: agentPath() });
          const { status, text } = await post(base, api, {
            ...REQUESTS[api].tool,
            stream,
          });

          // The session starts before any byte of a stream is written.
          expect(status).toBe(500);
          expect(JSON.parse(text)).toEqual(errorBody(api, "cursor_cli_error", AGENT_START));
          expectNoLeak(text, agentPath());
          expectLogged(api, "cursor_cli_error", agentPath());
          expect(consoleErrors()).toContain(errno);
        },
      );
    });
  });
});

describe("tool turn that fails for another reason", () => {
  const acp = (scenario: string): Partial<BridgeConfig> => ({
    useAcp: true,
    acpCommand: process.execPath,
    acpArgs: [fakeAcpServer],
    acpEnv: { FAKE_ACP_SCENARIO: scenario },
  });

  it.each(APIS)(
    "%s answers a generic tool_session_error and logs the error",
    async (api) => {
      // An agent without HTTP MCP support: an error with no client-safe text.
      const base = await start(acp("no_http"));
      const { status, text } = await post(base, api, REQUESTS[api].tool);

      expect(status).toBe(500);
      expect(JSON.parse(text)).toEqual(errorBody(api, "tool_session_error", TOOL_TURN));
      expect(text).not.toContain("HTTP MCP");
      expectLogged(api, "tool_session_error", "does not support HTTP MCP servers");
    },
  );

  // tool_choice that requires a call, for an agent that answers without one.
  const REQUIRED_TOOL = {
    chat: { tool_choice: "required" },
    responses: { tool_choice: "required" },
    anthropic: { tool_choice: { type: "any" } },
  } as const;

  it.each(APIS)("%s keeps the message of a broken tool-call rule", async (api) => {
    const base = await start(acp(""));
    const { status, text } = await post(base, api, {
      ...REQUESTS[api].tool,
      ...REQUIRED_TOOL[api],
    });

    expect(status).toBe(500);
    expect(JSON.parse(text)).toEqual(
      errorBody(api, "tool_session_error", "Agent completed without the required tool call"),
    );
  });

  it("keeps the message when the agent makes more parallel calls than allowed", async () => {
    const base = await start(acp("tool_parallel"));
    const search = { type: "object", properties: { query: { type: "string" } } };
    const { status, text } = await post(base, "chat", {
      messages: [{ role: "user", content: "Weather and news?" }],
      tools: [
        { type: "function", function: { name: "weather", parameters: weather } },
        { type: "function", function: { name: "search", parameters: search } },
      ],
      parallel_tool_calls: false,
    });

    expect(status).toBe(500);
    expect(JSON.parse(text)).toEqual(
      errorBody("chat", "tool_session_error", "Agent emitted 2 parallel tool calls; maximum is 1"),
    );
  });
});

describe("error that no handler answers", () => {
  // Before #100 a sync turn's spawn error reached the request listener; its
  // catch-all still hides the text of anything else that escapes (#89).
  it.each(APIS)("%s answers a generic internal_error", async (api) => {
    const secret = join(workDir, "secret-config.json");
    vi.mocked(listCursorCliModels).mockRejectedValueOnce(
      new Error(`EACCES: permission denied, open '${secret}'`),
    );
    const base = await start({});
    const { status, text } = await post(base, api, REQUESTS[api].plain);

    expect(status).toBe(500);
    expect(JSON.parse(text)).toEqual(errorBody(api, "internal_error", INTERNAL));
    expectNoLeak(text, secret);
    expectLogged(api, "internal_error", secret);
  });
});
