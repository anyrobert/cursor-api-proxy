import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { describe, it, expect, vi, beforeEach } from "vitest";

import type { BridgeConfig } from "./config.js";
import { runAgentSync, runAgentStream } from "./agent-runner.js";
import { runAcpStream, runAcpSync } from "./acp-client.js";

vi.mock("./acp-client.js", () => ({
  runAcpSync: vi.fn().mockResolvedValue({ code: 0, stdout: "ok", stderr: "" }),
  runAcpStream: vi.fn().mockResolvedValue({ code: 0, stderr: "" }),
}));

vi.mock("./process.js", () => ({
  run: vi.fn().mockResolvedValue({ code: 0, stdout: "cli", stderr: "" }),
  runStreaming: vi.fn().mockResolvedValue({ code: 0, stderr: "" }),
}));

vi.mock("./token-cache.js", () => ({
  readKeychainToken: vi.fn().mockReturnValue(undefined),
  writeCachedToken: vi.fn(),
}));

function config(overrides: Partial<BridgeConfig> = {}): BridgeConfig {
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
    timeoutMs: 123_456,
    sessionsLogPath: "/tmp/agent-runner-test.log",
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
    contextPreamble: true,
    bridgePackageVersion: "0.0.0-test",
    ...overrides,
  };
}

describe("ACP requestTimeoutMs", () => {
  beforeEach(() => {
    vi.mocked(runAcpSync).mockClear();
    vi.mocked(runAcpStream).mockClear();
  });

  it("passes config.timeoutMs as ACP sync requestTimeoutMs", async () => {
    await runAgentSync(
      config(),
      "/tmp/ws",
      true,
      ["--print", "--mode", "ask", "--model", "auto"],
      undefined,
      "hello",
    );
    expect(runAcpSync).toHaveBeenCalledTimes(1);
    expect(vi.mocked(runAcpSync).mock.calls[0][3]).toMatchObject({
      timeoutMs: 123_456,
      requestTimeoutMs: 123_456,
    });
  });

  it("removes the chat-only temp dir when the run fails", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-proxy-"));
    fs.mkdirSync(path.join(tempDir, "home"));
    vi.mocked(runAcpSync).mockRejectedValueOnce(new Error("agent failed"));
    await expect(
      runAgentSync(
        config(),
        path.join(tempDir, "workspace"),
        true,
        ["--print", "--mode", "ask", "--model", "auto"],
        tempDir,
        "hello",
      ),
    ).rejects.toThrow("agent failed");
    expect(fs.existsSync(tempDir)).toBe(false);
  });

  it("runs a chat-only agent with HOME beside the workspace, not in it", async () => {
    await runAgentSync(
      config(),
      "/tmp/root/workspace",
      true,
      ["--print", "--mode", "ask", "--model", "auto"],
      "/tmp/root",
      "hello",
    );
    const opts = vi.mocked(runAcpSync).mock.calls[0][3];
    expect(opts.cwd).toBe("/tmp/root/workspace");
    expect(opts.env).toMatchObject({
      HOME: "/tmp/root/home",
      CURSOR_CONFIG_DIR: "/tmp/root/home/.cursor",
    });
  });

  it("passes config.timeoutMs as ACP stream requestTimeoutMs", async () => {
    await runAgentStream(
      config(),
      "/tmp/ws",
      true,
      ["--print", "--mode", "ask", "--model", "auto"],
      () => {},
      undefined,
      "hello",
    );
    expect(runAcpStream).toHaveBeenCalledTimes(1);
    expect(vi.mocked(runAcpStream).mock.calls[0][3]).toMatchObject({
      timeoutMs: 123_456,
      requestTimeoutMs: 123_456,
    });
  });
});
