import type { IncomingHttpHeaders } from "node:http";

import type { CursorExecutionMode } from "./execution-mode.js";

/** Joins bridge preamble and user/tool prompt in chat + Anthropic handlers. */
export const BRIDGE_AGENT_PROMPT_SEPARATOR = "\n\n---\n\n";

export type BridgeContextPreambleInput = {
  headers: IncomingHttpHeaders;
  /** Resolved `CURSOR_BRIDGE_WORKSPACE` (absolute). Not shown in chat-only mode. */
  bridgeWorkspaceBase: string;
  /** Directory the Cursor agent process uses as workspace cwd. */
  agentWorkspaceDir: string;
  /**
   * True when the agent runs in an isolated temp dir (chat-only sandbox):
   * the preamble then names only that dir, no host path.
   */
  isolatedChatOnly: boolean;
  cursorMode: CursorExecutionMode;
  /** Optional extra from `CURSOR_BRIDGE_CONTEXT_EXTRA` (already length-capped in config). */
  contextExtra?: string;
};

export function readHttpHeader(
  headers: IncomingHttpHeaders,
  name: string,
): string | undefined {
  const raw = headers[name.toLowerCase()];
  if (raw == null) return undefined;
  const s = Array.isArray(raw) ? raw[0] : raw;
  const t = typeof s === "string" ? s.trim() : "";
  return t || undefined;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
}

/**
 * The first preamble line's directories. In chat-only mode it names only the
 * sandbox: the agent's tools can read absolute paths, so naming the host
 * workspace would point it at the real project the sandbox keeps it out of.
 */
function describeDirectories(input: BridgeContextPreambleInput): string {
  const mode = `mode=${input.cursorMode}`;
  if (input.isolatedChatOnly) {
    return `cwd=${input.agentWorkspaceDir}; ${mode}. Chat-only: the cwd is a temp sandbox and nothing outside it is in scope.`;
  }
  const loc =
    input.bridgeWorkspaceBase === input.agentWorkspaceDir
      ? `cwd=${input.agentWorkspaceDir}`
      : `workspace=${input.bridgeWorkspaceBase}; agent cwd=${input.agentWorkspaceDir}`;
  return `${loc}; ${mode}.`;
}

/**
 * Short factual prefix: request went through this HTTP bridge, CLI mode, and
 * which directories apply. Optional lines only when headers / env add signal.
 */
export function buildBridgeContextPreamble(
  input: BridgeContextPreambleInput,
): string {
  const lines: string[] = [
    `Via cursor-api-proxy → Cursor CLI. ${describeDirectories(input)}`,
  ];

  // In chat-only mode the header does not pick the workspace, and its path
  // is a host path like the workspace base.
  const pathHint = input.isolatedChatOnly
    ? undefined
    : readHttpHeader(input.headers, "x-cursor-workspace");
  if (pathHint) {
    lines.push(`X-Cursor-Workspace=${truncate(pathHint, 120)}`);
  }

  const invokeFrom = readHttpHeader(input.headers, "x-cursor-invoke-from");
  const clientLabel = readHttpHeader(input.headers, "x-cursor-proxy-client");
  const client = invokeFrom ?? clientLabel;
  if (client) {
    lines.push(`client=${truncate(client, 64)}`);
  }

  if (input.contextExtra?.trim()) {
    lines.push(truncate(input.contextExtra.trim(), 400));
  }

  return lines.join("\n");
}
