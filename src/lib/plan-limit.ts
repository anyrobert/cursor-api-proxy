/**
 * Cursor's plan-limit replies (#65). Once an account may no longer use a
 * model (its plan is used up, or it needs a payment method), the agent does
 * not fail: it "answers" with one of these and exits 0. They were seen for
 * claude and gpt model ids while grok and composer still answered, so the
 * limit is per model, not per account.
 */
export const PLAN_LIMIT_REPLIES = [
  "Upgrade your plan to continue",
  "Add a payment method to continue",
] as const;

export const PLAN_LIMIT_CODE = "cursor_plan_limit";

export const PLAN_LIMIT_MESSAGE =
  "The Cursor account hit its plan limit for this model: Cursor answered with a plan or billing notice instead of a reply. " +
  "Retry later or with another model or account, or check the account's Cursor plan and payment method.";

/**
 * How long the account pool rests an account that hit the plan limit. A
 * plan limit does not lift within the minute a rate limit rests, so a
 * minute would spend one failed request per minute on the account; 15
 * minutes keeps it out of rotation while others serve, yet lets it back
 * soon for the models it still serves. When every account is resting the
 * pool still picks the one that recovers first, so nothing is blocked.
 */
export const PLAN_LIMIT_PENALTY_MS = 15 * 60_000;

const PHRASES = PLAN_LIMIT_REPLIES.map((reply) => reply.toLowerCase());

function normalize(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * Whether an answer is one plan-limit reply and nothing else (case, spacing
 * and closing punctuation aside). Strict on purpose: an answer that merely
 * mentions upgrading a plan is still an answer.
 */
export function isPlanLimitReply(text: string): boolean {
  const answer = normalize(text);
  return PHRASES.some(
    (phrase) =>
      answer.startsWith(phrase) && /^[.!]*$/.test(answer.slice(phrase.length)),
  );
}

/**
 * What the CLI prints instead (exit 1) when the account is out of plan:
 * "ActionRequiredError: Your team's prepaid balance is used up Buy credits
 * for your team to keep going."
 */
const OUT_OF_PLAN_ERRORS = [
  "prepaid balance is used up",
  "buy credits for your team",
];

/**
 * An ActionRequiredError line about money. Other user actions (log in,
 * approve a plan in plan mode, say) raise the same error class, so the line
 * must say which; "plan" alone is too broad for that.
 */
const ACTION_REQUIRED_PLAN =
  /ActionRequiredError:.*\b(balance|credits?|payment|billing)\b/i;

/**
 * Whether diagnostics (CLI stderr, an ACP error) carry a plan-limit reply
 * or an out-of-plan error anywhere.
 */
export function mentionsPlanLimit(diagnostics: string | undefined): boolean {
  if (!diagnostics) return false;
  const text = normalize(diagnostics);
  return (
    PHRASES.some((phrase) => text.includes(phrase)) ||
    OUT_OF_PLAN_ERRORS.some((error) => text.includes(error)) ||
    diagnostics.split(/\r?\n/).some((line) => ACTION_REQUIRED_PLAN.test(line))
  );
}

/**
 * Whether a finished run hit the plan limit: its whole answer is a reply,
 * or the run failed or answered nothing and its diagnostics carry one.
 */
export function hitPlanLimit(run: {
  text: string;
  failed: boolean;
  diagnostics: ReadonlyArray<string | undefined>;
}): boolean {
  if (isPlanLimitReply(run.text)) return true;
  if (!run.failed && run.text.trim()) return false;
  return run.diagnostics.some(mentionsPlanLimit);
}

/** Thrown by a tool turn whose agent hit the plan limit. */
export class PlanLimitError extends Error {
  constructor() {
    super(PLAN_LIMIT_MESSAGE);
    this.name = "PlanLimitError";
  }
}

/**
 * Holds streamed text back while the answer so far could still become a
 * plan-limit reply, so no reply reaches a client as content. The first
 * text that rules them all out releases everything held, and from then on
 * text passes straight through: a compare per reply of a string no longer
 * than the replies per chunk until then, nothing after.
 */
export class PlanLimitHoldback {
  #held = "";
  #released = false;

  /** The text to show now: "" while holding. */
  push(delta: string): string {
    if (this.#released) return delta;
    this.#held += delta;
    return this.#couldBeReply() ? "" : this.release();
  }

  /** Lets go of the held text, which was not the reply after all. */
  release(): string {
    this.#released = true;
    const held = this.#held;
    this.#held = "";
    return held;
  }

  /** Whether everything pushed so far, none of it shown, is a reply. */
  get heldReply(): boolean {
    return !this.#released && isPlanLimitReply(this.#held);
  }

  #couldBeReply(): boolean {
    const sofar = this.#held.replace(/\s+/g, " ").trimStart().toLowerCase();
    return (
      PHRASES.some((phrase) => phrase.startsWith(sofar)) ||
      isPlanLimitReply(sofar)
    );
  }
}
