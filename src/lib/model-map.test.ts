import { describe, expect, it } from "vitest";

import {
  resolveModelForExecution,
  resolveToCursorModel,
  UnsupportedReasoningEffortError,
} from "./model-map.js";

describe("resolveToCursorModel", () => {
  it("maps dated sonnet id to cursor sonnet-4.5", () => {
    expect(resolveToCursorModel("claude-sonnet-4-5-20250929")).toBe("sonnet-4.5");
  });

  it("maps dated opus id with v-suffix", () => {
    expect(resolveToCursorModel("claude-opus-4-6-20260101-v1")).toBe("opus-4.6");
  });

  it("maps dated haiku id to sonnet fallback", () => {
    expect(resolveToCursorModel("claude-haiku-4-5-20251001")).toBe("sonnet-4.5");
  });
});

describe("resolveModelForExecution", () => {
  it("uses mapped model when available", () => {
    const decision = resolveModelForExecution({
      requested: "claude-sonnet-4-5-20250929",
      defaultModel: "auto",
      availableCursorIds: ["auto", "sonnet-4.5"],
    });
    expect(decision.final).toBe("sonnet-4.5");
    expect(decision.fallbackUsed).toBe(false);
    expect(decision.validated).toBe(true);
  });

  it("falls back to default model when mapped model is unavailable", () => {
    const decision = resolveModelForExecution({
      requested: "claude-sonnet-4-5-20250929",
      defaultModel: "auto",
      availableCursorIds: ["auto", "gpt-5.2"],
    });
    expect(decision.final).toBe("auto");
    expect(decision.fallbackUsed).toBe(true);
    expect(decision.fallbackReason).toBe("mapped_model_unavailable");
  });

  it("prefers explicit default request", () => {
    const decision = resolveModelForExecution({
      requested: "default",
      defaultModel: "auto",
      availableCursorIds: ["auto"],
    });
    expect(decision.final).toBe("default");
    expect(decision.requestedWasDefault).toBe(true);
  });

  it("maps a logical model and reasoning effort to a Cursor variant", () => {
    const decision = resolveModelForExecution({
      requested: "gpt-5.6-sol",
      reasoningEffort: "high",
      defaultModel: "auto",
      availableCursorIds: ["auto", "gpt-5.6-sol-low", "gpt-5.6-sol-high"],
    });
    expect(decision.final).toBe("gpt-5.6-sol-high");
    expect(decision.reasoningEffort).toBe("high");
    expect(decision.fallbackUsed).toBe(false);
  });

  it("replaces an explicit effort while preserving the fast variant", () => {
    const decision = resolveModelForExecution({
      requested: "gpt-5.6-sol-high-fast",
      reasoningEffort: "low",
      defaultModel: "auto",
      availableCursorIds: [
        "auto",
        "gpt-5.6-sol-high-fast",
        "gpt-5.6-sol-low-fast",
      ],
    });
    expect(decision.final).toBe("gpt-5.6-sol-low-fast");
  });

  it("maps off to Cursor's none suffix", () => {
    const decision = resolveModelForExecution({
      requested: "gpt-5.6-sol",
      reasoningEffort: "off",
      defaultModel: "auto",
      availableCursorIds: ["auto", "gpt-5.6-sol-none"],
    });
    expect(decision.final).toBe("gpt-5.6-sol-none");
    expect(decision.reasoningEffort).toBe("none");
  });

  it("accepts extra-high when the catalog spells it xhigh", () => {
    const decision = resolveModelForExecution({
      requested: "gpt-5.6-sol",
      reasoningEffort: "extra-high",
      defaultModel: "auto",
      availableCursorIds: ["auto", "gpt-5.6-sol-xhigh"],
    });
    expect(decision.final).toBe("gpt-5.6-sol-xhigh");
  });

  it("rejects a reasoning effort unavailable for the requested family", () => {
    expect(() =>
      resolveModelForExecution({
        requested: "composer-2.5",
        reasoningEffort: "high",
        defaultModel: "auto",
        availableCursorIds: ["auto", "composer-2.5"],
      }),
    ).toThrow(UnsupportedReasoningEffortError);
  });

  it("rejects an unknown reasoning effort", () => {
    expect(() =>
      resolveModelForExecution({
        requested: "gpt-5.6-sol",
        reasoningEffort: "ultra",
        defaultModel: "auto",
        availableCursorIds: ["auto", "gpt-5.6-sol-high"],
      }),
    ).toThrow(/ultra/);
  });
});
