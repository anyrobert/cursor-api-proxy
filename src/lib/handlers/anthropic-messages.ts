import { randomUUID } from "node:crypto";
import * as http from "node:http";

import type { AnthropicMessagesRequest } from "../anthropic.js";
import { buildPromptFromAnthropicMessages } from "../anthropic.js";
import { buildAgentCmdArgs } from "../agent-cmd-args.js";
import { runAgentStream, runAgentSync } from "../agent-runner.js";
import { createStreamParser } from "../cli-stream-parser.js";
import type { BridgeConfig } from "../config.js";
import { json, writeSseHeaders } from "../http.js";
import { resolveToCursorModel } from "../model-map.js";
import { normalizeModelId, toolsToSystemText } from "../openai.js";
import {
  logAgentError,
  logAccountAssigned,
  logAccountStats,
  logTrafficRequest,
  logTrafficResponse,
  type TrafficMessage,
} from "../request-log.js";
import { resolveModel } from "../resolve-model.js";
import { resolveWorkspace } from "../workspace.js";
import { sanitizeMessages, sanitizeSystem } from "../sanitize.js";
import {
  getNextAccountConfigDir,
  reportRequestStart,
  reportRequestEnd,
  reportRateLimit,
  reportRequestSuccess,
  reportRequestError,
  getAccountStats,
} from "../account-pool.js";

function isRateLimited(stderr: string): boolean {
  return /\b429\b|rate.?limit|too many requests/i.test(stderr);
}

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

  const cleanSystem = sanitizeSystem(body.system);
  const cleanMessages = sanitizeMessages(
    body.messages ?? [],
  ) as AnthropicMessagesRequest["messages"];

  // Inject Anthropic tool schemas as a system text block
  const toolsText = toolsToSystemText((body as any).tools);
  const systemWithTools = toolsText
    ? [cleanSystem, toolsText].filter(Boolean).join("\n\n")
    : cleanSystem;
  const prompt = buildPromptFromAnthropicMessages(
    cleanMessages,
    systemWithTools as AnthropicMessagesRequest["system"],
  );

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

  const trafficMessages: TrafficMessage[] = [];
  if (cleanSystem) {
    const sys =
      typeof cleanSystem === "string"
        ? cleanSystem
        : (cleanSystem as Array<{ type?: string; text?: string }>)
            .filter((p) => p.type === "text")
            .map((p) => p.text ?? "")
            .join("\n");
    if (sys.trim())
      trafficMessages.push({ role: "system", content: sys.trim() });
  }
  for (const m of cleanMessages) {
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
    res.on("error", () => {
      /* client disconnected mid-stream */
    });

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
    const parseLine = createStreamParser(
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
          delta: { stop_reason: "end_turn", stop_sequence: null },
          usage: { output_tokens: 0 },
        });
        writeEvent({ type: "message_stop" });
      },
    );

    const configDir = getNextAccountConfigDir();
    logAccountAssigned(configDir);
    reportRequestStart(configDir);
    const streamStart = Date.now();

    const abortController = new AbortController();
    req.once("close", () => abortController.abort());

    runAgentStream(
      config,
      workspaceDir,
      cmdArgs,
      parseLine,
      tempDir,
      configDir,
      abortController.signal,
    )
      .then(({ code, stderr: stderrOut }) => {
        const latencyMs = Date.now() - streamStart;
        reportRequestEnd(configDir);

        if (stderrOut && isRateLimited(stderrOut)) {
          reportRateLimit(configDir, 60000);
        }

        if (code !== 0) {
          reportRequestError(configDir, latencyMs);
          logAgentError(
            config.sessionsLogPath,
            method,
            pathname,
            remoteAddress,
            code,
            stderrOut,
          );
        } else {
          reportRequestSuccess(configDir, latencyMs);
        }
        logAccountStats(config.verbose, getAccountStats());
        res.end();
      })
      .catch((err) => {
        reportRequestEnd(configDir);
        reportRequestError(configDir, Date.now() - streamStart);
        console.error(`[${new Date().toISOString()}] Agent stream error:`, err);
        res.end();
      });
    return;
  }

  const configDir = getNextAccountConfigDir();
  logAccountAssigned(configDir);
  reportRequestStart(configDir);
  const syncStart = Date.now();

  const abortController = new AbortController();
  req.once("close", () => abortController.abort());

  const out = await runAgentSync(
    config,
    workspaceDir,
    cmdArgs,
    tempDir,
    configDir,
    abortController.signal,
  );
  const syncLatency = Date.now() - syncStart;
  reportRequestEnd(configDir);

  if (out.stderr && isRateLimited(out.stderr)) {
    reportRateLimit(configDir, 60000);
  }

  if (out.code !== 0) {
    reportRequestError(configDir, syncLatency);
    logAccountStats(config.verbose, getAccountStats());
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

  reportRequestSuccess(configDir, syncLatency);
  const content = out.stdout.trim();
  logTrafficResponse(config.verbose, model ?? cursorModel, content, false);
  logAccountStats(config.verbose, getAccountStats());
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
