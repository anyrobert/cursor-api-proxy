import { randomUUID } from "node:crypto";
import * as http from "node:http";

import { buildAgentFixedArgs } from "../agent-cmd-args.js";
import { prepareRequestMedia } from "../media-input.js";
import { getNextAccountConfigDir } from "../account-pool.js";
import {
  BRIDGE_AGENT_PROMPT_SEPARATOR,
  buildBridgeContextPreamble,
} from "../bridge-context-preamble.js";
import type { BridgeConfig } from "../config.js";
import type { CursorExecutionMode } from "../execution-mode.js";
import { json, startSseKeepalive, writeSseHeaders } from "../http.js";
import { startAgentToolSession } from "../agent-runner.js";
import type { ToolTurnEvent, ToolTurnResult } from "../acp-tool-session.js";
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
  logModelResolution,
  logToolSession,
  logTrafficRequest,
  logTrafficResponse,
  type TrafficMessage,
} from "../request-log.js";
import { rememberResolvedModel, resolveModel } from "../resolve-model.js";
import { resolveRequestMode } from "../resolve-mode.js";
import { sanitizeMessages } from "../sanitize.js";
import { removeChatOnlyTempDir, resolveWorkspace } from "../workspace.js";
import {
  fitPromptToWinCmdline,
  warnPromptTruncated,
} from "../win-cmdline-limit.js";
import {
  droppedToolsNote,
  freeformInput,
  isResponsesToolOutput,
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
import { openAiErrorBody, type AgentFailure } from "./agent-failure.js";
import {
  AccountUse,
  failToolTurn,
  runPlainTurn,
  streamPlainTurn,
  type PlainTurn,
} from "./agent-turn.js";
import { getCachedCursorModels, type ModelCacheRef } from "./models.js";

export type ResponsesCtx = {
  config: BridgeConfig;
  lastRequestedModelRef: { current?: string };
  modelCacheRef: ModelCacheRef;
  toolSessions: ToolSessionRegistry;
};

type ResponseStatus = "in_progress" | "completed" | "failed";

/**
 * How the Responses API reports a call: a function's JSON `arguments`, or
 * the raw `input` text of a freeform `custom` tool, each under its own item
 * type and streaming events.
 */
function callWire(call: PendingClientToolCall) {
  return call.freeform
    ? {
        type: "custom_tool_call",
        field: "input",
        events: "response.custom_tool_call_input",
        text: freeformInput(call.arguments),
      }
    : {
        type: "function_call",
        field: "arguments",
        events: "response.function_call_arguments",
        text: call.arguments,
      };
}

/**
 * A `namespace` member is reported as its bare name plus `namespace`, the
 * shape the Responses API uses and clients such as Codex route on, even when
 * the agent saw it under a `<namespace>__` prefix.
 */
function toolCallItem(
  call: PendingClientToolCall,
  status: "in_progress" | "completed" = "completed",
) {
  const wire = callWire(call);
  return {
    id: call.itemId,
    type: wire.type,
    status,
    call_id: call.callId,
    name: call.namespaced?.name ?? call.name,
    ...(call.namespaced ? { namespace: call.namespaced.namespace } : {}),
    [wire.field]: status === "completed" ? wire.text : "",
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
    output.push(...opts.result.toolCalls.map((call) => toolCallItem(call)));
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

async function writeStructuredResponseTurn(
  opts: ResponseFrame & {
    res: http.ServerResponse;
    stream: boolean;
    previousResponseId?: string | null;
    run: (
      listener?: (event: ToolTurnEvent) => void,
    ) => Promise<ToolTurnResult>;
  },
): Promise<ToolTurnResult> {
  const { events } = opts;
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
    events.write("response.created", { response: initial });
    let textStarted = false;
    let emittedText = "";
    const emitText = (text: string) => {
      if (!textStarted) {
        textStarted = true;
        events.write("response.output_item.added", {
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
        events.write("response.content_part.added", {
          response_id: opts.id,
          item_id: messageId,
          output_index: 0,
          content_index: 0,
          part: { type: "output_text", text: "", annotations: [] },
        });
      }
      emittedText += text;
      events.write("response.output_text.delta", {
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
      events.write("response.output_text.done", {
        response_id: opts.id,
        item_id: messageId,
        output_index: 0,
        content_index: 0,
        text: result.text,
      });
      events.write("response.content_part.done", {
        response_id: opts.id,
        item_id: messageId,
        output_index: 0,
        content_index: 0,
        part: { type: "output_text", text: result.text, annotations: [] },
      });
      events.write("response.output_item.done", {
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
        const wire = callWire(call);
        events.write("response.output_item.added", {
          response_id: opts.id,
          output_index: outputIndex,
          item: toolCallItem(call, "in_progress"),
        });
        events.write(`${wire.events}.delta`, {
          response_id: opts.id,
          item_id: call.itemId,
          output_index: outputIndex,
          delta: wire.text,
        });
        events.write(`${wire.events}.done`, {
          response_id: opts.id,
          item_id: call.itemId,
          output_index: outputIndex,
          [wire.field]: wire.text,
        });
        events.write("response.output_item.done", {
          response_id: opts.id,
          output_index: outputIndex,
          item: toolCallItem(call),
        });
        outputIndex += 1;
      }
    }
    events.write("response.completed", {
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
  createdAt: number;
  model: string | undefined;
  status: ResponseStatus;
  output: ReturnType<typeof createOutputItem>[];
  text: string;
  promptTokens: number;
  completionTokens: number;
  error?: { message: string; code: string } | null;
}) {
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
    output: opts.output,
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

/** An event's own fields; the writer sets `type` and `sequence_number`. */
type ResponseEventFields = Record<string, unknown> & {
  type?: never;
  sequence_number?: never;
};

/**
 * Writes one response's streaming events. Each carries `sequence_number`,
 * counting from 0 within the response, as the Responses API numbers them
 * (#94). Every event of a stream, its `response.failed` included, goes
 * through the response's one writer, so the numbers have no gaps or repeats.
 */
class ResponseEventWriter {
  readonly #res: http.ServerResponse;
  #next = 0;

  constructor(res: http.ServerResponse) {
    this.#res = res;
  }

  write(type: string, fields: ResponseEventFields): void {
    const event = { type, sequence_number: this.#next++, ...fields };
    this.#res.write(`event: ${type}\ndata: ${JSON.stringify(event)}\n\n`);
  }
}

/** The response a request answers: what its events and failure report on. */
type ResponseFrame = {
  body: OpenAiResponsesRequest;
  id: string;
  createdAt: number;
  model: string | undefined;
  promptLength: number;
  events: ResponseEventWriter;
};

/**
 * Ends a stream the way the Responses API reports a failed response: one
 * `response.failed` event carrying the response with `status: "failed"`,
 * its `error` and no output, as in OpenAI's reference; items already
 * announced are not closed. No `[DONE]`, which belongs to Chat Completions.
 */
function writeResponseFailed(
  frame: ResponseFrame,
  failure: AgentFailure,
): void {
  frame.events.write("response.failed", {
    response: createResponseObject({
      body: frame.body,
      id: frame.id,
      createdAt: frame.createdAt,
      model: frame.model,
      status: "failed",
      output: [],
      text: "",
      promptTokens: Math.max(1, Math.round(frame.promptLength / 4)),
      completionTokens: 0,
      error: { code: failure.code, message: failure.message },
    }),
  });
}

/** Answers with an error response, or ends a started stream with it. */
function writeResponsesFailure(
  res: http.ServerResponse,
  frame: ResponseFrame,
  failure: AgentFailure,
): void {
  if (!res.headersSent) {
    json(res, failure.status, openAiErrorBody(failure));
  } else if (!res.writableEnded) {
    writeResponseFailed(frame, failure);
    res.end();
  }
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
  const turnRequest = { config, method, pathname, remoteAddress };
  const body = JSON.parse(rawBody || "{}") as OpenAiResponsesRequest;
  let selectedTools;
  let toolInstruction: string | undefined;
  let requireToolCall = false;
  let maxParallelToolCalls: number | undefined;
  let submittedToolOutputs;
  try {
    const parsed = parseOpenAiFunctionTools(body.tools);
    const ignored = droppedToolsNote(parsed.dropped);
    if (ignored) logToolSession(config.verbose, ignored);
    const choice = resolveToolChoice(parsed.tools, body.tool_choice, {
      parallelToolCalls: body.parallel_tool_calls,
      dropped: parsed.dropped,
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
      body.input.some((item) => !isResponsesToolOutput(item))
    ) {
      json(res, 400, {
        error: {
          message:
            "A tool output resume cannot include input items other than function_call_output or custom_tool_call_output",
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
  const events = new ResponseEventWriter(res);

  const structuredToolStart =
    config.useAcp && selectedTools.length > 0 && !resuming;
  const toolsText = structuredToolStart
    ? undefined
    : toolsToSystemText(selectedTools);
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
    const use = new AccountUse(res, config.verbose, record.configDir);
    use.signal.addEventListener("abort", () => void record.session.close(), {
      once: true,
    });
    const resumeFrame: ResponseFrame = {
      body,
      id,
      createdAt,
      model: displayModel,
      promptLength: prompt.length,
      events,
    };
    try {
      const result = await writeStructuredResponseTurn({
        ...resumeFrame,
        res,
        stream: !!body.stream,
        previousResponseId,
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
      use.succeeded();
      logTrafficResponse(
        config.verbose,
        model ?? cursorModel,
        result.text,
        !!body.stream,
      );
    } catch (error) {
      writeResponsesFailure(
        res,
        resumeFrame,
        failToolTurn(turnRequest, use, error),
      );
    } finally {
      use.end();
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
    removeChatOnlyTempDir(tempDir);
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
  const frame: ResponseFrame = {
    body,
    id,
    createdAt,
    model: displayModel,
    promptLength: agentPrompt.length,
    events,
  };

  if (structuredToolStart) {
    const use = new AccountUse(res, config.verbose, getNextAccountConfigDir());
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
        configDir: use.configDir,
        signal: use.signal,
        modelDisplayName: modelCatalogName,
        requireToolCall,
        maxParallelToolCalls,
      });
      record = ctx.toolSessions.createRecord({
        api: "responses",
        ownerKey,
        model: displayModel ?? cursorModel,
        configDir: use.configDir,
        session,
      });
      use.signal.addEventListener("abort", () => void session.close(), {
        once: true,
      });
      const result = await writeStructuredResponseTurn({
        ...frame,
        res,
        stream: !!body.stream,
        previousResponseId: body.previous_response_id,
        run: async (listener) => {
          const turn = await ctx.toolSessions.collect(record!, listener);
          if (turn.status === "tool_calls") {
            ctx.toolSessions.aliasResponse(record!, id);
          }
          logToolTurn(config.verbose, record!, turn);
          return turn;
        },
      });
      use.succeeded();
      if (result.status === "completed") use.checkRateLimit(result.stderr);
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
      writeResponsesFailure(res, frame, failToolTurn(turnRequest, use, error));
    } finally {
      use.end();
    }
    return;
  }

  const turn: PlainTurn = {
    ...turnRequest,
    res,
    logModel: model ?? cursorModel,
    workspaceDir,
    effectiveChatOnly,
    cmdArgs,
    tempDir,
    promptForAgent,
    modelCatalogName,
    mediaBlocks,
  };
  const promptTokens = Math.max(1, Math.round(agentPrompt.length / 4));

  if (body.stream) {
    // The message item opens with the first text, so a failure that
    // arrives first reports a response with no output.
    let itemOpen = false;
    const openItem = () => {
      if (itemOpen) return;
      itemOpen = true;
      events.write("response.output_item.added", {
        response_id: id,
        output_index: 0,
        item: createOutputItem(itemId, "in_progress", ""),
      });
      events.write("response.content_part.added", {
        response_id: id,
        item_id: itemId,
        output_index: 0,
        content_index: 0,
        part: { type: "output_text", text: "", annotations: [] },
      });
    };
    await streamPlainTurn(
      turn,
      {
        open: () =>
          events.write("response.created", {
            response: createResponseObject({
              body,
              id,
              createdAt,
              model: displayModel,
              status: "in_progress",
              output: [],
              text: "",
              promptTokens,
              completionTokens: 0,
            }),
          }),
        text: (delta) => {
          openItem();
          events.write("response.output_text.delta", {
            response_id: id,
            item_id: itemId,
            output_index: 0,
            content_index: 0,
            delta,
          });
        },
        complete: (text) => {
          openItem();
          const item = createOutputItem(itemId, "completed", text);
          events.write("response.output_text.done", {
            response_id: id,
            item_id: itemId,
            output_index: 0,
            content_index: 0,
            text,
          });
          events.write("response.content_part.done", {
            response_id: id,
            item_id: itemId,
            output_index: 0,
            content_index: 0,
            part: item.content[0],
          });
          events.write("response.output_item.done", {
            response_id: id,
            output_index: 0,
            item,
          });
          events.write("response.completed", {
            response: createResponseObject({
              body,
              id,
              createdAt,
              model: displayModel,
              status: "completed",
              output: [item],
              text,
              promptTokens,
              completionTokens: Math.max(1, Math.round(text.length / 4)),
            }),
          });
          res.write("data: [DONE]\n\n");
        },
        fail: (failure) => writeResponseFailed(frame, failure),
      },
      truncatedHeaders,
    );
    return;
  }

  const outcome = await runPlainTurn(turn);
  if (!outcome) return;
  if (!outcome.ok) {
    json(res, outcome.failure.status, openAiErrorBody(outcome.failure));
    return;
  }
  json(
    res,
    200,
    createResponseObject({
      body,
      id,
      createdAt,
      model: displayModel,
      status: "completed",
      output: [createOutputItem(itemId, "completed", outcome.text)],
      text: outcome.text,
      promptTokens,
      completionTokens: Math.max(1, Math.round(outcome.text.length / 4)),
    }),
    truncatedHeaders,
  );
}
