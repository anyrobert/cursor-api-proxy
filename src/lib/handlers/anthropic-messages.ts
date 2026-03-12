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
import {
  logAgentError,
  logTrafficRequest,
  logTrafficResponse,
  type TrafficMessage,
} from "../request-log.js";
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

  const trafficMessages: TrafficMessage[] = [];
  if (body.system) {
    const sys =
      typeof body.system === "string"
        ? body.system
        : (body.system as Array<{ type?: string; text?: string }>)
            .filter((p) => p.type === "text")
            .map((p) => p.text ?? "")
            .join("\n");
    if (sys.trim())
      trafficMessages.push({ role: "system", content: sys.trim() });
  }
  for (const m of body.messages ?? []) {
    const text =
      typeof m.content === "string"
        ? m.content
        : (m.content as Array<{ type?: string; text?: string }>)
            .filter((p) => p.type === "text")
            .map((p) => p.text ?? "")
            .join("");
    if (text) trafficMessages.push({ role: m.role, content: text });
  }
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

    let accumulated = "";
    runAgentStream(
      config,
      workspaceDir,
      cmdArgs,
      (line) => {
        parseCliStreamLine(
          line,
          (text) => {
            accumulated += text;
            writeEvent({
              type: "content_block_delta",
              index: 0,
              delta: { type: "text_delta", text },
            });
          },
          () => {
            logTrafficResponse(
              config.verbose,
              model ?? cursorModel,
              accumulated,
              true,
            );
            writeEvent({ type: "content_block_stop", index: 0 });
            writeEvent({
              type: "message_delta",
              delta: { stop_reason: "end_turn" },
            });
            writeEvent({ type: "message_stop" });
          },
        );
      },
      tempDir,
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
  logTrafficResponse(config.verbose, model ?? cursorModel, content, false);
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
