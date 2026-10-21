/**
 * A private Cursor config dir for each agent run, plain CLI or `agent acp`.
 *
 * The CLI saves every model choice to its config dir, with no session-only
 * switch (CLI 2026.10.19). `agent acp` does it for `--model` at startup
 * (`model`, `hasChangedDefaultModel`, `maxMode` in cli-config.json) and for
 * every `session/set_config_option` (`selectedModel`, `modelParameters`,
 * `modelSelectionHistory`, `maxMode`, ... plus acp-config.json) (#63).
 * The plain chat command does it too: its `--model` goes through the same
 * `ModelManager.handleInitialModel` (#87). Each session also leaves a store
 * there (`chats/`, `acp-sessions/<id>/`). Run on an account's own config
 * dir, every proxy request would change the model that account then uses
 * interactively. A run instead gets a copy of the config files, deleted
 * when it ends: it starts from the account's settings, and nothing it
 * writes reaches the account. Concurrent runs never share a copy, so there
 * is nothing to lock or restore.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { debuglog } from "node:util";

const debugConfig = debuglog("cursor-api-proxy:config");

/**
 * The files the CLI reads from its config dir. The rest of that dir is
 * per-session state the proxy never reuses (`chats/`, `acp-sessions/`).
 * Login is not in the config dir: the CLI keeps it in the macOS keychain or
 * in `auth.json` under the user's config home, keyed by neither path.
 */
export const RUN_CONFIG_FILES = [
  "cli-config.json",
  "permissions.json",
  "acp-config.json",
  "statsig-cache.json",
] as const;

/**
 * The config dir the CLI uses with `env`, resolved the way the CLI does:
 * CURSOR_CONFIG_DIR, else $XDG_CONFIG_HOME/cursor, else ~/.cursor.
 */
export function cursorConfigDir(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): string {
  const explicit = env.CURSOR_CONFIG_DIR;
  if (explicit?.trim()) return explicit;
  const xdg = env.XDG_CONFIG_HOME;
  if (xdg?.trim()) return path.join(xdg, "cursor");
  const home = (platform === "win32" ? env.USERPROFILE : env.HOME) || os.homedir();
  return path.join(home, ".cursor");
}

export type RunConfigDir = {
  dir: string;
  /** Delete the copy (idempotent). Call once the run's agent is gone. */
  dispose: () => void;
};

/** Copy `sourceDir`'s config files into a new private temp dir. */
export function createRunConfigDir(sourceDir: string): RunConfigDir {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-proxy-config-"));
  for (const name of RUN_CONFIG_FILES) {
    try {
      fs.copyFileSync(path.join(sourceDir, name), path.join(dir, name));
    } catch (error) {
      // The CLI starts from defaults for a missing or unreadable file too.
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        debugConfig("run config dir: cannot copy %s: %s", name, String(error));
      }
    }
  }
  let disposed = false;
  return {
    dir,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    },
  };
}
