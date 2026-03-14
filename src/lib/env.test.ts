import * as path from "node:path";

import { describe, expect, it } from "vitest";

import { loadEnvConfig, resolveAgentCommand } from "./env.js";

describe("loadEnvConfig", () => {
  it("returns defaults when env is empty", () => {
    const loaded = loadEnvConfig({ env: {}, cwd: "/workspace" });

    expect(loaded.agentBin).toBe("agent");
    expect(loaded.host).toBe("127.0.0.1");
    expect(loaded.port).toBe(8765);
    expect(loaded.defaultModel).toBe("auto");
    expect(loaded.force).toBe(false);
    expect(loaded.approveMcps).toBe(false);
    expect(loaded.strictModel).toBe(true);
    expect(loaded.workspace).toBe("/workspace");
    expect(loaded.sessionsLogPath).toBe("/workspace/sessions.log");
    expect(loaded.chatOnlyWorkspace).toBe(true);
    expect(loaded.verbose).toBe(false);
    expect(loaded.commandShell).toBe("cmd.exe");
  });

  it("applies env aliases with expected precedence", () => {
    expect(
      loadEnvConfig({
        env: {
          CURSOR_CLI_PATH: "/path/from-cli-path",
          CURSOR_CLI_BIN: "/path/from-cli-bin",
          CURSOR_AGENT_BIN: "/path/from-agent-bin",
        },
      }).agentBin,
    ).toBe("/path/from-agent-bin");

    expect(
      loadEnvConfig({
        env: {
          CURSOR_CLI_PATH: "/path/from-cli-path",
          CURSOR_CLI_BIN: "/path/from-cli-bin",
        },
      }).agentBin,
    ).toBe("/path/from-cli-bin");
  });

  it("parses booleans, numbers, and model normalization", () => {
    const loaded = loadEnvConfig({
      env: {
        CURSOR_BRIDGE_FORCE: "yes",
        CURSOR_BRIDGE_APPROVE_MCPS: "on",
        CURSOR_BRIDGE_STRICT_MODEL: "off",
        CURSOR_BRIDGE_TIMEOUT_MS: "60000",
        CURSOR_BRIDGE_DEFAULT_MODEL: "org/claude-3-opus",
      },
    });

    expect(loaded.force).toBe(true);
    expect(loaded.approveMcps).toBe(true);
    expect(loaded.strictModel).toBe(false);
    expect(loaded.timeoutMs).toBe(60000);
    expect(loaded.defaultModel).toBe("claude-3-opus");
  });

  it("resolves workspace and explicit paths from cwd", () => {
    const loaded = loadEnvConfig({
      env: {
        CURSOR_BRIDGE_WORKSPACE: "./repo",
        CURSOR_BRIDGE_SESSIONS_LOG: "./logs/sessions.log",
        CURSOR_BRIDGE_TLS_CERT: "./certs/dev.crt",
        CURSOR_BRIDGE_TLS_KEY: "./certs/dev.key",
      },
      cwd: "/tmp/project",
    });

    expect(loaded.workspace).toBe("/tmp/project/repo");
    expect(loaded.sessionsLogPath).toBe("/tmp/project/logs/sessions.log");
    expect(loaded.tlsCertPath).toBe("/tmp/project/certs/dev.crt");
    expect(loaded.tlsKeyPath).toBe("/tmp/project/certs/dev.key");
  });

  it("uses HOME before USERPROFILE for default sessions log path", () => {
    const loaded = loadEnvConfig({
      env: {
        HOME: "/home/alice",
        USERPROFILE: "C:\\Users\\alice",
      },
      cwd: "/tmp/project",
    });

    expect(loaded.sessionsLogPath).toBe(
      path.join("/home/alice", ".cursor-api-proxy", "sessions.log"),
    );
  });

  it("uses USERPROFILE when HOME is not set", () => {
    const loaded = loadEnvConfig({
      env: {
        USERPROFILE: "C:\\Users\\alice",
      },
      cwd: "/tmp/project",
    });

    expect(loaded.sessionsLogPath).toBe(
      path.join("C:\\Users\\alice", ".cursor-api-proxy", "sessions.log"),
    );
  });

  it("applies tailscale host fallback only when host is unset", () => {
    expect(loadEnvConfig({ env: {}, tailscale: true }).host).toBe("0.0.0.0");

    expect(
      loadEnvConfig({
        env: { CURSOR_BRIDGE_HOST: "10.0.0.5" },
        tailscale: true,
      }).host,
    ).toBe("10.0.0.5");
  });
});

describe("resolveAgentCommand", () => {
  it("uses CURSOR_AGENT_NODE and CURSOR_AGENT_SCRIPT on Windows", () => {
    const command = resolveAgentCommand("agent.cmd", ["--print", "hello"], {
      platform: "win32",
      env: {
        CURSOR_AGENT_NODE: "C:\\node\\node.exe",
        CURSOR_AGENT_SCRIPT: "C:\\cursor\\agent.js",
      },
    });

    expect(command.command).toBe("C:\\node\\node.exe");
    expect(command.args).toEqual(["C:\\cursor\\agent.js", "--print", "hello"]);
    expect(command.env.CURSOR_INVOKED_AS).toBe("agent.cmd");
    expect(command.windowsVerbatimArguments).toBeUndefined();
  });

  it("uses COMSPEC for .cmd invocations on Windows when direct node launch is unavailable", () => {
    const command = resolveAgentCommand("C:\\cursor\\agent.cmd", ["--prompt", "hello world"], {
      platform: "win32",
      env: {
        COMSPEC: "C:\\Windows\\System32\\cmd.exe",
      },
    });

    expect(command.command).toBe("C:\\Windows\\System32\\cmd.exe");
    expect(command.args).toEqual([
      "/d",
      "/s",
      "/c",
      "\"\"C:\\cursor\\agent.cmd\" --prompt \"hello world\"\"",
    ]);
    expect(command.windowsVerbatimArguments).toBe(true);
  });

  it("returns the original command on non-Windows platforms", () => {
    const command = resolveAgentCommand("agent", ["--help"], {
      platform: "darwin",
      env: { CURSOR_AGENT_NODE: "/ignored/node" },
    });

    expect(command.command).toBe("agent");
    expect(command.args).toEqual(["--help"]);
    expect(command.windowsVerbatimArguments).toBeUndefined();
  });
});
