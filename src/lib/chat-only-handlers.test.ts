import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { BridgeConfig } from "./config.js";
import { run, runStreaming } from "./process.js";
import { startBridgeServer } from "./server.js";
import { fitPromptToWinCmdline } from "./win-cmdline-limit.js";

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
  logToolSession: vi.fn(),
  logAgentError: vi.fn().mockReturnValue("agent error"),
  appendSessionLine: vi.fn(),
  logAccountAssigned: vi.fn(),
  logAccountStats: vi.fn(),
}));

// A spy that keeps the real fit, so each test can read the prompt and cwd a
// handler built, or force the Windows command-line limit.
vi.mock("./win-cmdline-limit.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./win-cmdline-limit.js")>();
  return {
    ...actual,
    fitPromptToWinCmdline: vi.fn(actual.fitPromptToWinCmdline),
  };
});

/** The real project on the proxy host, which chat-only keeps the agent out of. */
const HOST_WORKSPACE = process.cwd();

function createTestConfig(): BridgeConfig {
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
    workspace: HOST_WORKSPACE,
    timeoutMs: 30_000,
    sessionsLogPath: "/tmp/chat-only-handlers-test.log",
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
  };
}

const endpoints = [
  {
    path: "/v1/chat/completions",
    body: { model: "claude-3-opus", messages: [{ role: "user", content: "hi" }] },
  },
  {
    path: "/v1/messages",
    body: {
      model: "claude-3-opus",
      max_tokens: 64,
      messages: [{ role: "user", content: "hi" }],
    },
  },
  {
    path: "/v1/responses",
    body: { model: "claude-3-opus", input: "hi" },
  },
];

describe("chat-only handlers", () => {
  let servers: http.Server[] = [];

  afterEach(async () => {
    for (const s of servers) await new Promise((r) => s.close(r));
    servers = [];
    vi.mocked(run).mockReset();
    vi.mocked(runStreaming).mockReset();
    vi.mocked(fitPromptToWinCmdline).mockClear();
  });

  async function post(endpoint: string, body: unknown): Promise<Response> {
    servers = startBridgeServer({
      version: "1.0.0",
      config: createTestConfig(),
    }) as http.Server[];
    await new Promise<void>((r) => servers[0].on("listening", () => r()));
    const { port } = servers[0].address() as { port: number };
    return fetch(`http://127.0.0.1:${port}${endpoint}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-cursor-workspace": HOST_WORKSPACE,
      },
      body: JSON.stringify(body),
    });
  }

  /** The prompt and cwd the handler built for its one agent run. */
  function agentInvocation(): { prompt: string; cwd: string } {
    expect(fitPromptToWinCmdline).toHaveBeenCalledTimes(1);
    const [, , prompt, opts] = vi.mocked(fitPromptToWinCmdline).mock.calls[0];
    return { prompt, cwd: opts.cwd! };
  }

  it.each(endpoints)(
    "$path names only the sandbox in the agent prompt",
    async ({ path: endpoint, body }) => {
      vi.mocked(run).mockResolvedValue({ code: 0, stdout: "ok", stderr: "" });

      const res = await post(endpoint, body);

      expect(res.status).toBe(200);
      const { prompt, cwd } = agentInvocation();
      expect(cwd).not.toBe(HOST_WORKSPACE);
      expect(prompt).toContain(`cwd=${cwd};`);
      expect(prompt).toContain("nothing outside it is in scope");
      expect(prompt).not.toContain(HOST_WORKSPACE);
      expect(fs.existsSync(path.dirname(cwd))).toBe(false);
    },
  );

  it.each(endpoints)(
    "$path removes the temp dir when it returns on the Windows command-line limit",
    async ({ path: endpoint, body }) => {
      vi.mocked(fitPromptToWinCmdline).mockReturnValueOnce({
        ok: false,
        error: "Windows command line exceeds the configured limit",
      });

      const res = await post(endpoint, body);

      expect(res.status).toBe(500);
      expect(JSON.stringify(await res.json())).toContain(
        "windows_cmdline_limit",
      );
      expect(run).not.toHaveBeenCalled();
      expect(runStreaming).not.toHaveBeenCalled();
      const tempDir = path.dirname(agentInvocation().cwd);
      expect(path.basename(tempDir)).toMatch(/^cursor-proxy-/);
      expect(fs.existsSync(tempDir)).toBe(false);
    },
  );
});
