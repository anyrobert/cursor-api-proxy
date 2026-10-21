import * as http from "node:http";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { BridgeConfig } from "./config.js";
import { startBridgeServer } from "./server.js";

// Issue #66: an agent that dies before replying on the ACP tool path.
const CLIENT_SAFE_EXIT =
  "The Cursor agent process exited with code 1 before responding. See server logs for details.";
const CLI_STDERR = "agent: unknown option '--bogus-flag'";

vi.mock("./cursor-cli.js", () => ({
  listCursorCliModels: vi.fn().mockResolvedValue([{ id: "gpt-4", name: "gpt-4" }]),
}));

const fakeServerPath = join(
  process.cwd(),
  "src",
  "lib",
  "__tests__",
  "fake-acp-server.mjs",
);
const servers: http.Server[] = [];

function config(): BridgeConfig {
  return {
    agentBin: "agent",
    acpCommand: process.execPath,
    acpArgs: [fakeServerPath],
    acpEnv: { FAKE_ACP_SCENARIO: "start_failure" },
    host: "127.0.0.1",
    port: 0,
    defaultModel: "gpt-4",
    mode: "ask",
    force: false,
    approveMcps: false,
    strictModel: true,
    workspace: process.cwd(),
    timeoutMs: 10_000,
    sessionsLogPath: "/tmp/cursor-api-proxy-start-failure-test.log",
    chatOnlyWorkspace: true,
    chatOnlyWorkspaceExplicit: false,
    verbose: false,
    maxMode: false,
    promptViaStdin: false,
    useAcp: true,
    acpSkipAuthenticate: true,
    acpRawDebug: false,
    configDirs: [],
    multiPort: false,
    winCmdlineMax: 30_000,
    contextPreamble: false,
    bridgePackageVersion: "0.0.0-test",
  };
}

async function start(): Promise<string> {
  const [server] = startBridgeServer({ version: "test", config: config() });
  servers.push(server as http.Server);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No port");
  return `http://127.0.0.1:${address.port}`;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    servers.splice(0).map(
      (server) => new Promise<void>((resolve) => server.close(() => resolve())),
    ),
  );
});

const weather = { type: "object", properties: { city: { type: "string" } } };

const toolRequests: Array<[path: string, body: Record<string, unknown>]> = [
  [
    "/v1/chat/completions",
    {
      messages: [{ role: "user", content: "Weather?" }],
      tools: [{ type: "function", function: { name: "weather", parameters: weather } }],
    },
  ],
  [
    "/v1/messages",
    {
      max_tokens: 64,
      messages: [{ role: "user", content: "Weather?" }],
      tools: [{ name: "weather", input_schema: weather }],
    },
  ],
  [
    "/v1/responses",
    {
      input: "Weather?",
      tools: [{ type: "function", name: "weather", parameters: weather }],
    },
  ],
];

describe("ACP tool turn whose agent exits before replying", () => {
  it.each(toolRequests)(
    "%s returns a client-safe reason and logs the CLI output",
    async (path, body) => {
      const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
      vi.spyOn(console, "log").mockImplementation(() => undefined);
      const base = await start();
      const response = await fetch(`${base}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "gpt-4", ...body }),
      });
      const text = await response.text();
      expect(response.status).toBe(500);
      expect(JSON.parse(text).error.message).toBe(CLIENT_SAFE_EXIT);
      expect(text).not.toContain(CLI_STDERR);
      expect(logged.mock.calls.map((call) => String(call[0])).join("\n")).toContain(
        CLI_STDERR,
      );
    },
  );
});
