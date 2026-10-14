import { randomUUID } from "node:crypto";
import * as http from "node:http";

import { buildAgentFixedArgs } from "../agent-cmd-args.js";
import { prepareRequestMedia } from "../media-input.js";
import {
  getAccountStats,
  getNextAccountConfigDir,
  reportRateLimit,
  reportRequestEnd,
  reportRequestError,
  reportRequestStart,
  reportRequestSuccess,
} from "../account-pool.js";
import {
  BRIDGE_AGENT_PROMPT_SEPARATOR,
  buildBridgeContextPreamble,
} from "../bridge-context-preamble.js";
import type { BridgeConfig } from "../config.js";
import type { CursorExecutionMode } from "../execution-mode.js";
import { json, startSseKeepalive, writeSseHeaders } from "../http.js";
import {
  runAgentStream,
  runAgentSync,
  startAgentToolSession,
} from "../agent-runner.js";
import type { ToolTurnEvent, ToolTurnResult } from "../acp-tool-session.js";
import { createStreamParser } from "../cli-stream-parser.js";
import {
  resolveModelForExecution,
  UnsupportedReasoningEffortError,
} from "../model-map.js";
import {
  buildPromptFromMessages,
  normalizeModelId,
  responsesInputToMessages,
  toolsToSystemText,
  type OpenAiResponsesRequest,
} from "../openai.js";
import {
  logAccountAssigned,
  logAccountStats,
  logAgentError,
  logModelResolution,
  logToolSession,
  logTrafficRequest,
  logTrafficResponse,
  type TrafficMessage,
} from "../request-log.js";
import { rememberResolvedModel, resolveModel } from "../resolve-model.js";
import { resolveRequestMode } from "../resolve-mode.js";
import { sanitizeMessages } from "../sanitize.js";
import { resolveWorkspace } from "../workspace.js";
import {
  fitPromptToWinCmdline,
  warnPromptTruncated,
} from "../win-cmdline-limit.js";
import { abortOnClientDisconnect } from "../client-disconnect.js";
import {
  parseOpenAiFunctionTools,
  resolveToolChoice,
  responsesCallIds,
  responsesToolOutputs,
  responsesTurnToolOutputs,
  type ClientToolOutput,
  type PendingClientToolCall,
} from "../tool-types.js";
import {
  ToolSessionError,
  toolSessionOwnerKey,
  type ToolSessionRecord,
  type ToolSessionRegistry,
} from "../tool-session-registry.js";
import { getCachedCursorModels, type ModelCacheRef } from "./models.js";

function isRateLimited(stderr: string): boolean {
  return /\b429\b|rate.?limit|too many requests/i.test(stderr);
}

export type ResponsesCtx = {
  config: BridgeConfig;
  lastRequestedModelRef: { current?: string };
  modelCacheRef: ModelCacheRef;
  toolSessions: ToolSessionRegistry;
};

type ResponseStatus = "in_progress" | "completed" | "failed";

/**
 * A `namespace` member is reported as its bare name plus `namespace`, the
 * shape the Responses API uses and clients such as Codex route on, even when
 * the agent saw it under a `<namespace>__` prefix.
 */
function functionCallItem(
  call: PendingClientToolCall,
  status: "in_progress" | "completed" = "completed",
) {
  return {
    id: call.itemId,
    type: "function_call",
    status,
    call_id: call.callId,
    name: call.namespaced?.name ?? call.name,
    ...(call.namespaced ? { namespace: call.namespaced.namespace } : {}),
    arguments: status === "completed" ? call.arguments : "",
  };
}

function logToolTurn(
  verbose: boolean,
  record: ToolSessionRecord,
  turn: ToolTurnResult,
): void {
  logToolSession(
    verbose,
    turn.status === "tool_calls"
      ? `${record.id} parked ${turn.toolCalls.map((call) => `${call.name} ${call.callId}`).join(", ")}`
      : `${record.id} completed`,
  );
}

/** A parked session and the outputs that answer its calls. */
type ParkedResume = {
  record: ToolSessionRecord;
  outputs: ClientToolOutput[];
};

/**
 * What a request from a client that resends its whole history does:
 * resume a parked call, continue a turn whose calls are no longer parked
 * from the transcript, or start a new turn.
 */
type TranscriptTurn =
  | ({ kind: "resume" } & ParkedResume)
  | { kind: "rebuild" }
  | { kind: "new" };

/**
 * Tells a session rebuilt mid-turn that the calls in its transcript already
 * ran. Without it, a rebuilt session was seen repeating the last call,
 * which would run a client's side-effecting command twice.
 */
const REBUILT_TURN_NOTE =
  "This conversation is being continued in a new session. The tool calls " +
  "in the transcript already ran and each result follows its call. Do not " +
  "call a tool again for a result that is already there; continue from the " +
  "latest result.";

/**
 * Classifies a request from a client that resends its whole history (Codex
 * sends store=false and no previous_response_id). Its input also carries
 * the outputs of finished turns, so only the outputs after the latest user
 * message can answer a parked call.
 *
 * When none of them is parked (expired, restarted, another process), the
 * transcript already holds the tool results and the caller rebuilds the
 * turn in a new session; a 409 would leave a stateless client nothing to
 * retry with. Bare outputs with no user message leave nothing to rebuild,
 * so they still get 409. A new or rebuilt turn also closes parked sessions
 * the transcript has moved past instead of letting them idle until the TTL.
 */
async function classifyTranscriptTurn(
  registry: ToolSessionRegistry,
  ownerKey: string,
  input: unknown,
  verbose: boolean,
): Promise<TranscriptTurn> {
  const turnOutputs = responsesTurnToolOutputs(input);
  const match = registry.findPendingCalls(
    "responses",
    ownerKey,
    turnOutputs.map((output) => output.callId),
  );
  if (match) {
    const callIds = new Set(match.callIds);
    return {
      kind: "resume",
      record: match.record,
      outputs: turnOutputs.filter((output) => callIds.has(output.callId)),
    };
  }
  if (turnOutputs.length > 0) {
    const hasUserTurn = responsesInputToMessages({ input }).some(
      (message) => message.role === "user",
    );
    if (!hasUserTurn) {
      throw new ToolSessionError(
        "Response tool session is missing or expired; resend the conversation",
        409,
        "tool_session_expired",
      );
    }
    logToolSession(
      verbose,
      `no parked call for ${turnOutputs.map((output) => output.callId).join(", ")}; starting a new session from the transcript`,
    );
  }
  const closed = await registry.closeSuperseded(
    "responses",
    ownerKey,
    responsesCallIds(input),
  );
  if (closed > 0) {
    logToolSession(
      verbose,
      `closed ${closed} parked session(s) the transcript moved past`,
    );
  }
  return { kind: turnOutputs.length > 0 ? "rebuild" : "new" };
}

function structuredResponseObject(opts: {
  body: OpenAiResponsesRequest;
  id: string;
  createdAt: number;
  model: string | undefined;
  result: ToolTurnResult;
  previousResponseId?: string | null;
  promptLength: number;
  messageId?: string;
}) {
  const output: Array<Record<string, unknown>> = [];
  if (opts.result.text) {
    output.push({
      id: opts.messageId ?? `msg_${randomUUID().replace(/-/g, "")}`,
      type: "message",
      status: "completed",
      role: "assistant",
      content: [
        {
          type: "output_text",
          text: opts.result.text,
          annotations: [],
        },
      ],
    });
  }
  if (opts.result.status === "tool_calls") {
    output.push(...opts.result.toolCalls.map((call) => functionCallItem(call)));
  }
  const inputTokens = Math.max(1, Math.round(opts.promptLength / 4));
  const outputTokens = Math.max(1, Math.round(opts.result.text.length / 4));
  return {
    id: opts.id,
    object: "response",
    created_at: opts.createdAt,
    status: "completed",
    background: false,
    error: null,
    incomplete_details: null,
    instructions: opts.body.instructions ?? null,
    max_output_tokens: opts.body.max_output_tokens ?? null,
    model: opts.model,
    output,
    output_text: opts.result.text,
    parallel_tool_calls: opts.body.parallel_tool_calls ?? true,
    previous_response_id:
      opts.previousResponseId ?? opts.body.previous_response_id ?? null,
    reasoning: opts.body.reasoning ?? null,
    service_tier: opts.body.service_tier ?? "default",
    store: opts.body.store ?? true,
    temperature: opts.body.temperature ?? null,
    text: opts.body.text ?? { format: { type: "text" } },
    tool_choice: opts.body.tool_choice ?? "auto",
    tools: opts.body.tools ?? [],
    top_p: opts.body.top_p ?? null,
    truncation: opts.body.truncation ?? "disabled",
    usage: {
      input_tokens: inputTokens,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens: outputTokens,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: inputTokens + outputTokens,
    },
    user: opts.body.user ?? null,
    metadata: opts.body.metadata ?? null,
  };
}

async function writeStructuredResponseTurn(opts: {
  res: http.ServerResponse;
  body: OpenAiResponsesRequest;
  stream: boolean;
  id: string;
  createdAt: number;
  model: string | undefined;
  previousResponseId?: string | null;
  promptLength: number;
  run: (
    listener?: (event: ToolTurnEvent) => void,
  ) => Promise<ToolTurnResult>;
}): Promise<ToolTurnResult> {
  const messageId = `msg_${randomUUID().replace(/-/g, "")}`;
  if (!opts.stream) {
    const result = await opts.run();
    json(
      opts.res,
      200,
      structuredResponseObject({
        body: opts.body,
        id: opts.id,
        createdAt: opts.createdAt,
        model: opts.model,
        result,
        previousResponseId: opts.previousResponseId,
        promptLength: opts.promptLength,
        messageId,
      }),
    );
    return result;
  }

  writeSseHeaders(opts.res);
  const stopKeepalive = startSseKeepalive(opts.res);
  try {
    const initial = {
      id: opts.id,
      object: "response",
      created_at: opts.createdAt,
      status: "in_progress",
      model: opts.model,
      output: [],
    };
    writeResponseEvent(opts.res, "response.created", { response: initial });
    let textStarted = false;
    let emittedText = "";
    const emitText = (text: string) => {
      if (!textStarted) {
        textStarted = true;
        writeResponseEvent(opts.res, "response.output_item.added", {
          response_id: opts.id,
          output_index: 0,
          item: {
            id: messageId,
            type: "message",
            status: "in_progress",
            role: "assistant",
            content: [],
          },
        });
        writeResponseEvent(opts.res, "response.content_part.added", {
          response_id: opts.id,
          item_id: messageId,
          output_index: 0,
          content_index: 0,
          part: { type: "output_text", text: "", annotations: [] },
        });
      }
      emittedText += text;
      writeResponseEvent(opts.res, "response.output_text.delta", {
        response_id: opts.id,
        item_id: messageId,
        output_index: 0,
        content_index: 0,
        delta: text,
      });
    };
    const result = await opts.run((event) => {
      if (event.type === "text") emitText(event.text);
    });
    if (result.text.length > emittedText.length) {
      emitText(result.text.slice(emittedText.length));
    }
    let outputIndex = textStarted ? 1 : 0;
    if (textStarted) {
      writeResponseEvent(opts.res, "response.output_text.done", {
        response_id: opts.id,
        item_id: messageId,
        output_index: 0,
        content_index: 0,
        text: result.text,
      });
      writeResponseEvent(opts.res, "response.content_part.done", {
        response_id: opts.id,
        item_id: messageId,
        output_index: 0,
        content_index: 0,
        part: { type: "output_text", text: result.text, annotations: [] },
      });
      writeResponseEvent(opts.res, "response.output_item.done", {
        response_id: opts.id,
        output_index: 0,
        item: {
          id: messageId,
          type: "message",
          status: "completed",
          role: "assistant",
          content: [
            { type: "output_text", text: result.text, annotations: [] },
          ],
        },
      });
    }
    if (result.status === "tool_calls") {
      for (const call of result.toolCalls) {
        writeResponseEvent(opts.res, "response.output_item.added", {
          response_id: opts.id,
          output_index: outputIndex,
          item: functionCallItem(call, "in_progress"),
        });
        writeResponseEvent(
          opts.res,
          "response.function_call_arguments.delta",
          {
            response_id: opts.id,
            item_id: call.itemId,
            output_index: outputIndex,
            delta: call.arguments,
          },
        );
        writeResponseEvent(
          opts.res,
          "response.function_call_arguments.done",
          {
            response_id: opts.id,
            item_id: call.itemId,
            output_index: outputIndex,
            arguments: call.arguments,
          },
        );
        writeResponseEvent(opts.res, "response.output_item.done", {
          response_id: opts.id,
          output_index: outputIndex,
          item: functionCallItem(call),
        });
        outputIndex += 1;
      }
    }
    writeResponseEvent(opts.res, "response.completed", {
      response: structuredResponseObject({
        body: opts.body,
        id: opts.id,
        createdAt: opts.createdAt,
        model: opts.model,
        result,
        previousResponseId: opts.previousResponseId,
        promptLength: opts.promptLength,
        messageId,
      }),
    });
    opts.res.write("data: [DONE]\n\n");
    opts.res.end();
    return result;
  } finally {
    stopKeepalive();
  }
}

function createResponseObject(opts: {
  body: OpenAiResponsesRequest;
  id: string;
  itemId: string;
  createdAt: number;
  model: string | undefined;
  status: ResponseStatus;
  text: string;
  promptTokens: number;
  completionTokens: number;
  error?: { message: string; code: string } | null;
}) {
  const output =
    opts.status === "completed"
      ? [
          {
            id: opts.itemId,
            type: "message",
            status: "completed",
            role: "assistant",
            content: [
              {
                type: "output_text",
                text: opts.text,
                annotations: [],
              },
            ],
          },
        ]
      : [];
  const totalTokens = opts.promptTokens + opts.completionTokens;

  return {
    id: opts.id,
    object: "response",
    created_at: opts.createdAt,
    status: opts.status,
    background: false,
    error: opts.error ?? null,
    incomplete_details: null,
    instructions: opts.body.instructions ?? null,
    max_output_tokens: opts.body.max_output_tokens ?? null,
    model: opts.model,
    output,
    output_text: opts.text,
    parallel_tool_calls: opts.body.parallel_tool_calls ?? true,
    previous_response_id: opts.body.previous_response_id ?? null,
    reasoning: opts.body.reasoning ?? null,
    service_tier: opts.body.service_tier ?? "default",
    store: opts.body.store ?? false,
    temperature: opts.body.temperature ?? null,
    text: opts.body.text ?? { format: { type: "text" } },
    tool_choice: opts.body.tool_choice ?? "auto",
    tools: opts.body.tools ?? [],
    top_p: opts.body.top_p ?? null,
    truncation: opts.body.truncation ?? "disabled",
    usage: {
      input_tokens: opts.promptTokens,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens: opts.completionTokens,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: totalTokens,
    },
    user: opts.body.user ?? null,
    metadata: opts.body.metadata ?? null,
  };
}

function createOutputItem(itemId: string, status: ResponseStatus, text: string) {
  return {
    id: itemId,
    type: "message",
    status,
    role: "assistant",
    content: [
      {
        type: "output_text",
        text,
        annotations: [],
      },
    ],
  };
}

function writeResponseEvent(
  res: http.ServerResponse,
  type: string,
  data: Record<string, unknown>,
): void {
  res.write(`event: ${type}\n`);
  res.write(`data: ${JSON.stringify({ type, ...data })}\n\n`);
}

function responseContentText(message: any): string {
  const content = message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter(
        (p) =>
          p?.type === "text" ||
          p?.type === "input_text" ||
          p?.type === "output_text",
      )
      .map((p) => p.text ?? "")
      .join("");
  }
  return "";
}

export async function handleResponses(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  ctx: ResponsesCtx,
  rawBody: string,
  method: string,
  pathname: string,
  remoteAddress: string,
): Promise<void> {
  const { config, lastRequestedModelRef, modelCacheRef } = ctx;
  const body = JSON.parse(rawBody || "{}") as OpenAiResponsesRequest;
  let selectedTools;
  let toolInstruction: string | undefined;
  let requireToolCall = false;
  let maxParallelToolCalls: number | undefined;
  let submittedToolOutputs;
  try {
    const parsedTools = parseOpenAiFunctionTools(body.tools);
    const choice = resolveToolChoice(parsedTools, body.tool_choice, {
      parallelToolCalls: body.parallel_tool_calls,
    });
    selectedTools = choice.tools;
    toolInstruction = choice.instruction;
    requireToolCall = choice.required;
    maxParallelToolCalls = choice.maxParallelToolCalls;
    submittedToolOutputs = responsesToolOutputs(body.input);
  } catch (error) {
    json(res, 400, {
      error: {
        message: error instanceof Error ? error.message : String(error),
        code: "invalid_tools",
        type: "invalid_request_error",
      },
    });
    return;
  }
  // A stateful client names the response whose parked calls it answers.
  // Every other client resends its transcript, and classifyTranscriptTurn
  // matches the call ids its current turn answers instead.
  const statefulResume =
    config.useAcp &&
    submittedToolOutputs.length > 0 &&
    typeof body.previous_response_id === "string";
  if (statefulResume) {
    if (
      Array.isArray(body.input) &&
      body.input.some(
        (item) =>
          !item ||
          typeof item !== "object" ||
          (item as { type?: unknown }).type !== "function_call_output",
      )
    ) {
      json(res, 400, {
        error: {
          message:
            "A function_call_output resume cannot include other input item types",
          code: "invalid_tool_resume",
          type: "invalid_request_error",
        },
      });
      return;
    }
    if (body.instructions != null) {
      json(res, 400, {
        error: {
          message:
            "instructions cannot change while an ACP tool turn is active",
          code: "invalid_tool_resume",
          type: "invalid_request_error",
        },
      });
      return;
    }
  }
  const ownerKey = toolSessionOwnerKey(req, remoteAddress);
  let transcriptTurn: TranscriptTurn | undefined;
  if (config.useAcp && !statefulResume) {
    try {
      transcriptTurn = await classifyTranscriptTurn(
        ctx.toolSessions,
        ownerKey,
        body.input,
        config.verbose,
      );
    } catch (error) {
      if (!(error instanceof ToolSessionError)) throw error;
      json(res, error.status, {
        error: {
          message: error.message,
          code: error.code,
          type: "invalid_request_error",
        },
      });
      return;
    }
  }
  const transcriptResume =
    transcriptTurn?.kind === "resume" ? transcriptTurn : undefined;
  const resuming = statefulResume || transcriptResume !== undefined;
  const requested = normalizeModelId(body.model);
  const model = resolveModel(requested, lastRequestedModelRef, config);
  const models = await getCachedCursorModels(config, modelCacheRef);
  let decision;
  try {
    decision = resolveModelForExecution({
      requested: model,
      defaultModel: config.defaultModel,
      availableCursorIds: models.map((m) => m.id),
      reasoningEffort:
        typeof body.reasoning?.effort === "string"
          ? body.reasoning.effort
          : undefined,
    });
  } catch (error) {
    if (!(error instanceof UnsupportedReasoningEffortError)) throw error;
    json(res, 400, {
      error: {
        message: error.message,
        code: error.code,
        type: "invalid_request_error",
      },
    });
    return;
  }
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
  const id = `resp_${randomUUID().replace(/-/g, "")}`;
  const createdAt = Math.floor(Date.now() / 1000);

  const structuredToolStart =
    config.useAcp && selectedTools.length > 0 && !resuming;
  const toolsText = structuredToolStart
    ? undefined
    : body.tool_choice === "none"
      ? undefined
      : toolsToSystemText(body.tools);
  const media = await prepareRequestMedia(
    Array.isArray(body.input) ? body.input : [],
    { useAcp: config.useAcp, resumesToolSession: resuming },
  );
  if (!media.ok) {
    json(res, 422, {
      error: {
        message: media.error,
        code: "unsupported_media",
        type: "invalid_request_error",
      },
    });
    return;
  }
  const mediaBlocks = media.blocks;
  // Forwarded media is replaced by its "[Image n of N attached below]" label.
  const cleanMessages = sanitizeMessages(
    responsesInputToMessages(
      Array.isArray(body.input) ? { ...body, input: media.items } : body,
    ),
  );
  const messagesWithTools = [
    ...(toolInstruction && structuredToolStart
      ? [{ role: "system", content: toolInstruction }]
      : []),
    ...(toolsText ? [{ role: "system", content: toolsText }] : []),
    ...cleanMessages,
    // Last among the system parts, so it sits next to the transcript.
    ...(transcriptTurn?.kind === "rebuild"
      ? [{ role: "system", content: REBUILT_TURN_NOTE }]
      : []),
  ];
  const prompt = buildPromptFromMessages(messagesWithTools);

  const trafficMessages: TrafficMessage[] = cleanMessages.map((m: any) => ({
    role: String(m?.role ?? "user"),
    content: responseContentText(m),
  }));
  logTrafficRequest(
    config.verbose,
    model ?? cursorModel,
    trafficMessages,
    !!body.stream,
  );

  if (resuming) {
    const previousResponseId = body.previous_response_id;
    let resumed: ParkedResume | undefined = transcriptResume;
    if (!resumed && typeof previousResponseId === "string") {
      const found = ctx.toolSessions.findByResponseId(
        ownerKey,
        previousResponseId,
      );
      if (
        found?.api === "responses" &&
        submittedToolOutputs.every((output) =>
          found.session.hasCall(output.callId),
        )
      ) {
        resumed = { record: found, outputs: submittedToolOutputs };
      }
    }
    if (!resumed) {
      json(res, 409, {
        error: {
          message:
            "Response tool session is missing or expired; resend the original input",
          code: "tool_session_expired",
          type: "invalid_request_error",
        },
      });
      return;
    }
    const { record, outputs } = resumed;
    logToolSession(
      config.verbose,
      `${record.id} resumed with ${outputs.map((output) => output.callId).join(", ")} (matched by ${transcriptResume ? "call_id" : "previous_response_id"})`,
    );
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
      const result = await writeStructuredResponseTurn({
        res,
        body,
        stream: !!body.stream,
        id,
        createdAt,
        model: displayModel,
        previousResponseId,
        promptLength: prompt.length,
        run: async (listener) => {
          const turn = await ctx.toolSessions.resume(
            record,
            outputs,
            listener,
          );
          if (turn.status === "tool_calls") {
            ctx.toolSessions.aliasResponse(record, id);
          }
          logToolTurn(config.verbose, record, turn);
          return turn;
        },
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
            message: error instanceof Error ? error.message : String(error),
            code:
              error instanceof ToolSessionError
                ? error.code
                : "tool_session_error",
          },
        });
      } else if (!res.writableEnded) {
        writeResponseEvent(res, "response.failed", {
          response: {
            id,
            object: "response",
            status: "failed",
            error: {
              message: error instanceof Error ? error.message : String(error),
              code: "tool_session_error",
            },
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
      responsesInputToMessages(body),
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Invalid mode";
    json(res, 400, { error: { message: msg, code: "invalid_mode" } });
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
    json(res, 400, { error: { message: msg, code: "invalid_workspace" } });
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
        message: fit.error,
        code: "windows_cmdline_limit",
        type: "api_error",
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

  const itemId = `msg_${randomUUID().replace(/-/g, "")}`;
  const promptForAgent =
    config.promptViaStdin || config.useAcp ? agentPrompt : undefined;
  const truncatedHeaders = fit.truncated
    ? { "X-Cursor-Proxy-Prompt-Truncated": "true" }
    : undefined;

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
        mediaBlocks,
        tools: selectedTools,
        tempDir,
        configDir,
        signal: abortController.signal,
        modelDisplayName: modelCatalogName,
        requireToolCall,
        maxParallelToolCalls,
      });
      record = ctx.toolSessions.createRecord({
        api: "responses",
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
      const result = await writeStructuredResponseTurn({
        res,
        body,
        stream: !!body.stream,
        id,
        createdAt,
        model: displayModel,
        previousResponseId: body.previous_response_id,
        promptLength: agentPrompt.length,
        run: async (listener) => {
          const turn = await ctx.toolSessions.collect(record!, listener);
          if (turn.status === "tool_calls") {
            ctx.toolSessions.aliasResponse(record!, id);
          }
          logToolTurn(config.verbose, record!, turn);
          return turn;
        },
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
            message: error instanceof Error ? error.message : String(error),
            code: "tool_session_error",
            type: "api_error",
          },
        });
      } else if (!res.writableEnded) {
        writeResponseEvent(res, "response.failed", {
          response: {
            id,
            object: "response",
            status: "failed",
            error: {
              message: error instanceof Error ? error.message : String(error),
              code: "tool_session_error",
            },
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
    const configDir = getNextAccountConfigDir();
    logAccountAssigned(configDir);
    reportRequestStart(configDir);
    const streamStart = Date.now();

    const abortController = new AbortController();
    abortOnClientDisconnect(res, abortController);

    writeSseHeaders(res, truncatedHeaders);
    const stopKeepalive = startSseKeepalive(res);
    res.on("error", () => {
      /* client disconnected mid-stream */
    });

    const initialResponse = createResponseObject({
      body,
      id,
      itemId,
      createdAt,
      model: displayModel,
      status: "in_progress",
      text: "",
      promptTokens: Math.max(1, Math.round(agentPrompt.length / 4)),
      completionTokens: 0,
    });
    writeResponseEvent(res, "response.created", { response: initialResponse });
    writeResponseEvent(res, "response.output_item.added", {
      response_id: id,
      output_index: 0,
      item: createOutputItem(itemId, "in_progress", ""),
    });
    writeResponseEvent(res, "response.content_part.added", {
      response_id: id,
      item_id: itemId,
      output_index: 0,
      content_index: 0,
      part: { type: "output_text", text: "", annotations: [] },
    });

    const writeChunk = (chunk: string, accumulated: string) => {
      writeResponseEvent(res, "response.output_text.delta", {
        response_id: id,
        item_id: itemId,
        output_index: 0,
        content_index: 0,
        delta: chunk,
      });
      return accumulated + chunk;
    };

    const finishStream = (accumulated: string) => {
      logTrafficResponse(config.verbose, model ?? cursorModel, accumulated, true);
      const promptTokens = Math.max(1, Math.round(agentPrompt.length / 4));
      const completionTokens = Math.max(1, Math.round(accumulated.length / 4));
      const completedItem = createOutputItem(itemId, "completed", accumulated);
      writeResponseEvent(res, "response.output_text.done", {
        response_id: id,
        item_id: itemId,
        output_index: 0,
        content_index: 0,
        text: accumulated,
      });
      writeResponseEvent(res, "response.content_part.done", {
        response_id: id,
        item_id: itemId,
        output_index: 0,
        content_index: 0,
        part: completedItem.content[0],
      });
      writeResponseEvent(res, "response.output_item.done", {
        response_id: id,
        output_index: 0,
        item: completedItem,
      });
      writeResponseEvent(res, "response.completed", {
        response: createResponseObject({
          body,
          id,
          itemId,
          createdAt,
          model: displayModel,
          status: "completed",
          text: accumulated,
          promptTokens,
          completionTokens,
        }),
      });
      res.write("data: [DONE]\n\n");
    };

    if (config.useAcp && typeof promptForAgent === "string") {
      let accumulated = "";
      runAgentStream(
        config,
        workspaceDir,
        effectiveChatOnly,
        cmdArgs,
        (chunk) => {
          accumulated = writeChunk(chunk, accumulated);
        },
        tempDir,
        promptForAgent,
        configDir,
        abortController.signal,
        modelCatalogName,
        mediaBlocks,
      )
        .then(({ code, stderr: stderrOut }) => {
          stopKeepalive();
          const latencyMs = Date.now() - streamStart;
          reportRequestEnd(configDir);

          if (stderrOut && isRateLimited(stderrOut)) {
            reportRateLimit(configDir, 60000);
          }

          if (abortController.signal.aborted) {
            /* client disconnected — do not count as success or failure */
          } else if (code !== 0) {
            reportRequestError(configDir, latencyMs);
            const publicMsg = logAgentError(
              config.sessionsLogPath,
              method,
              pathname,
              remoteAddress,
              code,
              stderrOut,
            );
            writeResponseEvent(res, "error", {
              error: { message: publicMsg, code: "cursor_cli_error" },
            });
            res.write("data: [DONE]\n\n");
            logAccountStats(config.verbose, getAccountStats());
            res.end();
            return;
          } else {
            reportRequestSuccess(configDir, latencyMs);
          }
          logAccountStats(config.verbose, getAccountStats());
          finishStream(accumulated);
          res.end();
        })
        .catch((err) => {
          stopKeepalive();
          reportRequestEnd(configDir);
          if (!abortController.signal.aborted) {
            reportRequestError(configDir, Date.now() - streamStart);
            writeResponseEvent(res, "error", {
              error: {
                message:
                  "The Cursor agent stream failed. See server logs for details.",
                code: "cursor_cli_error",
              },
            });
            res.write("data: [DONE]\n\n");
          }
          console.error(
            `[${new Date().toISOString()}] Agent stream error:`,
            err,
          );
          res.end();
        });
      return;
    }

    let accumulated = "";
    const parseLine = createStreamParser(
      (text) => {
        accumulated = writeChunk(text, accumulated);
      },
      () => {
        finishStream(accumulated);
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
      mediaBlocks,
    )
      .then(({ code, stderr: stderrOut }) => {
        stopKeepalive();
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
        stopKeepalive();
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
    mediaBlocks,
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

  const promptTokens = Math.max(1, Math.round(agentPrompt.length / 4));
  const completionTokens = Math.max(1, Math.round(content.length / 4));

  logAccountStats(config.verbose, getAccountStats());
  json(
    res,
    200,
    createResponseObject({
      body,
      id,
      itemId,
      createdAt,
      model: displayModel,
      status: "completed",
      text: content,
      promptTokens,
      completionTokens,
    }),
    truncatedHeaders,
  );
}
