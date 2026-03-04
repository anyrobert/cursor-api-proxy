/**
 * Maps Anthropic/Claude Code model names to Cursor CLI model IDs
 * so clients like Claude Code can send "claude-opus-4-6" and the proxy uses "opus-4.6".
 */

/** Anthropic-style model name (any case) -> Cursor CLI model id */
const ANTHROPIC_TO_CURSOR: Record<string, string> = {
  // Claude 4.6
  "claude-opus-4-6": "opus-4.6",
  "claude-opus-4.6": "opus-4.6",
  "claude-sonnet-4-6": "sonnet-4.6",
  "claude-sonnet-4.6": "sonnet-4.6",
  // Claude 4.5
  "claude-opus-4-5": "opus-4.5",
  "claude-opus-4.5": "opus-4.5",
  "claude-sonnet-4-5": "sonnet-4.5",
  "claude-sonnet-4.5": "sonnet-4.5",
  // Generic 4.x (prefer 4.6)
  "claude-opus-4": "opus-4.6",
  "claude-sonnet-4": "sonnet-4.6",
  // Haiku (Cursor has no Haiku; map to Sonnet)
  "claude-haiku-4-5-20251001": "sonnet-4.5",
  "claude-haiku-4-5": "sonnet-4.5",
  "claude-haiku-4-6": "sonnet-4.6",
  "claude-haiku-4": "sonnet-4.5",
  // Thinking variants (if client sends them)
  "claude-opus-4-6-thinking": "opus-4.6-thinking",
  "claude-sonnet-4-6-thinking": "sonnet-4.6-thinking",
  "claude-opus-4-5-thinking": "opus-4.5-thinking",
  "claude-sonnet-4-5-thinking": "sonnet-4.5-thinking",
};

/** Cursor IDs we want to expose under Anthropic-style names in GET /v1/models */
const CURSOR_TO_ANTHROPIC_ALIAS: Array<{ cursorId: string; anthropicId: string; name: string }> = [
  { cursorId: "opus-4.6", anthropicId: "claude-opus-4-6", name: "Claude 4.6 Opus" },
  { cursorId: "opus-4.6-thinking", anthropicId: "claude-opus-4-6-thinking", name: "Claude 4.6 Opus (Thinking)" },
  { cursorId: "sonnet-4.6", anthropicId: "claude-sonnet-4-6", name: "Claude 4.6 Sonnet" },
  { cursorId: "sonnet-4.6-thinking", anthropicId: "claude-sonnet-4-6-thinking", name: "Claude 4.6 Sonnet (Thinking)" },
  { cursorId: "opus-4.5", anthropicId: "claude-opus-4-5", name: "Claude 4.5 Opus" },
  { cursorId: "opus-4.5-thinking", anthropicId: "claude-opus-4-5-thinking", name: "Claude 4.5 Opus (Thinking)" },
  { cursorId: "sonnet-4.5", anthropicId: "claude-sonnet-4-5", name: "Claude 4.5 Sonnet" },
  { cursorId: "sonnet-4.5-thinking", anthropicId: "claude-sonnet-4-5-thinking", name: "Claude 4.5 Sonnet (Thinking)" },
];

/**
 * Resolve a requested model (e.g. from the client) to the Cursor CLI model ID.
 * If the request uses an Anthropic-style name, returns the mapped Cursor ID; otherwise returns the value as-is.
 */
export function resolveToCursorModel(requested: string | undefined): string | undefined {
  if (!requested || !requested.trim()) return undefined;
  const key = requested.trim().toLowerCase();
  return ANTHROPIC_TO_CURSOR[key] ?? requested.trim();
}

/**
 * Return extra model list entries for GET /v1/models so clients like Claude Code
 * see Anthropic-style ids (e.g. claude-opus-4-6) when those Cursor models are available.
 */
export function getAnthropicModelAliases(availableCursorIds: string[]): Array<{ id: string; name: string }> {
  const set = new Set(availableCursorIds);
  return CURSOR_TO_ANTHROPIC_ALIAS
    .filter((a) => set.has(a.cursorId))
    .map((a) => ({ id: a.anthropicId, name: a.name }));
}
