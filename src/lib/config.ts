import { loadEnvConfig, type EnvOptions } from "./env.js";

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
  /** When true, print full request/response content to stdout for each completion. */
  verbose: boolean;
  /** When true, enable Cursor Max Mode (larger context, more tool calls) via cli-config.json preflight. */
  maxMode: boolean;
};

export function loadBridgeConfig(opts: EnvOptions = {}): BridgeConfig {
  const env = loadEnvConfig(opts);

  return {
    agentBin: env.agentBin,
    host: env.host,
    port: env.port,
    requiredKey: env.requiredKey,
    defaultModel: env.defaultModel,
    mode: "ask", // proxy is chat-only; CURSOR_BRIDGE_MODE is ignored
    force: env.force,
    approveMcps: env.approveMcps,
    strictModel: env.strictModel,
    workspace: env.workspace,
    timeoutMs: env.timeoutMs,
    tlsCertPath: env.tlsCertPath,
    tlsKeyPath: env.tlsKeyPath,
    sessionsLogPath: env.sessionsLogPath,
    chatOnlyWorkspace: env.chatOnlyWorkspace,
    verbose: env.verbose,
    maxMode: env.maxMode,
  };
}
