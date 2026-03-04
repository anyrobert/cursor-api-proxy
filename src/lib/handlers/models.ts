import * as http from "node:http";

import type { BridgeConfig } from "../config.js";
import type { CursorCliModel } from "../cursor-cli.js";
import { listCursorCliModels } from "../cursor-cli.js";
import { json } from "../http.js";
import { getAnthropicModelAliases } from "../model-map.js";

const MODEL_CACHE_TTL_MS = 5 * 60_000;

export type ModelCache = { at: number; models: CursorCliModel[] };

export type HandleModelsOpts = {
  config: BridgeConfig;
  modelCacheRef: { current?: ModelCache };
};

export async function handleModels(
  res: http.ServerResponse,
  opts: HandleModelsOpts,
): Promise<void> {
  const { config, modelCacheRef } = opts;
  const now = Date.now();
  if (
    !modelCacheRef.current ||
    now - modelCacheRef.current.at > MODEL_CACHE_TTL_MS
  ) {
    const models = await listCursorCliModels({
      agentBin: config.agentBin,
      timeoutMs: 60_000,
    });
    modelCacheRef.current = { at: now, models };
  }

  const models = modelCacheRef.current.models;
  const cursorModels = models.map((m) => ({
    id: m.id,
    object: "model" as const,
    owned_by: "cursor" as const,
    name: m.name,
  }));
  const anthropicAliases = getAnthropicModelAliases(models.map((m) => m.id)).map(
    (a) => ({
      id: a.id,
      object: "model" as const,
      owned_by: "cursor" as const,
      name: a.name,
    }),
  );

  json(res, 200, {
    object: "list",
    data: [...cursorModels, ...anthropicAliases],
  });
}
