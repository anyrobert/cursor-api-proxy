import * as fs from "node:fs";
import * as path from "node:path";

import type { AccountStat } from "./account-pool.js";
import type { ModelResolutionDecision } from "./model-map.js";

export function logIncoming(
  method: string,
  pathname: string,
  remoteAddress: string,
): void {
  console.log(
    `[${new Date().toISOString()}] Incoming: ${method} ${pathname} (from ${remoteAddress})`,
  );
}

export type TrafficMessage = { role: string; content: string };

// ANSI color helpers
const C = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  cyan: "\x1b[36m",
  bCyan: "\x1b[1;96m",
  green: "\x1b[32m",
  bGreen: "\x1b[1;92m",
  yellow: "\x1b[33m",
  magenta: "\x1b[35m",
  bMagenta: "\x1b[1;95m",
  red: "\x1b[31m",
  gray: "\x1b[90m",
  white: "\x1b[97m",
};

const ROLE_STYLE: Record<string, string> = {
  system: C.yellow,
  user: C.cyan,
  assistant: C.green,
};

const ROLE_EMOJI: Record<string, string> = {
  system: "🔧",
  user: "👤",
  assistant: "🤖",
};

function ts(): string {
  return `${C.gray}${new Date().toISOString()}${C.reset}`;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  const head = Math.floor(max * 0.6);
  const tail = max - head;
  const omitted = s.length - head - tail;
  return (
    s.slice(0, head) +
    `${C.dim} … (${omitted} chars omitted) … ` +
    s.slice(s.length - tail) +
    C.reset
  );
}

function hr(char = "─", len = 60): string {
  return C.gray + char.repeat(len) + C.reset;
}

export function logAccountAssigned(configDir: string | undefined): void {
  if (!configDir) return;
  const name = path.basename(configDir);
  console.log(
    `[${new Date().toISOString()}] ${C.bCyan}→ account${C.reset} ${C.bold}${name}${C.reset}`,
  );
}

export function logAccountStats(verbose: boolean, stats: AccountStat[]): void {
  if (!verbose || stats.length === 0) return;
  const lines: string[] = [];
  for (const s of stats) {
    const name = path.basename(s.configDir).padEnd(20);
    const active =
      s.activeRequests > 0
        ? `${C.bCyan}active:${s.activeRequests}${C.reset}`
        : `${C.dim}active:0${C.reset}`;
    const total = `total:${C.bold}${s.totalRequests}${C.reset}`;
    const ok = `${C.green}ok:${s.totalSuccess}${C.reset}`;
    const err =
      s.totalErrors > 0
        ? `${C.red}err:${s.totalErrors}${C.reset}`
        : `${C.dim}err:0${C.reset}`;
    const rl =
      s.totalRateLimits > 0
        ? `${C.yellow}rl:${s.totalRateLimits}${C.reset}`
        : `${C.dim}rl:0${C.reset}`;
    const avg =
      s.totalRequests > 0
        ? `avg:${Math.round(s.totalLatencyMs / s.totalRequests)}ms`
        : `avg:-`;
    const status = s.isRateLimited
      ? `${C.red}⛔ rate-limited (recovers ${new Date(s.rateLimitUntil).toISOString()})${C.reset}`
      : `${C.green}✓${C.reset}`;
    lines.push(
      `  ${C.bold}${name}${C.reset}  ${active}  ${total}  ${ok}  ${err}  ${rl}  ${C.dim}${avg}${C.reset}  ${status}`,
    );
  }
  console.log(`${C.gray}┌─ Account Stats ${"─".repeat(44)}┐${C.reset}`);
  for (const l of lines) console.log(l);
  console.log(`${C.gray}└${"─".repeat(60)}┘${C.reset}`);
}

export function logTrafficRequest(
  verbose: boolean,
  model: string,
  messages: TrafficMessage[],
  isStream: boolean,
): void {
  if (!verbose) return;
  const modeTag = isStream
    ? `${C.bCyan}⚡ stream${C.reset}`
    : `${C.dim}sync${C.reset}`;
  const modelStr = `${C.bMagenta}✦ ${model}${C.reset}`;
  console.log(hr());
  console.log(
    `${ts()} 📤 ${C.bCyan}${C.bold}REQUEST${C.reset}  ${modelStr}  ${modeTag}`,
  );
  for (const m of messages) {
    const roleColor = ROLE_STYLE[m.role] ?? C.white;
    const emoji = ROLE_EMOJI[m.role] ?? "💬";
    const label = `${roleColor}${C.bold}[${m.role}]${C.reset}`;
    const charCount = `${C.dim}(${m.content.length} chars)${C.reset}`;
    const preview = truncate(m.content.replace(/\n/g, "↵ "), 280);
    console.log(`  ${emoji} ${label} ${charCount}`);
    console.log(`     ${C.dim}${preview}${C.reset}`);
  }
}

export function logTrafficResponse(
  verbose: boolean,
  model: string,
  text: string,
  isStream: boolean,
): void {
  if (!verbose) return;
  const modeTag = isStream
    ? `${C.bGreen}⚡ stream${C.reset}`
    : `${C.dim}sync${C.reset}`;
  const modelStr = `${C.bMagenta}✦ ${model}${C.reset}`;
  const charCount = `${C.bold}${text.length}${C.reset}${C.dim} chars${C.reset}`;
  const preview = truncate(text.replace(/\n/g, "↵ "), 480);
  console.log(
    `${ts()} 📥 ${C.bGreen}${C.bold}RESPONSE${C.reset}  ${modelStr}  ${modeTag}  ${charCount}`,
  );
  console.log(`  🤖 ${C.green}${preview}${C.reset}`);
  console.log(hr("─", 60));
}

/** One step of a client-tool ACP turn: parked, resumed, rebuilt, closed. */
export function logToolSession(verbose: boolean, message: string): void {
  if (!verbose) return;
  console.log(`${ts()} ${C.bold}${C.yellow}TOOL${C.reset} ${message}`);
}

export function logModelResolution(
  verbose: boolean,
  decision: ModelResolutionDecision,
): void {
  if (!verbose) return;
  const requested = decision.requested ?? "(none)";
  const mapped = decision.mapped ?? "(none)";
  const fallback = decision.fallbackUsed
    ? `${C.yellow}yes${C.reset}${decision.fallbackReason ? ` (${decision.fallbackReason})` : ""}`
    : `${C.dim}no${C.reset}`;
  const validated = decision.validated
    ? `${C.green}yes${C.reset}`
    : `${C.red}no${C.reset}`;
  console.log(
    `${ts()} ${C.bMagenta}MODEL${C.reset} requested=${C.white}${requested}${C.reset} mapped=${C.white}${mapped}${C.reset} final=${C.bold}${decision.final}${C.reset} validated=${validated} fallback=${fallback}`,
  );
}

export function appendSessionLine(
  logPath: string,
  method: string,
  pathname: string,
  remoteAddress: string,
  statusCode: number,
): void {
  if (pathname === "/api/log" || pathname === "/api/status") {
    return;
  }
  const line = `${new Date().toISOString()} ${method} ${pathname} ${remoteAddress} ${statusCode}\n`;
  try {
    const dir = path.dirname(logPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.appendFileSync(logPath, line);
  } catch (err) {
    console.error("Failed to write sessions log:", err);
  }
}

/**
 * One ERROR line in the sessions log: the failure's tag and the first 200
 * characters of its detail, on one line.
 */
function appendSessionError(
  logPath: string,
  method: string,
  pathname: string,
  remoteAddress: string,
  tag: string,
  detail: string,
): void {
  try {
    const truncated = detail.trim().slice(0, 200).replace(/\n/g, " ");
    fs.appendFileSync(
      logPath,
      `${new Date().toISOString()} ERROR ${method} ${pathname} ${remoteAddress} ${tag} ${truncated}\n`,
    );
  } catch {
    /* ignore */
  }
}

/**
 * Log an agent execution error to console and sessions log.
 * Returns the message for the API response: `reason` when the proxy knows
 * why the run failed (never raw CLI stderr), else a generic line.
 */
export function logAgentError(
  logPath: string,
  method: string,
  pathname: string,
  remoteAddress: string,
  exitCode: number,
  stderr: string,
  reason?: string,
): string {
  const errMsg = `Cursor CLI failed (exit ${exitCode}): ${stderr.trim()}`;
  console.error(`[${new Date().toISOString()}] Agent error: ${errMsg}`);
  appendSessionError(
    logPath,
    method,
    pathname,
    remoteAddress,
    `agent_exit_${exitCode}`,
    stderr,
  );
  return (
    reason?.trim() ||
    `The Cursor agent process exited with code ${exitCode}. See server logs for details.`
  );
}

/**
 * Log a failed turn the proxy reported to its client: its code and client
 * message to the console, and to the sessions log its code with `detail`
 * (server-side diagnostics, such as the CLI output of an agent that
 * exited), or else the message.
 */
export function logTurnFailure(
  logPath: string,
  method: string,
  pathname: string,
  remoteAddress: string,
  failure: { code: string; message: string },
  detail?: string,
): void {
  console.error(
    `[${new Date().toISOString()}] Agent turn failed (${failure.code}): ${failure.message}`,
  );
  appendSessionError(
    logPath,
    method,
    pathname,
    remoteAddress,
    failure.code,
    detail?.trim() || failure.message,
  );
}
