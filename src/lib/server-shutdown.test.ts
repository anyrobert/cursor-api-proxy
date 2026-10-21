import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { BridgeConfig } from "./config.js";
import {
  setupGracefulShutdown,
  shutdownBridge,
  startBridgeServer,
  type BridgeHttpServer,
} from "./server.js";
import { ToolSessionRegistry } from "./tool-session-registry.js";

vi.mock("./cursor-cli.js", () => ({
  listCursorCliModels: vi.fn().mockResolvedValue([
    { id: "gpt-4", name: "gpt-4" },
  ]),
}));

const fakeServerPath = join(
  process.cwd(),
  "src",
  "lib",
  "__tests__",
  "fake-acp-server.mjs",
);

const weatherTool = {
  type: "function",
  function: {
    name: "weather",
    description: "Get weather",
    parameters: { type: "object", properties: { city: { type: "string" } } },
  },
};

let root: string;
/** os.tmpdir() of this file: where every run dir of the proxy lands. */
let tmp: string;
let servers: BridgeHttpServer[] = [];

beforeEach(() => {
  root = fs.mkdtempSync(join(os.tmpdir(), "server-shutdown-test-"));
  tmp = join(root, "tmp");
  fs.mkdirSync(tmp);
  fs.mkdirSync(join(root, "workspace"));
  for (const key of ["TMPDIR", "TMP", "TEMP"]) vi.stubEnv(key, tmp);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    servers.splice(0).map((server) => {
      server.closeAllConnections();
      return new Promise<void>((resolve) => server.close(() => resolve()));
    }),
  );
  vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
});

function config(overrides: Partial<BridgeConfig> = {}): BridgeConfig {
  return {
    agentBin: "agent",
    acpCommand: process.execPath,
    acpArgs: [fakeServerPath],
    acpEnv: { FAKE_ACP_SCENARIO: "tool_call" },
    host: "127.0.0.1",
    port: 0,
    defaultModel: "gpt-4",
    mode: "ask",
    force: false,
    approveMcps: false,
    strictModel: true,
    workspace: join(root, "workspace"),
    timeoutMs: 10_000,
    sessionsLogPath: join(root, "sessions.log"),
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
    ...overrides,
  };
}

async function start(overrides: Partial<BridgeConfig> = {}): Promise<string> {
  const [server] = startBridgeServer({ version: "test", config: config(overrides) });
  servers.push(server);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No port");
  return `http://127.0.0.1:${address.port}`;
}

function chat(base: string, body: Record<string, unknown>) {
  return fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "gpt-4",
      messages: [{ role: "user", content: "Weather?" }],
      ...body,
    }),
  });
}

/** Leaves a client-tool turn parked, waiting for the tool's output. */
async function parkToolTurn(base: string): Promise<void> {
  const response = await chat(base, { tools: [weatherTool] });
  expect(response.status).toBe(200);
  const payload = (await response.json()) as {
    choices: { finish_reason: string }[];
  };
  expect(payload.choices[0].finish_reason).toBe("tool_calls");
}

/** Records what is left in the run-dir root when exit is called. */
function recordingExit() {
  const atExit: string[][] = [];
  const exit = vi.fn((_code: number) => {
    atExit.push(fs.readdirSync(tmp));
  });
  return { exit, atExit };
}

describe("shutdownBridge (#90)", () => {
  it("removes the run dirs of parked tool turns on every server before exit", async () => {
    // A chat-only turn owns a temp workspace; a workspace turn owns a
    // private copy of the CLI config. Two servers, as in multi-port mode.
    const chatOnly = await start();
    const workspace = await start({ chatOnlyWorkspace: false });
    await parkToolTurn(chatOnly);
    await parkToolTurn(workspace);
    expect(fs.readdirSync(tmp).length).toBeGreaterThanOrEqual(2);

    const { exit, atExit } = recordingExit();
    await shutdownBridge(servers, { exit });

    expect(exit).toHaveBeenCalledExactlyOnceWith(0);
    expect(atExit).toEqual([[]]);
    expect(servers.every((server) => !server.listening)).toBe(true);
  });

  it("waits for a turn still running to clean up before exit", async () => {
    const base = await start({ acpEnv: { FAKE_ACP_SCENARIO: "hang_prompt" } });
    const running = chat(base, { stream: false }).catch(() => undefined);
    await vi.waitFor(() => expect(fs.readdirSync(tmp)).toHaveLength(1));

    const { exit, atExit } = recordingExit();
    await shutdownBridge(servers, { exit });
    await running;

    expect(exit).toHaveBeenCalledExactlyOnceWith(0);
    expect(atExit).toEqual([[]]);
  });

  it("awaits closeAll before exit", async () => {
    await start();
    let finish!: () => void;
    const closeAll = vi
      .spyOn(ToolSessionRegistry.prototype, "closeAll")
      .mockReturnValue(new Promise<void>((resolve) => (finish = resolve)));
    const exit = vi.fn();

    const done = shutdownBridge(servers, { exit });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(closeAll).toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();

    finish();
    await done;
    expect(exit).toHaveBeenCalledExactlyOnceWith(0);
  });

  it("stops waiting for the cleanup after cleanupTimeoutMs", async () => {
    await start();
    vi.spyOn(ToolSessionRegistry.prototype, "closeAll").mockReturnValue(
      new Promise<void>(() => {}),
    );
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const exit = vi.fn();

    const startedAt = Date.now();
    await shutdownBridge(servers, { exit, cleanupTimeoutMs: 80 });

    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(70);
    expect(Date.now() - startedAt).toBeLessThan(2_000);
    expect(exit).toHaveBeenCalledExactlyOnceWith(0);
    expect(error).toHaveBeenCalledWith(
      expect.stringMatching(/Timed out waiting for agent sessions/),
    );
  });
});

describe("setupGracefulShutdown", () => {
  it("shuts down on SIGTERM and exits at once on a second signal", async () => {
    await start();
    vi.spyOn(ToolSessionRegistry.prototype, "closeAll").mockReturnValue(
      new Promise<void>(() => {}),
    );
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const signals = new EventEmitter();
    const exit = vi.fn();
    setupGracefulShutdown(servers, { signals, exit, cleanupTimeoutMs: 100 });

    signals.emit("SIGTERM");
    await vi.waitFor(() => expect(servers[0].listening).toBe(false));
    expect(exit).not.toHaveBeenCalled();

    signals.emit("SIGINT");
    expect(exit).toHaveBeenCalledExactlyOnceWith(1);

    // The graceful path still ends once its cleanup bound runs out.
    await vi.waitFor(() => expect(exit).toHaveBeenCalledTimes(2));
    expect(exit).toHaveBeenLastCalledWith(0);
  });
});
