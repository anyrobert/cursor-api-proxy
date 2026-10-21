/**
 * Cursor Max Mode (CURSOR_BRIDGE_MAX_MODE) for a CLI run: `maxMode: true` in
 * the cli-config.json the run's agent child reads. agent-runner calls this on
 * the run's own config dir (see run-config-dir.ts), so the setting never
 * reaches an account's or the user's config.
 */
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Write `maxMode: true` into `configDir`'s cli-config.json. Best-effort: a
 * missing or unreadable file, or a stub with at most one key, is left alone
 * and the CLI starts from its defaults.
 */
export function enableMaxMode(configDir: string): void {
  const file = path.join(configDir, "cli-config.json");
  try {
    const raw: unknown = JSON.parse(
      fs.readFileSync(file, "utf-8").replace(/^﻿/, ""),
    );
    if (!isRecord(raw) || Object.keys(raw).length <= 1) return;
    raw.maxMode = true;
    if (isRecord(raw.model)) raw.model.maxMode = true;
    fs.writeFileSync(file, JSON.stringify(raw, null, 2), "utf-8");
  } catch {
    /* best effort */
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
