import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { describe, expect, it, afterEach } from "vitest";

import { loadEnvConfig, resolveAgentCommand } from "./env.js";

describe("loadEnvConfig", () => {
  it("returns defaults when env is empty", () => {
    const loaded = loadEnvConfig({ env: {}, cwd: "/workspace" });

    expect(loaded.agentBin).toBe("agent");
    expect(loaded.host).toBe("127.0.0.1");
    expect(loaded.port).toBe(8765);
    expect(loaded.defaultModel).toBe("default");
    expect(loaded.force).toBe(false);
    expect(loaded.approveMcps).toBe(false);
    expect(loaded.strictModel).toBe(true);
    expect(loaded.workspace).toBe("/workspace");
    expect(loaded.sessionsLogPath).toBe(path.join("/workspace", "sessions.log"));
    expect(loaded.chatOnlyWorkspace).toBe(true);
    expect(loaded.verbose).toBe(false);
    expect(loaded.commandShell).toBe("cmd.exe");
    expect(loaded.maxMode).toBe(false);
    expect(loaded.promptViaStdin).toBe(false);
    expect(loaded.useAcp).toBe(false);
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

    expect(loaded.workspace).toBe(path.resolve("/tmp/project", "./repo"));
    expect(loaded.sessionsLogPath).toBe(
      path.resolve("/tmp/project", "./logs/sessions.log"),
    );
    expect(loaded.tlsCertPath).toBe(
      path.resolve("/tmp/project", "./certs/dev.crt"),
    );
    expect(loaded.tlsKeyPath).toBe(
      path.resolve("/tmp/project", "./certs/dev.key"),
    );
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

  it("parses CURSOR_CONFIG_DIRS as comma-separated absolute paths", () => {
    const loaded = loadEnvConfig({
      env: { CURSOR_CONFIG_DIRS: "/acc/a,/acc/b,/acc/c" },
      cwd: "/workspace",
    });
    expect(loaded.configDirs).toEqual([
      path.resolve("/workspace", "/acc/a"),
      path.resolve("/workspace", "/acc/b"),
      path.resolve("/workspace", "/acc/c"),
    ]);
  });

  it("CURSOR_ACCOUNT_DIRS is an alias for CURSOR_CONFIG_DIRS", () => {
    const loaded = loadEnvConfig({
      env: { CURSOR_ACCOUNT_DIRS: "/acc/x,/acc/y" },
      cwd: "/workspace",
    });
    expect(loaded.configDirs).toEqual([
      path.resolve("/workspace", "/acc/x"),
      path.resolve("/workspace", "/acc/y"),
    ]);
  });

  it("CURSOR_CONFIG_DIRS takes precedence over CURSOR_ACCOUNT_DIRS", () => {
    const loaded = loadEnvConfig({
      env: {
        CURSOR_CONFIG_DIRS: "/primary/a",
        CURSOR_ACCOUNT_DIRS: "/secondary/b",
      },
      cwd: "/workspace",
    });
    expect(loaded.configDirs).toEqual([
      path.resolve("/workspace", "/primary/a"),
    ]);
  });

  it("trims whitespace from each dir in CURSOR_CONFIG_DIRS", () => {
    const loaded = loadEnvConfig({
      env: { CURSOR_CONFIG_DIRS: " /acc/a , /acc/b " },
      cwd: "/workspace",
    });
    expect(loaded.configDirs).toEqual([
      path.resolve("/workspace", "/acc/a"),
      path.resolve("/workspace", "/acc/b"),
    ]);
  });

  it("resolves relative dirs in CURSOR_CONFIG_DIRS against cwd", () => {
    const loaded = loadEnvConfig({
      env: { CURSOR_CONFIG_DIRS: "./accounts/a,./accounts/b" },
      cwd: "/workspace",
    });
    expect(loaded.configDirs).toEqual([
      path.resolve("/workspace", "./accounts/a"),
      path.resolve("/workspace", "./accounts/b"),
    ]);
  });

  it("returns empty configDirs when CURSOR_CONFIG_DIRS is unset and no accounts dir", () => {
    const loaded = loadEnvConfig({
      env: { HOME: "/nonexistent-home-" + Date.now() },
      cwd: "/workspace",
    });
    expect(loaded.configDirs).toEqual([]);
  });

  it("multiPort defaults to false", () => {
    const loaded = loadEnvConfig({ env: {}, cwd: "/workspace" });
    expect(loaded.multiPort).toBe(false);
  });

  it("multiPort is parsed from CURSOR_BRIDGE_MULTI_PORT env var", () => {
    expect(
      loadEnvConfig({ env: { CURSOR_BRIDGE_MULTI_PORT: "true" } }).multiPort,
    ).toBe(true);
    expect(
      loadEnvConfig({ env: { CURSOR_BRIDGE_MULTI_PORT: "1" } }).multiPort,
    ).toBe(true);
    expect(
      loadEnvConfig({ env: { CURSOR_BRIDGE_MULTI_PORT: "false" } }).multiPort,
    ).toBe(false);
  });

  it("falls back to default port 8765 for invalid CURSOR_BRIDGE_PORT", () => {
    expect(
      loadEnvConfig({ env: { CURSOR_BRIDGE_PORT: "not-a-number" } }).port,
    ).toBe(8765);
    expect(loadEnvConfig({ env: { CURSOR_BRIDGE_PORT: "0" } }).port).toBe(8765);
    expect(loadEnvConfig({ env: { CURSOR_BRIDGE_PORT: "-1" } }).port).toBe(
      8765,
    );
  });

  it("maxMode defaults to false", () => {
    expect(loadEnvConfig({ env: {} }).maxMode).toBe(false);
  });

  it("maxMode is parsed from CURSOR_BRIDGE_MAX_MODE", () => {
    expect(
      loadEnvConfig({ env: { CURSOR_BRIDGE_MAX_MODE: "true" } }).maxMode,
    ).toBe(true);
  });

  it("winCmdlineMax defaults to 30000", () => {
    expect(loadEnvConfig({ env: {} }).winCmdlineMax).toBe(30_000);
  });

  it("winCmdlineMax is parsed from CURSOR_BRIDGE_WIN_CMDLINE_MAX and clamped", () => {
    expect(
      loadEnvConfig({ env: { CURSOR_BRIDGE_WIN_CMDLINE_MAX: "25000" } })
        .winCmdlineMax,
    ).toBe(25_000);
    expect(
      loadEnvConfig({ env: { CURSOR_BRIDGE_WIN_CMDLINE_MAX: "999999" } })
        .winCmdlineMax,
    ).toBe(32_700);
    expect(
      loadEnvConfig({ env: { CURSOR_BRIDGE_WIN_CMDLINE_MAX: "100" } })
        .winCmdlineMax,
    ).toBe(4096);
  });

  it("parses CURSOR_BRIDGE_PROMPT_VIA_STDIN and CURSOR_BRIDGE_USE_ACP", () => {
    expect(
      loadEnvConfig({ env: { CURSOR_BRIDGE_PROMPT_VIA_STDIN: "true" } })
        .promptViaStdin,
    ).toBe(true);
    expect(loadEnvConfig({ env: { CURSOR_BRIDGE_USE_ACP: "1" } }).useAcp).toBe(
      true,
    );
  });
});

describe("discoverAccountDirs filtering", () => {
  let tmpBase: string;

  afterEach(() => {
    if (tmpBase) {
      try {
        fs.rmSync(tmpBase, { recursive: true, force: true });
      } catch {}
    }
  });

  function makeTmpAccounts(): string {
    tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "cap-test-"));
    const accountsDir = path.join(tmpBase, ".cursor-api-proxy", "accounts");
    fs.mkdirSync(accountsDir, { recursive: true });
    return accountsDir;
  }

  function writeCliConfig(dir: string, withAuth: boolean) {
    fs.mkdirSync(dir, { recursive: true });
    const cfg = withAuth
      ? {
          authInfo: { email: "test@example.com", displayName: "Test" },
          version: 1,
        }
      : { version: 1, permissions: {} };
    fs.writeFileSync(path.join(dir, "cli-config.json"), JSON.stringify(cfg));
  }

  it("auto-discovers only authenticated account dirs", () => {
    const accountsDir = makeTmpAccounts();
    writeCliConfig(path.join(accountsDir, "auth-account"), true);
    writeCliConfig(path.join(accountsDir, "no-auth-account"), false);
    fs.mkdirSync(path.join(accountsDir, "empty-account"), { recursive: true }); // no cli-config.json

    const loaded = loadEnvConfig({ env: { HOME: tmpBase }, cwd: "/workspace" });
    expect(loaded.configDirs).toHaveLength(1);
    expect(loaded.configDirs[0]).toContain("auth-account");
  });

  it("returns empty configDirs when all account dirs are unauthenticated", () => {
    const accountsDir = makeTmpAccounts();
    writeCliConfig(path.join(accountsDir, "no-auth-1"), false);
    writeCliConfig(path.join(accountsDir, "no-auth-2"), false);

    const loaded = loadEnvConfig({ env: { HOME: tmpBase }, cwd: "/workspace" });
    expect(loaded.configDirs).toEqual([]);
  });

  it("returns empty when accounts dir does not exist", () => {
    tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "cap-test-"));
    const loaded = loadEnvConfig({ env: { HOME: tmpBase }, cwd: "/workspace" });
    expect(loaded.configDirs).toEqual([]);
  });

  it("discovers multiple authenticated accounts and preserves filesystem order", () => {
    const accountsDir = makeTmpAccounts();
    writeCliConfig(path.join(accountsDir, "a-account"), true);
    writeCliConfig(path.join(accountsDir, "b-account"), true);
    writeCliConfig(path.join(accountsDir, "c-account"), true);

    const loaded = loadEnvConfig({ env: { HOME: tmpBase }, cwd: "/workspace" });
    expect(loaded.configDirs).toHaveLength(3);
    expect(loaded.configDirs.map((d) => path.basename(d))).toEqual(
      expect.arrayContaining(["a-account", "b-account", "c-account"]),
    );
  });

  it("CURSOR_CONFIG_DIRS takes priority over auto-discovery", () => {
    const accountsDir = makeTmpAccounts();
    writeCliConfig(path.join(accountsDir, "discovered"), true);

    const loaded = loadEnvConfig({
      env: { HOME: tmpBase, CURSOR_CONFIG_DIRS: "/explicit/dir" },
      cwd: "/workspace",
    });
    expect(loaded.configDirs).toEqual([
      path.resolve("/workspace", "/explicit/dir"),
    ]);
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
    const command = resolveAgentCommand(
      "C:\\cursor\\agent.cmd",
      ["--prompt", "hello world"],
      {
        platform: "win32",
        env: {
          COMSPEC: "C:\\Windows\\System32\\cmd.exe",
        },
      },
    );

    expect(command.command).toBe("C:\\Windows\\System32\\cmd.exe");
    expect(command.args).toEqual([
      "/d",
      "/s",
      "/c",
      '""C:\\cursor\\agent.cmd" --prompt "hello world""',
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

  it("uses versioned layout (versions/YYYY.MM.DD-commit) when node.exe/index.js not in agent dir", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-agent-"));
    try {
      const agentCmd = path.join(tmp, "agent.cmd");
      const versionDir = path.join(tmp, "versions", "2026.03.11-6dfa30c");
      fs.mkdirSync(versionDir, { recursive: true });
      fs.writeFileSync(path.join(versionDir, "node.exe"), "");
      fs.writeFileSync(path.join(versionDir, "index.js"), "");
      fs.writeFileSync(agentCmd, "");

      const command = resolveAgentCommand(agentCmd, ["acp"], {
        platform: "win32",
        env: {},
        cwd: tmp,
      });

      expect(command.command).toBe(path.join(versionDir, "node.exe"));
      expect(command.args).toEqual([path.join(versionDir, "index.js"), "acp"]);
      expect(command.windowsVerbatimArguments).toBeUndefined();
      expect(command.env.CURSOR_INVOKED_AS).toBe("agent.cmd");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("falls back to cmd when versions dir does not exist", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-agent-"));
    try {
      const agentCmd = path.join(tmp, "agent.cmd");
      fs.writeFileSync(agentCmd, "");

      const command = resolveAgentCommand(agentCmd, ["acp"], {
        platform: "win32",
        env: { COMSPEC: "C:\\Windows\\System32\\cmd.exe" },
        cwd: tmp,
      });

      expect(command.command).toBe("C:\\Windows\\System32\\cmd.exe");
      expect(command.windowsVerbatimArguments).toBe(true);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("falls back to cmd when versions dir has no valid version subdirs", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-agent-"));
    try {
      const agentCmd = path.join(tmp, "agent.cmd");
      const versionsDir = path.join(tmp, "versions");
      fs.mkdirSync(versionsDir, { recursive: true });
      fs.writeFileSync(agentCmd, "");
      fs.mkdirSync(path.join(versionsDir, "not-a-version"), { recursive: true });

      const command = resolveAgentCommand(agentCmd, ["acp"], {
        platform: "win32",
        env: { COMSPEC: "C:\\Windows\\System32\\cmd.exe" },
        cwd: tmp,
      });

      expect(command.command).toBe("C:\\Windows\\System32\\cmd.exe");
      expect(command.windowsVerbatimArguments).toBe(true);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
