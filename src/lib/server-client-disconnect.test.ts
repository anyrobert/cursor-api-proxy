import * as http from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { BridgeConfig } from "./config.js";
import { run } from "./process.js";
import { startBridgeServer } from "./server.js";

vi.mock("./cursor-cli.js", () => ({
  listCursorCliModels: vi
    .fn()
    .mockResolvedValue([{ id: "claude-3-opus", name: "Claude 3 Opus" }]),
}));

vi.mock("./process.js", () => ({
  killAllChildProcesses: vi.fn(),
  run: vi.fn(),
  runStreaming: vi.fn(),
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

function createTestConfig(overrides: Partial<BridgeConfig> = {}): BridgeConfig {
  return {
    agentBin: "agent",
    acpCommand: "agent",
    acpArgs: ["acp"],
    acpEnv: {},
    host: "127.0.0.1",
    port: 0,
    defaultModel: "default",
    mode: "ask",
    force: false,
    approveMcps: false,
    strictModel: true,
    workspace: process.cwd(),
    timeoutMs: 30_000,
    sessionsLogPath: "/tmp/cursor-proxy-disconnect-test.log",
    chatOnlyWorkspace: true,
    chatOnlyWorkspaceExplicit: false,
    verbose: false,
    maxMode: false,
    promptViaStdin: false,
    useAcp: false,
    acpSkipAuthenticate: false,
    acpRawDebug: false,
    configDirs: [],
    multiPort: false,
    winCmdlineMax: 30_000,
    contextPreamble: true,
    bridgePackageVersion: "0.0.0-test",
    ...overrides,
  };
}

/** Sends a request, then destroys the socket once the agent has been reached. */
function requestThenDisconnect(
  server: http.Server,
  body: string,
): Promise<void> {
  const port = (server.address() as { port: number }).port;
  return new Promise((resolve, reject) => {
    const req = http.request(
      `http://127.0.0.1:${port}/v1/chat/completions`,
      { method: "POST", headers: { "content-type": "application/json" } },
      () => {
        /* no response expected — we bail out first */
      },
    );
    req.on("error", () => resolve());
    req.write(body);
    req.end();
    setTimeout(() => {
      req.destroy();
      resolve();
    }, 150).unref?.();
    setTimeout(() => reject(new Error("disconnect timeout")), 5_000).unref?.();
  });
}

describe("client disconnect", () => {
  let servers: http.Server[] = [];

  afterEach(async () => {
    for (const s of servers) await new Promise((r) => s.close(r));
    servers = [];
    vi.mocked(run).mockReset();
  });

  it("aborts the agent when the client goes away mid-request", async () => {
    let seenSignal: AbortSignal | undefined;
    const agentReached = new Promise<void>((resolve) => {
      vi.mocked(run).mockImplementation((_bin, _args, opts) => {
        seenSignal = opts?.signal;
        resolve();
        return new Promise(() => {});
      });
    });

    servers = startBridgeServer({
      version: "1.0.0",
      config: createTestConfig(),
    }) as http.Server[];
    const server = servers[0];
    expect(server).toBeDefined();
    if (!server) return;
    await new Promise<void>((r) => server.on("listening", () => r()));

    const disconnected = requestThenDisconnect(
      server,
      JSON.stringify({
        model: "claude-3-opus",
        messages: [{ role: "user", content: "hi" }],
      }),
    );

    await agentReached;
    expect(seenSignal).toBeDefined();
    expect(seenSignal?.aborted).toBe(false);

    await disconnected;
    await vi.waitFor(() => {
      expect(seenSignal?.aborted).toBe(true);
    });
  });
});
