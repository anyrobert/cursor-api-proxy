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
const INTERNAL =
  "The proxy could not handle the request. See server logs for details.";

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

describe("agent that cannot be started on a sync turn", () => {
  // The ACP child's spawn error ("spawn <path> ENOENT") rejects the turn,
  // and the request listener answers it.
  let base: string;
  let missingAcp: string;

  beforeEach(async () => {
    missingAcp = join(workDir, "no-such-acp-agent");
    base = await start({
      agentBin: fakeAgent("agent-catalog", "echo 'auto - Auto'"),
      useAcp: true,
      acpCommand: missingAcp,
      acpArgs: [],
      acpEnv: {},
    });
  });

  it.each(["chat", "responses", "anthropic"] as const)(
    "%s answers a generic 500 in the API's shape and logs the spawn error",
    async (api) => {
      const { status, text } = await post(base, api);

      expect(status).toBe(500);
      expect(JSON.parse(text)).toEqual(errorBody(api, 500, "internal_error", INTERNAL));
      expect(text).not.toContain(workDir);
      expect(consoleErrors()).toContain(missingAcp);
      expect(sessionsLogText()).toContain(" internal_error ");
    },
  );
});

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

describe("API key (#102)", () => {
  // With CURSOR_BRIDGE_API_KEY set, the key is read from Authorization: Bearer
  // (OpenAI SDKs) or x-api-key (Anthropic SDKs), and a refused request is
  // answered in the error shape of the API that was called.
  const KEY = "sk-proxy-secret";
  const MISSING =
    "Missing API key. Send it in an 'Authorization: Bearer <key>' or an 'x-api-key: <key>' header.";
  const INVALID = "Invalid API key";
  const BEARER = { authorization: `Bearer ${KEY}` };
  const X_API_KEY = { "x-api-key": KEY };

  /** The 401 each API's clients parse, as OpenAI and Anthropic send it. */
  function unauthorizedBody(api: Api | "proxy", message: string) {
    if (api === "anthropic") {
      return {
        type: "error",
        error: { type: "authentication_error", message, code: "invalid_api_key" },
      };
    }
    if (api === "proxy") return { error: { message, code: "invalid_api_key" } };
    return {
      error: { message, type: "invalid_request_error", param: null, code: "invalid_api_key" },
    };
  }

  /**
   * Sends `api` a body that is not JSON, so a request the key lets through
   * is answered 400 invalid_json before any agent runs.
   */
  async function postApi(base: string, api: Api, headers: Record<string, string>) {
    const [path] = API_REQUESTS[api];
    const response = await fetch(`${base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: "{",
    });
    return { status: response.status, body: await response.json() };
  }

  async function get(base: string, path: string, headers: Record<string, string> = {}) {
    const response = await fetch(`${base}${path}`, { headers });
    return { status: response.status, text: await response.text() };
  }

  describe.each(["chat", "responses", "anthropic"] as const)("%s", (api) => {
    let base: string;

    beforeEach(async () => {
      base = await start({ agentBin: join(workDir, "no-such-agent"), requiredKey: KEY });
    });

    it.each([
      ["Authorization: Bearer", BEARER],
      ["x-api-key", X_API_KEY],
    ])("accepts the key in %s", async (_header, headers) => {
      const { status, body } = await postApi(base, api, headers);

      expect(status).toBe(400);
      expect(body).toEqual(errorBody(api, 400, "invalid_json", expect.any(String)));
    });

    it("answers a request without a key with a 401 in the API's shape", async () => {
      const { status, body } = await postApi(base, api, {});

      expect(status).toBe(401);
      expect(body).toEqual(unauthorizedBody(api, MISSING));
    });

    it.each([
      ["a wrong Bearer token", { authorization: "Bearer sk-proxy-secreT" }],
      ["a wrong x-api-key", { "x-api-key": "sk-proxy-secreT" }],
      ["a key that only starts with the right one", { "x-api-key": `${KEY}x` }],
      [
        "a wrong Bearer token beside the right x-api-key",
        { ...X_API_KEY, authorization: "Bearer sk-wrong" },
      ],
    ])("answers %s with a 401 in the API's shape", async (_case, headers) => {
      const { status, body } = await postApi(base, api, headers);

      expect(status).toBe(401);
      expect(body).toEqual(unauthorizedBody(api, INVALID));
    });
  });

  describe("the proxy's own routes", () => {
    let base: string;

    beforeEach(async () => {
      base = await start({
        agentBin: fakeAgent("agent-catalog-102", "echo 'auto - Auto'"),
        requiredKey: KEY,
      });
    });

    it.each([
      ["no key", {}, MISSING],
      ["a wrong Bearer token", { authorization: "Bearer sk-wrong" }, INVALID],
      ["a wrong x-api-key", { "x-api-key": "sk-wrong" }, INVALID],
    ])("answer %s with a 401 in the proxy's shape", async (_case, headers, message) => {
      for (const path of ["/health", "/v1/models", "/v1/embeddings"]) {
        const { status, text } = await get(base, path, headers);

        expect(status).toBe(401);
        expect(JSON.parse(text)).toEqual(unauthorizedBody("proxy", message));
      }
    });

    it.each([
      ["Authorization: Bearer", BEARER],
      ["x-api-key", X_API_KEY],
    ])("accept the key in %s", async (_header, headers) => {
      expect((await get(base, "/health", headers)).status).toBe(200);
      const models = await get(base, "/v1/models", headers);
      expect(models.status).toBe(200);
      expect(JSON.parse(models.text).data).toEqual([
        expect.objectContaining({ id: "auto" }),
      ]);
      expect((await get(base, "/v1/embeddings", headers)).status).toBe(404);
    });

    it.each(["/healthz", "/", "/wiki", "/static/styles.css"])(
      "serve GET %s without a key",
      async (path) => {
        expect((await get(base, path)).status).toBe(200);
      },
    );
  });

  describe("without CURSOR_BRIDGE_API_KEY", () => {
    let base: string;

    beforeEach(async () => {
      base = await start({ agentBin: join(workDir, "no-such-agent") });
    });

    it.each([
      ["no key", {}],
      ["any Bearer token", { authorization: "Bearer anything" }],
      ["any x-api-key", { "x-api-key": "anything" }],
    ])("lets a request with %s through", async (_case, headers) => {
      expect((await get(base, "/health", headers)).status).toBe(200);
      for (const api of ["chat", "responses", "anthropic"] as const) {
        expect((await postApi(base, api, headers)).status).toBe(400);
      }
    });
  });
});
