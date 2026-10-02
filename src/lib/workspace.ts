import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { BridgeConfig } from "./config.js";

export type WorkspaceResult = {
  workspaceDir: string;
  tempDir?: string;
};

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
  workspaceDir: string,
  authConfigDir?: string,
): Record<string, string> {
  const cursorDir = authConfigDir ?? path.join(workspaceDir, ".cursor");
  const overrides: Record<string, string> = {
    CURSOR_CONFIG_DIR: cursorDir,
  };

  if (authConfigDir) {
    return overrides;
  }

  overrides.HOME = workspaceDir;
  overrides.USERPROFILE = workspaceDir;
  if (process.platform === "win32") {
    const appDataRoaming = path.join(workspaceDir, "AppData", "Roaming");
    const appDataLocal = path.join(workspaceDir, "AppData", "Local");
    overrides.APPDATA = appDataRoaming;
    overrides.LOCALAPPDATA = appDataLocal;
  } else {
    overrides.XDG_CONFIG_HOME = path.join(workspaceDir, ".config");
  }
  return overrides;
}

/**
 * Built-in Cursor CLI tools denied when the caller supplies its own tools, so the
 * agent must act through the client's tools (which run in the client's real
 * workspace) instead of exploring the empty temp directory.
 */
export const CLIENT_TOOL_BUILTIN_DENY = ["Read(**)", "Write(**)", "Shell(*)"];

export function resolveWorkspace(
  config: BridgeConfig,
  workspaceHeader?: string | string[] | null,
  effectiveChatOnly?: boolean,
  opts: { denyBuiltinTools?: boolean } = {},
): WorkspaceResult {
  const useChatOnly =
    effectiveChatOnly !== undefined
      ? effectiveChatOnly
      : config.chatOnlyWorkspace;
  if (useChatOnly) {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-proxy-"));
    const cursorDir = path.join(tempDir, ".cursor");
    fs.mkdirSync(cursorDir, { recursive: true });
    fs.mkdirSync(path.join(cursorDir, "rules"), { recursive: true });
    const minimalConfig = {
      version: 1,
      editor: { vimMode: false },
      permissions: {
        allow: [],
        deny: opts.denyBuiltinTools ? CLIENT_TOOL_BUILTIN_DENY : [],
      },
    };
    fs.writeFileSync(
      path.join(cursorDir, "cli-config.json"),
      JSON.stringify(minimalConfig, null, 0),
      "utf8",
    );
    if (process.platform === "win32") {
      fs.mkdirSync(path.join(tempDir, "AppData", "Roaming"), { recursive: true });
      fs.mkdirSync(path.join(tempDir, "AppData", "Local"), { recursive: true });
    } else {
      fs.mkdirSync(path.join(tempDir, ".config"), { recursive: true });
    }
    return { workspaceDir: tempDir, tempDir };
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
