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
import { loadBridgeConfig } from "./config.js";
import { createRequestListener } from "./request-listener.js";
import { ToolSessionRegistry } from "./tool-session-registry.js";

// Issue #89: an error a route throws reaches the client without CLI output
// or proxy-host paths, in the error shape of the API the request was for.

const SECRET_STDERR = "agent: token=secret-models-detail";
const MODEL_CHECK_FAILED =
  "The Cursor CLI could not list models. See server logs for details.";

let workDir: string;
let sessionsLog: string;
let consoleError: MockInstance<typeof console.error>;
const servers: http.Server[] = [];

beforeAll(() => {
  workDir = fs.mkdtempSync(join(tmpdir(), "request-listener-test-"));
});

afterAll(() => {
  fs.rmSync(workDir, { recursive: true, force: true });
});

beforeEach(() => {
  sessionsLog = join(workDir, `sessions-${Date.now()}-${Math.random()}.log`);
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

/** A stand-in `agent` that runs `script` (sh) and never talks to Cursor. */
function fakeAgent(name: string, script: string): string {
  const bin = join(workDir, name);
  fs.writeFileSync(bin, `#!/bin/sh\n${script}\n`, { mode: 0o755 });
  return bin;
}

async function start(overrides: Partial<BridgeConfig>): Promise<string> {
  const config: BridgeConfig = {
    ...loadBridgeConfig({ env: {}, cwd: workDir }),
    sessionsLogPath: sessionsLog,
    configDirs: [],
    defaultModel: "auto",
    timeoutMs: 10_000,
    ...overrides,
  };
  const server = http.createServer(
    createRequestListener(
      { version: "test", config },
      { toolSessions: new ToolSessionRegistry() },
    ),
  );
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No port");
  return `http://127.0.0.1:${address.port}`;
}

const API_REQUESTS = {
  chat: ["/v1/chat/completions", { messages: [{ role: "user", content: "Hi" }] }],
  responses: ["/v1/responses", { input: "Hi" }],
  anthropic: [
    "/v1/messages",
    { max_tokens: 16, messages: [{ role: "user", content: "Hi" }] },
  ],
} as const;

type Api = keyof typeof API_REQUESTS;

/** The error body each API's clients parse, for a 400 or a 500. */
function errorBody(api: Api, status: 400 | 500, code: string, message: unknown) {
  if (api === "anthropic") {
    const type = status === 400 ? "invalid_request_error" : "api_error";
    return { type: "error", error: { type, message, code } };
  }
  const type = status === 400 ? "invalid_request_error" : "server_error";
  return { error: { message, type, param: null, code } };
}

async function post(
  base: string,
  api: Api,
  extra: Record<string, unknown> = {},
) {
  const [path, body] = API_REQUESTS[api];
  const response = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "auto", ...body, ...extra }),
  });
  return { status: response.status, text: await response.text() };
}

function consoleErrors(): string {
  return consoleError.mock.calls.map((call) => call.map(String).join(" ")).join("\n");
}

function sessionsLogText(): string {
  return fs.existsSync(sessionsLog) ? fs.readFileSync(sessionsLog, "utf8") : "";
}

describe("model check that fails", () => {
  let failingAgent: string;

  beforeAll(() => {
    failingAgent = fakeAgent("agent-list-models-fails", `echo '${SECRET_STDERR}' >&2\nexit 1`);
  });

  describe.each(["chat", "responses", "anthropic"] as const)("%s", (api) => {
    it.each([false, true])(
      "stream=%s answers 500 in the API's shape without the path or stderr",
      async (stream) => {
        const base = await start({ agentBin: failingAgent });
        const { status, text } = await post(base, api, { stream });

        expect(status).toBe(500);
        expect(JSON.parse(text)).toEqual(
          errorBody(api, 500, "cursor_cli_error", MODEL_CHECK_FAILED),
        );
        expect(text).not.toContain(workDir);
        expect(text).not.toContain("secret-models-detail");
      },
    );

    it("logs the binary's path and the CLI's stderr", async () => {
      const base = await start({ agentBin: failingAgent });
      await post(base, api);

      const logged = consoleErrors();
      expect(logged).toContain(JSON.stringify(failingAgent));
      expect(logged).toContain("--list-models exited 1");
      expect(logged).toContain(SECRET_STDERR);
      const [path] = API_REQUESTS[api];
      const errorLine = sessionsLogText()
        .split("\n")
        .find((line) => line.includes(" ERROR "));
      expect(errorLine).toContain(` ERROR POST ${path} `);
      expect(errorLine).toContain(" cursor_cli_error ");
      expect(errorLine).toContain(failingAgent);
    });
  });

  it("GET /v1/models keeps the proxy's error shape without the path or stderr", async () => {
    const base = await start({ agentBin: failingAgent });
    const response = await fetch(`${base}/v1/models`);
    const text = await response.text();

    expect(response.status).toBe(500);
    expect(JSON.parse(text)).toEqual({
      error: { message: MODEL_CHECK_FAILED, code: "cursor_cli_error" },
    });
    expect(text).not.toContain(workDir);
    expect(consoleErrors()).toContain(SECRET_STDERR);
  });

  it("reports a missing binary without its path", async () => {
    const missing = join(workDir, "no-such-agent");
    const base = await start({ agentBin: missing });
    const { status, text } = await post(base, "anthropic");

    expect(status).toBe(500);
    expect(JSON.parse(text)).toEqual(
      errorBody("anthropic", 500, "cursor_cli_error", MODEL_CHECK_FAILED),
    );
    expect(text).not.toContain(workDir);
    expect(consoleErrors()).toContain(missing);
  });
});

// An agent that cannot be started, and the catch-all's generic answer for
// anything else, are covered in agent-start-failure-api.test.ts (#100).

describe("model API body that is not JSON", () => {
  it.each(["chat", "responses", "anthropic"] as const)(
    "%s answers 400 invalid_json in the API's shape",
    async (api) => {
      const base = await start({ agentBin: join(workDir, "no-such-agent") });
      const [path] = API_REQUESTS[api];
      const response = await fetch(`${base}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: '{"model": "auto",',
      });

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual(
        errorBody(
          api,
          400,
          "invalid_json",
          expect.stringMatching(/^Could not parse the request body as JSON: \S/),
        ),
      );
      expect(consoleErrors()).not.toContain("Proxy error");
    },
  );
});
