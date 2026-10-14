/**
 * Map Cursor CLI model ids onto ACP session/set_config_option.
 *
 * CLI 2026.09 catalogs two shapes:
 * - parameterized (client advertises `_meta.parameterizedModelPicker`): one
 *   family id (`glm-5.2`) plus separate reasoning/effort/thinking/fast selects
 * - legacy bracket rows (`glm-5.2[reasoning=high]`) with a single variant
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
  | { action: "missing" }
  | { action: "set"; modelId: string; parameters?: AcpModelParameters };

export type AcpConfigOption = {
  id: string;
  currentValue?: string;
  options?: Array<{ value?: string }>;
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

function stripSuffix(
  model: string,
  suffixes: readonly string[],
): { base: string; suffix?: string } {
  const lower = model.toLowerCase();
  const suffix = suffixes.find((value) => lower.endsWith(`-${value}`));
  if (!suffix) return { base: model };
  return { base: model.slice(0, -(suffix.length + 1)), suffix };
}

export function parseCliModelVariant(model: string): {
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
    const level = params.reasoning ?? params.effort ?? params.reasoning_effort;
    if (!level || !effortCandidates(parsed.effort).includes(level)) return false;
  }
  if (parsed.fast) {
    if (params.fast !== "true") return false;
  } else if (params.fast === "true") {
    return false;
  }
  if (parsed.thinking) {
    if (params.thinking !== "true") return false;
  } else if (params.thinking === "true") {
    return false;
  }
  return true;
}

function rowMatches(model: AcpCatalogModel, keys: Set<string>): boolean {
  return (
    keys.has(norm(model.name)) ||
    keys.has(norm(model.modelId)) ||
    keys.has(norm(baseModelId(model.modelId)))
  );
}

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

  const keys = new Set(
    [trimmed, ...aliases, ...(parsed.variant ? [parsed.base] : [])]
      .map((value) => norm(value))
      .filter(Boolean),
  );
  const hit = availableModels.find((model) => rowMatches(model, keys));
  if (!hit) return { action: "missing" };
  if (!parsed.variant) return { action: "set", modelId: hit.modelId };

  const params = bracketParams(hit.modelId);
  if (params) {
    return variantMatchesBracket(parsed, params)
      ? { action: "set", modelId: hit.modelId }
      : { action: "missing" };
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

/**
 * Legacy string resolver. `default[]` means the catalog has no row.
 * `default` means "leave the session model alone".
 */
export function resolveAcpModelConfigValue(
  displayName: string,
  availableModels: readonly AcpCatalogModel[] | undefined,
  aliases: readonly string[] = [],
): string {
  const plan = planAcpModelSelection(displayName, availableModels, aliases);
  if (plan.action === "passthrough" || plan.action === "set") return plan.modelId;
  if (plan.action === "skip") return "default";
  return "default[]";
}

export function acpModelSelectionError(requested: string): string {
  return `ACP model catalog has no match for ${JSON.stringify(requested)}`;
}

export function readAcpConfigOptions(result: unknown): AcpConfigOption[] {
  if (!result || typeof result !== "object") return [];
  const list = (result as { configOptions?: unknown }).configOptions;
  return Array.isArray(list) ? (list as AcpConfigOption[]) : [];
}

function optionValues(option: AcpConfigOption): string[] {
  return (option.options ?? [])
    .map((item) => (item.value == null ? "" : String(item.value)))
    .filter(Boolean);
}

function pickLevelOption(
  options: readonly AcpConfigOption[],
  effort: string,
): AcpConfigOption | undefined {
  const present = options.filter((option) =>
    option.id === "reasoning" ||
    option.id === "effort" ||
    option.id === "reasoning_effort",
  );
  const candidates = effortCandidates(effort);
  return (
    present.find((option) =>
      optionValues(option).some((value) => candidates.includes(norm(value))),
    ) ?? present[0]
  );
}

function matchingOptionValue(
  option: AcpConfigOption,
  effort: string,
): string | undefined {
  const candidates = effortCandidates(effort);
  return optionValues(option).find((value) => candidates.includes(norm(value)));
}

async function applyBooleanParameter(
  options: readonly AcpConfigOption[],
  setOption: (configId: string, value: string) => Promise<unknown>,
  id: "thinking" | "fast",
  desired: boolean,
): Promise<void> {
  const option = options.find((item) => item.id === id);
  if (!option) {
    if (desired) {
      throw new Error(`ACP model has no ${id} parameter`);
    }
    return;
  }
  const value = desired ? "true" : "false";
  if (!optionValues(option).includes(value)) {
    throw new Error(
      `ACP model does not offer ${id}=${value} (available: ${optionValues(option).join(", ")})`,
    );
  }
  if (String(option.currentValue) === value) return;
  await setOption(id, value);
}

export async function applyAcpModelPlan(
  plan: AcpModelPlan,
  setOption: (configId: string, value: string) => Promise<unknown>,
): Promise<void> {
  if (plan.action === "skip" || plan.action === "missing") return;
  const result = await setOption("model", plan.modelId);
  if (plan.action !== "set" || !plan.parameters) return;

  const options = readAcpConfigOptions(result);
  const { effort, thinking, fast } = plan.parameters;
  if (effort) {
    const option = pickLevelOption(options, effort);
    if (!option) {
      throw new Error(
        `ACP model ${JSON.stringify(plan.modelId)} has no reasoning or effort parameter`,
      );
    }
    const value = matchingOptionValue(option, effort);
    if (!value) {
      throw new Error(
        `ACP model ${JSON.stringify(plan.modelId)} does not offer ${option.id} ${JSON.stringify(effort)} (available: ${optionValues(option).join(", ")})`,
      );
    }
    if (String(option.currentValue) !== value) {
      await setOption(option.id, value);
    }
  }
  await applyBooleanParameter(options, setOption, "thinking", thinking);
  await applyBooleanParameter(options, setOption, "fast", fast);
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
