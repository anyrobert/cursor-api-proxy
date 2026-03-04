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
  const explicitModel =
    requested && requested !== "auto" ? requested : undefined;
  if (explicitModel) lastRequestedModelRef.current = explicitModel;

  return (
    explicitModel ??
    (config.strictModel ? lastRequestedModelRef.current : undefined) ??
    requested ??
    lastRequestedModelRef.current ??
    config.defaultModel
  );
}
