import { randomUUID } from "node:crypto";
import * as http from "node:http";

import type { AnthropicMessagesRequest } from "../anthropic.js";
import { buildPromptFromAnthropicMessages } from "../anthropic.js";
import { buildAgentFixedArgs } from "../agent-cmd-args.js";
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
import {
  fitPromptToWinCmdline,
  warnPromptTruncated,
} from "../win-cmdline-limit.js";

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
  const displayModel =
    requested === "default" && config.defaultModel !== "default"
      ? config.defaultModel
      : model;

  const cleanSystem = sanitizeSystem(body.system);
  const cleanMessages = sanitizeMessages(
    body.messages ?? [],
  ) as AnthropicMessagesRequest["messages"];

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
  let workspaceDir: string;
  let tempDir: string | undefined;
  try {
    const ws = resolveWorkspace(config, headerWs);
    workspaceDir = ws.workspaceDir;
    tempDir = ws.tempDir;
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Invalid workspace";
    json(res, 400, {
      error: { type: "invalid_request_error", message: msg },
    });
    return;
  }

  const fixedArgs = buildAgentFixedArgs(
    config,
    workspaceDir,
    cursorModel,
    !!body.stream,
  );
  const fit = fitPromptToWinCmdline(config.agentBin, fixedArgs, prompt, {
    maxCmdline: config.winCmdlineMax,
    platform: process.platform,
    cwd: workspaceDir,
  });
  if (!fit.ok) {
    json(res, 500, {
      error: {
        type: "api_error",
        message: fit.error,
        code: "windows_cmdline_limit",
      },
    });
    return;
  }
  if (fit.truncated) {
    warnPromptTruncated(fit.originalLength, fit.finalPromptLength);
  }
  const cmdArgs = fit.args;

  const msgId = `msg_${randomUUID().replace(/-/g, "")}`;

  const truncatedHeaders = fit.truncated
    ? { "X-Cursor-Proxy-Prompt-Truncated": "true" }
    : undefined;

  const promptForAgent =
    config.promptViaStdin || config.useAcp ? prompt : undefined;

  if (body.stream) {
    writeSseHeaders(res, truncatedHeaders);
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
        model: displayModel ?? cursorModel,
        content: [],
      },
    });
    writeEvent({
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    });

    const configDir = getNextAccountConfigDir();
    logAccountAssigned(configDir);
    reportRequestStart(configDir);
    const streamStart = Date.now();

    const abortController = new AbortController();
    req.once("close", () => abortController.abort());

    if (config.useAcp && typeof promptForAgent === "string") {
      let accumulated = "";
      runAgentStream(
        config,
        workspaceDir,
        cmdArgs,
        (chunk) => {
          accumulated += chunk;
          writeEvent({
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: chunk },
          });
        },
        tempDir,
        promptForAgent,
        configDir,
        abortController.signal,
      )
        .then(({ code, stderr: stderrOut }) => {
          const latencyMs = Date.now() - streamStart;
          reportRequestEnd(configDir);

          if (stderrOut && isRateLimited(stderrOut)) {
            reportRateLimit(configDir, 60000);
          }

          if (!abortController.signal.aborted) {
            if (code !== 0) {
              reportRequestError(configDir, latencyMs);
              const publicMsg = logAgentError(
                config.sessionsLogPath,
                method,
                pathname,
                remoteAddress,
                code,
                stderrOut,
              );
              writeEvent({
                type: "error",
                error: { type: "api_error", message: publicMsg },
              });
            } else {
              reportRequestSuccess(configDir, latencyMs);
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
            }
          }
          logAccountStats(config.verbose, getAccountStats());
          res.end();
        })
        .catch((err) => {
          reportRequestEnd(configDir);
          if (!abortController.signal.aborted) {
            reportRequestError(configDir, Date.now() - streamStart);
          }
          console.error(
            `[${new Date().toISOString()}] Agent stream error:`,
            err,
          );
          if (!abortController.signal.aborted) {
            writeEvent({
              type: "error",
              error: {
                type: "api_error",
                message: "The Cursor agent stream failed. See server logs for details.",
              },
            });
          }
          res.end();
        });
      return;
    }

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

    runAgentStream(
      config,
      workspaceDir,
      cmdArgs,
      parseLine,
      tempDir,
      promptForAgent,
      configDir,
      abortController.signal,
    )
      .then(({ code, stderr: stderrOut }) => {
        const latencyMs = Date.now() - streamStart;
        reportRequestEnd(configDir);

        if (stderrOut && isRateLimited(stderrOut)) {
          reportRateLimit(configDir, 60000);
        }

        if (abortController.signal.aborted) {
          /* client disconnected — do not count as success or failure */
        } else if (code !== 0) {
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
        if (!abortController.signal.aborted) {
          reportRequestError(configDir, Date.now() - streamStart);
        }
        console.error(
          `[${new Date().toISOString()}] Agent stream error:`,
          err,
        );
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
    promptForAgent,
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
      error: { type: "api_error", message: errMsg, code: "cursor_cli_error" },
    });
    return;
  }

  reportRequestSuccess(configDir, syncLatency);
  const content = out.stdout.trim();
  logTrafficResponse(config.verbose, model ?? cursorModel, content, false);
  logAccountStats(config.verbose, getAccountStats());
  const inTok = Math.max(1, Math.round(prompt.length / 4));
  const outTok = Math.max(1, Math.round(content.length / 4));
  json(
    res,
    200,
    {
      id: msgId,
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: content }],
      model: displayModel ?? cursorModel,
      stop_reason: "end_turn",
      usage: {
        input_tokens: inTok,
        output_tokens: outTok,
      },
    },
    truncatedHeaders,
  );
}
