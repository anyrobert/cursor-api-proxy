import type { BridgeConfig } from "./config.js";

/**
 * Resolve the requested model (already normalized) to the final model string,
 * applying strictModel and lastRequestedModelRef semantics.
 */
export function resolveModel(
  requested: string | undefined,
  lastRequestedModelRef: { current?: string },
  config: BridgeConfig,
): string {
  const isAuto = requested === "auto";
  const explicitModel = requested && !isAuto ? requested : undefined;
  if (explicitModel) lastRequestedModelRef.current = explicitModel;

  // "auto" is a valid Cursor model identifier — pass it through directly
  if (isAuto) return "auto";

  return (
    explicitModel ??
    (config.strictModel ? lastRequestedModelRef.current : undefined) ??
    lastRequestedModelRef.current ??
    config.defaultModel
  );
}
