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
  toolsToSystemText,
  type OpenAiChatCompletionRequest,
} from "../openai.js";
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
import { sanitizeMessages } from "../sanitize.js";
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

  const cleanMessages = sanitizeMessages(body.messages ?? []);

  // Inject tool/function schemas as a system message so the model is aware of them
  const toolsText = toolsToSystemText(body.tools, body.functions);
  const messagesWithTools = toolsText
    ? [{ role: "system", content: toolsText }, ...cleanMessages]
    : cleanMessages;
  const prompt = buildPromptFromMessages(messagesWithTools);

  const trafficMessages: TrafficMessage[] = cleanMessages.map((m: any) => {
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
  });
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

  if (body.stream) {
    writeSseHeaders(res);
    res.on("error", () => {
      /* client disconnected mid-stream */
    });

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

        if (code !== 0 && !abortController.signal.aborted) {
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
      error: { message: errMsg, code: "cursor_cli_error" },
    });
    return;
  }

  reportRequestSuccess(configDir, syncLatency);
  const content = out.stdout.trim();
  logTrafficResponse(config.verbose, model ?? cursorModel, content, false);
  logAccountStats(config.verbose, getAccountStats());
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
