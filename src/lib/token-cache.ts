import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

/** Token file written per-account after each agent run */
export const TOKEN_FILE = ".cursor-token";

export function readCachedToken(configDir: string): string | undefined {
  try {
    const p = path.join(configDir, TOKEN_FILE);
    if (fs.existsSync(p))
      return fs.readFileSync(p, "utf-8").trim() || undefined;
  } catch {
    /* ignore */
  }
  return undefined;
}

export function writeCachedToken(configDir: string, token: string): void {
  try {
    fs.writeFileSync(path.join(configDir, TOKEN_FILE), token, {
      encoding: "utf-8",
      mode: 0o600,
    });
  } catch {
    /* ignore */
  }
}

/** Read the shared macOS Keychain slot used by the Cursor CLI. */
export function readKeychainToken(): string | undefined {
  try {
    const t = execSync(
      'security find-generic-password -s "cursor-access-token" -w',
      { stdio: ["pipe", "pipe", "pipe"], timeout: 5000 },
    )
      .toString()
      .trim();
    return t || undefined;
  } catch {
    return undefined;
  }
}
