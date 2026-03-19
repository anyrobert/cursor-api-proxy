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
 */
export function getChatOnlyEnvOverrides(workspaceDir: string): Record<string, string> {
  const cursorDir = path.join(workspaceDir, ".cursor");
  const overrides: Record<string, string> = {
    CURSOR_CONFIG_DIR: cursorDir,
    HOME: workspaceDir,
    USERPROFILE: workspaceDir,
  };
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

export function resolveWorkspace(
  config: BridgeConfig,
  workspaceHeader?: string | string[] | null,
): WorkspaceResult {
  if (config.chatOnlyWorkspace) {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-proxy-"));
    const cursorDir = path.join(tempDir, ".cursor");
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
  const workspaceDir = headerWs ?? config.workspace;
  return { workspaceDir };
}
