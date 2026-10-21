import * as http from "node:http";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { BridgeConfig } from "./config.js";
import { startBridgeServer } from "./server.js";

// Issue #57: a listed id the ACP catalog cannot derive, served end to end.
const MODEL = "claude-4.6-sonnet-medium";

vi.mock("./cursor-cli.js", () => ({
  listCursorCliModels: vi.fn().mockResolvedValue([
    { id: "claude-4.6-sonnet-medium", name: "Claude Sonnet 4.6 1M" },
  ]),
}));

const fakeServerPath = join(
  process.cwd(),
  "src",
  "lib",
  "__tests__",
  "fake-acp-server.mjs",
);
const servers: http.Server[] = [];

function config(acpEnv: Record<string, string>): BridgeConfig {
  return {
    agentBin: "agent",
    acpCommand: process.execPath,
    // "acp" lets agent-runner add --model like it does for the real CLI.
    acpArgs: [fakeServerPath, "acp"],
    acpEnv: { FAKE_ACP_SCENARIO: "real_catalog", ...acpEnv },
    host: "127.0.0.1",
    port: 0,
    defaultModel: "default",
    mode: "ask",
    force: false,
    approveMcps: false,
    strictModel: true,
    workspace: process.cwd(),
    timeoutMs: 10_000,
    sessionsLogPath: "/tmp/cursor-api-proxy-acp-model-test.log",
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

async function start(acpEnv: Record<string, string> = {}): Promise<string> {
  const [server] = startBridgeServer({ version: "test", config: config(acpEnv) });
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

const requests: Array<[path: string, body: Record<string, unknown>]> = [
  ["/v1/chat/completions", { messages: [{ role: "user", content: "hi" }] }],
  ["/v1/messages", { max_tokens: 64, messages: [{ role: "user", content: "hi" }] }],
  ["/v1/responses", { input: "hi" }],
];

async function post(base: string, path: string, body: Record<string, unknown>) {
  const response = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: MODEL, ...body }),
  });
  return { status: response.status, text: await response.text() };
}

describe.each([false, true])("ACP model selection over HTTP, stream=%s", (stream) => {
  it.each(requests)("%s runs on the model the CLI selected, at 1M context", async (path, body) => {
    const base = await start();
    const response = await post(base, path, { ...body, stream });
    expect(response.status).toBe(200);
    // The fake CLI answers with the selection the turn ran on.
    expect(response.text).toContain("claude-sonnet-4-6");
    // Issue #73: the "1M" display name reaches the model decision.
    expect(response.text).toContain("context=1m");
    expect(response.text).not.toContain("cursor_cli_error");
  });

  it.each(requests)("%s returns the selection error, not the exit code", async (path, body) => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const base = await start({ FAKE_ACP_CURRENT_MODEL: "default" });
    const response = await post(base, path, { ...body, stream });
    expect(response.status).toBe(stream ? 200 : 500);
    expect(response.text).toContain("ACP model catalog has no match for");
    expect(response.text).toContain(MODEL);
    expect(response.text).toContain("session model: default");
    expect(response.text).not.toContain("exited with code");
  });
});
