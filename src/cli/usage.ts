import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as https from "node:https";

// ---------------------------------------------------------------------------
// Token file written per-account after each agent run
// ---------------------------------------------------------------------------

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
    fs.writeFileSync(path.join(configDir, TOKEN_FILE), token, "utf-8");
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

// ---------------------------------------------------------------------------
// JWT helpers (no external dependencies)
// ---------------------------------------------------------------------------

export function decodeJwtPayload(token: string): Record<string, unknown> {
  try {
    const parts = token.split(".");
    if (parts.length < 2) return {};
    const padded = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(Buffer.from(padded, "base64").toString("utf-8"));
  } catch {
    return {};
  }
}

/** Extract the auth0 user sub from a Cursor access token (e.g. "auth0|user_01KK…"). */
export function tokenSub(token: string): string | undefined {
  const p = decodeJwtPayload(token);
  return typeof p.sub === "string" ? p.sub : undefined;
}

// ---------------------------------------------------------------------------
// Cursor API
// ---------------------------------------------------------------------------

const API_BASE = "https://api2.cursor.sh";

function apiGet(path: string, token: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: "api2.cursor.sh",
      path,
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
    };
    const req = https.request(opts, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        try {
          resolve(JSON.parse(data));
        } catch {
          resolve(null);
        }
      });
    });
    req.on("error", reject);
    req.setTimeout(8000, () => {
      req.destroy(new Error("timeout"));
    });
    req.end();
  });
}

export type ModelUsage = {
  numRequests: number;
  numRequestsTotal: number;
  numTokens: number;
  maxTokenUsage: number | null;
  maxRequestUsage: number | null;
};

export type UsageData = {
  startOfMonth: string;
  models: Record<string, ModelUsage>;
};

export async function fetchAccountUsage(
  token: string,
): Promise<UsageData | null> {
  try {
    const raw = (await apiGet("/auth/usage", token)) as Record<
      string,
      unknown
    > | null;
    if (!raw || typeof raw !== "object") return null;
    const { startOfMonth, ...rest } = raw as Record<string, unknown>;
    return {
      startOfMonth: typeof startOfMonth === "string" ? startOfMonth : "",
      models: rest as Record<string, ModelUsage>,
    };
  } catch {
    return null;
  }
}

export type StripeProfile = {
  membershipType: string;
  subscriptionStatus: string;
  daysRemainingOnTrial: number | null;
  isTeamMember: boolean;
  isYearlyPlan: boolean;
};

/** Human-readable plan name + limits for display. */
export function describePlan(profile: StripeProfile): string {
  const { membershipType, subscriptionStatus, daysRemainingOnTrial } = profile;
  switch (membershipType) {
    case "free_trial": {
      const days = daysRemainingOnTrial ?? 0;
      return `Free Trial (${days}d left) — unlimited fast requests`;
    }
    case "pro":
    case "pro_plus":
    case "ultra":
      return `${membershipType === "pro" ? "Pro" : membershipType === "pro_plus" ? "Pro+" : "Ultra"} — extended limits`;
    case "free":
    case "hobby":
      return "Hobby (free) — limited agent requests";
    default:
      return `${membershipType} · ${subscriptionStatus}`;
  }
}

export async function fetchStripeProfile(
  token: string,
): Promise<StripeProfile | null> {
  try {
    const raw = (await apiGet("/auth/full_stripe_profile", token)) as Record<
      string,
      unknown
    > | null;
    if (!raw || typeof raw !== "object") return null;
    return {
      membershipType: String(raw.membershipType ?? ""),
      subscriptionStatus: String(raw.subscriptionStatus ?? ""),
      daysRemainingOnTrial:
        typeof raw.daysRemainingOnTrial === "number"
          ? raw.daysRemainingOnTrial
          : null,
      isTeamMember: Boolean(raw.isTeamMember),
      isYearlyPlan: Boolean(raw.isYearlyPlan),
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Summary helpers
// ---------------------------------------------------------------------------

// Human-readable labels for Cursor's internal model/pool keys.
// Keys are actual identifiers from the agent binary (2026.03.20 build).
const MODEL_LABELS: Record<string, string> = {
  // ── Usage pool keys (what the /auth/usage API actually returns) ──
  "gpt-4": "Fast Premium Requests", // main premium pool (all models)

  // ── Claude Sonnet ──
  "claude-sonnet-4-6": "Claude Sonnet 4.6",
  "claude-sonnet-4-5-20250929-v1": "Claude Sonnet 4.5",
  "claude-sonnet-4-20250514-v1": "Claude Sonnet 4",

  // ── Claude Opus ──
  "claude-opus-4-6-v1": "Claude Opus 4.6",
  "claude-opus-4-5-20251101-v1": "Claude Opus 4.5",
  "claude-opus-4-1-20250805-v1": "Claude Opus 4.1",
  "claude-opus-4-20250514-v1": "Claude Opus 4",

  // ── Claude Haiku ──
  "claude-haiku-4-5-20251001-v1": "Claude Haiku 4.5",
  "claude-3-5-haiku-20241022-v1": "Claude 3.5 Haiku",

  // ── GPT / OpenAI ──
  "gpt-5": "GPT-5",
  "gpt-4o": "GPT-4o",
  o1: "o1",
  "o3-mini": "o3-mini",

  // ── Cursor-native ──
  "cursor-small": "Cursor Small (free)",
};

function modelLabel(key: string): string {
  return MODEL_LABELS[key] ?? key;
}

export function formatUsageSummary(usage: UsageData): string[] {
  const lines: string[] = [];
  const start = usage.startOfMonth
    ? new Date(usage.startOfMonth).toLocaleDateString()
    : "?";
  lines.push(`     📅 Billing period from ${start}`);

  const entries = Object.entries(usage.models);
  if (entries.length === 0) {
    lines.push(`     🔢 No requests this billing period`);
    return lines;
  }

  // Sort: entries with limits first, then by usage descending
  const sorted = entries.sort(([, a], [, b]) => {
    if ((a.maxRequestUsage !== null) !== (b.maxRequestUsage !== null))
      return a.maxRequestUsage !== null ? -1 : 1;
    return b.numRequests - a.numRequests;
  });

  for (const [key, v] of sorted) {
    const used = v.numRequests;
    const max = v.maxRequestUsage;
    const label = modelLabel(key);
    if (max !== null && max > 0) {
      const pct = Math.round((used / max) * 100);
      const bar = makeBar(used, max, 12);
      lines.push(`     🔢 ${label}: ${used}/${max} (${pct}%) [${bar}]`);
    } else if (used > 0) {
      lines.push(`     🔢 ${label}: ${used} requests`);
    } else {
      lines.push(`     🔢 ${label}: 0 requests (unlimited)`);
    }
  }

  return lines;
}

function makeBar(used: number, max: number, width: number): string {
  const fill = Math.round((used / max) * width);
  return "█".repeat(fill) + "░".repeat(width - fill);
}
