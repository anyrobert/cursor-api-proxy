import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";
import * as https from "node:https";
import * as os from "node:os";
import * as path from "node:path";
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
import { run, runStreaming } from "./process.js";
import { appendSessionLine, logIncoming } from "./requestLog.js";

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
    const protocol = config.tlsCertPath && config.tlsKeyPath ? "https" : "http";
    const url = new URL(req.url || "/", `${protocol}://${req.headers.host || "localhost"}`);
    const remoteAddress = req.socket?.remoteAddress ?? "unknown";
    const method = req.method ?? "?";
    const pathname = url.pathname;

    logIncoming(method, pathname, remoteAddress);
    res.on("finish", () => {
      appendSessionLine(config.sessionsLogPath, method, pathname, remoteAddress, res.statusCode);
    });

    try {
      if (config.requiredKey) {
        const token = extractBearerToken(req);
        if (token !== config.requiredKey) {
          json(res, 401, { error: { message: "Invalid API key", code: "unauthorized" } });
          return;
        }
      }

      if (req.method === "GET" && pathname === "/health") {
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

      if (req.method === "GET" && pathname === "/v1/models") {
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

      if (req.method === "POST" && pathname === "/v1/chat/completions") {
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

        // Chat-only: use an empty temp dir as workspace so the CLI cannot read or write the real project.
        // Any files it creates go into the temp dir and are discarded.
        let workspaceDir: string;
        let tempDir: string | undefined;
        if (config.chatOnlyWorkspace) {
          tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-proxy-"));
          workspaceDir = tempDir;
        } else {
          const headerWs = req.headers["x-cursor-workspace"];
          workspaceDir =
            (typeof headerWs === "string" && headerWs.trim()) || config.workspace;
        }

        const cmdArgs: string[] = ["--print"];

        if (config.approveMcps) cmdArgs.push("--approve-mcps");
        if (config.force) cmdArgs.push("--force");

        // Trust the workspace so the CLI does not prompt (required for our isolated temp dir)
        if (config.chatOnlyWorkspace) {
          cmdArgs.push("--trust");
        }

        // Proxy is chat-only: always use "ask" so the CLI never creates or edits files
        cmdArgs.push("--mode", "ask");

        cmdArgs.push("--workspace", workspaceDir);
        cmdArgs.push("--model", model);
        if (body.stream) {
          cmdArgs.push("--stream-partial-output", "--output-format", "stream-json");
        } else {
          cmdArgs.push("--output-format", "text");
        }
        cmdArgs.push(prompt);

        const id = `chatcmpl_${randomUUID().replace(/-/g, "")}`;
        const created = Math.floor(Date.now() / 1000);

        if (body.stream) {
          res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
            "X-Accel-Buffering": "no",
          });

          runStreaming(config.agentBin, cmdArgs, {
            cwd: workspaceDir,
            timeoutMs: config.timeoutMs,
            onLine(line: string) {
              try {
                const obj = JSON.parse(line) as {
                  type?: string;
                  subtype?: string;
                  message?: { content?: Array<{ type?: string; text?: string }> };
                };
                if (obj.type === "assistant" && obj.message?.content) {
                  for (const part of obj.message.content) {
                    if (part.type === "text" && part.text) {
                      res.write(
                        `data: ${JSON.stringify({
                          id,
                          object: "chat.completion.chunk",
                          created,
                          model,
                          choices: [
                            {
                              index: 0,
                              delta: { content: part.text },
                              finish_reason: null,
                            },
                          ],
                        })}\n\n`,
                      );
                    }
                  }
                }
                if (obj.type === "result" && obj.subtype === "success") {
                  res.write(
                    `data: ${JSON.stringify({
                      id,
                      object: "chat.completion.chunk",
                      created,
                      model,
                      choices: [
                        { index: 0, delta: {}, finish_reason: "stop" },
                      ],
                    })}\n\n`,
                  );
                  res.write("data: [DONE]\n\n");
                }
              } catch {
                // ignore parse errors for non-JSON lines
              }
            },
          })
            .then(({ code, stderr: stderrOut }) => {
              if (tempDir) {
                try {
                  fs.rmSync(tempDir, { recursive: true, force: true });
                } catch {
                  // ignore
                }
              }
              if (code !== 0) {
                const errMsg = `Cursor CLI failed (exit ${code}): ${stderrOut.trim()}`;
                console.error(`[${new Date().toISOString()}] Agent error: ${errMsg}`);
                try {
                  fs.appendFileSync(
                    config.sessionsLogPath,
                    `${new Date().toISOString()} ERROR ${method} ${pathname} ${remoteAddress} agent_exit_${code} ${stderrOut.trim().slice(0, 200).replace(/\n/g, " ")}\n`,
                  );
                } catch {
                  // ignore
                }
              }
              res.end();
            })
            .catch((err) => {
              if (tempDir) {
                try {
                  fs.rmSync(tempDir, { recursive: true, force: true });
                } catch {
                  // ignore
                }
              }
              console.error(`[${new Date().toISOString()}] Agent stream error:`, err);
              res.end();
            });
          return;
        }

        const out = await run(config.agentBin, cmdArgs, {
          cwd: workspaceDir,
          timeoutMs: config.timeoutMs,
        });

        if (tempDir) {
          try {
            fs.rmSync(tempDir, { recursive: true, force: true });
          } catch {
            // ignore cleanup errors
          }
        }
        if (out.code !== 0) {
          const errMsg = `Cursor CLI failed (exit ${out.code}): ${out.stderr.trim()}`;
          console.error(`[${new Date().toISOString()}] Agent error: ${errMsg}`);
          try {
            fs.appendFileSync(
              config.sessionsLogPath,
              `${new Date().toISOString()} ERROR ${method} ${pathname} ${remoteAddress} agent_exit_${out.code} ${out.stderr.trim().slice(0, 200).replace(/\n/g, " ")}\n`,
            );
          } catch {
            // ignore log write errors
          }
          json(res, 500, {
            error: {
              message: errMsg,
              code: "cursor_cli_error",
            },
          });
          return;
        }

        const content = out.stdout.trim();
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
        // ignore log write errors
      }
      json(res, 500, {
        error: {
          message: msg,
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
    console.log(`- sessions log: ${config.sessionsLogPath}`);
    console.log(`- chat-only workspace: ${config.chatOnlyWorkspace ? "yes (isolated temp dir)" : "no"}`);
  });

  return server;
}
