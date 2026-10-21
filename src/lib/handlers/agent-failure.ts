import { AcpChildExitError } from "../acp-connection.js";
import { ToolCallConstraintError } from "../acp-tool-session.js";
import {
  PLAN_LIMIT_CODE,
  PLAN_LIMIT_MESSAGE,
  PlanLimitError,
} from "../plan-limit.js";
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

/**
 * The agent could not be started, e.g. its binary is missing or cannot be
 * run. Every path (plain or tool, sync or stream) reports it like this,
 * with the code of a failed agent run (#66, #67, #89): either way the
 * Cursor CLI is unusable, and only the proxy's operator can fix it. The
 * cause names paths on the proxy host, so it stays in the server logs.
 */
export const AGENT_START_FAILURE: AgentFailure = {
  status: 500,
  code: "cursor_cli_error",
  message: "The Cursor agent could not be started. See server logs for details.",
};

/**
 * The account hit Cursor's plan limit (#65). A 429, not a 402: clients
 * retry a 429 (the OpenAI and Anthropic SDKs with backoff), and the pool
 * moves the retry to another account, so the request can still succeed.
 */
export const PLAN_LIMIT_FAILURE: AgentFailure = {
  status: 429,
  code: PLAN_LIMIT_CODE,
  message: PLAN_LIMIT_MESSAGE,
};

/** A tool turn that threw an error with no client-safe message of its own. */
const TOOL_TURN_FAILURE: AgentFailure = {
  status: 500,
  code: "tool_session_error",
  message: "The client-tool turn failed. See server logs for details.",
};

/**
 * Whether `error` is Node's report that a child process could not be
 * spawned ("spawn /path/to/agent ENOENT"), which the ACP connection passes
 * on as it is.
 */
function isSpawnError(error: unknown): boolean {
  const syscall = (error as NodeJS.ErrnoException | null | undefined)?.syscall;
  return typeof syscall === "string" && syscall.startsWith("spawn");
}

/**
 * A structured tool turn that threw. An agent that exited, could not be
 * started or hit the plan limit reports like it does on the plain path. A
 * tool-session error keeps its status and code, and a broken tool-call rule
 * keeps its message. Any other error's text can hold paths or CLI output,
 * so the client gets a generic message and the error stays in the logs.
 */
export function toolTurnFailure(error: unknown): AgentFailure {
  if (error instanceof PlanLimitError) return PLAN_LIMIT_FAILURE;
  if (error instanceof AcpChildExitError) return agentExitFailure(error.message);
  if (error instanceof ToolSessionError) {
    return { status: error.status, code: error.code, message: error.message };
  }
  if (error instanceof ToolCallConstraintError) {
    return { ...TOOL_TURN_FAILURE, message: error.message };
  }
  if (isSpawnError(error)) return AGENT_START_FAILURE;
  return TOOL_TURN_FAILURE;
}

/**
 * OpenAI's error `type` for a failure. A 429 uses the type OpenAI sends for
 * an exhausted quota (the plan limit) or for request rate limits; other
 * client errors are invalid requests.
 */
function openAiErrorType(failure: AgentFailure): string {
  if (failure.status >= 500) return "server_error";
  if (failure.code === PLAN_LIMIT_CODE) return "insufficient_quota";
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
