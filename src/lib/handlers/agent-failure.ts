import { AcpChildExitError } from "../acp-connection.js";
import { ToolSessionError } from "../tool-session-registry.js";

/**
 * Why a turn failed, in the terms every API reports it: the HTTP status of
 * a response that has not started yet, a machine-readable code and a
 * client-safe message. Streams carry the code and message in their own
 * terminal error event instead of the status.
 */
export type AgentFailure = {
  status: number;
  code: string;
  message: string;
};

/** The agent exited non-zero; `message` comes from logAgentError. */
export function agentExitFailure(message: string): AgentFailure {
  return { status: 500, code: "cursor_cli_error", message };
}

/** The agent could not be run or its stream broke (spawn error and the like). */
export const STREAM_FAILURE: AgentFailure = {
  status: 500,
  code: "cursor_cli_error",
  message: "The Cursor agent stream failed. See server logs for details.",
};

/**
 * A structured tool turn that threw: an agent that exited reports like it
 * does on the plain path, a tool-session error keeps its status and code.
 */
export function toolTurnFailure(error: unknown): AgentFailure {
  if (error instanceof AcpChildExitError) return agentExitFailure(error.message);
  if (error instanceof ToolSessionError) {
    return { status: error.status, code: error.code, message: error.message };
  }
  return {
    status: 500,
    code: "tool_session_error",
    message: error instanceof Error ? error.message : String(error),
  };
}

/**
 * OpenAI's error `type` for a status. A 429 uses the type OpenAI sends for
 * request rate limits; other client errors are invalid requests.
 */
function openAiErrorType(failure: AgentFailure): string {
  if (failure.status >= 500) return "server_error";
  if (failure.status === 429) return "requests";
  return "invalid_request_error";
}

/** Chat Completions and Responses error body: `{ error: { message, type, param, code } }`. */
export function openAiErrorBody(failure: AgentFailure) {
  return {
    error: {
      message: failure.message,
      type: openAiErrorType(failure),
      param: null,
      code: failure.code,
    },
  };
}

function anthropicErrorType(status: number): string {
  if (status >= 500) return "api_error";
  if (status === 429) return "rate_limit_error";
  return "invalid_request_error";
}

/**
 * Anthropic error body, also the data of a stream's `error` event:
 * `{ type: "error", error: { type, message } }`, plus the proxy's `code`
 * when it has one.
 */
export function anthropicErrorBody(
  failure: Omit<AgentFailure, "code"> & { code?: string },
) {
  return {
    type: "error",
    error: {
      type: anthropicErrorType(failure.status),
      message: failure.message,
      ...(failure.code ? { code: failure.code } : {}),
    },
  };
}
