/**
 * Sanitizes prompts passed to the Cursor CLI agent by stripping/replacing
 * third-party AI branding, telemetry headers, and identifying metadata that
 * could indicate the request originated outside of Cursor.
 */

const RULES: Array<[RegExp, string]> = [
  // Strip x-anthropic-billing-header prefix (injected by Claude Code CLI)
  [/x-anthropic-billing-header:[^\n]*\n?/gi, ""],
  // Strip individual telemetry tokens that may appear in headers or text
  [/\bcc_version=[^\s;,\n]+[;,]?\s*/gi, ""],
  [/\bcc_entrypoint=[^\s;,\n]+[;,]?\s*/gi, ""],
  [/\bcch=[a-f0-9]+[;,]?\s*/gi, ""],
  // Replace "Claude Code" product name with "Cursor"
  [/\bClaude Code\b/g, "Cursor"],
  // Replace full Anthropic CLI description
  [/Anthropic['']s official CLI for Claude/gi, "Cursor AI assistant"],
  // Replace remaining Anthropic company brand references
  [/\bAnthropic\b/g, "Cursor"],
  // Replace known Anthropic domains
  [/anthropic\.com/gi, "cursor.com"],
  [/claude\.ai/gi, "cursor.sh"],
  // Normalise leftover leading semicolons/whitespace at start of content
  [/^[;,\s]+/, ""],
];

type JsonRecord = {
  [key: string]: unknown;
  content?: unknown;
  text?: unknown;
  type?: unknown;
};

/**
 * Apply all sanitization rules to a string.
 * Safe to call with any string; returns the original value if nothing matched.
 */
export function sanitizeText(text: string): string {
  let s = text;
  for (const [pattern, replacement] of RULES) {
    s = s.replace(pattern, replacement);
  }
  return s;
}

/** Alias kept for backwards compat. */
export const sanitizePrompt = sanitizeText;

/**
 * Sanitize an OpenAI-style messages array in place (returns a new array).
 * Handles both string and array content parts.
 */
export function sanitizeMessages(messages: unknown[]): JsonRecord[] {
  return (messages ?? []).map((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    const m = value as JsonRecord;
    if (typeof m.content === "string") {
      return { ...m, content: sanitizeText(m.content) };
    }
    if (Array.isArray(m.content)) {
      return {
        ...m,
        content: m.content.map((part) => {
          if (!part || typeof part !== "object" || Array.isArray(part))
            return part;
          const p = part as JsonRecord;
          if (p.type === "text" && typeof p.text === "string") {
            return { ...p, text: sanitizeText(p.text) };
          }
          return p;
        }),
      };
    }
    return m;
  });
}

/**
 * Sanitize an Anthropic-style system field (string or content-block array).
 */
export function sanitizeSystem(system: unknown): unknown {
  if (typeof system === "string") return sanitizeText(system);
  if (Array.isArray(system)) {
    return system.map((part) => {
      if (!part || typeof part !== "object" || Array.isArray(part)) return part;
      const p = part as JsonRecord;
      if (p.type === "text" && typeof p.text === "string") {
        return { ...p, text: sanitizeText(p.text) };
      }
      return p;
    });
  }
  return system;
}
