import * as http from "node:http";

import type { BridgeConfig } from "../config.js";
import { json } from "../http.js";

export type HealthHandlerOpts = {
  version: string;
  config: BridgeConfig;
};

export function handleHealth(
  res: http.ServerResponse,
  opts: HealthHandlerOpts,
): void {
  const { version, config } = opts;
  json(res, 200, {
    ok: true,
    version,
    workspace: config.workspace,
    mode: config.mode,
    defaultModel: config.defaultModel,
    force: config.force,
    approveMcps: config.approveMcps,
    strictModel: config.strictModel,
  });
}
