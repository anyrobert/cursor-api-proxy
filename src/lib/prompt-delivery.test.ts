import { describe, expect, it } from "vitest";

import { POSIX_MAX_ARG_BYTES, sendsPromptOnStdin } from "./prompt-delivery.js";

const argv = { promptViaStdin: false, useAcp: false };

describe("sendsPromptOnStdin", () => {
  it("keeps a short prompt in argv", () => {
    expect(sendsPromptOnStdin(argv, "hi", "linux")).toBe(false);
  });

  it("keeps the longest prompt one argv string holds in argv", () => {
    const prompt = "x".repeat(POSIX_MAX_ARG_BYTES - 1);
    expect(sendsPromptOnStdin(argv, prompt, "linux")).toBe(false);
  });

  it.each(["linux", "darwin"] as const)(
    "sends a prompt too long for one argv string on stdin on %s",
    (platform) => {
      const prompt = "x".repeat(POSIX_MAX_ARG_BYTES);
      expect(sendsPromptOnStdin(argv, prompt, platform)).toBe(true);
    },
  );

  it("measures the prompt in UTF-8 bytes, not characters", () => {
    const prompt = "é".repeat(POSIX_MAX_ARG_BYTES / 2);
    expect(prompt.length).toBeLessThan(POSIX_MAX_ARG_BYTES);
    expect(sendsPromptOnStdin(argv, prompt, "linux")).toBe(true);
  });

  it("leaves a long prompt to the Windows truncation", () => {
    const prompt = "x".repeat(POSIX_MAX_ARG_BYTES * 2);
    expect(sendsPromptOnStdin(argv, prompt, "win32")).toBe(false);
  });

  it.each([
    { promptViaStdin: true, useAcp: false },
    { promptViaStdin: false, useAcp: true },
  ])("sends even a short prompt on stdin with %o", (config) => {
    expect(sendsPromptOnStdin(config, "hi", "win32")).toBe(true);
  });
});
