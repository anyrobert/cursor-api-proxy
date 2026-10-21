import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { BridgeConfig } from "./config.js";

export type WorkspaceResult = {
  workspaceDir: string;
  /** Isolation root of a chat-only request, removed when the request ends. */
  tempDir?: string;
};

/**
 * A chat-only request's temp dir holds two siblings: the agent's empty
 * `workspace` (its cwd and `--workspace`) and a private `home` for `HOME`,
 * Cursor's config and, on macOS, the link to the real keychains. Keeping
 * `home` out of the workspace keeps that link out of everything the agent
 * lists, searches or edits as "the project".
 */
const CHAT_ONLY_WORKSPACE = "workspace";
const CHAT_ONLY_HOME = "home";

/**
 * `HOME` for a chat-only run: the `home` beside its workspace. A caller with
 * no isolation root (no `tempDir`) keeps the old layout, `HOME` at the
 * workspace, where nothing is linked.
 */
export function chatOnlyHomeDir(workspaceDir: string, tempDir?: string): string {
  return tempDir ? path.join(tempDir, CHAT_ONLY_HOME) : workspaceDir;
}

/**
 * Env overrides for chat-only (isolated) workspace so the agent cannot load
 * rules from ~/.cursor or other user config paths.
 *
 * When `authConfigDir` is set (account pool), use it for `CURSOR_CONFIG_DIR` so the
 * CLI loads credentials from that profile.
 *
 * We do **not** override `HOME` / `USERPROFILE` / `XDG_*` in that case: the Cursor CLI
 * still resolves auth relative to the real user profile for `agent --print` / ask, and
 * a fake `HOME` makes login fail even when `CURSOR_CONFIG_DIR` points at the pool.
 * Without a pool, the temp `HOME` keeps rules from the real `~/.cursor` from loading.
 */
export function getChatOnlyEnvOverrides(
  homeDir: string,
  authConfigDir?: string,
): Record<string, string> {
  const cursorDir = authConfigDir ?? path.join(homeDir, ".cursor");
  const overrides: Record<string, string> = {
    CURSOR_CONFIG_DIR: cursorDir,
  };

  if (authConfigDir) {
    return overrides;
  }

  overrides.HOME = homeDir;
  overrides.USERPROFILE = homeDir;
  if (process.platform === "win32") {
    const appDataRoaming = path.join(homeDir, "AppData", "Roaming");
    const appDataLocal = path.join(homeDir, "AppData", "Local");
    overrides.APPDATA = appDataRoaming;
    overrides.LOCALAPPDATA = appDataLocal;
  } else {
    overrides.XDG_CONFIG_HOME = path.join(homeDir, ".config");
  }
  return overrides;
}

/**
 * macOS resolves the login keychain from `$HOME/Library/Keychains`. With the temp
 * `HOME` from chat-only mode the CLI cannot read or save its auth token there
 * ("Not logged in" / `security` exit 154), so expose the real keychains folder.
 * Only ever link into the private `home` (see CHAT_ONLY_HOME), never into a
 * directory the agent works in.
 */
export function linkMacKeychains(tempHome: string, realHome = os.homedir()): void {
  const source = path.join(realHome, "Library", "Keychains");
  if (!fs.existsSync(source)) return;
  try {
    fs.mkdirSync(path.join(tempHome, "Library"), { recursive: true });
    fs.symlinkSync(source, path.join(tempHome, "Library", "Keychains"), "dir");
  } catch {
    /* best effort */
  }
}

/**
 * Remove a chat-only request's isolation root. Whoever holds `tempDir` owns
 * it: an agent runner removes it once its run settles, and a handler removes
 * it itself on any path that returns before it hands the dir to a runner.
 * `rmSync` unlinks the keychain link without following it.
 */
export function removeChatOnlyTempDir(tempDir: string | undefined): void {
  if (!tempDir) return;
  try {
    fs.rmSync(tempDir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}

function createChatOnlyWorkspace(): Required<WorkspaceResult> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-proxy-"));
  try {
    const workspaceDir = path.join(tempDir, CHAT_ONLY_WORKSPACE);
    const homeDir = chatOnlyHomeDir(workspaceDir, tempDir);
    fs.mkdirSync(workspaceDir);
    const cursorDir = path.join(homeDir, ".cursor");
    fs.mkdirSync(cursorDir, { recursive: true });
    fs.mkdirSync(path.join(cursorDir, "rules"), { recursive: true });
    const minimalConfig = {
      version: 1,
      editor: { vimMode: false },
      permissions: { allow: [], deny: [] },
    };
    fs.writeFileSync(
      path.join(cursorDir, "cli-config.json"),
      JSON.stringify(minimalConfig, null, 0),
      "utf8",
    );
    if (process.platform === "win32") {
      fs.mkdirSync(path.join(homeDir, "AppData", "Roaming"), { recursive: true });
      fs.mkdirSync(path.join(homeDir, "AppData", "Local"), { recursive: true });
    } else {
      fs.mkdirSync(path.join(homeDir, ".config"), { recursive: true });
    }
    if (process.platform === "darwin") {
      linkMacKeychains(homeDir);
    }
    return { workspaceDir, tempDir };
  } catch (error) {
    removeChatOnlyTempDir(tempDir);
    throw error;
  }
}

/**
 * The agent's workspace for one request. In chat-only mode this creates a
 * fresh temp dir (`tempDir`) that the caller owns: hand it to an agent runner,
 * which removes it when the run ends, or remove it with
 * `removeChatOnlyTempDir` when returning without running the agent.
 */
export function resolveWorkspace(
  config: BridgeConfig,
  workspaceHeader?: string | string[] | null,
  effectiveChatOnly?: boolean,
): WorkspaceResult {
  const useChatOnly =
    effectiveChatOnly !== undefined
      ? effectiveChatOnly
      : config.chatOnlyWorkspace;
  if (useChatOnly) {
    return createChatOnlyWorkspace();
  }
  const headerWs =
    typeof workspaceHeader === "string" && workspaceHeader.trim()
      ? workspaceHeader.trim()
      : null;
  const base = path.resolve(config.workspace);
  if (!headerWs) {
    return { workspaceDir: base };
  }

  const candidate = path.resolve(headerWs);
  if (!fs.existsSync(candidate) || !fs.statSync(candidate).isDirectory()) {
    throw new Error(
      "X-Cursor-Workspace must be an existing directory on the proxy host",
    );
  }

  const realBase = fs.existsSync(base) ? fs.realpathSync(base) : base;
  const realRequested = fs.realpathSync(candidate);
  const rel = path.relative(realBase, realRequested);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(
      "X-Cursor-Workspace must resolve to a directory under the configured workspace base",
    );
  }
  return { workspaceDir: realRequested };
}
