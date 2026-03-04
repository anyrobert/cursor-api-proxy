import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { loadBridgeConfig } from "./config.js";
import * as path from "node:path";

const ENV_BACKUP: Record<string, string | undefined> = {};

function setEnv(key: string, value: string | undefined) {
  ENV_BACKUP[key] = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

function restoreEnv() {
  for (const [key, val] of Object.entries(ENV_BACKUP)) {
    if (val === undefined) delete process.env[key];
    else process.env[key] = val;
  }
}

describe("loadBridgeConfig", () => {
  const configKeys = [
    "CURSOR_AGENT_BIN",
    "CURSOR_CLI_BIN",
    "CURSOR_BRIDGE_HOST",
    "CURSOR_BRIDGE_PORT",
    "CURSOR_BRIDGE_API_KEY",
    "CURSOR_BRIDGE_DEFAULT_MODEL",
    "CURSOR_BRIDGE_FORCE",
    "CURSOR_BRIDGE_APPROVE_MCPS",
    "CURSOR_BRIDGE_STRICT_MODEL",
    "CURSOR_BRIDGE_WORKSPACE",
    "CURSOR_BRIDGE_SESSIONS_LOG",
    "CURSOR_BRIDGE_TIMEOUT_MS",
    "CURSOR_BRIDGE_CHAT_ONLY_WORKSPACE",
    "HOME",
    "USERPROFILE",
  ];

  beforeEach(() => {
    for (const key of configKeys) {
      ENV_BACKUP[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(restoreEnv);

  it("returns defaults when env is empty", () => {
    const config = loadBridgeConfig();
    expect(config.agentBin).toBe("agent");
    expect(config.host).toBe("127.0.0.1");
    expect(config.port).toBe(8765);
    expect(config.requiredKey).toBeUndefined();
    expect(config.defaultModel).toBe("auto");
    expect(config.force).toBe(false);
    expect(config.approveMcps).toBe(false);
    expect(config.strictModel).toBe(true);
    expect(config.mode).toBe("ask");
    expect(config.chatOnlyWorkspace).toBe(true);
  });

  it("uses CURSOR_AGENT_BIN for agent path", () => {
    setEnv("CURSOR_AGENT_BIN", "/usr/bin/agent");
    const config = loadBridgeConfig();
    expect(config.agentBin).toBe("/usr/bin/agent");
  });

  it("uses CURSOR_BRIDGE_HOST for host", () => {
    setEnv("CURSOR_BRIDGE_HOST", "0.0.0.0");
    const config = loadBridgeConfig();
    expect(config.host).toBe("0.0.0.0");
  });

  it("uses CURSOR_BRIDGE_PORT for port", () => {
    setEnv("CURSOR_BRIDGE_PORT", "9999");
    const config = loadBridgeConfig();
    expect(config.port).toBe(9999);
  });

  it("uses CURSOR_BRIDGE_API_KEY for requiredKey", () => {
    setEnv("CURSOR_BRIDGE_API_KEY", "sk-secret");
    const config = loadBridgeConfig();
    expect(config.requiredKey).toBe("sk-secret");
  });

  it("normalizes default model id", () => {
    setEnv("CURSOR_BRIDGE_DEFAULT_MODEL", "org/claude-3-opus");
    const config = loadBridgeConfig();
    expect(config.defaultModel).toBe("claude-3-opus");
  });

  it("parses CURSOR_BRIDGE_FORCE as boolean", () => {
    setEnv("CURSOR_BRIDGE_FORCE", "true");
    expect(loadBridgeConfig().force).toBe(true);
    setEnv("CURSOR_BRIDGE_FORCE", "1");
    expect(loadBridgeConfig().force).toBe(true);
    setEnv("CURSOR_BRIDGE_FORCE", "false");
    expect(loadBridgeConfig().force).toBe(false);
    setEnv("CURSOR_BRIDGE_FORCE", "0");
    expect(loadBridgeConfig().force).toBe(false);
  });

  it("parses CURSOR_BRIDGE_APPROVE_MCPS as boolean", () => {
    setEnv("CURSOR_BRIDGE_APPROVE_MCPS", "yes");
    expect(loadBridgeConfig().approveMcps).toBe(true);
    setEnv("CURSOR_BRIDGE_APPROVE_MCPS", "off");
    expect(loadBridgeConfig().approveMcps).toBe(false);
  });

  it("parses CURSOR_BRIDGE_STRICT_MODEL as boolean", () => {
    setEnv("CURSOR_BRIDGE_STRICT_MODEL", "false");
    expect(loadBridgeConfig().strictModel).toBe(false);
  });

  it("resolves CURSOR_BRIDGE_WORKSPACE to absolute path", () => {
    setEnv("CURSOR_BRIDGE_WORKSPACE", "./my-workspace");
    const config = loadBridgeConfig();
    expect(path.isAbsolute(config.workspace)).toBe(true);
    expect(config.workspace).toContain("my-workspace");
  });

  it("uses CURSOR_BRIDGE_TIMEOUT_MS for timeout", () => {
    setEnv("CURSOR_BRIDGE_TIMEOUT_MS", "60000");
    const config = loadBridgeConfig();
    expect(config.timeoutMs).toBe(60000);
  });

  it("parses CURSOR_BRIDGE_CHAT_ONLY_WORKSPACE", () => {
    setEnv("CURSOR_BRIDGE_CHAT_ONLY_WORKSPACE", "false");
    expect(loadBridgeConfig().chatOnlyWorkspace).toBe(false);
    setEnv("CURSOR_BRIDGE_CHAT_ONLY_WORKSPACE", "0");
    expect(loadBridgeConfig().chatOnlyWorkspace).toBe(false);
  });
});
