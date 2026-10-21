/**
 * One-shot ACP turns for Cursor CLI: one `agent acp` child per prompt, run
 * on AcpConnection (shared with the tool path) and reported the way the CLI
 * path reports a run: exit code, server-side stderr and, when the proxy
 * knows why the turn failed, a client-safe reason.
 * See https://cursor.com/docs/cli/acp and https://agentclientprotocol.com/
 */

import { debuglog } from "node:util";

import {
  AcpChildExitError,
  AcpConnection,
  appendAcpFailure,
} from "./acp-connection.js";
import { acpFailureText, type AcpModelOptions } from "./acp-model.js";
import type { AcpPromptBlock } from "./media-input.js";

const debugAcp = debuglog("cursor-api-proxy:acp");

export type AcpRunOptions = AcpModelOptions & {
  /** Optional validated media blocks appended to the text prompt. */
  mediaBlocks?: AcpPromptBlock[];
  cwd: string;
  timeoutMs: number;
  env?: Record<string, string | undefined>;
  /** Per-request timeout in ms (default 60000). Rejects and clears pending on timeout. */
  requestTimeoutMs?: number;
  /** Spawn options (e.g. windowsVerbatimArguments for cmd.exe fallback on Windows). */
  spawnOptions?: { windowsVerbatimArguments?: boolean };
  /** When true, skip authenticate step (use when pre-authenticated via --api-key or agent login). */
  skipAuthenticate?: boolean;
  /** When true, log every raw JSON-RPC line from ACP stdout (very verbose). */
  rawDebug?: boolean;
  /** When aborted, the ACP child is killed (same as CLI path). */
  signal?: AbortSignal;
};

export type AcpStreamResult = {
  code: number;
  /** Raw CLI stderr plus proxy diagnostics; for server logs only. */
  stderr: string;
  /**
   * Why the proxy aborted the turn (model selection, an ACP JSON-RPC error,
   * a request timeout). Never raw CLI output, so callers may show it to
   * clients the way the tool path already does.
   */
  error?: string;
};

export type AcpSyncResult = AcpStreamResult & {
  /** Assistant message text only (never includes agent_thought_chunk). */
  stdout: string;
  /**
   * Concatenated agent_thought_chunk text for this turn.
   * Present when any thought arrived; callers decide drop vs reasoning_content.
   */
  reasoning?: string;
};

/** Reported when the whole turn outlives `timeoutMs`, as timeout(1) does. */
const TIMEOUT_EXIT_CODE = 124;

/**
 * The cursor/* answers this path has always sent. They predate the shapes
 * documented at cursor.com/docs/cli/acp, which AcpConnection sends by
 * default (first option `answered`, plan `accepted`); kept so that sharing
 * AcpConnection does not change what plain ask/plan turns do.
 */
function plainExtensionResponse(
  method: string,
  params: Record<string, unknown>,
): Record<string, unknown> {
  if (method === "cursor/ask_question" && Array.isArray(params.options)) {
    const options = params.options as Array<{ id?: string; label?: string }>;
    const first = options[0];
    console.warn(
      "[cursor-api-proxy:acp] cursor/ask_question auto-selecting first option: id=%s (total=%d)",
      first?.id ?? "(none)",
      options.length,
    );
    return { selectedId: first?.id ?? "" };
  }
  if (method === "cursor/create_plan") return { approved: true };
  console.warn(
    "[cursor-api-proxy:acp] auto-responding to unknown %s with empty result",
    method,
  );
  return {};
}

type TurnOutput = {
  onText: (text: string) => void;
  /** Thought chunks; omitted when the caller drops them. */
  onThought?: (text: string) => void;
};

/**
 * Spawn, set up the session, send one prompt and settle once: on the prompt
 * reply, a failed step, the child's exit, `timeoutMs`, or a spawn error
 * (which rejects, as before). Abort kills the child with SIGTERM and lets
 * its exit settle the turn.
 */
function runAcpTurn(
  command: string,
  args: string[],
  prompt: string,
  opts: AcpRunOptions,
  output: TurnOutput,
): Promise<AcpStreamResult> {
  return new Promise((resolve, reject) => {
    const connection = new AcpConnection(command, args, {
      cwd: opts.cwd,
      env: opts.env,
      spawnOptions: opts.spawnOptions,
      requestTimeoutMs: opts.requestTimeoutMs,
      rawDebug: opts.rawDebug,
      onAgentTextChunk: output.onText,
      onAgentThoughtChunk: output.onThought,
      onExtensionRequest: plainExtensionResponse,
      // The diagnostics go back in `stderr`, which callers log (logAgentError).
      logUnexpectedExit: false,
    });

    let settled = false;
    const onAbort = () => connection.kill("SIGTERM");
    const timer =
      opts.timeoutMs > 0
        ? setTimeout(
            () => finish(TIMEOUT_EXIT_CODE, connection.stderr),
            opts.timeoutMs,
          )
        : undefined;

    function settle(): boolean {
      if (settled) return false;
      settled = true;
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      return true;
    }

    function finish(code: number, stderr: string, error?: string): void {
      if (!settle()) return;
      void connection.close();
      resolve({ code, stderr, ...(error ? { error } : {}) });
    }

    connection.child.once("error", (error) => {
      if (settle()) reject(error);
    });

    if (opts.signal) {
      if (opts.signal.aborted) onAbort();
      else opts.signal.addEventListener("abort", onAbort, { once: true });
    }

    connection
      .openSession(opts)
      .then((sessionId) =>
        connection.prompt(sessionId, prompt, undefined, opts.mediaBlocks),
      )
      .then(
        () => finish(0, connection.stderr),
        (error: unknown) => {
          if (error instanceof AcpChildExitError) {
            // Raw CLI output stays in server-side stderr, never in `error`.
            // A clean exit keeps the plain stderr, as it always has.
            finish(
              error.exitCode,
              error.exitCode !== 0 ? error.diagnostics : connection.stderr,
            );
            return;
          }
          finish(
            1,
            appendAcpFailure(connection.stderr, error),
            acpFailureText(error) || undefined,
          );
        },
      );
  });
}

/**
 * Run a single prompt via ACP and return the full response (sync).
 * Uses pre-resolved command + args (e.g. node + script on Windows) to avoid spawn EINVAL and DEP0190.
 */
export async function runAcpSync(
  command: string,
  args: string[],
  prompt: string,
  opts: AcpRunOptions,
): Promise<AcpSyncResult> {
  let text = "";
  let thought = "";
  const result = await runAcpTurn(command, args, prompt, opts, {
    onText: (chunk) => {
      text += chunk;
    },
    onThought: (chunk) => {
      thought += chunk;
    },
  });
  if (result.code === 0 && text.length === 0) {
    debugAcp("ACP sync: no content accumulated; stderr tail: %s", result.stderr.slice(-500));
  }
  const reasoning = thought.trim();
  return {
    ...result,
    stdout: text.trim(),
    ...(reasoning ? { reasoning } : {}),
  };
}

/**
 * Run a single prompt via ACP and stream response chunks via onChunk.
 */
export function runAcpStream(
  command: string,
  args: string[],
  prompt: string,
  opts: AcpRunOptions,
  onChunk: (text: string) => void,
): Promise<AcpStreamResult> {
  return runAcpTurn(command, args, prompt, opts, { onText: onChunk });
}
