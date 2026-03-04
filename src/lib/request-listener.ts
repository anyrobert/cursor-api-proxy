import * as fs from "node:fs";
import * as http from "node:http";

import type { BridgeConfig } from "./config.js";
import type { ModelCache } from "./handlers/models.js";
import { handleHealth } from "./handlers/health.js";
import { handleModels } from "./handlers/models.js";
import { handleChatCompletions } from "./handlers/chat-completions.js";
import { handleAnthropicMessages } from "./handlers/anthropic-messages.js";
import { extractBearerToken, json, readBody } from "./http.js";
import { appendSessionLine, logIncoming } from "./request-log.js";

export type BridgeServerOptions = {
  version: string;
  config: BridgeConfig;
};

export function createRequestListener(opts: BridgeServerOptions) {
  const { config } = opts;
  const modelCacheRef: { current?: ModelCache } = { current: undefined };
  const lastRequestedModelRef: { current?: string } = {};

  return async (req: http.IncomingMessage, res: http.ServerResponse) => {
    const protocol =
      config.tlsCertPath && config.tlsKeyPath ? "https" : "http";
    const url = new URL(
      req.url || "/",
      `${protocol}://${req.headers.host || "localhost"}`,
    );
    const remoteAddress = req.socket?.remoteAddress ?? "unknown";
    const method = req.method ?? "?";
    const pathname = url.pathname;

    logIncoming(method, pathname, remoteAddress);
    res.on("finish", () => {
      appendSessionLine(
        config.sessionsLogPath,
        method,
        pathname,
        remoteAddress,
        res.statusCode,
      );
    });

    try {
      if (config.requiredKey) {
        const token = extractBearerToken(req);
        if (token !== config.requiredKey) {
          json(res, 401, {
            error: { message: "Invalid API key", code: "unauthorized" },
          });
          return;
        }
      }

      if (req.method === "GET" && pathname === "/health") {
        handleHealth(res, { version: opts.version, config });
        return;
      }

      if (req.method === "GET" && pathname === "/v1/models") {
        await handleModels(res, { config, modelCacheRef });
        return;
      }

      if (req.method === "POST" && pathname === "/v1/chat/completions") {
        const raw = await readBody(req);
        await handleChatCompletions(
          req,
          res,
          { config, lastRequestedModelRef },
          raw,
          method,
          pathname,
          remoteAddress,
        );
        return;
      }

      if (req.method === "POST" && pathname === "/v1/messages") {
        const raw = await readBody(req);
        await handleAnthropicMessages(
          req,
          res,
          { config, lastRequestedModelRef },
          raw,
          method,
          pathname,
          remoteAddress,
        );
        return;
      }

      json(res, 404, { error: { message: "Not found", code: "not_found" } });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[${new Date().toISOString()}] Proxy error: ${msg}`);
      if (err instanceof Error && err.stack) {
        console.error(err.stack);
      }
      try {
        fs.appendFileSync(
          config.sessionsLogPath,
          `${new Date().toISOString()} ERROR ${method} ${pathname} ${remoteAddress} ${msg.slice(0, 200).replace(/\n/g, " ")}\n`,
        );
      } catch {
        /* ignore */
      }
      json(res, 500, {
        error: { message: msg, code: "internal_error" },
      });
    }
  };
}
