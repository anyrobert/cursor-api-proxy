import * as crypto from "node:crypto";
import * as http from "node:http";

import type { BridgeConfig } from "./config.js";
import { CursorCliModelsError } from "./cursor-cli.js";
import {
  anthropicErrorBody,
  openAiErrorBody,
  type AgentFailure,
} from "./handlers/agent-failure.js";
import type { ModelCacheRef } from "./handlers/models.js";
import { handleHealth } from "./handlers/health.js";
import { handleModels } from "./handlers/models.js";
import { handleChatCompletions } from "./handlers/chat-completions.js";
import { handleResponses } from "./handlers/responses.js";
import { handleAnthropicMessages } from "./handlers/anthropic-messages.js";
import {
  adminDashboardMatches,
  handleAdminDashboard,
} from "./admin-dashboard.js";
import { extractBearerToken, json, readBody } from "./http.js";
import {
  appendSessionError,
  appendSessionLine,
  logIncoming,
} from "./request-log.js";
import type { ToolSessionRegistry } from "./tool-session-registry.js";

export type BridgeServerOptions = {
  version: string;
  config: BridgeConfig;
};

export type BridgeRequestRuntime = {
  toolSessions: ToolSessionRegistry;
};

type ModelApi = {
  /** Every model API handler has the Chat Completions handler's signature. */
  handle: typeof handleChatCompletions;
  /** A failure as the API's clients parse it. */
  errorBody: (failure: AgentFailure) => unknown;
};

/**
 * The model APIs: POST routes that take a JSON body and run an agent turn.
 * An error a handler throws is answered in its API's error shape.
 */
const MODEL_APIS = new Map<string, ModelApi>([
  ["/v1/chat/completions", { handle: handleChatCompletions, errorBody: openAiErrorBody }],
  ["/v1/responses", { handle: handleResponses, errorBody: openAiErrorBody }],
  ["/v1/messages", { handle: handleAnthropicMessages, errorBody: anthropicErrorBody }],
]);

/** The error shape of the proxy's own routes, such as /v1/models. */
function proxyErrorBody(failure: AgentFailure) {
  return { error: { message: failure.message, code: failure.code } };
}

/** What the client hears about an error nothing else answered. */
const INTERNAL_FAILURE: AgentFailure = {
  status: 500,
  code: "internal_error",
  message: "The proxy could not handle the request. See server logs for details.",
};

/**
 * A thrown error as the client sees it, and the detail that stays in the
 * server logs. A thrown error's own text can hold CLI output or paths on the
 * proxy host, so the client sees it only when its type promises a
 * client-safe message.
 */
function describeThrown(error: unknown): {
  failure: AgentFailure;
  detail: string;
  stack?: string;
} {
  if (error instanceof CursorCliModelsError) {
    // The code of a failed agent run: either way the Cursor CLI is unusable,
    // and only the proxy's operator can fix it.
    return {
      failure: { status: 500, code: "cursor_cli_error", message: error.message },
      detail: error.diagnostics,
    };
  }
  if (error instanceof Error) {
    return { failure: INTERNAL_FAILURE, detail: error.message, stack: error.stack };
  }
  return { failure: INTERNAL_FAILURE, detail: String(error) };
}

/**
 * The failure for a model API body that is not JSON, which makes the
 * handler throw on its first line. That is the client's mistake, so it gets
 * a 400 with the parser's reason, which quotes only the body. The listener
 * checks this only after a handler threw, so a good body is parsed once.
 */
function invalidJsonBody(rawBody: string): AgentFailure | undefined {
  try {
    JSON.parse(rawBody || "{}");
    return undefined;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return {
      status: 400,
      code: "invalid_json",
      message: `Could not parse the request body as JSON: ${reason}`,
    };
  }
}

export function createRequestListener(
  opts: BridgeServerOptions,
  runtime: BridgeRequestRuntime,
) {
  const { config } = opts;
  const modelCacheRef: ModelCacheRef = { current: undefined };
  const lastRequestedModelRef: { current?: string } = {};
  const apiCtx = {
    config,
    lastRequestedModelRef,
    modelCacheRef,
    toolSessions: runtime.toolSessions,
  };

  return async (req: http.IncomingMessage, res: http.ServerResponse) => {
    const protocol = config.tlsCertPath && config.tlsKeyPath ? "https" : "http";
    const url = new URL(
      req.url || "/",
      `${protocol}://${req.headers.host || "localhost"}`,
    );
    const remoteAddress = req.socket?.remoteAddress ?? "unknown";
    const method = req.method ?? "?";
    const pathname = url.pathname;
    const api = method === "POST" ? MODEL_APIS.get(pathname) : undefined;
    let rawBody: string | undefined;

    // Skip request logging for the admin dashboard's own traffic
    // (status/log/stats polls, asset loads, control actions). These are
    // self-referential noise that pollutes the live log tail the dashboard
    // reads from the sessions log file.
    const isAdminDashboardReq = adminDashboardMatches(req);

    if (!isAdminDashboardReq) {
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
    }

    try {
      if (req.method === "GET" && pathname === "/healthz") {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("ok\n");
        return;
      }

      if (isAdminDashboardReq) {
        handleAdminDashboard(req, res, opts);
        return;
      }

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

      if (api) {
        rawBody = await readBody(req);
        await api.handle(req, res, apiCtx, rawBody, method, pathname, remoteAddress);
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
      let failure = rawBody === undefined ? undefined : invalidJsonBody(rawBody);
      if (!failure) {
        const thrown = describeThrown(err);
        failure = thrown.failure;
        console.error(
          `[${new Date().toISOString()}] Proxy error (${failure.code}): ${thrown.detail}`,
        );
        if (thrown.stack) console.error(thrown.stack);
        appendSessionError(
          config.sessionsLogPath,
          method,
          pathname,
          remoteAddress,
          failure.code,
          thrown.detail,
        );
      }
      if (!res.headersSent) {
        const errorBody = api?.errorBody ?? proxyErrorBody;
        json(res, failure.status, errorBody(failure));
      } else {
        res.end();
      }
    }
  };
}
