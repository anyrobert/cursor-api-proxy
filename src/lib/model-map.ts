/**
 * Maps Anthropic/Claude Code model names to Cursor CLI model IDs
 * so clients like Claude Code can send "claude-opus-4-6" and the proxy uses "opus-4.6".
 */

export type ModelResolutionDecision = {
  requested?: string;
  mapped?: string;
  final: string;
  reasoningEffort?: CursorReasoningEffort;
  requestedWasDefault: boolean;
  validated: boolean;
  fallbackUsed: boolean;
  fallbackReason?: string;
};

export type CursorReasoningEffort =
  | "none"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";

export class UnsupportedReasoningEffortError extends Error {
  readonly code = "unsupported_reasoning_effort";

  constructor(
    readonly model: string,
    readonly effort: string,
  ) {
    super(`Cursor model "${model}" does not offer reasoning effort "${effort}"`);
    this.name = "UnsupportedReasoningEffortError";
  }
}

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

function normalizeForLookup(value: string): string {
  return value.trim().toLowerCase();
}

function mapClaudeDatedVariant(key: string): string | undefined {
  const trimmed = key.trim().toLowerCase();
  const simplified = trimmed.replace(/-v\d+$/i, "");
  const match = simplified.match(
    /^claude-(opus|sonnet|haiku)-4(?:[.-](5|6))?(?:-thinking)?(?:-\d{8})?$/,
  );
  if (!match) return undefined;

  const family = match[1];
  const version = match[2];
  const isThinking = simplified.includes("-thinking");

  const normalizedFamily = family === "haiku" ? "sonnet" : family;
  const normalizedVersion = version ?? "6";
  const suffix = isThinking ? "-thinking" : "";
  return `${normalizedFamily}-4.${normalizedVersion}${suffix}`;
}

/**
 * Resolve a requested model (e.g. from the client) to the Cursor CLI model ID.
 * If the request uses an Anthropic-style name, returns the mapped Cursor ID; otherwise returns the value as-is.
 */
export function resolveToCursorModel(requested: string | undefined): string | undefined {
  if (!requested || !requested.trim()) return undefined;
  const key = normalizeForLookup(requested);
  return ANTHROPIC_TO_CURSOR[key] ?? mapClaudeDatedVariant(key) ?? requested.trim();
}

function matchAvailableModel(
  candidate: string | undefined,
  availableCursorIds: string[],
): string | undefined {
  if (!candidate) return undefined;
  const byLower = new Map(availableCursorIds.map((id) => [id.toLowerCase(), id]));
  return byLower.get(candidate.toLowerCase());
}

const EFFORT_ALIASES: Record<string, CursorReasoningEffort> = {
  off: "none",
  none: "none",
  minimal: "minimal",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "xhigh",
  "extra-high": "xhigh",
  extra_high: "xhigh",
  max: "max",
};

const EFFORT_SUFFIXES = [
  "extra-high",
  "minimal",
  "medium",
  "xhigh",
  "high",
  "none",
  "low",
  "max",
] as const;

function normalizeReasoningEffort(
  effort: string | undefined,
): CursorReasoningEffort | undefined {
  if (!effort?.trim()) return undefined;
  return EFFORT_ALIASES[effort.trim().toLowerCase()];
}

function splitFastSuffix(model: string): { base: string; fast: boolean } {
  return model.toLowerCase().endsWith("-fast")
    ? { base: model.slice(0, -5), fast: true }
    : { base: model, fast: false };
}

function stripEffortSuffix(model: string): string {
  const lower = model.toLowerCase();
  const suffix = EFFORT_SUFFIXES.find((value) =>
    lower.endsWith(`-${value}`),
  );
  return suffix ? model.slice(0, -(suffix.length + 1)) : model;
}

function effortSuffixCandidates(effort: CursorReasoningEffort): string[] {
  if (effort === "xhigh") return ["xhigh", "extra-high"];
  return [effort];
}

function resolveReasoningModel(args: {
  model: string;
  effort: CursorReasoningEffort;
  availableCursorIds: string[];
}): string | undefined {
  if (args.model === "default" || args.model === "auto") return undefined;

  const { base: withoutFast, fast } = splitFastSuffix(args.model);
  const base = stripEffortSuffix(withoutFast);
  for (const suffix of effortSuffixCandidates(args.effort)) {
    const candidate = `${base}-${suffix}${fast ? "-fast" : ""}`;
    const matched = matchAvailableModel(candidate, args.availableCursorIds);
    if (matched) return matched;
  }
  return undefined;
}

export function resolveModelForExecution(args: {
  requested: string | undefined;
  defaultModel: string;
  availableCursorIds: string[];
  reasoningEffort?: string;
}): ModelResolutionDecision {
  const requested = args.requested?.trim();
  const requestedWasDefault = requested === "default";
  const mapped = requestedWasDefault
    ? "default"
    : resolveToCursorModel(requested) ?? args.defaultModel;
  const reasoningEffort = normalizeReasoningEffort(args.reasoningEffort);

  if (args.reasoningEffort && !reasoningEffort) {
    throw new UnsupportedReasoningEffortError(
      mapped,
      args.reasoningEffort,
    );
  }

  if (reasoningEffort) {
    const reasoningModel = resolveReasoningModel({
      model: mapped,
      effort: reasoningEffort,
      availableCursorIds: args.availableCursorIds,
    });
    if (!reasoningModel) {
      throw new UnsupportedReasoningEffortError(mapped, reasoningEffort);
    }
    return {
      requested,
      mapped,
      final: reasoningModel,
      reasoningEffort,
      requestedWasDefault,
      validated: true,
      fallbackUsed: false,
    };
  }

  if (mapped === "default") {
    return {
      requested,
      mapped,
      final: "default",
      requestedWasDefault,
      validated: true,
      fallbackUsed: false,
    };
  }

  const matchedMapped = matchAvailableModel(mapped, args.availableCursorIds);
  if (matchedMapped) {
    return {
      requested,
      mapped,
      final: matchedMapped,
      requestedWasDefault,
      validated: true,
      fallbackUsed: false,
    };
  }

  const matchedDefault = matchAvailableModel(args.defaultModel, args.availableCursorIds);
  if (matchedDefault) {
    return {
      requested,
      mapped,
      final: matchedDefault,
      requestedWasDefault,
      validated: true,
      fallbackUsed: true,
      fallbackReason: "mapped_model_unavailable",
    };
  }

  const matchedAuto = matchAvailableModel("auto", args.availableCursorIds);
  if (matchedAuto) {
    return {
      requested,
      mapped,
      final: matchedAuto,
      requestedWasDefault,
      validated: true,
      fallbackUsed: true,
      fallbackReason: "mapped_model_unavailable",
    };
  }

  const firstAvailable = args.availableCursorIds[0];
  if (firstAvailable) {
    return {
      requested,
      mapped,
      final: firstAvailable,
      requestedWasDefault,
      validated: true,
      fallbackUsed: true,
      fallbackReason: "mapped_model_unavailable",
    };
  }

  return {
    requested,
    mapped,
    final: mapped,
    requestedWasDefault,
    validated: false,
    fallbackUsed: false,
    fallbackReason: "catalog_unavailable",
  };
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
