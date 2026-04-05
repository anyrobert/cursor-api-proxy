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
  const isDefault = requested === "default";
  const explicitModel = requested && !isDefault ? requested : undefined;
  if (explicitModel) lastRequestedModelRef.current = explicitModel;

  // "default" matches ACP catalog name for session default model — pass through directly
  if (isDefault) return "default";

  return (
    explicitModel ??
    (config.strictModel ? lastRequestedModelRef.current : undefined) ??
    lastRequestedModelRef.current ??
    config.defaultModel
  );
}
