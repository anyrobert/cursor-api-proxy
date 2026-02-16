import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";
import * as https from "node:https";
import { URL } from "node:url";

import type { BridgeConfig } from "./config.js";
import type { CursorCliModel } from "./cursorCli.js";
import { listCursorCliModels } from "./cursorCli.js";
import { extractBearerToken, json, readBody } from "./http.js";
import {
  buildPromptFromMessages,
  normalizeModelId,
  type OpenAiChatCompletionRequest,
} from "./openai.js";
import { run } from "./process.js";

type ModelCache = { at: number; models: CursorCliModel[] };

export type BridgeServerOptions = {
  version: string;
  config: BridgeConfig;
};

export function startBridgeServer(opts: BridgeServerOptions): http.Server | https.Server {
  const { config } = opts;

  let modelCache: ModelCache | undefined;
  let lastRequestedModel: string | undefined;

  const requestListener = async (req: http.IncomingMessage, res: http.ServerResponse) => {
    try {
      const protocol = config.tlsCertPath && config.tlsKeyPath ? "https" : "http";
      const url = new URL(req.url || "/", `${protocol}://${req.headers.host || "localhost"}`);

      if (config.requiredKey) {
        const token = extractBearerToken(req);
        if (token !== config.requiredKey) {
          json(res, 401, { error: { message: "Invalid API key", code: "unauthorized" } });
          return;
        }
      }

      if (req.method === "GET" && url.pathname === "/health") {
        json(res, 200, {
          ok: true,
          version: opts.version,
          workspace: config.workspace,
          mode: config.mode,
          defaultModel: config.defaultModel,
          force: config.force,
          approveMcps: config.approveMcps,
          strictModel: config.strictModel,
        });
        return;
      }

      if (req.method === "GET" && url.pathname === "/v1/models") {
        const now = Date.now();
        if (!modelCache || now - modelCache.at > 5 * 60_000) {
          const models = await listCursorCliModels({
            agentBin: config.agentBin,
            timeoutMs: 60_000,
          });
          modelCache = { at: now, models };
        }

        json(res, 200, {
          object: "list",
          data: modelCache.models.map((m) => ({
            id: m.id,
            object: "model",
            owned_by: "cursor",
            name: m.name,
          })),
        });
        return;
      }

      if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
        const raw = await readBody(req);
        const body = JSON.parse(raw || "{}") as OpenAiChatCompletionRequest;
        const requested = normalizeModelId(body.model);
        const explicitModel = requested && requested !== "auto" ? requested : undefined;
        if (explicitModel) lastRequestedModel = explicitModel;

        const model =
          explicitModel ||
          (config.strictModel ? lastRequestedModel : undefined) ||
          requested ||
          lastRequestedModel ||
          config.defaultModel;

        const prompt = buildPromptFromMessages(body.messages || []);

        const headerWs = req.headers["x-cursor-workspace"];
        const requestWorkspace =
          (typeof headerWs === "string" && headerWs.trim()) || config.workspace;

        const cmdArgs: string[] = ["--print"];

        if (config.approveMcps) cmdArgs.push("--approve-mcps");
        if (config.force) cmdArgs.push("--force");

        if (config.mode !== "agent") cmdArgs.push("--mode", config.mode);

        cmdArgs.push("--workspace", requestWorkspace);
        cmdArgs.push("--model", model);
        cmdArgs.push("--output-format", "text");
        cmdArgs.push(prompt);

        const out = await run(config.agentBin, cmdArgs, {
          cwd: requestWorkspace,
          timeoutMs: config.timeoutMs,
        });
        if (out.code !== 0) {
          json(res, 500, {
            error: {
              message: `Cursor CLI failed (exit ${out.code}): ${out.stderr.trim()}`,
              code: "cursor_cli_error",
            },
          });
          return;
        }

        const content = out.stdout.trim();
        const id = `chatcmpl_${randomUUID().replace(/-/g, "")}`;
        const created = Math.floor(Date.now() / 1000);

        if (body.stream) {
          res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
            "X-Accel-Buffering": "no",
          });

          const chunk1 = {
            id,
            object: "chat.completion.chunk",
            created,
            model,
            choices: [
              {
                index: 0,
                delta: { role: "assistant", content },
                finish_reason: null,
              },
            ],
          };
          res.write(`data: ${JSON.stringify(chunk1)}\n\n`);
          const chunk2 = {
            id,
            object: "chat.completion.chunk",
            created,
            model,
            choices: [
              {
                index: 0,
                delta: {},
                finish_reason: "stop",
              },
            ],
          };
          res.write(`data: ${JSON.stringify(chunk2)}\n\n`);
          res.write("data: [DONE]\n\n");
          res.end();
          return;
        }

        json(res, 200, {
          id,
          object: "chat.completion",
          created,
          model,
          choices: [
            {
              index: 0,
              message: { role: "assistant", content },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        });
        return;
      }

      json(res, 404, { error: { message: "Not found", code: "not_found" } });
    } catch (err) {
      json(res, 500, {
        error: {
          message: err instanceof Error ? err.message : String(err),
          code: "internal_error",
        },
      });
    }
  };

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
    console.log(`cursor-api-proxy listening on ${scheme}://${config.host}:${config.port}`);
    console.log(`- agent bin: ${config.agentBin}`);
    console.log(`- workspace: ${config.workspace}`);
    console.log(`- mode: ${config.mode}`);
    console.log(`- default model: ${config.defaultModel}`);
    console.log(`- force: ${config.force}`);
    console.log(`- approve mcps: ${config.approveMcps}`);
    console.log(`- required api key: ${config.requiredKey ? "yes" : "no"}`);
  });

  return server;
}
