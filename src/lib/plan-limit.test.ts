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
  ])("leaves the answer %j alone", (text) => {
    expect(isPlanLimitReply(text)).toBe(false);
  });
});

describe("mentionsPlanLimit", () => {
  it("finds the reply anywhere in diagnostics", () => {
    expect(mentionsPlanLimit("Internal error: Upgrade your plan to continue")).toBe(true);
    expect(mentionsPlanLimit("error: UPGRADE YOUR PLAN\nTO CONTINUE")).toBe(true);
  });

  it("ignores other diagnostics", () => {
    expect(mentionsPlanLimit(undefined)).toBe(false);
    expect(mentionsPlanLimit("rate limit exceeded")).toBe(false);
    expect(mentionsPlanLimit("upgrade your plan")).toBe(false);
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
  it("shows nothing of the reply, however it is split", () => {
    const reply = "Upgrade your plan to continue.";
    const holdback = new PlanLimitHoldback();
    expect(stream(holdback, [...reply]).join("")).toBe("");
    expect(holdback.heldReply).toBe(true);
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
