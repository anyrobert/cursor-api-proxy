import type * as http from "node:http";

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
  logAccountAssigned,
  logAccountStats,
  logAgentError,
  logTrafficResponse,
  logTurnFailure,
} from "../request-log.js";
import { ToolSessionError } from "../tool-session-registry.js";
import {
  agentExitFailure,
  STREAM_FAILURE,
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

  /** Rests the account when the agent's diagnostics show a rate limit. */
  checkRateLimit(stderr: string | undefined): void {
    if (stderr && isRateLimited(stderr)) {
      reportRateLimit(this.configDir, RATE_LIMIT_PENALTY_MS);
    }
  }

  succeeded(): void {
    reportRequestSuccess(this.configDir, Date.now() - this.#startedAt);
  }

  failed(): void {
    reportRequestError(this.configDir, Date.now() - this.#startedAt);
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
 * Records a structured tool turn that threw and returns what to tell the
 * client. Tool-session errors answer the client's own request and are not
 * logged; anything else goes to the console and the sessions log, with the
 * CLI output of an agent that exited.
 */
export function failToolTurn(
  turn: TurnRequest,
  use: AccountUse,
  error: unknown,
): AgentFailure {
  const failure = toolTurnFailure(error);
  use.failed();
  if (!(error instanceof ToolSessionError)) {
    logTurnFailure(
      turn.config.sessionsLogPath,
      turn.method,
      turn.pathname,
      turn.remoteAddress,
      failure,
      error instanceof AcpChildExitError ? error.diagnostics : undefined,
    );
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
 * Records a finished run on its account and returns its failure, if any.
 * A run the client walked away from counts as neither.
 */
function settleRun(
  turn: PlainTurn,
  use: AccountUse,
  run: AgentRun,
): AgentFailure | undefined {
  use.checkRateLimit(run.stderr);
  if (use.signal.aborted) return undefined;
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
 * Streams a plain turn through `sink` and always ends the response: with
 * the answer, with the API's terminal error when the agent fails, or with
 * nothing once the client has gone. The CLI marks a finished answer with a
 * `result` line before it exits, so its answer can close first; an exit
 * after that is still recorded as the account's failure.
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

  let text = "";
  let ended = false;
  const end = (failure?: AgentFailure) => {
    if (ended || use.signal.aborted) return;
    ended = true;
    if (failure) {
      sink.fail(failure);
      return;
    }
    logTrafficResponse(config.verbose, turn.logModel, text, true);
    sink.complete(text);
  };
  const onText = (delta: string) => {
    if (ended) return;
    text += delta;
    sink.text(delta);
  };
  const viaAcp = config.useAcp && typeof turn.promptForAgent === "string";
  try {
    sink.open();
    const run = await runAgentStream(
      config,
      turn.workspaceDir,
      turn.effectiveChatOnly,
      turn.cmdArgs,
      viaAcp ? onText : createStreamParser(onText, () => end()),
      turn.tempDir,
      turn.promptForAgent,
      use.configDir,
      use.signal,
      turn.modelCatalogName,
      turn.mediaBlocks,
    );
    end(settleRun(turn, use, run));
  } catch (error) {
    if (!use.signal.aborted) use.failed();
    console.error(`[${new Date().toISOString()}] Agent stream error:`, error);
    end(STREAM_FAILURE);
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
 * missing, say) rejects, and the request listener answers it.
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
    const failure = settleRun(turn, use, out);
    if (use.signal.aborted) return undefined;
    if (failure) return { ok: false, failure };
    const text = out.stdout.trim();
    logTrafficResponse(config.verbose, turn.logModel, text, false);
    return { ok: true, text };
  } catch (error) {
    if (!use.signal.aborted) use.failed();
    throw error;
  } finally {
    use.end();
  }
}
