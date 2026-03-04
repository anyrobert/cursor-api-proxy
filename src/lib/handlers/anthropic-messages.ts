import { randomUUID } from "node:crypto";
import * as http from "node:http";

import type { AnthropicMessagesRequest } from "../anthropic.js";
import { buildPromptFromAnthropicMessages } from "../anthropic.js";
import { buildAgentCmdArgs } from "../agent-cmd-args.js";
import { runAgentStream, runAgentSync } from "../agent-runner.js";
import { parseCliStreamLine } from "../cli-stream-parser.js";
import type { BridgeConfig } from "../config.js";
import { json, writeSseHeaders } from "../http.js";
import { resolveToCursorModel } from "../model-map.js";
import { normalizeModelId } from "../openai.js";
import { logAgentError } from "../request-log.js";
import { resolveModel } from "../resolve-model.js";
import { resolveWorkspace } from "../workspace.js";

export type AnthropicMessagesCtx = {
  config: BridgeConfig;
  lastRequestedModelRef: { current?: string };
};

export async function handleAnthropicMessages(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  ctx: AnthropicMessagesCtx,
  rawBody: string,
  method: string,
  pathname: string,
  remoteAddress: string,
): Promise<void> {
  const { config, lastRequestedModelRef } = ctx;
  const body = JSON.parse(rawBody || "{}") as AnthropicMessagesRequest;
  const requested = normalizeModelId(body.model);
  const model = resolveModel(requested, lastRequestedModelRef, config);

  if (body.max_tokens == null || typeof body.max_tokens !== "number") {
    json(res, 400, {
      error: {
        type: "invalid_request_error",
        message: "max_tokens is required",
      },
    });
    return;
  }

  const cursorModel = resolveToCursorModel(model) ?? model;
  const prompt = buildPromptFromAnthropicMessages(body.messages, body.system);

  const headerWs = req.headers["x-cursor-workspace"];
  const { workspaceDir, tempDir } = resolveWorkspace(config, headerWs);

  const cmdArgs = buildAgentCmdArgs(
    config,
    workspaceDir,
    cursorModel,
    prompt,
    !!body.stream,
  );

  const msgId = `msg_${randomUUID().replace(/-/g, "")}`;

  if (body.stream) {
    writeSseHeaders(res);

    const writeEvent = (evt: object) => {
      res.write(`data: ${JSON.stringify(evt)}\n\n`);
    };

    writeEvent({
      type: "message_start",
      message: {
        id: msgId,
        type: "message",
        role: "assistant",
        model: model ?? cursorModel,
        content: [],
      },
    });
    writeEvent({
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    });

    runAgentStream(config, workspaceDir, cmdArgs, (line) => {
      parseCliStreamLine(
        line,
        (text) =>
          writeEvent({
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text },
          }),
        () => {
          writeEvent({ type: "content_block_stop", index: 0 });
          writeEvent({
            type: "message_delta",
            delta: { stop_reason: "end_turn" },
          });
          writeEvent({ type: "message_stop" });
        },
      );
    }, tempDir)
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

  const out = await runAgentSync(config, workspaceDir, cmdArgs, tempDir);

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
      error: { type: "api_error", message: errMsg },
    });
    return;
  }

  const content = out.stdout.trim();
  json(res, 200, {
    id: msgId,
    type: "message",
    role: "assistant",
    content: [{ type: "text", text: content }],
    model: model ?? cursorModel,
    stop_reason: "end_turn",
    usage: { input_tokens: 0, output_tokens: 0 },
  });
}
