import type { IncomingHttpHeaders } from "node:http";

import type { CursorExecutionMode } from "./execution-mode.js";

/** Joins bridge preamble and user/tool prompt in chat + Anthropic handlers. */
export const BRIDGE_AGENT_PROMPT_SEPARATOR = "\n\n---\n\n";

export type BridgeContextPreambleInput = {
  headers: IncomingHttpHeaders;
  /** Resolved `CURSOR_BRIDGE_WORKSPACE` (absolute). */
  bridgeWorkspaceBase: string;
  /** Directory the Cursor agent process uses as workspace cwd. */
  agentWorkspaceDir: string;
  /** True when the agent runs in an isolated temp dir (chat-only sandbox). */
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
 * Short factual prefix: request went through this HTTP bridge, CLI mode, and
 * which directories apply. Optional lines only when headers / env add signal.
 */
export function buildBridgeContextPreamble(
  input: BridgeContextPreambleInput,
): string {
  const samePath =
    !input.isolatedChatOnly &&
    input.bridgeWorkspaceBase === input.agentWorkspaceDir;
  const loc = samePath
    ? `cwd=${input.agentWorkspaceDir}`
    : `workspace=${input.bridgeWorkspaceBase}; agent cwd=${input.agentWorkspaceDir}`;
  const sandbox = input.isolatedChatOnly ? " (agent cwd is a temp sandbox)" : "";

  const lines: string[] = [
    `Via cursor-api-proxy → Cursor CLI. ${loc}; mode=${input.cursorMode}${sandbox}.`,
  ];

  const pathHint = readHttpHeader(input.headers, "x-cursor-workspace");
  if (pathHint) {
    const hintTag = input.isolatedChatOnly ? " (hint only)" : "";
    lines.push(`X-Cursor-Workspace=${truncate(pathHint, 120)}${hintTag}`);
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
