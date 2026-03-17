import { randomUUID } from "node:crypto";
import * as http from "node:http";

import type { BridgeConfig } from "../config.js";
import { buildAgentCmdArgs } from "../agent-cmd-args.js";
import { runAgentStream, runAgentSync } from "../agent-runner.js";
import { createStreamParser } from "../cli-stream-parser.js";
import { json, writeSseHeaders } from "../http.js";
import { resolveToCursorModel } from "../model-map.js";
import {
  buildPromptFromMessages,
  normalizeModelId,
  type OpenAiChatCompletionRequest,
} from "../openai.js";
import {
  logAgentError,
  logTrafficRequest,
  logTrafficResponse,
  type TrafficMessage,
} from "../request-log.js";
import { resolveModel } from "../resolve-model.js";
import { resolveWorkspace } from "../workspace.js";

export type ChatCompletionsCtx = {
  config: BridgeConfig;
  lastRequestedModelRef: { current?: string };
};

export async function handleChatCompletions(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  ctx: ChatCompletionsCtx,
  rawBody: string,
  method: string,
  pathname: string,
  remoteAddress: string,
): Promise<void> {
  const { config, lastRequestedModelRef } = ctx;
  const body = JSON.parse(rawBody || "{}") as OpenAiChatCompletionRequest;
  const requested = normalizeModelId(body.model);
  const model = resolveModel(requested, lastRequestedModelRef, config);
  const cursorModel = resolveToCursorModel(model) ?? model;
  const prompt = buildPromptFromMessages(body.messages ?? []);

  const trafficMessages: TrafficMessage[] = (body.messages ?? []).map(
    (m: any) => {
      const content =
        typeof m?.content === "string"
          ? m.content
          : Array.isArray(m?.content)
            ? (m.content as Array<{ type?: string; text?: string }>)
                .filter((p) => p.type === "text")
                .map((p) => p.text ?? "")
                .join("")
            : "";
      return { role: String(m?.role ?? "user"), content };
    },
  );
  logTrafficRequest(
    config.verbose,
    model ?? cursorModel,
    trafficMessages,
    !!body.stream,
  );

  const headerWs = req.headers["x-cursor-workspace"];
  const { workspaceDir, tempDir } = resolveWorkspace(config, headerWs);

  const cmdArgs = buildAgentCmdArgs(
    config,
    workspaceDir,
    cursorModel,
    prompt,
    !!body.stream,
  );

  const id = `chatcmpl_${randomUUID().replace(/-/g, "")}`;
  const created = Math.floor(Date.now() / 1000);

  const promptForAgent = (config.promptViaStdin || config.useAcp) ? prompt : undefined;

  if (body.stream) {
    writeSseHeaders(res);

    if (config.useAcp && typeof promptForAgent === "string") {
      let accumulated = "";
      runAgentStream(
        config,
        workspaceDir,
        [],
        (chunk) => {
          accumulated += chunk;
          res.write(
            `data: ${JSON.stringify({
              id,
              object: "chat.completion.chunk",
              created,
              model,
              choices: [
                { index: 0, delta: { content: chunk }, finish_reason: null },
              ],
            })}\n\n`,
          );
        },
        tempDir,
        promptForAgent,
      )
        .then(({ code, stderr: stderrOut }) => {
          if (code !== 0) {
            logAgentError(
              config.sessionsLogPath,
              method,
              pathname,
              remoteAddress,
              code,
              stderrOut,
            );
          }
          logTrafficResponse(
            config.verbose,
            model ?? cursorModel,
            accumulated,
            true,
          );
          res.write(
            `data: ${JSON.stringify({
              id,
              object: "chat.completion.chunk",
              created,
              model,
              choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
            })}\n\n`,
          );
          res.write("data: [DONE]\n\n");
          res.end();
        })
        .catch((err) => {
          console.error(`[${new Date().toISOString()}] Agent stream error:`, err);
          res.end();
        });
      return;
    }

    let accumulated = "";
    const parseLine = createStreamParser(
      (text) => {
        accumulated += text;
        res.write(
          `data: ${JSON.stringify({
            id,
            object: "chat.completion.chunk",
            created,
            model,
            choices: [
              { index: 0, delta: { content: text }, finish_reason: null },
            ],
          })}\n\n`,
        );
      },
      () => {
        logTrafficResponse(
          config.verbose,
          model ?? cursorModel,
          accumulated,
          true,
        );
        res.write(
          `data: ${JSON.stringify({
            id,
            object: "chat.completion.chunk",
            created,
            model,
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          })}\n\n`,
        );
        res.write("data: [DONE]\n\n");
      },
    );
    runAgentStream(
      config,
      workspaceDir,
      cmdArgs,
      parseLine,
      tempDir,
      promptForAgent,
    )
      .then(({ code, stderr: stderrOut }) => {
        if (code !== 0) {
          logAgentError(
            config.sessionsLogPath,
            method,
            pathname,
            remoteAddress,
            code,
            stderrOut,
          );
        }
        res.end();
      })
      .catch((err) => {
        console.error(`[${new Date().toISOString()}] Agent stream error:`, err);
        res.end();
      });
    return;
  }

  const out = await runAgentSync(
    config,
    workspaceDir,
    cmdArgs,
    tempDir,
    promptForAgent,
  );

  if (out.code !== 0) {
    const errMsg = logAgentError(
      config.sessionsLogPath,
      method,
      pathname,
      remoteAddress,
      out.code,
      out.stderr,
    );
    json(res, 500, {
      error: { message: errMsg, code: "cursor_cli_error" },
    });
    return;
  }

  const content = out.stdout.trim();
  logTrafficResponse(config.verbose, model ?? cursorModel, content, false);
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
}
