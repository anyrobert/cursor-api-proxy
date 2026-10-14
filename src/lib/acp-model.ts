/**
 * Map Cursor CLI model ids onto ACP session/set_config_option.
 *
 * Matching is catalog-driven and has no per-family id table. Public CLI ids
 * are decomposed by trailing suffixes (`-fast`, effort, `-thinking`) plus an
 * optional `cursor-` vendor prefix; the ACP catalog then supplies the base
 * row and the concrete option ids/values. New families (Grok 4.8, …) work as
 * long as ACP advertises a matching base row.
 *
 * Catalog shapes:
 * - parameterized (client advertises `_meta.parameterizedModelPicker`): one
 *   family id (`glm-5.2`, `grok-4.6`) plus effort/thinking/fast selects
 * - legacy bracket rows (`glm-5.2[reasoning=high]`) with a single variant
 * - per-variant rows (`grok-4.6-medium`) that already encode the suffix
 */

export type AcpCatalogModel = { modelId: string; name: string };

export type AcpModelParameters = {
  effort?: string;
  thinking: boolean;
  fast: boolean;
};

export type AcpModelPlan =
  | { action: "passthrough"; modelId: string }
  | { action: "skip" }
  | { action: "missing"; candidates: string[] }
  | { action: "set"; modelId: string; parameters?: AcpModelParameters };

export type AcpConfigOption = {
  id: string;
  currentValue?: string;
  options?: Array<{ value?: string }>;
};

/**
 * The model request. Both ACP paths take these fields in their options and
 * pass them through unchanged, so they always decide on the same inputs.
 */
export type AcpModelOptions = {
  /** Public CLI id (`agent --list-models`); also spawned as `agent acp --model`. */
  model?: string;
  /** Extra catalog names, typically the `agent --list-models` display name. */
  modelAliases?: readonly string[];
  /** Fail when neither the ACP catalog nor the CLI yields a model. */
  strictModel?: boolean;
};

export const ACP_CLIENT_CAPABILITIES = {
  fs: { readTextFile: false, writeTextFile: false },
  terminal: false,
  _meta: { parameterizedModelPicker: true },
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

/** Effort/reasoning select ids seen in the ACP catalog and in bracket rows. */
const LEVEL_OPTION_IDS = ["reasoning", "effort", "reasoning_effort"] as const;

function norm(value: string): string {
  return value.trim().toLowerCase();
}

function isAutoRequest(value: string): boolean {
  const key = norm(value);
  return key === "auto" || key === "default";
}

function isAutoRow(model: AcpCatalogModel): boolean {
  const id = norm(model.modelId);
  const name = norm(model.name);
  return id === "default" || id === "default[]" || name === "auto";
}

function baseModelId(modelId: string): string {
  return modelId.replace(/\[.*$/, "");
}

/**
 * Strip the public CLI vendor prefix. `agent --list-models` emits both
 * `cursor-grok-4.6-medium` and unprefixed `grok-4.7-low`; ACP catalog rows
 * typically omit `cursor-`. This is a prefix rule, not a model-name list —
 * `cursor-<anything>` stays future-proof.
 */
function withoutCursorPrefix(value: string): string {
  return value.startsWith("cursor-") ? value.slice("cursor-".length) : value;
}

function keySet(values: ReadonlyArray<string | undefined>): Set<string> {
  return new Set(
    values
      .filter((value): value is string => Boolean(value))
      .map((value) => norm(value))
      .filter(Boolean),
  );
}

function stripSuffix(
  model: string,
  suffixes: readonly string[],
): { base: string; suffix?: string } {
  const lower = model.toLowerCase();
  const suffix = suffixes.find((value) => lower.endsWith(`-${value}`));
  if (!suffix) return { base: model };
  return { base: model.slice(0, -(suffix.length + 1)), suffix };
}

function parseCliModelVariant(model: string): {
  base: string;
  effort?: string;
  thinking: boolean;
  fast: boolean;
  variant: boolean;
  auto: boolean;
} {
  const raw = model.trim();
  if (isAutoRequest(raw)) {
    return { base: raw, thinking: false, fast: false, variant: false, auto: true };
  }
  const fast = stripSuffix(raw, ["fast"]);
  const effort = stripSuffix(fast.base, EFFORT_SUFFIXES);
  const thinking = stripSuffix(effort.base, ["thinking"]);
  return {
    base: thinking.base,
    effort: effort.suffix,
    thinking: Boolean(thinking.suffix),
    fast: Boolean(fast.suffix),
    variant: Boolean(fast.suffix || effort.suffix || thinking.suffix),
    auto: false,
  };
}

function bracketParams(modelId: string): Record<string, string> | undefined {
  const match = modelId.match(/\[(.*)\]\s*$/);
  if (!match) return undefined;
  const params: Record<string, string> = {};
  if (!match[1]) return params;
  for (const part of match[1].split(",")) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    params[norm(part.slice(0, eq))] = norm(part.slice(eq + 1));
  }
  return params;
}

function effortCandidates(effort: string): string[] {
  const value = norm(effort);
  if (value === "xhigh" || value === "extra-high" || value === "extra_high") {
    return ["xhigh", "extra-high"];
  }
  return [value];
}

function variantMatchesBracket(
  parsed: ReturnType<typeof parseCliModelVariant>,
  params: Record<string, string>,
): boolean {
  if (parsed.effort) {
    const level = LEVEL_OPTION_IDS.map((id) => params[id]).find(Boolean);
    if (!level || !effortCandidates(parsed.effort).includes(level)) return false;
  }
  if (parsed.fast !== (params.fast === "true")) return false;
  if (parsed.thinking !== (params.thinking === "true")) return false;
  return true;
}

function rowMatches(model: AcpCatalogModel, keys: Set<string>): boolean {
  return (
    keys.has(norm(model.name)) ||
    keys.has(norm(model.modelId)) ||
    keys.has(norm(baseModelId(model.modelId)))
  );
}

/**
 * Resolve a public CLI id against the ACP catalog.
 *
 * Phase 1 matches the full id (with/without `cursor-`). Phase 2 uses display
 * names only when they cannot swallow a variant (plain base name like
 * "Grok 4.5" for `cursor-grok-4.5-high` is not authoritative). Phase 3 strips
 * effort/fast/thinking suffixes and matches the remaining base family.
 */
export function planAcpModelSelection(
  requested: string,
  availableModels: readonly AcpCatalogModel[] | undefined,
  aliases: readonly string[] = [],
): AcpModelPlan {
  const trimmed = requested.trim();
  if (!trimmed) return { action: "skip" };
  if (!availableModels?.length) {
    return isAutoRequest(trimmed)
      ? { action: "skip" }
      : { action: "passthrough", modelId: trimmed };
  }

  const parsed = parseCliModelVariant(trimmed);
  if (parsed.auto) {
    const auto = availableModels.find(isAutoRow);
    return auto
      ? { action: "set", modelId: auto.modelId }
      : { action: "skip" };
  }

  const idKeys = keySet([trimmed, withoutCursorPrefix(trimmed)]);
  const aliasKeys = keySet(aliases);
  const baseKeys = parsed.variant
    ? keySet([parsed.base, withoutCursorPrefix(parsed.base)])
    : keySet([]);

  const missing = (): AcpModelPlan => ({
    action: "missing",
    candidates: [...idKeys, ...aliasKeys, ...baseKeys],
  });

  // Phase 1: authoritative id match — the full requested id with or without
  // the public "cursor-" prefix pins a single catalog row.
  const idHit = availableModels.find((model) => rowMatches(model, idKeys));
  if (idHit) {
    const params = bracketParams(idHit.modelId);
    if (!parsed.variant || !params || variantMatchesBracket(parsed, params)) {
      return { action: "set", modelId: idHit.modelId };
    }
    return missing();
  }

  // Phase 2: display-name alias. Authoritative when the request is plain or
  // the row is a legacy bracket row whose name encodes the variant. A plain
  // base row name (e.g. "Grok 4.5" for cursor-grok-4.5-high) is NOT
  // authoritative for a variant request — fall through to base matching so
  // the requested options are still applied.
  if (aliasKeys.size > 0) {
    const aliasHit = availableModels.find((model) =>
      rowMatches(model, aliasKeys),
    );
    if (aliasHit) {
      const params = bracketParams(aliasHit.modelId);
      if (!parsed.variant) return { action: "set", modelId: aliasHit.modelId };
      if (params) {
        return variantMatchesBracket(parsed, params)
          ? { action: "set", modelId: aliasHit.modelId }
          : missing();
      }
    }
  }

  // Phase 3: variant decomposition — match the base family (with or without
  // the "cursor-" prefix), then apply the requested options or bracket check.
  if (parsed.variant) {
    const hit = availableModels.find((model) => {
      if (!rowMatches(model, baseKeys)) return false;
      const params = bracketParams(model.modelId);
      return !params || variantMatchesBracket(parsed, params);
    });
    if (hit) {
      if (bracketParams(hit.modelId)) {
        return { action: "set", modelId: hit.modelId };
      }
      return {
        action: "set",
        modelId: hit.modelId,
        parameters: {
          effort: parsed.effort,
          thinking: parsed.thinking,
          fast: parsed.fast,
        },
      };
    }
  }

  return missing();
}

export function acpModelSelectionError(
  requested: string,
  candidates?: readonly string[],
): string {
  const tried = [
    ...new Set(
      (candidates ?? [])
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  ].filter((value) => value !== norm(requested));
  const detail = tried.length
    ? ` (also tried: ${tried.join(", ")})`
    : "";
  return `ACP model catalog has no match for ${JSON.stringify(requested)}${detail}`;
}

function readAcpConfigOptions(result: unknown): AcpConfigOption[] {
  if (!result || typeof result !== "object") return [];
  const list = (result as { configOptions?: unknown }).configOptions;
  return Array.isArray(list) ? (list as AcpConfigOption[]) : [];
}

function optionValues(option: AcpConfigOption): string[] {
  return (option.options ?? [])
    .map((item) => (item.value == null ? "" : String(item.value)))
    .filter(Boolean);
}

function findOption(
  options: readonly AcpConfigOption[],
  id: string,
): AcpConfigOption | undefined {
  const key = norm(id);
  return options.find((option) => norm(option.id) === key);
}

function describeAdvertised(options: readonly AcpConfigOption[]): string {
  const parts = options
    .filter((option) => option.id && option.id !== "model")
    .map((option) => `${option.id}=[${optionValues(option).join(", ")}]`);
  return parts.length ? parts.join(", ") : "(none)";
}

/** A select change to send, a reason it cannot be sent, or nothing to do. */
type OptionChange =
  | { configId: string; value: string }
  | { problem: string }
  | undefined;

function changeTo(option: AcpConfigOption, value: string): OptionChange {
  return String(option.currentValue) === value
    ? undefined
    : { configId: option.id, value };
}

function effortChange(
  options: readonly AcpConfigOption[],
  effort: string,
): OptionChange {
  const levels = LEVEL_OPTION_IDS.map((id) => findOption(options, id)).filter(
    (option): option is AcpConfigOption => Boolean(option),
  );
  if (levels.length === 0) {
    return { problem: "has no reasoning or effort parameter" };
  }
  const wanted = effortCandidates(effort);
  for (const option of levels) {
    const value = optionValues(option).find((item) => wanted.includes(norm(item)));
    if (value) return changeTo(option, value);
  }
  const first = levels[0]!;
  return {
    problem: `does not offer ${first.id} ${JSON.stringify(effort)} (available: ${optionValues(first).join(", ")})`,
  };
}

function booleanChange(
  options: readonly AcpConfigOption[],
  id: "thinking" | "fast",
  desired: boolean,
): OptionChange {
  const option = findOption(options, id);
  if (!option) return desired ? { problem: `has no ${id} parameter` } : undefined;
  const value = String(desired);
  if (!optionValues(option).includes(value)) {
    return {
      problem: `does not offer ${id}=${value} (available: ${optionValues(option).join(", ")})`,
    };
  }
  return changeTo(option, value);
}

export async function applyAcpModelPlan(
  plan: AcpModelPlan,
  setOption: (configId: string, value: string) => Promise<unknown>,
  requested?: string,
): Promise<void> {
  if (plan.action === "skip" || plan.action === "missing") return;
  const result = await setOption("model", plan.modelId);
  if (plan.action !== "set" || !plan.parameters) return;

  const options = readAcpConfigOptions(result);
  const fail = (detail: string): Error => {
    const publicId = requested?.trim();
    const head = publicId
      ? `Requested public model: ${publicId}; matched ACP base model: ${plan.modelId}; `
      : `ACP model ${JSON.stringify(plan.modelId)} `;
    return new Error(
      `${head}${detail}; advertised ACP options: ${describeAdvertised(options)}`,
    );
  };

  const { effort, thinking, fast } = plan.parameters;
  const changes = [
    effort ? effortChange(options, effort) : undefined,
    booleanChange(options, "thinking", thinking),
    booleanChange(options, "fast", fast),
  ];
  for (const change of changes) {
    if (!change) continue;
    if ("problem" in change) throw fail(change.problem);
    try {
      await setOption(change.configId, change.value);
    } catch (error) {
      throw fail(acpFailureText(error));
    }
  }
}

export function formatAcpRpcError(error: {
  message?: string;
  data?: { message?: string } | string;
} | undefined): string {
  const top = error?.message?.trim() || "ACP error";
  const detail =
    typeof error?.data === "string"
      ? error.data.trim()
      : error?.data?.message?.trim();
  if (detail && !top.includes(detail)) return `${top}: ${detail}`;
  return top;
}

export function acpFailureText(error: unknown): string {
  if (error instanceof Error) return error.message.trim();
  return String(error ?? "").trim();
}
