import { randomUUID } from "node:crypto";
import * as http from "node:http";

import type { AnthropicMessagesRequest } from "../anthropic.js";
import { buildPromptFromAnthropicMessages } from "../anthropic.js";
import {
  buildBridgeContextPreamble,
  BRIDGE_AGENT_PROMPT_SEPARATOR,
} from "../bridge-context-preamble.js";
import { resolveClientLaunchInfo } from "../client-process.js";
import { buildAgentFixedArgs } from "../agent-cmd-args.js";
import {
  runAgentStream,
  runAgentSync,
  startAgentToolSession,
} from "../agent-runner.js";
import type { ToolTurnEvent, ToolTurnResult } from "../acp-tool-session.js";
import { createStreamParser } from "../cli-stream-parser.js";
import type { BridgeConfig } from "../config.js";
import type { CursorExecutionMode } from "../execution-mode.js";
import type { ModelCacheRef } from "./models.js";
import { getCachedCursorModels } from "./models.js";
import { json, writeSseHeaders } from "../http.js";
import { resolveModelForExecution } from "../model-map.js";
import { normalizeModelId, toolsToSystemText } from "../openai.js";
import {
  logAgentError,
  logAccountAssigned,
  logAccountStats,
  logModelResolution,
  logTrafficRequest,
  logTrafficResponse,
  type TrafficMessage,
} from "../request-log.js";
import { rememberResolvedModel, resolveModel } from "../resolve-model.js";
import { resolveRequestMode } from "../resolve-mode.js";
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
import { abortOnClientDisconnect } from "../client-disconnect.js";
import {
  anthropicToolOutputs,
  parseAnthropicFunctionTools,
  resolveToolChoice,
  type PendingClientToolCall,
} from "../tool-types.js";
import {
  ToolSessionError,
  toolSessionOwnerKey,
  type ToolSessionRecord,
  type ToolSessionRegistry,
} from "../tool-session-registry.js";

function isRateLimited(stderr: string): boolean {
  return /\b429\b|rate.?limit|too many requests/i.test(stderr);
}

export type AnthropicMessagesCtx = {
  config: BridgeConfig;
  lastRequestedModelRef: { current?: string };
  modelCacheRef: ModelCacheRef;
  toolSessions: ToolSessionRegistry;
};

function anthropicToolUse(call: PendingClientToolCall) {
  let input: unknown = {};
  try {
    input = JSON.parse(call.arguments);
  } catch {
    input = {};
  }
  return {
    type: "tool_use",
    id: call.callId,
    name: call.name,
    input,
  };
}

function structuredAnthropicResponse(opts: {
  body: AnthropicMessagesRequest;
  id: string;
  model: string | undefined;
  result: ToolTurnResult;
  promptLength: number;
}) {
  const content: Array<Record<string, unknown>> = [];
  if (opts.result.text) content.push({ type: "text", text: opts.result.text });
  if (opts.result.status === "tool_calls") {
    content.push(...opts.result.toolCalls.map(anthropicToolUse));
  }
  return {
    id: opts.id,
    type: "message",
    role: "assistant",
    model: opts.model,
    content,
    stop_reason:
      opts.result.status === "tool_calls" ? "tool_use" : "end_turn",
    stop_sequence: null,
    usage: {
      input_tokens: Math.max(1, Math.round(opts.promptLength / 4)),
      output_tokens: Math.max(1, Math.round(opts.result.text.length / 4)),
    },
  };
}

function writeAnthropicEvent(
  res: http.ServerResponse,
  event: string,
  data: Record<string, unknown>,
): void {
  res.write(`event: ${event}\ndata: ${JSON.stringify({ type: event, ...data })}\n\n`);
}

async function writeStructuredAnthropicTurn(opts: {
  res: http.ServerResponse;
  body: AnthropicMessagesRequest;
  stream: boolean;
  id: string;
  model: string | undefined;
  promptLength: number;
  run: (
    listener?: (event: ToolTurnEvent) => void,
  ) => Promise<ToolTurnResult>;
}): Promise<ToolTurnResult> {
  if (!opts.stream) {
    const result = await opts.run();
    json(
      opts.res,
      200,
      structuredAnthropicResponse({
        body: opts.body,
        id: opts.id,
        model: opts.model,
        result,
        promptLength: opts.promptLength,
      }),
    );
    return result;
  }

  writeSseHeaders(opts.res);
  writeAnthropicEvent(opts.res, "message_start", {
    message: {
      id: opts.id,
      type: "message",
      role: "assistant",
      model: opts.model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: {
        input_tokens: Math.max(1, Math.round(opts.promptLength / 4)),
        output_tokens: 0,
      },
    },
  });

  let nextIndex = 0;
  let textIndex: number | undefined;
  let emittedText = "";
  const emit = (event: ToolTurnEvent) => {
    if (event.type !== "text") return;
    if (event.type === "text") {
      if (textIndex === undefined) {
        textIndex = nextIndex++;
        writeAnthropicEvent(opts.res, "content_block_start", {
          index: textIndex,
          content_block: { type: "text", text: "" },
        });
      }
      emittedText += event.text;
      writeAnthropicEvent(opts.res, "content_block_delta", {
        index: textIndex,
        delta: { type: "text_delta", text: event.text },
      });
      return;
    }
  };

  const result = await opts.run(emit);
  if (result.text.length > emittedText.length) {
    emit({ type: "text", text: result.text.slice(emittedText.length) });
  }
  if (textIndex !== undefined) {
    writeAnthropicEvent(opts.res, "content_block_stop", { index: textIndex });
  }
  if (result.status === "tool_calls") {
    for (const call of result.toolCalls) {
      const index = nextIndex++;
      writeAnthropicEvent(opts.res, "content_block_start", {
        index,
        content_block: {
          type: "tool_use",
          id: call.callId,
          name: call.name,
          input: {},
        },
      });
      writeAnthropicEvent(opts.res, "content_block_delta", {
        index,
        delta: { type: "input_json_delta", partial_json: call.arguments },
      });
      writeAnthropicEvent(opts.res, "content_block_stop", { index });
    }
  }
  writeAnthropicEvent(opts.res, "message_delta", {
    delta: {
      stop_reason:
        result.status === "tool_calls" ? "tool_use" : "end_turn",
      stop_sequence: null,
    },
    usage: {
      output_tokens: Math.max(1, Math.round(result.text.length / 4)),
    },
  });
  writeAnthropicEvent(opts.res, "message_stop", {});
  opts.res.end();
  return result;
}

export async function handleAnthropicMessages(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  ctx: AnthropicMessagesCtx,
  rawBody: string,
  method: string,
  pathname: string,
  remoteAddress: string,
): Promise<void> {
  const { config, lastRequestedModelRef, modelCacheRef } = ctx;
  const body = JSON.parse(rawBody || "{}") as AnthropicMessagesRequest;
  let selectedTools;
  let toolInstruction: string | undefined;
  let requireToolCall = false;
  let maxParallelToolCalls: number | undefined;
  let submittedToolOutputs;
  try {
    const parsedTools = parseAnthropicFunctionTools(body.tools);
    const choice = resolveToolChoice(parsedTools, body.tool_choice, {
      anthropic: true,
      parallelToolCalls:
        body.tool_choice?.disable_parallel_tool_use === true
          ? false
          : undefined,
    });
    selectedTools = choice.tools;
    toolInstruction = choice.instruction;
    requireToolCall = choice.required;
    maxParallelToolCalls = choice.maxParallelToolCalls;
    submittedToolOutputs = anthropicToolOutputs(body.messages ?? []);
  } catch (error) {
    json(res, 400, {
      error: {
        type: "invalid_request_error",
        message: error instanceof Error ? error.message : String(error),
      },
    });
    return;
  }
  if (config.useAcp && submittedToolOutputs.length > 0) {
    const last = body.messages?.[body.messages.length - 1];
    if (
      Array.isArray(last?.content) &&
      last.content.some((block) => block?.type !== "tool_result")
    ) {
      json(res, 400, {
        error: {
          type: "invalid_request_error",
          message:
            "A tool_result resume message cannot contain additional content blocks",
        },
      });
      return;
    }
  }
  const ownerKey = toolSessionOwnerKey(req, remoteAddress);
  const requested = normalizeModelId(body.model);
  const model = resolveModel(requested, lastRequestedModelRef, config);
  const models = await getCachedCursorModels(config, modelCacheRef);
  const decision = resolveModelForExecution({
    requested: model,
    defaultModel: config.defaultModel,
    availableCursorIds: models.map((m) => m.id),
  });
  const cursorModel = decision.final;
  rememberResolvedModel(cursorModel, lastRequestedModelRef);
  logModelResolution(config.verbose, decision);
  const displayModel =
    decision.requestedWasDefault && config.defaultModel !== "default"
      ? config.defaultModel
      : model;
  const modelCatalogName = models.find(
    (item) => item.id === cursorModel,
  )?.name;
  const msgId = `msg_${randomUUID().replace(/-/g, "")}`;

  const cleanSystem = sanitizeSystem(body.system);
  const cleanMessages = sanitizeMessages(
    body.messages ?? [],
  ) as AnthropicMessagesRequest["messages"];

  const structuredToolStart =
    config.useAcp &&
    selectedTools.length > 0 &&
    submittedToolOutputs.length === 0;
  const toolsText = structuredToolStart
    ? undefined
    : body.tool_choice?.type === "none"
      ? undefined
      : toolsToSystemText(body.tools);
  const cleanSystemText =
    typeof cleanSystem === "string"
      ? cleanSystem
      : (cleanSystem ?? [])
          .filter(
            (part: { type?: string; text?: string }) => part?.type === "text",
          )
          .map((part: { type?: string; text?: string }) => part.text ?? "")
          .join("\n");
  const systemWithTools = [cleanSystemText, toolsText, toolInstruction]
    .filter(Boolean)
    .join("\n\n");
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

  if (config.useAcp && submittedToolOutputs.length > 0) {
    const record = ctx.toolSessions.findByCallIds(
      "anthropic",
      ownerKey,
      submittedToolOutputs.map((output) => output.callId),
    );
    if (!record) {
      json(res, 409, {
        error: {
          type: "invalid_request_error",
          message:
            "Tool session is missing or expired; restart the conversation",
        },
      });
      return;
    }
    const configDir = record.configDir;
    logAccountAssigned(configDir);
    reportRequestStart(configDir);
    const startedAt = Date.now();
    const abortController = new AbortController();
    abortOnClientDisconnect(res, abortController);
    abortController.signal.addEventListener(
      "abort",
      () => void record.session.close(),
      { once: true },
    );
    try {
      const result = await writeStructuredAnthropicTurn({
        res,
        body,
        stream: !!body.stream,
        id: msgId,
        model: displayModel,
        promptLength: prompt.length,
        run: (listener) =>
          ctx.toolSessions.resume(record, submittedToolOutputs, listener),
      });
      reportRequestSuccess(configDir, Date.now() - startedAt);
      logTrafficResponse(
        config.verbose,
        model ?? cursorModel,
        result.text,
        !!body.stream,
      );
    } catch (error) {
      reportRequestError(configDir, Date.now() - startedAt);
      if (!res.headersSent) {
        json(res, error instanceof ToolSessionError ? error.status : 500, {
          error: {
            type: "api_error",
            message: error instanceof Error ? error.message : String(error),
          },
        });
      } else if (!res.writableEnded) {
        writeAnthropicEvent(res, "error", {
          error: {
            type: "api_error",
            message: error instanceof Error ? error.message : String(error),
          },
        });
        res.end();
      }
    } finally {
      reportRequestEnd(configDir);
      logAccountStats(config.verbose, getAccountStats());
    }
    return;
  }

  let mode: CursorExecutionMode;
  try {
    mode = resolveRequestMode(
      config,
      req.headers["x-cursor-mode"],
      body.mode,
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Invalid mode";
    json(res, 400, {
      error: {
        type: "invalid_request_error",
        message: msg,
        code: "invalid_mode",
      },
    });
    return;
  }

  const effectiveChatOnly =
    mode === "ask"
      ? config.chatOnlyWorkspace
      : config.chatOnlyWorkspaceExplicit && config.chatOnlyWorkspace;

  const headerWs = req.headers["x-cursor-workspace"];
  let workspaceDir: string;
  let tempDir: string | undefined;
  try {
    const ws = resolveWorkspace(config, headerWs, effectiveChatOnly);
    workspaceDir = ws.workspaceDir;
    tempDir = ws.tempDir;
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Invalid workspace";
    json(res, 400, {
      error: { type: "invalid_request_error", message: msg },
    });
    return;
  }

  const agentPrompt = config.contextPreamble
    ? `${buildBridgeContextPreamble({
        headers: req.headers,
        bridgeWorkspaceBase: config.workspace,
        agentWorkspaceDir: workspaceDir,
        isolatedChatOnly: tempDir !== undefined,
        cursorMode: mode,
        contextExtra: config.contextExtra,
      })}${BRIDGE_AGENT_PROMPT_SEPARATOR}${prompt}`
    : prompt;

  const fixedArgs = buildAgentFixedArgs(
    config,
    workspaceDir,
    cursorModel,
    !!body.stream,
    mode,
    effectiveChatOnly,
  );
  const fit = fitPromptToWinCmdline(config.agentBin, fixedArgs, agentPrompt, {
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
  // When the prompt is delivered via stdin (or ACP), keep it OUT of argv,
  // otherwise a long prompt still blows past the kernel ARG_MAX (spawn E2BIG
  // on Linux). fit.args appends the full prompt for the argv path only.
  const cmdArgs =
    config.promptViaStdin || config.useAcp ? fixedArgs : fit.args;

  const truncatedHeaders = fit.truncated
    ? { "X-Cursor-Proxy-Prompt-Truncated": "true" }
    : undefined;

  const promptForAgent =
    config.promptViaStdin || config.useAcp ? agentPrompt : undefined;

  if (structuredToolStart) {
    const configDir = getNextAccountConfigDir();
    logAccountAssigned(configDir);
    reportRequestStart(configDir);
    const startedAt = Date.now();
    const abortController = new AbortController();
    abortOnClientDisconnect(res, abortController);
    let record: ToolSessionRecord | undefined;
    try {
      const session = await startAgentToolSession({
        config,
        workspaceDir,
        effectiveChatOnly,
        cmdArgs,
        prompt: agentPrompt,
        tools: selectedTools,
        tempDir,
        configDir,
        signal: abortController.signal,
        modelDisplayName: modelCatalogName,
        requireToolCall,
        maxParallelToolCalls,
      });
      record = ctx.toolSessions.createRecord({
        api: "anthropic",
        ownerKey,
        model: displayModel ?? cursorModel,
        configDir,
        session,
      });
      abortController.signal.addEventListener(
        "abort",
        () => void session.close(),
        { once: true },
      );
      const result = await writeStructuredAnthropicTurn({
        res,
        body,
        stream: !!body.stream,
        id: msgId,
        model: displayModel,
        promptLength: agentPrompt.length,
        run: (listener) => ctx.toolSessions.collect(record!, listener),
      });
      reportRequestSuccess(configDir, Date.now() - startedAt);
      if (
        result.status === "completed" &&
        result.stderr &&
        isRateLimited(result.stderr)
      ) {
        reportRateLimit(configDir, 60_000);
      }
      logTrafficResponse(
        config.verbose,
        model ?? cursorModel,
        result.text,
        !!body.stream,
      );
    } catch (error) {
      if (record) {
        ctx.toolSessions.remove(record);
        await record.session.close().catch(() => undefined);
      }
      reportRequestError(configDir, Date.now() - startedAt);
      if (!res.headersSent) {
        json(res, 500, {
          error: {
            type: "api_error",
            message: error instanceof Error ? error.message : String(error),
          },
        });
      } else if (!res.writableEnded) {
        writeAnthropicEvent(res, "error", {
          error: {
            type: "api_error",
            message: error instanceof Error ? error.message : String(error),
          },
        });
        res.end();
      }
    } finally {
      reportRequestEnd(configDir);
      logAccountStats(config.verbose, getAccountStats());
    }
    return;
  }

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
    abortOnClientDisconnect(res, abortController);

    if (config.useAcp && typeof promptForAgent === "string") {
      let accumulated = "";
      runAgentStream(
        config,
        workspaceDir,
        effectiveChatOnly,
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
        modelCatalogName,
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
      effectiveChatOnly,
      cmdArgs,
      parseLine,
      tempDir,
      promptForAgent,
      configDir,
      abortController.signal,
      modelCatalogName,
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
  abortOnClientDisconnect(res, abortController);

  const out = await runAgentSync(
    config,
    workspaceDir,
    effectiveChatOnly,
    cmdArgs,
    tempDir,
    promptForAgent,
    configDir,
    abortController.signal,
    modelCatalogName,
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
  const inTok = Math.max(1, Math.round(agentPrompt.length / 4));
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
