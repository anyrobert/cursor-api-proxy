import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { describe, it, expect, vi, beforeEach } from "vitest";

import type { BridgeConfig } from "./config.js";
import { runAgentSync, runAgentStream } from "./agent-runner.js";
import { runAcpStream, runAcpSync } from "./acp-client.js";
import { run, runStreaming } from "./process.js";

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

  it("runs a pool account on a private copy of its config dir (#63)", async () => {
    const account = fs.mkdtempSync(path.join(os.tmpdir(), "account-"));
    fs.writeFileSync(path.join(account, "cli-config.json"), '{"version":1}');
    let seen: { dir?: string; config?: string } = {};
    vi.mocked(runAcpSync).mockImplementationOnce(async (_cmd, _args, _prompt, opts) => {
      const dir = opts.env?.CURSOR_CONFIG_DIR;
      seen = { dir, config: fs.readFileSync(path.join(dir!, "cli-config.json"), "utf8") };
      return { code: 0, stdout: "ok", stderr: "" };
    });
    try {
      await runAgentSync(
        config(),
        "/tmp/ws",
        false,
        ["--print", "--mode", "agent", "--model", "auto"],
        undefined,
        "hello",
        account,
      );
      expect(seen.dir).toBeDefined();
      expect(seen.dir).not.toBe(account);
      expect(seen.config).toBe('{"version":1}');
      expect(fs.existsSync(seen.dir!)).toBe(false);
    } finally {
      fs.rmSync(account, { recursive: true, force: true });
    }
  });

  it("removes the run's config dir and temp dir when the run fails", async () => {
    const account = fs.mkdtempSync(path.join(os.tmpdir(), "account-"));
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-proxy-"));
    vi.mocked(runAcpStream).mockRejectedValueOnce(new Error("agent failed"));
    try {
      await expect(
        runAgentStream(
          config(),
          path.join(tempDir, "workspace"),
          true,
          ["--print", "--mode", "ask", "--model", "auto"],
          () => {},
          tempDir,
          "hello",
          account,
        ),
      ).rejects.toThrow("agent failed");
      const runConfigDir = vi.mocked(runAcpStream).mock.calls[0][3].env?.CURSOR_CONFIG_DIR;
      expect(runConfigDir).toMatch(/cursor-proxy-config-/);
      expect(fs.existsSync(runConfigDir!)).toBe(false);
      expect(fs.existsSync(tempDir)).toBe(false);
    } finally {
      fs.rmSync(account, { recursive: true, force: true });
    }
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

describe("plain CLI runs get their own config dir (#87)", () => {
  const CLI_ARGS = ["--print", "--mode", "ask", "--model", "auto"];

  beforeEach(() => {
    vi.mocked(run).mockClear();
    vi.mocked(runStreaming).mockClear();
  });

  /** A pool account dir and a chat-only isolation root, removed afterwards. */
  function dirs() {
    const account = fs.mkdtempSync(path.join(os.tmpdir(), "account-"));
    fs.writeFileSync(path.join(account, "cli-config.json"), '{"version":1}');
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-proxy-"));
    return {
      account,
      tempDir,
      cleanup: () => {
        for (const dir of [account, tempDir]) {
          fs.rmSync(dir, { recursive: true, force: true });
        }
      },
    };
  }

  it("runs a pool account on a private copy of its config dir", async () => {
    const { account, cleanup } = dirs();
    let seen: { dir?: string; config?: string } = {};
    vi.mocked(run).mockImplementationOnce(async (_cmd, _args, opts) => {
      const dir = opts?.envOverrides?.CURSOR_CONFIG_DIR;
      seen = { dir, config: fs.readFileSync(path.join(dir!, "cli-config.json"), "utf8") };
      return { code: 0, stdout: "cli", stderr: "" };
    });
    try {
      await runAgentSync(
        config({ useAcp: false }),
        "/tmp/ws",
        false,
        CLI_ARGS,
        undefined,
        "hello",
        account,
      );
      expect(seen.dir).toMatch(/cursor-proxy-config-/);
      expect(seen.config).toBe('{"version":1}');
      expect(fs.existsSync(seen.dir!)).toBe(false);
    } finally {
      cleanup();
    }
  });

  it("removes the copy and the temp dir when the CLI cannot start", async () => {
    const { account, tempDir, cleanup } = dirs();
    vi.mocked(runStreaming).mockRejectedValueOnce(new Error("Command not found: agent"));
    try {
      await expect(
        runAgentStream(
          config({ useAcp: false }),
          path.join(tempDir, "workspace"),
          true,
          CLI_ARGS,
          () => {},
          tempDir,
          "hello",
          account,
        ),
      ).rejects.toThrow("Command not found");
      const runConfigDir = vi.mocked(runStreaming).mock.calls[0][2].envOverrides?.CURSOR_CONFIG_DIR;
      expect(runConfigDir).toMatch(/cursor-proxy-config-/);
      expect(fs.existsSync(runConfigDir!)).toBe(false);
      expect(fs.existsSync(tempDir)).toBe(false);
    } finally {
      cleanup();
    }
  });

  it("removes the copy and the temp dir when starting the CLI throws", async () => {
    const { account, tempDir, cleanup } = dirs();
    vi.mocked(run).mockImplementationOnce(() => {
      throw new Error("spawn EINVAL");
    });
    try {
      await expect(
        runAgentSync(
          config({ useAcp: false }),
          path.join(tempDir, "workspace"),
          true,
          CLI_ARGS,
          tempDir,
          "hello",
          account,
        ),
      ).rejects.toThrow("spawn EINVAL");
      const runConfigDir = vi.mocked(run).mock.calls[0][2]?.envOverrides?.CURSOR_CONFIG_DIR;
      expect(runConfigDir).toMatch(/cursor-proxy-config-/);
      expect(fs.existsSync(runConfigDir!)).toBe(false);
      expect(fs.existsSync(tempDir)).toBe(false);
    } finally {
      cleanup();
    }
  });
});
