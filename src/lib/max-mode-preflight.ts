/**
 * Sets maxMode=true in Cursor CLI's cli-config.json before spawning the agent.
 * Config resolution order (same as Cursor CLI):
 * 1. CURSOR_CONFIG_DIR/cli-config.json
 * 2. <agent-dir>/../data/config/cli-config.json (CursorToolkit layout)
 * 3. Platform default (LOCALAPPDATA / Library / XDG)
 */
import * as fs from "node:fs";
import * as path from "node:path";

function getCandidates(agentScriptPath?: string): string[] {
  const result: string[] = [];

  if (process.env.CURSOR_CONFIG_DIR) {
    result.push(path.join(process.env.CURSOR_CONFIG_DIR, "cli-config.json"));
  }

  if (agentScriptPath) {
    const agentDir = path.dirname(path.resolve(agentScriptPath));
    result.push(path.join(agentDir, "..", "data", "config", "cli-config.json"));
  }

  const home = process.env.HOME ?? process.env.USERPROFILE ?? "";

  if (process.platform === "win32") {
    const local = process.env.LOCALAPPDATA ?? path.join(home, "AppData", "Local");
    result.push(path.join(local, "cursor-agent", "cli-config.json"));
  } else if (process.platform === "darwin") {
    result.push(
      path.join(home, "Library", "Application Support", "cursor-agent", "cli-config.json"),
    );
  } else {
    const xdg = process.env.XDG_CONFIG_HOME ?? path.join(home, ".config");
    result.push(path.join(xdg, "cursor-agent", "cli-config.json"));
  }

  return result;
}

/**
 * Write maxMode: true to the first writable cli-config.json.
 * Best-effort: ignores errors (e.g. missing or read-only config).
 */
export function runMaxModePreflight(agentScriptPath?: string): void {
  for (const candidate of getCandidates(agentScriptPath)) {
    try {
      const rawStr = fs.readFileSync(candidate, "utf-8");
      const raw = JSON.parse(rawStr.replace(/^\uFEFF/, "")) as Record<string, unknown>;
      if (!raw || typeof raw !== "object" || Object.keys(raw).length <= 1) continue;

      raw.maxMode = true;
      if (typeof raw.model === "object" && raw.model && raw.model !== null) {
        (raw.model as Record<string, unknown>).maxMode = true;
      }
      fs.writeFileSync(candidate, JSON.stringify(raw, null, 2), "utf-8");
      return;
    } catch {
      /* candidate not found or unreadable — try next */
    }
  }
}
