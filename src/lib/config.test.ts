import * as path from "node:path";
import { describe, expect, it } from "vitest";

import { loadBridgeConfig } from "./config.js";

describe("loadBridgeConfig", () => {
  it("returns defaults when env is empty", () => {
    const config = loadBridgeConfig({ env: {}, cwd: "/workspace" });

    expect(config.agentBin).toBe("agent");
    expect(config.host).toBe("127.0.0.1");
    expect(config.port).toBe(8765);
    expect(config.requiredKey).toBeUndefined();
    expect(config.defaultModel).toBe("auto");
    expect(config.force).toBe(false);
    expect(config.approveMcps).toBe(false);
    expect(config.strictModel).toBe(true);
    expect(config.mode).toBe("ask");
    expect(config.workspace).toBe("/workspace");
    expect(config.chatOnlyWorkspace).toBe(true);
    expect(config.sessionsLogPath).toBe("/workspace/sessions.log");
  });

  it("assembles config from the centralized env layer", () => {
    const config = loadBridgeConfig({
      env: {
        CURSOR_AGENT_BIN: "/usr/bin/agent",
        CURSOR_BRIDGE_HOST: "0.0.0.0",
        CURSOR_BRIDGE_PORT: "9999",
        CURSOR_BRIDGE_API_KEY: "sk-secret",
        CURSOR_BRIDGE_DEFAULT_MODEL: "org/claude-3-opus",
        CURSOR_BRIDGE_FORCE: "true",
        CURSOR_BRIDGE_APPROVE_MCPS: "yes",
        CURSOR_BRIDGE_STRICT_MODEL: "false",
        CURSOR_BRIDGE_WORKSPACE: "./my-workspace",
        CURSOR_BRIDGE_TIMEOUT_MS: "60000",
        CURSOR_BRIDGE_CHAT_ONLY_WORKSPACE: "false",
        CURSOR_BRIDGE_VERBOSE: "1",
        CURSOR_BRIDGE_TLS_CERT: "./certs/test.crt",
        CURSOR_BRIDGE_TLS_KEY: "./certs/test.key",
      },
      cwd: "/tmp/project",
    });

    expect(config.agentBin).toBe("/usr/bin/agent");
    expect(config.host).toBe("0.0.0.0");
    expect(config.port).toBe(9999);
    expect(config.requiredKey).toBe("sk-secret");
    expect(config.defaultModel).toBe("claude-3-opus");
    expect(config.force).toBe(true);
    expect(config.approveMcps).toBe(true);
    expect(config.strictModel).toBe(false);
    expect(path.isAbsolute(config.workspace)).toBe(true);
    expect(config.workspace).toContain("my-workspace");
    expect(config.timeoutMs).toBe(60000);
    expect(config.chatOnlyWorkspace).toBe(false);
    expect(config.verbose).toBe(true);
    expect(config.tlsCertPath).toBe("/tmp/project/certs/test.crt");
    expect(config.tlsKeyPath).toBe("/tmp/project/certs/test.key");
  });

  it("sets acpSkipAuthenticate and acpEnv when CURSOR_API_KEY is set", () => {
    const config = loadBridgeConfig({
      env: { CURSOR_API_KEY: "sk-abc", CURSOR_AGENT_BIN: "agent" },
      cwd: "/workspace",
    });
    expect(config.acpSkipAuthenticate).toBe(true);
    expect(config.acpEnv.CURSOR_API_KEY).toBe("sk-abc");
    expect(config.acpEnv.CURSOR_AUTH_TOKEN).toBe("sk-abc");
  });

  it("allows CURSOR_BRIDGE_ACP_SKIP_AUTHENTICATE to force skip", () => {
    const config = loadBridgeConfig({
      env: {
        CURSOR_BRIDGE_ACP_SKIP_AUTHENTICATE: "true",
        CURSOR_AGENT_BIN: "agent",
      },
      cwd: "/workspace",
    });
    expect(config.acpSkipAuthenticate).toBe(true);
  });

  it("sets acpRawDebug when CURSOR_BRIDGE_ACP_RAW_DEBUG=1", () => {
    const config = loadBridgeConfig({
      env: { CURSOR_BRIDGE_ACP_RAW_DEBUG: "1", CURSOR_AGENT_BIN: "agent" },
      cwd: "/workspace",
    });
    expect(config.acpRawDebug).toBe(true);
  });

  it("uses tailscale host fallback without mutating process.env", () => {
    const config = loadBridgeConfig({
      env: {},
      tailscale: true,
      cwd: "/workspace",
    });

    expect(config.host).toBe("0.0.0.0");
  });
});
