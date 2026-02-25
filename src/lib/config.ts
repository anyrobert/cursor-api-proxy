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
  /** Path to TLS certificate file (e.g. Tailscale cert). When set with tlsKeyPath, server uses HTTPS. */
  tlsCertPath?: string;
  /** Path to TLS private key file. When set with tlsCertPath, server uses HTTPS. */
  tlsKeyPath?: string;
  /** Path to sessions log file; each request is appended as a line. Default: sessions.log in cwd. */
  sessionsLogPath: string;
  /** When true (default), run CLI in an empty temp dir so it cannot read or write the real project. Pure chat only. */
  chatOnlyWorkspace: boolean;
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

function getTlsCertPath(): string | undefined {
  const v = process.env.CURSOR_BRIDGE_TLS_CERT;
  return v && v.trim() ? v.trim() : undefined;
}

function getTlsKeyPath(): string | undefined {
  const v = process.env.CURSOR_BRIDGE_TLS_KEY;
  return v && v.trim() ? v.trim() : undefined;
}

function getWorkspace(): string {
  const raw = process.env.CURSOR_BRIDGE_WORKSPACE;
  return raw ? path.resolve(raw) : process.cwd();
}

function getSessionsLogPath(): string {
  const raw = process.env.CURSOR_BRIDGE_SESSIONS_LOG;
  return raw ? path.resolve(raw) : path.join(process.cwd(), "sessions.log");
}

function getChatOnlyWorkspace(): boolean {
  const raw = process.env.CURSOR_BRIDGE_CHAT_ONLY_WORKSPACE;
  if (raw == null) return true; // default: isolate so CLI cannot touch real project
  const v = raw.trim().toLowerCase();
  if (v === "0" || v === "false" || v === "no" || v === "off") return false;
  return true;
}

export function loadBridgeConfig(): BridgeConfig {
  return {
    agentBin: getAgentBin(),
    host: getHost(),
    port: getPort(),
    requiredKey: getRequiredKey(),
    defaultModel: normalizeModelId(process.env.CURSOR_BRIDGE_DEFAULT_MODEL) || "auto",
    mode: "ask", // proxy is chat-only; CURSOR_BRIDGE_MODE is ignored
    force: envBool("CURSOR_BRIDGE_FORCE", false),
    approveMcps: envBool("CURSOR_BRIDGE_APPROVE_MCPS", false),
    strictModel: envBool("CURSOR_BRIDGE_STRICT_MODEL", true),
    workspace: getWorkspace(),
    timeoutMs: envNumber("CURSOR_BRIDGE_TIMEOUT_MS", 300_000),
    tlsCertPath: getTlsCertPath(),
    tlsKeyPath: getTlsKeyPath(),
    sessionsLogPath: getSessionsLogPath(),
    chatOnlyWorkspace: getChatOnlyWorkspace(),
  };
}
