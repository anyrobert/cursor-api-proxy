import { debuglog } from "node:util";

const debugAcp = debuglog("cursor-api-proxy:acp");

/**
 * The Cursor CLI's ACP server reports a turn that failed after it started
 * answering as one more agent_message_chunk, `\n\nError: ${String(error)}`,
 * and then still answers session/prompt with stopReason "end_turn"
 * (CursorAcpAgent.handlePrompt, CLI 2026.10.19). On image prompts its
 * internal stream is often already closed when the answer is done, so a
 * correct answer ends in this text (#76). It is not part of the answer.
 */
export const RETRIABLE_TRAILER =
  "Error: RetriableError: WritableIterable is closed";

const TRAILER_ONLY = /^\s*Error: RetriableError: WritableIterable is closed\s*$/;

function whitespaceRunStart(text: string, end: number): number {
  let start = end;
  while (start > 0 && /\s/.test(text[start - 1]!)) start -= 1;
  return start;
}

/**
 * Index where the part of `text` that could still become the trailer
 * begins: its trailing whitespace, or the trailer (whole or begun) with the
 * whitespace before it. The trailer only counts after whitespace or as the
 * first text of the turn, so "TypeError: Retri…" never matches.
 */
function trailerCandidateStart(text: string, turnStart: boolean): number {
  const startWithWhitespace = (trailerStart: number): number | undefined => {
    const start = whitespaceRunStart(text, trailerStart);
    return start < trailerStart || (start === 0 && turnStart) ? start : undefined;
  };
  const trimmed = text.trimEnd();
  if (trimmed.endsWith(RETRIABLE_TRAILER)) {
    const start = startWithWhitespace(trimmed.length - RETRIABLE_TRAILER.length);
    if (start !== undefined) return start;
  }
  const longest = Math.min(RETRIABLE_TRAILER.length - 1, text.length);
  for (let length = longest; length > 0; length -= 1) {
    if (!text.endsWith(RETRIABLE_TRAILER.slice(0, length))) continue;
    const start = startWithWhitespace(text.length - length);
    if (start !== undefined) return start;
  }
  return whitespaceRunStart(text, text.length);
}

/**
 * Removes RETRIABLE_TRAILER from the end of a turn's agent text as the text
 * streams. Text that could be the start of the trailer is held back until
 * later text shows it is not, the turn moves on to a tool call, or the turn
 * ends; only a whole trailer at the very end of the turn is dropped.
 */
export class AcpTrailerFilter {
  readonly #emit: (text: string) => void;
  #held = "";
  #emitted = false;

  constructor(emit: (text: string) => void) {
    this.#emit = emit;
  }

  /** Agent text, in arrival order. */
  push(text: string): void {
    const buffer = this.#held + text;
    const start = trailerCandidateStart(buffer, !this.#emitted);
    this.#held = buffer.slice(start);
    this.#send(buffer.slice(0, start));
  }

  /** The turn continues past this text (a tool call): emit what is held. */
  flush(): void {
    const held = this.#held;
    this.#held = "";
    this.#send(held);
  }

  /** The turn is over: drop a whole trailer, emit anything else held. */
  end(): void {
    const held = this.#held;
    this.#held = "";
    if (TRAILER_ONLY.test(held)) {
      debugAcp("ACP: removed the CLI's %j trailer at the end of the turn", RETRIABLE_TRAILER);
    } else {
      this.#send(held);
    }
    this.#emitted = false;
  }

  #send(text: string): void {
    if (!text) return;
    this.#emitted = true;
    this.#emit(text);
  }
}
