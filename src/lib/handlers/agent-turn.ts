import type * as http from "node:http";
import * as path from "node:path";

import { AcpChildExitError } from "../acp-connection.js";
import {
  getAccountStats,
  getNextAccountConfigDir,
  reportRateLimit,
  reportRequestEnd,
  reportRequestError,
  reportRequestStart,
  reportRequestSuccess,
} from "../account-pool.js";
import { runAgentStream, runAgentSync } from "../agent-runner.js";
import { abortOnClientDisconnect } from "../client-disconnect.js";
import { createStreamParser } from "../cli-stream-parser.js";
import type { BridgeConfig } from "../config.js";
import { startSseKeepalive, writeSseHeaders } from "../http.js";
import type { AcpPromptBlock } from "../media-input.js";
import {
  hitPlanLimit,
  PLAN_LIMIT_CODE,
  PLAN_LIMIT_PENALTY_MS,
  PlanLimitError,
  PlanLimitHoldback,
} from "../plan-limit.js";
import {
  appendSessionError,
  logAccountAssigned,
  logAccountStats,
  logAgentError,
  logTrafficResponse,
  logTurnFailure,
} from "../request-log.js";
import { ToolSessionError } from "../tool-session-registry.js";
import {
  AGENT_START_FAILURE,
  agentExitFailure,
  PLAN_LIMIT_FAILURE,
  toolTurnFailure,
  type AgentFailure,
} from "./agent-failure.js";

const RATE_LIMIT_PENALTY_MS = 60_000;

function isRateLimited(stderr: string): boolean {
  return /\b429\b|rate.?limit|too many requests/i.test(stderr);
}

/** The request a turn answers, for the error logs. */
export type TurnRequest = {
  config: BridgeConfig;
  method: string;
  pathname: string;
  remoteAddress: string;
};

/**
 * One request's use of a pool account: it is assigned and counted at
 * construction, the agent is aborted when the client goes away, and the
 * outcome is recorded for the pool to rotate on.
 */
export class AccountUse {
  readonly configDir: string | undefined;
  readonly #abort = new AbortController();
  readonly #startedAt = Date.now();
  readonly #verbose: boolean;
  #ended = false;

  constructor(
    res: http.ServerResponse,
    verbose: boolean,
    configDir: string | undefined,
  ) {
    this.configDir = configDir;
    this.#verbose = verbose;
    logAccountAssigned(configDir);
    reportRequestStart(configDir);
    abortOnClientDisconnect(res, this.#abort);
  }

  get signal(): AbortSignal {
    return this.#abort.signal;
  }

  /** The account's name for logs, as logAccountAssigned prints it. */
  get account(): string {
    return this.configDir ? path.basename(this.configDir) : "default";
  }

  /** Rests the account when the agent's diagnostics show a rate limit. */
  checkRateLimit(stderr: string | undefined): void {
    if (stderr && isRateLimited(stderr)) {
      reportRateLimit(this.configDir, RATE_LIMIT_PENALTY_MS);
    }
  }

  succeeded(): void {
    reportRequestSuccess(this.configDir, Date.now() - this.#startedAt);
  }

  /** Counts an error; a plan limit also rests the account, as a rate limit does. */
  failed(failure?: AgentFailure): void {
    reportRequestError(this.configDir, Date.now() - this.#startedAt);
    if (failure?.code === PLAN_LIMIT_CODE) {
      reportRateLimit(this.configDir, PLAN_LIMIT_PENALTY_MS);
    }
  }

  /** Releases the account once the request is answered. */
  end(): void {
    if (this.#ended) return;
    this.#ended = true;
    reportRequestEnd(this.configDir);
    logAccountStats(this.#verbose, getAccountStats());
  }
}

/**
 * Logs an error the client hears about only as `failure`, since its text
 * can name paths on the proxy host or hold CLI output: the whole error
 * (with its stack) to the console, its message to the sessions log.
 */
function logThrownError(
  turn: TurnRequest,
  failure: AgentFailure,
  error: unknown,
): void {
  console.error(
    `[${new Date().toISOString()}] Agent turn error (${failure.code}):`,
    error,
  );
  appendSessionError(
    turn.config.sessionsLogPath,
    turn.method,
    turn.pathname,
    turn.remoteAddress,
    failure.code,
    error instanceof Error ? error.message : String(error),
  );
}

/**
 * Records a structured tool turn that threw and returns what to tell the
 * client. Tool-session errors answer the client's own request and are not
 * logged. An agent exit or the plan limit is logged like on the plain path,
 * with the CLI output of an agent that exited (AcpConnection has printed
 * it); any other error is logged whole.
 */
export function failToolTurn(
  turn: TurnRequest,
  use: AccountUse,
  error: unknown,
): AgentFailure {
  const failure = toolTurnFailure(error);
  use.failed(failure);
  if (error instanceof ToolSessionError) return failure;
  if (error instanceof AcpChildExitError || error instanceof PlanLimitError) {
    logTurnFailure(
      turn.config.sessionsLogPath,
      turn.method,
      turn.pathname,
      turn.remoteAddress,
      failure,
      error instanceof AcpChildExitError ? error.diagnostics : undefined,
    );
  } else {
    logThrownError(turn, failure, error);
  }
  return failure;
}

/** A plain (no client tools) agent turn, the same for every API. */
export type PlainTurn = TurnRequest & {
  res: http.ServerResponse;
  /** Model name for the traffic log. */
  logModel: string;
  workspaceDir: string;
  effectiveChatOnly: boolean;
  cmdArgs: string[];
  tempDir?: string;
  promptForAgent?: string;
  modelCatalogName?: string;
  mediaBlocks?: AcpPromptBlock[];
};

/** How one API writes a plain turn's SSE stream. */
export type TextStreamSink = {
  /** The first events, right after the SSE headers. */
  open(): void;
  text(delta: string): void;
  /** Closes the answer; `text` is everything sent. */
  complete(text: string): void;
  /** The API's terminal error event. */
  fail(failure: AgentFailure): void;
};

type AgentRun = { code: number; stderr: string; error?: string };

/**
 * Records a finished run that answered `text` on its account and returns
 * its failure, if any: the plan limit before an exit code, since Cursor
 * reports it as an answer. A run the client walked away from counts as
 * neither.
 */
function settleRun(
  turn: PlainTurn,
  use: AccountUse,
  run: AgentRun,
  text: string,
): AgentFailure | undefined {
  use.checkRateLimit(run.stderr);
  if (use.signal.aborted) return undefined;
  if (
    hitPlanLimit({
      text,
      failed: run.code !== 0,
      diagnostics: [run.stderr, run.error],
    })
  ) {
    use.failed(PLAN_LIMIT_FAILURE);
    logTurnFailure(
      turn.config.sessionsLogPath,
      turn.method,
      turn.pathname,
      turn.remoteAddress,
      PLAN_LIMIT_FAILURE,
      `account ${use.account}, exit ${run.code}`,
    );
    return PLAN_LIMIT_FAILURE;
  }
  if (run.code === 0) {
    use.succeeded();
    return undefined;
  }
  use.failed();
  return agentExitFailure(
    logAgentError(
      turn.config.sessionsLogPath,
      turn.method,
      turn.pathname,
      turn.remoteAddress,
      run.code,
      run.stderr,
      run.error,
    ),
  );
}

/**
 * Records a run that rejected, which runAgentSync and runAgentStream do
 * only when the agent could not be started (a missing binary, say), and
 * returns AGENT_START_FAILURE. A run the client walked away from counts as
 * nothing, as in settleRun.
 */
function settleStartError(
  turn: PlainTurn,
  use: AccountUse,
  error: unknown,
): AgentFailure | undefined {
  if (use.signal.aborted) return undefined;
  use.failed();
  logThrownError(turn, AGENT_START_FAILURE, error);
  return AGENT_START_FAILURE;
}

/**
 * Streams a plain turn through `sink` and always ends the response: with
 * the answer, with the API's terminal error when the agent fails, or with
 * nothing once the client has gone. Text that could still be the plan-limit
 * reply is held back until it is ruled out. The CLI marks a finished answer
 * with a `result` line before it exits, so its answer can close first; an
 * exit after that is still recorded as the account's failure.
 */
export async function streamPlainTurn(
  turn: PlainTurn,
  sink: TextStreamSink,
  headers?: http.OutgoingHttpHeaders,
): Promise<void> {
  const { config, res } = turn;
  const use = new AccountUse(res, config.verbose, getNextAccountConfigDir());
  writeSseHeaders(res, headers);
  const stopKeepalive = startSseKeepalive(res);
  res.on("error", () => {
    /* client disconnected mid-stream */
  });

  const holdback = new PlanLimitHoldback();
  let text = "";
  let ended = false;
  const end = (failure?: AgentFailure) => {
    if (ended || use.signal.aborted) return;
    ended = true;
    if (failure) {
      sink.fail(failure);
      return;
    }
    const held = holdback.release();
    if (held) sink.text(held);
    logTrafficResponse(config.verbose, turn.logModel, text, true);
    sink.complete(text);
  };
  const onText = (delta: string) => {
    if (ended) return;
    text += delta;
    const shown = holdback.push(delta);
    if (shown) sink.text(shown);
  };
  // The answer settles the plan-limit question before the CLI exits; the
  // exit then records it on the account (settleRun sees the same text).
  const onCliResult = () =>
    end(holdback.heldReply ? PLAN_LIMIT_FAILURE : undefined);
  const viaAcp = config.useAcp && typeof turn.promptForAgent === "string";
  try {
    sink.open();
    const run = await runAgentStream(
      config,
      turn.workspaceDir,
      turn.effectiveChatOnly,
      turn.cmdArgs,
      viaAcp ? onText : createStreamParser(onText, onCliResult),
      turn.tempDir,
      turn.promptForAgent,
      use.configDir,
      use.signal,
      turn.modelCatalogName,
      turn.mediaBlocks,
    );
    end(settleRun(turn, use, run, text));
  } catch (error) {
    const failure = settleStartError(turn, use, error);
    if (failure) end(failure);
  } finally {
    stopKeepalive();
    use.end();
    res.end();
  }
}

export type PlainTurnResult =
  | { ok: true; text: string }
  | { ok: false; failure: AgentFailure };

/**
 * Runs a plain turn to completion. Undefined when the client has gone and
 * there is no one to answer. A run that cannot start (the agent binary is
 * missing, say) fails with AGENT_START_FAILURE, as it does in a stream.
 */
export async function runPlainTurn(
  turn: PlainTurn,
): Promise<PlainTurnResult | undefined> {
  const { config } = turn;
  const use = new AccountUse(
    turn.res,
    config.verbose,
    getNextAccountConfigDir(),
  );
  try {
    const out = await runAgentSync(
      config,
      turn.workspaceDir,
      turn.effectiveChatOnly,
      turn.cmdArgs,
      turn.tempDir,
      turn.promptForAgent,
      use.configDir,
      use.signal,
      turn.modelCatalogName,
      turn.mediaBlocks,
    );
    const text = out.stdout.trim();
    const failure = settleRun(turn, use, out, text);
    if (use.signal.aborted) return undefined;
    if (failure) return { ok: false, failure };
    logTrafficResponse(config.verbose, turn.logModel, text, false);
    return { ok: true, text };
  } catch (error) {
    const failure = settleStartError(turn, use, error);
    return failure && { ok: false, failure };
  } finally {
    use.end();
  }
}
