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
} from "vitest";

import { getAccountStats } from "./account-pool.js";
import type { BridgeConfig } from "./config.js";
import { PLAN_LIMIT_MESSAGE, PLAN_LIMIT_PENALTY_MS } from "./plan-limit.js";
import { startBridgeServer } from "./server.js";

// Issue #67: every API ends a failed turn with its own terminal error.
// Issue #65: Cursor's plan-limit answer is reported as an error, not content.

vi.mock("./cursor-cli.js", () => ({
  listCursorCliModels: vi.fn().mockResolvedValue([{ id: "gpt-4", name: "gpt-4" }]),
}));

// Pool tests use account dirs; never copy the real keychain token into them.
vi.mock("./token-cache.js", () => ({
  readKeychainToken: () => undefined,
  readCachedToken: () => undefined,
  writeCachedToken: vi.fn(),
}));

const fixtures = join(process.cwd(), "src", "lib", "__tests__");
const fakeAcpServer = join(fixtures, "fake-acp-server.mjs");
const fakeCliAgent = join(fixtures, "fake-cli-agent.mjs");
const SECRET = "secret-cli-detail";
const CLI_EXIT =
  "The Cursor agent process exited with code 1. See server logs for details.";

let workDir: string;
let agentBin: string;
let sessionsLog: string;
const servers: http.Server[] = [];

beforeAll(() => {
  workDir = fs.mkdtempSync(join(tmpdir(), "agent-failure-api-"));
  agentBin = join(workDir, "agent");
  fs.writeFileSync(
    agentBin,
    `#!/bin/sh\nexec "${process.execPath}" "${fakeCliAgent}" "$@"\n`,
    { mode: 0o755 },
  );
});

afterAll(() => {
  fs.rmSync(workDir, { recursive: true, force: true });
});

beforeEach(() => {
  sessionsLog = join(workDir, `sessions-${Date.now()}-${Math.random()}.log`);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
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

function config(overrides: Partial<BridgeConfig> = {}): BridgeConfig {
  return {
    agentBin,
    acpCommand: process.execPath,
    acpArgs: [fakeAcpServer],
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

async function start(overrides: Partial<BridgeConfig> = {}): Promise<string> {
  const [server] = startBridgeServer({ version: "test", config: config(overrides) });
  servers.push(server as http.Server);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No port");
  return `http://127.0.0.1:${address.port}`;
}

async function post(base: string, path: string, body: Record<string, unknown>) {
  const response = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "gpt-4", ...body }),
  });
  return { status: response.status, text: await response.text() };
}

type SseEvent = { event?: string; data: string };

function sseEvents(text: string): SseEvent[] {
  return text
    .split(/\r?\n\r?\n/)
    .map((block) => block.split(/\r?\n/).filter((line) => !line.startsWith(":")))
    .filter((lines) => lines.some((line) => line.startsWith("data: ")))
    .map((lines) => ({
      event: lines.find((line) => line.startsWith("event: "))?.slice(7),
      data: lines
        .filter((line) => line.startsWith("data: "))
        .map((line) => line.slice(6))
        .join("\n"),
    }));
}

function jsonData(events: SseEvent[]): any[] {
  return events
    .filter((event) => event.data !== "[DONE]")
    .map((event) => JSON.parse(event.data));
}

/** The answer text a stream showed, whichever API wrote it. */
function streamedText(text: string): string {
  return jsonData(sseEvents(text))
    .map((data) => {
      if (data.object === "chat.completion.chunk") {
        return data.choices[0]?.delta?.content ?? "";
      }
      if (data.type === "response.output_text.delta") return data.delta;
      if (data.type === "content_block_delta") return data.delta.text ?? "";
      return "";
    })
    .join("");
}

/** The answer of a non-streamed response, whichever API wrote it. */
function answerText(api: Api, body: any): string {
  if (api === "chat") return body.choices[0].message.content;
  if (api === "responses") return body.output[0].content[0].text;
  return body.content[0].text;
}

const PLAIN_REQUESTS = {
  chat: ["/v1/chat/completions", { messages: [{ role: "user", content: "Hi" }] }],
  responses: ["/v1/responses", { input: "Hi" }],
  anthropic: ["/v1/messages", { max_tokens: 64, messages: [{ role: "user", content: "Hi" }] }],
} as const;

const weather = { type: "object", properties: { city: { type: "string" } } };

const TOOL_REQUESTS = {
  chat: [
    "/v1/chat/completions",
    {
      messages: [{ role: "user", content: "Weather?" }],
      tools: [{ type: "function", function: { name: "weather", parameters: weather } }],
    },
  ],
  responses: [
    "/v1/responses",
    {
      input: "Weather?",
      tools: [{ type: "function", name: "weather", parameters: weather }],
    },
  ],
  anthropic: [
    "/v1/messages",
    {
      max_tokens: 64,
      messages: [{ role: "user", content: "Weather?" }],
      tools: [{ name: "weather", input_schema: weather }],
    },
  ],
} as const;

type Api = keyof typeof PLAIN_REQUESTS;
const APIS = ["chat", "responses", "anthropic"] as const;

/** The error `type` each API gives an agent failure (Responses has none). */
const SERVER_ERROR_TYPE = {
  chat: { type: "server_error" },
  responses: {},
  anthropic: { type: "api_error" },
} as const;

/**
 * Asserts the API's own stream ending for a failed turn and returns the
 * error: {code, message} plus `type` where the API has one.
 */
function expectStreamFailure(api: Api, text: string): Record<string, unknown> {
  const events = sseEvents(text);
  const last = events[events.length - 1];
  if (api === "responses") {
    // One response.failed, no Chat Completions [DONE] and no completion.
    expect(last.event).toBe("response.failed");
    expect(events.some((event) => event.data === "[DONE]")).toBe(false);
    expect(events.map((event) => event.event)).not.toContain("response.completed");
    const { type, response } = JSON.parse(last.data);
    expect(type).toBe("response.failed");
    expect(response).toMatchObject({ object: "response", status: "failed", output: [] });
    expect(Object.keys(response.error).sort()).toEqual(["code", "message"]);
    return response.error;
  }
  if (api === "chat") {
    // OpenAI's mid-stream error: a chunk holding only `error`, then [DONE].
    expect(last.data).toBe("[DONE]");
    const chunks = jsonData(events);
    const error = chunks[chunks.length - 1];
    expect(Object.keys(error)).toEqual(["error"]);
    expect(error.error.param).toBeNull();
    expect(chunks.flatMap((chunk) => chunk.choices ?? []).map((c: any) => c.finish_reason))
      .not.toContain("stop");
    return error.error;
  }
  // Anthropic: every event is named (the SDKs dispatch on it), and an
  // `error` event with the error body ends the stream.
  expect(events.every((event) => event.event !== undefined)).toBe(true);
  expect(last.event).toBe("error");
  expect(events.map((event) => event.event)).not.toContain("message_stop");
  const body = JSON.parse(last.data);
  expect(body.type).toBe("error");
  return body.error;
}

describe("CLI agent that exits non-zero (#67)", () => {
  beforeEach(() => {
    vi.stubEnv("FAKE_CLI_SCENARIO", "exit_after_text");
  });

  it.each(APIS)(
    "%s stream ends with the API's terminal error after the partial text",
    async (api) => {
      const base = await start();
      const [path, body] = PLAIN_REQUESTS[api];
      const { status, text } = await post(base, path, { ...body, stream: true });
      expect(status).toBe(200);
      expect(streamedText(text)).toBe("Partial answer ");
      expect(text).not.toContain(SECRET);
      expect(expectStreamFailure(api, text)).toEqual({
        code: "cursor_cli_error",
        message: CLI_EXIT,
        ...SERVER_ERROR_TYPE[api],
        ...(api === "chat" ? { param: null } : {}),
      });
      expect(fs.readFileSync(sessionsLog, "utf8")).toContain(
        `agent_exit_1 agent: token=${SECRET}`,
      );
    },
  );

  it("Responses stream reports no output item when the agent printed nothing", async () => {
    vi.stubEnv("FAKE_CLI_SCENARIO", "exit_silent");
    const base = await start();
    const { text } = await post(base, "/v1/responses", { input: "Hi", stream: true });
    expect(sseEvents(text).map((event) => event.event)).toEqual([
      "response.created",
      "response.failed",
    ]);
  });

  it("Responses stream reports the failure on the response it created", async () => {
    const base = await start();
    const { text } = await post(base, "/v1/responses", {
      input: "Hi",
      stream: true,
      instructions: "Be brief",
    });
    const [created, ...rest] = jsonData(sseEvents(text));
    const failed = rest[rest.length - 1];
    expect(failed.response.id).toBe(created.response.id);
    expect(failed.response).toMatchObject({
      model: "gpt-4",
      instructions: "Be brief",
      error: { code: "cursor_cli_error", message: CLI_EXIT },
    });
  });

  it.each([
    ["chat", { error: { message: CLI_EXIT, type: "server_error", param: null, code: "cursor_cli_error" } }],
    ["responses", { error: { message: CLI_EXIT, type: "server_error", param: null, code: "cursor_cli_error" } }],
    ["anthropic", { type: "error", error: { type: "api_error", message: CLI_EXIT, code: "cursor_cli_error" } }],
  ] as const)("%s returns 500 with the API's error body", async (api, expected) => {
    const base = await start();
    const [path, body] = PLAIN_REQUESTS[api];
    const { status, text } = await post(base, path, body);
    expect(status).toBe(500);
    expect(JSON.parse(text)).toEqual(expected);
  });
});

describe("CLI agent that succeeds", () => {
  it("Responses stream opens the message item with the first text and completes", async () => {
    const base = await start();
    const { text } = await post(base, "/v1/responses", { input: "Hi", stream: true });
    const events = sseEvents(text);
    expect(events.map((event) => event.event ?? event.data)).toEqual([
      "response.created",
      "response.output_item.added",
      "response.content_part.added",
      "response.output_text.delta",
      "response.output_text.delta",
      "response.output_text.done",
      "response.content_part.done",
      "response.output_item.done",
      "response.completed",
      "[DONE]",
    ]);
    const completed = JSON.parse(events[8].data).response;
    expect(completed.status).toBe("completed");
    expect(completed.output[0].content[0].text).toBe("Hello from fake CLI");
  });

  it("Anthropic stream names every event and ends with message_stop", async () => {
    const base = await start();
    const { text } = await post(base, "/v1/messages", {
      ...PLAIN_REQUESTS.anthropic[1],
      stream: true,
    });
    const events = sseEvents(text);
    expect(events.map((event) => event.event)).toEqual([
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ]);
    for (const event of events) {
      expect(JSON.parse(event.data).type).toBe(event.event);
    }
    expect(JSON.parse(events[0].data).message).toMatchObject({
      stop_reason: null,
      stop_sequence: null,
      usage: { output_tokens: 0 },
    });
  });
});

describe("ACP agent that exits mid-turn (#67)", () => {
  it.each(APIS)(
    "%s plain stream ends with the API's terminal error",
    async (api) => {
      const base = await start({
        useAcp: true,
        acpEnv: { FAKE_ACP_SCENARIO: "process_exit" },
      });
      const [path, body] = PLAIN_REQUESTS[api];
      const { status, text } = await post(base, path, { ...body, stream: true });
      expect(status).toBe(200);
      const error = expectStreamFailure(api, text);
      expect(error).toMatchObject({
        code: "cursor_cli_error",
        message: expect.stringMatching(/exited with code 7/),
        ...SERVER_ERROR_TYPE[api],
      });
    },
  );

  it.each(APIS)(
    "%s tool stream ends with the API's terminal error and logs the failure",
    async (api) => {
      const base = await start({
        useAcp: true,
        acpEnv: { FAKE_ACP_SCENARIO: "process_exit" },
      });
      const [path, body] = TOOL_REQUESTS[api];
      const { status, text } = await post(base, path, { ...body, stream: true });
      expect(status).toBe(200);
      const error = expectStreamFailure(api, text);
      expect(error).toMatchObject({
        code: "cursor_cli_error",
        message: expect.stringMatching(/exited with code 7 before responding/),
        ...SERVER_ERROR_TYPE[api],
      });
      await vi.waitFor(() => {
        expect(fs.readFileSync(sessionsLog, "utf8")).toMatch(
          new RegExp(`ERROR POST ${path} \\S+ cursor_cli_error `),
        );
      });
    },
  );
});

/** What each API answers when the account hit Cursor's plan limit (#65). */
const PLAN_LIMIT_BODY = {
  chat: {
    error: {
      message: PLAN_LIMIT_MESSAGE,
      type: "insufficient_quota",
      param: null,
      code: "cursor_plan_limit",
    },
  },
  responses: {
    error: {
      message: PLAN_LIMIT_MESSAGE,
      type: "insufficient_quota",
      param: null,
      code: "cursor_plan_limit",
    },
  },
  anthropic: {
    type: "error",
    error: {
      type: "rate_limit_error",
      message: PLAN_LIMIT_MESSAGE,
      code: "cursor_plan_limit",
    },
  },
} as const;

/** The stream's terminal error for the plan limit, per API. */
function expectPlanLimitStream(api: Api, text: string): void {
  // Nothing of Cursor's reply reaches the client as answer text.
  expect(streamedText(text)).toBe("");
  const events = sseEvents(text);
  if (api === "responses") {
    expect(events.map((event) => event.event)).toEqual([
      "response.created",
      "response.failed",
    ]);
  }
  if (api === "anthropic") {
    expect(events.map((event) => event.event)).toEqual(["message_start", "error"]);
  }
  const { error } = PLAN_LIMIT_BODY[api];
  expect(expectStreamFailure(api, text)).toEqual(
    api === "responses"
      ? { code: error.code, message: error.message }
      : error,
  );
}

describe("Cursor plan limit, CLI mode (#65)", () => {
  // Each fake CLI scenario answers with one of Cursor's plan-limit replies.
  const REPLY_CASES = APIS.flatMap((api) =>
    (["plan_limit", "payment_method"] as const).map((scenario) => [api, scenario] as const),
  );

  it.each(REPLY_CASES)("%s answers 429 cursor_plan_limit instead of the %s reply", async (api, scenario) => {
    vi.stubEnv("FAKE_CLI_SCENARIO", scenario);
    const base = await start();
    const [path, body] = PLAIN_REQUESTS[api];
    const { status, text } = await post(base, path, body);
    expect(status).toBe(429);
    expect(JSON.parse(text)).toEqual(PLAN_LIMIT_BODY[api]);
    expect(fs.readFileSync(sessionsLog, "utf8")).toMatch(
      new RegExp(`ERROR POST ${path} \\S+ cursor_plan_limit account default, exit 0`),
    );
  });

  it.each(REPLY_CASES)("%s stream holds the %s reply back and ends with the error", async (api, scenario) => {
    vi.stubEnv("FAKE_CLI_SCENARIO", scenario);
    const base = await start();
    const [path, body] = PLAIN_REQUESTS[api];
    const { status, text } = await post(base, path, { ...body, stream: true });
    expect(status).toBe(200);
    expectPlanLimitStream(api, text);
  });

  it("reports the reply on the CLI's stderr when it exits non-zero", async () => {
    vi.stubEnv("FAKE_CLI_SCENARIO", "plan_limit_stderr");
    const base = await start();
    const { status, text } = await post(base, ...PLAIN_REQUESTS.chat);
    expect(status).toBe(429);
    expect(JSON.parse(text)).toEqual(PLAN_LIMIT_BODY.chat);
  });

  // The CLI exits 1 with "ActionRequiredError: Your team's prepaid balance
  // is used up ..." where ACP answers with a plan-limit reply.
  it.each(APIS)("%s reports the CLI's prepaid-balance error as a plan limit", async (api) => {
    vi.stubEnv("FAKE_CLI_SCENARIO", "prepaid_balance");
    const base = await start();
    const [path, body] = PLAIN_REQUESTS[api];
    const sync = await post(base, path, body);
    expect(sync.status).toBe(429);
    expect(JSON.parse(sync.text)).toEqual(PLAN_LIMIT_BODY[api]);
    const streamed = await post(base, path, { ...body, stream: true });
    expect(streamed.status).toBe(200);
    expectPlanLimitStream(api, streamed.text);
    expect(fs.readFileSync(sessionsLog, "utf8")).toMatch(
      new RegExp(`ERROR POST ${path} \\S+ cursor_plan_limit account default, exit 1`),
    );
  });

  it.each(APIS)("%s keeps an answer that only starts like the reply", async (api) => {
    vi.stubEnv("FAKE_CLI_SCENARIO", "upgrade_mention");
    const answer =
      "Upgrade your plan to continue using premium models, or pick a free one.";
    const base = await start();
    const [path, body] = PLAIN_REQUESTS[api];
    const sync = await post(base, path, body);
    expect(sync.status).toBe(200);
    expect(answerText(api, JSON.parse(sync.text))).toBe(answer);
    const streamed = await post(base, path, { ...body, stream: true });
    expect(streamedText(streamed.text)).toBe(answer);
    expect(streamed.text).not.toContain("cursor_plan_limit");
  });

  it.each(APIS)("%s stream releases a held prefix when the answer ends", async (api) => {
    vi.stubEnv("FAKE_CLI_SCENARIO", "plan_limit_prefix");
    const base = await start();
    const [path, body] = PLAIN_REQUESTS[api];
    const { text } = await post(base, path, { ...body, stream: true });
    expect(streamedText(text)).toBe("Upgrade your plan");
    expect(text).not.toContain("cursor_plan_limit");
  });
});

describe("Cursor plan limit, ACP mode (#65)", () => {
  const acp = (scenario: string) => ({
    useAcp: true,
    acpEnv: { FAKE_ACP_SCENARIO: scenario },
  });

  it.each(APIS)("%s plain turn answers 429", async (api) => {
    const base = await start(acp("plan_limit_text"));
    const [path, body] = PLAIN_REQUESTS[api];
    const { status, text } = await post(base, path, body);
    expect(status).toBe(429);
    expect(JSON.parse(text)).toEqual(PLAN_LIMIT_BODY[api]);
  });

  it.each(APIS)("%s plain stream ends with the error", async (api) => {
    const base = await start(acp("plan_limit_text"));
    const [path, body] = PLAIN_REQUESTS[api];
    const { text } = await post(base, path, { ...body, stream: true });
    expectPlanLimitStream(api, text);
  });

  it("reports a prompt error that carries the reply", async () => {
    const base = await start(acp("plan_limit_rpc_error"));
    const { status, text } = await post(base, ...PLAIN_REQUESTS.anthropic);
    expect(status).toBe(429);
    expect(JSON.parse(text)).toEqual(PLAN_LIMIT_BODY.anthropic);
  });

  // tool_choice that requires a call, the case that used to report
  // "Agent completed without the required tool call".
  const REQUIRED_TOOL = {
    chat: { tool_choice: "required" },
    responses: { tool_choice: "required" },
    anthropic: { tool_choice: { type: "any" } },
  } as const;

  it.each(APIS)("%s tool turn with a required call answers 429", async (api) => {
    const base = await start(acp("plan_limit_text"));
    const [path, body] = TOOL_REQUESTS[api];
    const { status, text } = await post(base, path, { ...body, ...REQUIRED_TOOL[api] });
    expect(status).toBe(429);
    expect(JSON.parse(text)).toEqual(PLAN_LIMIT_BODY[api]);
    expect(text).not.toContain("required tool call");
  });

  it.each(APIS)("%s tool stream holds the reply back and ends with the error", async (api) => {
    const base = await start(acp("plan_limit_text"));
    const [path, body] = TOOL_REQUESTS[api];
    const { text } = await post(base, path, { ...body, stream: true });
    expect(streamedText(text)).toBe("");
    const error = expectStreamFailure(api, text);
    expect(error).toMatchObject({ code: "cursor_plan_limit", message: PLAN_LIMIT_MESSAGE });
  });

  it("tool turn reports a prompt error that carries the reply", async () => {
    const base = await start(acp("plan_limit_rpc_error"));
    const { status, text } = await post(base, ...TOOL_REQUESTS.responses);
    expect(status).toBe(429);
    expect(JSON.parse(text)).toEqual(PLAN_LIMIT_BODY.responses);
  });
});

describe("Cursor plan limit with an account pool (#65)", () => {
  let accounts: string[];

  beforeEach(() => {
    accounts = ["acct-a", "acct-b"].map((name) => {
      const dir = join(workDir, `${name}-${Math.random().toString(36).slice(2)}`);
      fs.mkdirSync(dir);
      return dir;
    });
  });

  const stat = (dir: string) =>
    getAccountStats().find((account) => account.configDir === dir)!;

  it.each([
    ["CLI", false],
    ["ACP tool", true],
  ] as const)("%s turn rests the account and the next request rotates", async (_, acpTool) => {
    vi.stubEnv("FAKE_CLI_SCENARIO", "plan_limit");
    const base = await start({
      configDirs: accounts,
      ...(acpTool
        ? { useAcp: true, acpEnv: { FAKE_ACP_SCENARIO: "plan_limit_text" } }
        : {}),
    });
    const [path, body] = acpTool ? TOOL_REQUESTS.chat : PLAIN_REQUESTS.chat;
    const before = Date.now();
    expect((await post(base, path, body)).status).toBe(429);

    const [limited, other] = stat(accounts[0]).totalRequests === 1
      ? [accounts[0], accounts[1]]
      : [accounts[1], accounts[0]];
    expect(stat(limited)).toMatchObject({
      totalRequests: 1,
      totalErrors: 1,
      totalRateLimits: 1,
      isRateLimited: true,
      activeRequests: 0,
    });
    expect(stat(limited).rateLimitUntil).toBeGreaterThanOrEqual(
      before + PLAN_LIMIT_PENALTY_MS,
    );

    await post(base, path, body);
    expect(stat(other).totalRequests).toBe(1);
    expect(stat(limited).totalRequests).toBe(1);
  });
});
