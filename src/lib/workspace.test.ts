import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
  CLIENT_TOOL_BUILTIN_DENY,
  getChatOnlyEnvOverrides,
  resolveWorkspace,
} from "./workspace.js";
import type { BridgeConfig } from "./config.js";

function baseConfig(overrides: Partial<BridgeConfig> = {}): BridgeConfig {
  return {
    agentBin: "agent",
    acpCommand: "agent",
    acpArgs: ["acp"],
    acpEnv: {},
    host: "127.0.0.1",
    port: 8765,
    defaultModel: "default",
    mode: "ask",
    force: false,
    approveMcps: false,
    strictModel: false,
    workspace: "/tmp/proj-base",
    timeoutMs: 300_000,
    sessionsLogPath: "/tmp/sessions.log",
    chatOnlyWorkspace: false,
    chatOnlyWorkspaceExplicit: false,
    verbose: false,
    maxMode: false,
    promptViaStdin: false,
    useAcp: false,
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

describe("getChatOnlyEnvOverrides", () => {
  it("uses temp workspace .cursor when no auth pool dir", () => {
    const tmp = "/tmp/cursor-proxy-abc123";
    const o = getChatOnlyEnvOverrides(tmp);
    expect(o.CURSOR_CONFIG_DIR).toBe(`${tmp}/.cursor`);
  });

  it("uses account pool path for CURSOR_CONFIG_DIR when provided", () => {
    const tmp = "/tmp/cursor-proxy-abc123";
    const pool = "/home/u/.cursor-api-proxy/accounts/account-5765";
    const o = getChatOnlyEnvOverrides(tmp, pool);
    expect(o.CURSOR_CONFIG_DIR).toBe(pool);
    expect(o.HOME).toBeUndefined();
  });
});

describe("resolveWorkspace", () => {
  it("uses temp dir when chat-only is effective", () => {
    const cfg = baseConfig({ chatOnlyWorkspace: true });
    const { workspaceDir, tempDir } = resolveWorkspace(cfg, undefined);
    expect(tempDir).toBeDefined();
    expect(workspaceDir).toContain("cursor-proxy-");
  });

  it("leaves built-in tools allowed in the temp cli-config by default", () => {
    const cfg = baseConfig({ chatOnlyWorkspace: true });
    const { workspaceDir } = resolveWorkspace(cfg, undefined);
    const cliConfig = JSON.parse(
      fs.readFileSync(path.join(workspaceDir, ".cursor", "cli-config.json"), "utf8"),
    );
    expect(cliConfig.permissions.deny).toEqual([]);
  });

  it("denies built-in tools in the temp cli-config when client tools are present", () => {
    const cfg = baseConfig({ chatOnlyWorkspace: true });
    const { workspaceDir } = resolveWorkspace(cfg, undefined, undefined, {
      denyBuiltinTools: true,
    });
    const cliConfig = JSON.parse(
      fs.readFileSync(path.join(workspaceDir, ".cursor", "cli-config.json"), "utf8"),
    );
    expect(cliConfig.permissions.deny).toEqual(CLIENT_TOOL_BUILTIN_DENY);
  });

  it("uses real workspace when effectiveChatOnly is false despite config.chatOnlyWorkspace", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ws-real-"));
    const cfg = baseConfig({ workspace: tmp, chatOnlyWorkspace: true });
    const { workspaceDir, tempDir } = resolveWorkspace(cfg, undefined, false);
    expect(tempDir).toBeUndefined();
    expect(fs.realpathSync(workspaceDir)).toBe(fs.realpathSync(tmp));
  });

  it("rejects X-Cursor-Workspace outside configured base", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ws-base-"));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "ws-out-"));
    const cfg = baseConfig({ workspace: tmp });
    expect(() => resolveWorkspace(cfg, outside)).toThrow(
      /under the configured workspace base/,
    );
  });

  it("allows header path under workspace base", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ws-base-"));
    const sub = path.join(tmp, "pkg", "src");
    fs.mkdirSync(sub, { recursive: true });
    const cfg = baseConfig({ workspace: tmp });
    const { workspaceDir } = resolveWorkspace(cfg, sub);
    expect(fs.realpathSync(workspaceDir)).toBe(fs.realpathSync(sub));
  });
});
