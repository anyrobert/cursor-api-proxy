import type * as http from "node:http";

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
  // mode: default for Cursor CLI; clients may override per request (body.mode, X-Cursor-Mode).
  json(res, 200, {
    ok: true,
    version,
    workspace: config.workspace,
    mode: config.mode,
    perRequestMode: true,
    defaultModel: config.defaultModel,
    force: config.force,
    approveMcps: config.approveMcps,
    strictModel: config.strictModel,
  });
}
