import { describe, expect, it } from "vitest";

import {
  hitPlanLimit,
  isPlanLimitReply,
  mentionsPlanLimit,
  PlanLimitHoldback,
} from "./plan-limit.js";

describe("isPlanLimitReply", () => {
  it.each([
    "Upgrade your plan to continue",
    "Upgrade your plan to continue.",
    "Upgrade your plan to continue!",
    "  upgrade YOUR plan\nto   continue \n",
    "Add a payment method to continue",
    "add a PAYMENT method  to continue.\n",
  ])("matches the whole reply %j", (text) => {
    expect(isPlanLimitReply(text)).toBe(true);
  });

  it.each([
    "",
    "Upgrade your plan",
    "Please upgrade your plan to continue",
    "Upgrade your plan to continue using premium models.",
    "Upgrade your plan to continue. Meanwhile, here is the answer: 42",
    'Your paywall should say "Upgrade your plan to continue".',
    "Upgrade your plan to continue?",
    "Upgrade your plan to continue...!?",
    "Add a payment method",
    "Add a payment method to continue checkout in your Stripe form.",
    "To fix the checkout, add a payment method to continue.",
  ])("leaves the answer %j alone", (text) => {
    expect(isPlanLimitReply(text)).toBe(false);
  });
});

describe("mentionsPlanLimit", () => {
  it("finds the reply anywhere in diagnostics", () => {
    expect(mentionsPlanLimit("Internal error: Upgrade your plan to continue")).toBe(true);
    expect(mentionsPlanLimit("error: UPGRADE YOUR PLAN\nTO CONTINUE")).toBe(true);
    expect(mentionsPlanLimit("Internal error: Add a payment method to continue")).toBe(true);
  });

  it("ignores other diagnostics", () => {
    expect(mentionsPlanLimit(undefined)).toBe(false);
    expect(mentionsPlanLimit("rate limit exceeded")).toBe(false);
    expect(mentionsPlanLimit("upgrade your plan")).toBe(false);
  });

  const PREPAID =
    "ActionRequiredError: Your team's prepaid balance is used up Buy credits for your team to keep going.";

  it.each([
    PREPAID,
    `[cli] starting\n${PREPAID}\n    at run (agent.js:1:1)`,
    // The same text as an ACP JSON-RPC error (formatAcpRpcError's "message: data").
    `Internal error: ${PREPAID}`,
    "Your team's PREPAID balance\nis used up",
    "Buy credits for your team to keep going.",
    "ActionRequiredError: Billing details are missing for this team",
    "ActionRequiredError: Add a credit card to your plan",
    "ActionRequiredError: Not enough credits left",
  ])("finds the out-of-plan error in %j", (diagnostics) => {
    expect(mentionsPlanLimit(diagnostics)).toBe(true);
  });

  it.each([
    "ActionRequiredError: Please log in to continue (run `agent login`)",
    "ActionRequiredError: Accept the new terms of service",
    "ActionRequiredError: Approve the plan before the agent continues",
    // The keywords outside the ActionRequiredError line do not count.
    "ActionRequiredError: Please log in\nYour plan: Pro",
    "Error: credits endpoint unreachable",
    "balance used up",
  ])("leaves %j alone", (diagnostics) => {
    expect(mentionsPlanLimit(diagnostics)).toBe(false);
  });
});

describe("hitPlanLimit", () => {
  const diagnostics = ["Error: Upgrade your plan to continue"];

  it("is the whole answer, whatever the exit", () => {
    for (const failed of [false, true]) {
      expect(
        hitPlanLimit({ text: "Upgrade your plan to continue", failed, diagnostics: [] }),
      ).toBe(true);
    }
  });

  it("trusts diagnostics only when the run failed or answered nothing", () => {
    expect(hitPlanLimit({ text: "", failed: true, diagnostics })).toBe(true);
    expect(hitPlanLimit({ text: "Partial", failed: true, diagnostics })).toBe(true);
    expect(hitPlanLimit({ text: "  ", failed: false, diagnostics })).toBe(true);
    expect(hitPlanLimit({ text: "A real answer", failed: false, diagnostics })).toBe(false);
  });

  it("is false for a failure without the reply", () => {
    expect(
      hitPlanLimit({ text: "", failed: true, diagnostics: ["exit 1", undefined] }),
    ).toBe(false);
  });
});

/** Pushes chunks and returns what was shown, chunk by chunk. */
function stream(holdback: PlanLimitHoldback, chunks: string[]): string[] {
  return chunks.map((chunk) => holdback.push(chunk));
}

describe("PlanLimitHoldback", () => {
  it.each(["Upgrade your plan to continue.", "Add a payment method to continue"])(
    "shows nothing of %j, however it is split",
    (reply) => {
      const holdback = new PlanLimitHoldback();
      expect(stream(holdback, [...reply]).join("")).toBe("");
      expect(holdback.heldReply).toBe(true);
    },
  );

  it("holds a reply split across chunks and releases a near-miss", () => {
    const reply = new PlanLimitHoldback();
    expect(stream(reply, ["Add a pay", "ment method ", "to continue"])).toEqual(["", "", ""]);
    expect(reply.heldReply).toBe(true);

    const nearMiss = new PlanLimitHoldback();
    expect(stream(nearMiss, ["Add a pay", "ment method ", "in Settings"])).toEqual([
      "",
      "",
      "Add a payment method in Settings",
    ]);
    expect(nearMiss.heldReply).toBe(false);
  });

  it("releases the held text as soon as the answer rules the reply out", () => {
    const holdback = new PlanLimitHoldback();
    expect(stream(holdback, ["Upgrade ", "your plan ", "to continue ", "using GPT-5"])).toEqual([
      "",
      "",
      "",
      "Upgrade your plan to continue using GPT-5",
    ]);
    expect(holdback.push(" today.")).toBe(" today.");
    expect(holdback.heldReply).toBe(false);
  });

  it("passes an unrelated answer through from its first chunk", () => {
    const holdback = new PlanLimitHoldback();
    expect(stream(holdback, ["Hello", " world"])).toEqual(["Hello", " world"]);
    expect(holdback.release()).toBe("");
  });

  it("holds leading whitespace and a bare prefix until released", () => {
    const holdback = new PlanLimitHoldback();
    expect(stream(holdback, ["\n ", "Upgrade", " your plan"])).toEqual(["", "", ""]);
    expect(holdback.heldReply).toBe(false);
    expect(holdback.release()).toBe("\n Upgrade your plan");
    expect(holdback.push(" now")).toBe(" now");
  });
});
