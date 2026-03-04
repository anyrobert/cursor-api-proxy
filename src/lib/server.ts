import * as fs from "node:fs";
import * as http from "node:http";
import * as https from "node:https";

import type { BridgeConfig } from "./config.js";
import { createRequestListener } from "./request-listener.js";

export type BridgeServerOptions = {
  version: string;
  config: BridgeConfig;
};

export function startBridgeServer(
  opts: BridgeServerOptions,
): http.Server | https.Server {
  const { config } = opts;
  const requestListener = createRequestListener(opts);

  const useTls = Boolean(config.tlsCertPath && config.tlsKeyPath);
  let server: http.Server | https.Server;

  if (useTls) {
    const cert = fs.readFileSync(config.tlsCertPath!, "utf8");
    const key = fs.readFileSync(config.tlsKeyPath!, "utf8");
    server = https.createServer({ cert, key }, requestListener);
  } else {
    server = http.createServer(requestListener);
  }

  server.listen(config.port, config.host, () => {
    const scheme = useTls ? "https" : "http";
    console.log(
      `cursor-api-proxy listening on ${scheme}://${config.host}:${config.port}`,
    );
    console.log(`- agent bin: ${config.agentBin}`);
    console.log(`- workspace: ${config.workspace}`);
    console.log(`- mode: ${config.mode}`);
    console.log(`- default model: ${config.defaultModel}`);
    console.log(`- force: ${config.force}`);
    console.log(`- approve mcps: ${config.approveMcps}`);
    console.log(
      `- required api key: ${config.requiredKey ? "yes" : "no"}`,
    );
    console.log(`- sessions log: ${config.sessionsLogPath}`);
    console.log(
      `- chat-only workspace: ${config.chatOnlyWorkspace ? "yes (isolated temp dir)" : "no"}`,
    );
  });

  return server;
}
