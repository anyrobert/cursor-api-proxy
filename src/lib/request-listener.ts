import * as crypto from "node:crypto";
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
    const protocol = config.tlsCertPath && config.tlsKeyPath ? "https" : "http";
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
        const token = extractBearerToken(req) ?? "";
        const expected = config.requiredKey;
        const a = Buffer.from(token, "utf8");
        const b = Buffer.from(expected, "utf8");
        const match =
          a.length === b.length && crypto.timingSafeEqual(a, b);
        if (!match) {
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

      if (
        (req.method === "POST" || req.method === "GET") &&
        pathname === "/v1/completions"
      ) {
        json(res, 404, {
          error: {
            message:
              "Legacy completions endpoint is not supported. Use POST /v1/chat/completions instead.",
            code: "not_found",
          },
        });
      } else if (pathname === "/v1/embeddings") {
        json(res, 404, {
          error: {
            message: "Embeddings are not supported by this proxy.",
            code: "not_found",
          },
        });
      } else {
        json(res, 404, { error: { message: "Not found", code: "not_found" } });
      }
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
      if (!res.headersSent) {
        json(res, 500, {
          error: { message: msg, code: "internal_error" },
        });
      } else {
        res.end();
      }
    }
  };
}
