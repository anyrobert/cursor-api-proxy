import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
  chatOnlyHomeDir,
  getChatOnlyEnvOverrides,
  linkMacKeychains,
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
  it("uses the temp home's .cursor when no auth pool dir", () => {
    const home = "/tmp/cursor-proxy-abc123/home";
    const o = getChatOnlyEnvOverrides(home);
    expect(o.CURSOR_CONFIG_DIR).toBe(`${home}/.cursor`);
    expect(o.HOME).toBe(home);
  });

  it("uses account pool path for CURSOR_CONFIG_DIR when provided", () => {
    const tmp = "/tmp/cursor-proxy-abc123";
    const pool = "/home/u/.cursor-api-proxy/accounts/account-5765";
    const o = getChatOnlyEnvOverrides(tmp, pool);
    expect(o.CURSOR_CONFIG_DIR).toBe(pool);
    expect(o.HOME).toBeUndefined();
  });
});

describe("linkMacKeychains", () => {
  it("links real keychains into temp home and cleanup keeps the target", () => {
    const realHome = fs.mkdtempSync(path.join(os.tmpdir(), "real-home-"));
    const keychains = path.join(realHome, "Library", "Keychains");
    fs.mkdirSync(keychains, { recursive: true });
    fs.writeFileSync(path.join(keychains, "login.keychain-db"), "x");
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-proxy-"));

    linkMacKeychains(tempHome, realHome);

    const link = path.join(tempHome, "Library", "Keychains");
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(fs.realpathSync(link)).toBe(fs.realpathSync(keychains));

    fs.rmSync(tempHome, { recursive: true, force: true });
    expect(fs.existsSync(path.join(keychains, "login.keychain-db"))).toBe(true);
  });

  it("does nothing when real home has no keychains folder", () => {
    const realHome = fs.mkdtempSync(path.join(os.tmpdir(), "real-home-"));
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-proxy-"));
    linkMacKeychains(tempHome, realHome);
    expect(fs.existsSync(path.join(tempHome, "Library"))).toBe(false);
    fs.rmSync(tempHome, { recursive: true, force: true });
    fs.rmSync(realHome, { recursive: true, force: true });
  });
});

describe("resolveWorkspace", () => {
  it("uses temp dir when chat-only is effective", () => {
    const cfg = baseConfig({ chatOnlyWorkspace: true });
    const { workspaceDir, tempDir } = resolveWorkspace(cfg, undefined);
    expect(tempDir).toBeDefined();
    expect(workspaceDir).toContain("cursor-proxy-");
    fs.rmSync(tempDir!, { recursive: true, force: true });
  });

  it("keeps the chat-only home, config and keychain link out of the workspace", () => {
    const cfg = baseConfig({ chatOnlyWorkspace: true });
    const { workspaceDir, tempDir } = resolveWorkspace(cfg, undefined);
    try {
      expect(tempDir).toBeDefined();
      // The agent's workspace starts empty: no Library/Keychains link, no
      // .cursor config, nothing that leads back to the real user profile.
      expect(fs.readdirSync(workspaceDir)).toEqual([]);

      const home = chatOnlyHomeDir(workspaceDir, tempDir);
      expect(path.relative(workspaceDir, home).startsWith("..")).toBe(true);
      expect(fs.existsSync(path.join(home, ".cursor", "cli-config.json"))).toBe(
        true,
      );
      const env = getChatOnlyEnvOverrides(home);
      expect(env.HOME).toBe(home);
      expect(env.CURSOR_CONFIG_DIR).toBe(path.join(home, ".cursor"));
      const realKeychains = path.join(os.homedir(), "Library", "Keychains");
      if (process.platform === "darwin" && fs.existsSync(realKeychains)) {
        expect(
          fs.lstatSync(path.join(home, "Library", "Keychains")).isSymbolicLink(),
        ).toBe(true);
      }
    } finally {
      fs.rmSync(tempDir!, { recursive: true, force: true });
    }
  });

  it("keeps HOME at the workspace for callers without an isolation root", () => {
    expect(chatOnlyHomeDir("/tmp/ws")).toBe("/tmp/ws");
    expect(chatOnlyHomeDir("/tmp/root/workspace", "/tmp/root")).toBe(
      "/tmp/root/home",
    );
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
