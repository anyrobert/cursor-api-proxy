import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  chatOnlyHomeDir,
  getChatOnlyEnvOverrides,
  linkMacKeychains,
  removeChatOnlyTempDir,
  resolveWorkspace,
} from "./workspace.js";
import type { BridgeConfig } from "./config.js";

const fsFault = vi.hoisted(() => ({
  writeFileSync: undefined as Error | undefined,
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    writeFileSync: (...args: Parameters<typeof actual.writeFileSync>) => {
      if (fsFault.writeFileSync) throw fsFault.writeFileSync;
      actual.writeFileSync(...args);
    },
  };
});

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

const testDirs: string[] = [];

function makeTestDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  testDirs.push(dir);
  return dir;
}

afterEach(() => {
  fsFault.writeFileSync = undefined;
  vi.unstubAllEnvs();
  for (const dir of testDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

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
    const realHome = makeTestDir("real-home-");
    const keychains = path.join(realHome, "Library", "Keychains");
    fs.mkdirSync(keychains, { recursive: true });
    fs.writeFileSync(path.join(keychains, "login.keychain-db"), "x");
    const tempHome = makeTestDir("cursor-proxy-");

    linkMacKeychains(tempHome, realHome);

    const link = path.join(tempHome, "Library", "Keychains");
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(fs.realpathSync(link)).toBe(fs.realpathSync(keychains));

    removeChatOnlyTempDir(tempHome);
    expect(fs.existsSync(tempHome)).toBe(false);
    expect(fs.existsSync(path.join(keychains, "login.keychain-db"))).toBe(true);
  });

  it("does nothing when real home has no keychains folder", () => {
    const realHome = makeTestDir("real-home-");
    const tempHome = makeTestDir("cursor-proxy-");
    linkMacKeychains(tempHome, realHome);
    expect(fs.existsSync(path.join(tempHome, "Library"))).toBe(false);
  });
});

describe("removeChatOnlyTempDir", () => {
  it("ignores a missing or already removed dir", () => {
    expect(() => removeChatOnlyTempDir(undefined)).not.toThrow();
    const gone = makeTestDir("cursor-proxy-");
    removeChatOnlyTempDir(gone);
    expect(() => removeChatOnlyTempDir(gone)).not.toThrow();
  });
});

describe("resolveWorkspace", () => {
  it("uses temp dir when chat-only is effective", () => {
    const cfg = baseConfig({ chatOnlyWorkspace: true });
    const { workspaceDir, tempDir } = resolveWorkspace(cfg, undefined);
    expect(tempDir).toBeDefined();
    testDirs.push(tempDir!);
    expect(workspaceDir).toContain("cursor-proxy-");
  });

  it("keeps the chat-only home, config and keychain link out of the workspace", () => {
    const cfg = baseConfig({ chatOnlyWorkspace: true });
    const { workspaceDir, tempDir } = resolveWorkspace(cfg, undefined);
    expect(tempDir).toBeDefined();
    testDirs.push(tempDir!);
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
  });

  it("removes the temp dir when the chat-only setup fails", () => {
    const tmpRoot = makeTestDir("tmp-root-");
    vi.stubEnv("TMPDIR", tmpRoot);
    vi.stubEnv("TMP", tmpRoot);
    vi.stubEnv("TEMP", tmpRoot);
    fsFault.writeFileSync = new Error("ENOSPC: no space left on device");

    const cfg = baseConfig({ chatOnlyWorkspace: true });
    expect(() => resolveWorkspace(cfg, undefined)).toThrow(/ENOSPC/);
    expect(fs.readdirSync(tmpRoot)).toEqual([]);
  });

  it("keeps HOME at the workspace for callers without an isolation root", () => {
    expect(chatOnlyHomeDir("/tmp/ws")).toBe("/tmp/ws");
    expect(chatOnlyHomeDir("/tmp/root/workspace", "/tmp/root")).toBe(
      "/tmp/root/home",
    );
  });

  it("uses real workspace when effectiveChatOnly is false despite config.chatOnlyWorkspace", () => {
    const tmp = makeTestDir("ws-real-");
    const cfg = baseConfig({ workspace: tmp, chatOnlyWorkspace: true });
    const { workspaceDir, tempDir } = resolveWorkspace(cfg, undefined, false);
    expect(tempDir).toBeUndefined();
    expect(fs.realpathSync(workspaceDir)).toBe(fs.realpathSync(tmp));
  });

  it("rejects X-Cursor-Workspace outside configured base", () => {
    const tmp = makeTestDir("ws-base-");
    const outside = makeTestDir("ws-out-");
    const cfg = baseConfig({ workspace: tmp });
    expect(() => resolveWorkspace(cfg, outside)).toThrow(
      /under the configured workspace base/,
    );
  });

  it("allows header path under workspace base", () => {
    const tmp = makeTestDir("ws-base-");
    const sub = path.join(tmp, "pkg", "src");
    fs.mkdirSync(sub, { recursive: true });
    const cfg = baseConfig({ workspace: tmp });
    const { workspaceDir } = resolveWorkspace(cfg, sub);
    expect(fs.realpathSync(workspaceDir)).toBe(fs.realpathSync(sub));
  });
});
