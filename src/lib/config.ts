import * as path from "node:path";

export type CursorExecutionMode = "agent" | "ask" | "plan";

export type BridgeConfig = {
  agentBin: string;
  host: string;
  port: number;
  requiredKey?: string;
  defaultModel: string;
  mode: CursorExecutionMode;
  force: boolean;
  approveMcps: boolean;
  strictModel: boolean;
  workspace: string;
  timeoutMs: number;
};

function envBool(name: string, defaultValue: boolean): boolean {
  const raw = process.env[name];
  if (raw == null) return defaultValue;
  const v = raw.trim().toLowerCase();
  if (v === "1" || v === "true" || v === "yes" || v === "on") return true;
  if (v === "0" || v === "false" || v === "no" || v === "off") return false;
  return defaultValue;
}

function envNumber(name: string, defaultValue: number): number {
  const raw = process.env[name];
  if (raw == null) return defaultValue;
  const n = Number(raw);
  return Number.isFinite(n) ? n : defaultValue;
}

function normalizeMode(raw: string | undefined): CursorExecutionMode {
  const m = (raw || "").trim().toLowerCase();
  if (m === "ask" || m === "plan" || m === "agent") return m;
  return "ask";
}

function normalizeModelId(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const parts = trimmed.split("/");
  return parts[parts.length - 1] || undefined;
}

function getAgentBin(): string {
  return (
    process.env.CURSOR_AGENT_BIN ||
    process.env.CURSOR_CLI_BIN ||
    process.env.CURSOR_CLI_PATH ||
    "agent"
  );
}

function getHost(): string {
  return process.env.CURSOR_BRIDGE_HOST || "127.0.0.1";
}

function getPort(): number {
  const n = envNumber("CURSOR_BRIDGE_PORT", 8765);
  return Number.isFinite(n) && n > 0 ? n : 8765;
}

function getRequiredKey(): string | undefined {
  return process.env.CURSOR_BRIDGE_API_KEY;
}

function getWorkspace(): string {
  const raw = process.env.CURSOR_BRIDGE_WORKSPACE;
  return raw ? path.resolve(raw) : process.cwd();
}

export function loadBridgeConfig(): BridgeConfig {
  return {
    agentBin: getAgentBin(),
    host: getHost(),
    port: getPort(),
    requiredKey: getRequiredKey(),
    defaultModel: normalizeModelId(process.env.CURSOR_BRIDGE_DEFAULT_MODEL) || "auto",
    mode: normalizeMode(process.env.CURSOR_BRIDGE_MODE),
    force: envBool("CURSOR_BRIDGE_FORCE", false),
    approveMcps: envBool("CURSOR_BRIDGE_APPROVE_MCPS", false),
    strictModel: envBool("CURSOR_BRIDGE_STRICT_MODEL", true),
    workspace: getWorkspace(),
    timeoutMs: envNumber("CURSOR_BRIDGE_TIMEOUT_MS", 300_000),
  };
}
