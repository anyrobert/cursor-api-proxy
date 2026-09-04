import { describe, expect, it } from "vitest";
import { BRIDGE_AGENT_PROMPT_SEPARATOR } from "./bridge-context-preamble.js";
import type { AgentCommand } from "./env.js";
import {
  estimateCmdlineLength,
  fitPromptToWinCmdline,
  WIN_PROMPT_OMISSION_PREFIX,
} from "./win-cmdline-limit.js";

describe("estimateCmdlineLength", () => {
  it("counts argv with pessimistic quoting budget", () => {
    const resolved: AgentCommand = {
      command: "node",
      args: ["script.js", "a"],
      env: {},
    };
    const len = estimateCmdlineLength(resolved);
    expect(len).toBeGreaterThan(
      "node".length + "script.js".length + "a".length + 10,
    );
  });

  it("uses smaller growth for windowsVerbatimArguments", () => {
    const base = {
      command: "cmd.exe",
      args: ["/c", "echo", "hi"],
      env: {},
    };
    const quoted = estimateCmdlineLength(base);
    const verbatim = estimateCmdlineLength({
      ...base,
      windowsVerbatimArguments: true,
    });
    expect(verbatim).toBeLessThan(quoted);
  });
});

describe("fitPromptToWinCmdline", () => {
  const fixedArgs = [
    "--print",
    "--mode",
    "ask",
    "--workspace",
    "/tmp/ws",
    "--model",
    "default",
    "--output-format",
    "text",
  ];

  it("leaves prompt unchanged on non-Windows", () => {
    const prompt = "x".repeat(100_000);
    const fit = fitPromptToWinCmdline("agent", fixedArgs, prompt, {
      maxCmdline: 100,
      platform: "darwin",
    });
    expect(fit.ok).toBe(true);
    if (!fit.ok) throw new Error("expected ok");
    expect(fit.truncated).toBe(false);
    expect(fit.args[fit.args.length - 1]).toBe(prompt);
  });

  it("truncates tail on Windows when prompt exceeds budget", () => {
    const prompt = "y".repeat(80_000);
    const fit = fitPromptToWinCmdline("agent", fixedArgs, prompt, {
      maxCmdline: 8000,
      platform: "win32",
      cwd: "/tmp/ws",
      env: {},
    });
    expect(fit.ok).toBe(true);
    if (!fit.ok) throw new Error("expected ok");
    expect(fit.truncated).toBe(true);
    const last = fit.args.at(-1);
    if (last === undefined) throw new Error("expected prompt argument");
    expect(last.length).toBeLessThan(prompt.length);
    expect(last.startsWith(WIN_PROMPT_OMISSION_PREFIX)).toBe(true);
    expect(last.endsWith("y")).toBe(true);
  });

  it("on Windows, keeps bridge preamble when using bridge separator", () => {
    const preamble = "[cursor-api-proxy]\nstub";
    const body = "z".repeat(80_000);
    const prompt = `${preamble}${BRIDGE_AGENT_PROMPT_SEPARATOR}${body}`;
    const fit = fitPromptToWinCmdline("agent", fixedArgs, prompt, {
      maxCmdline: 12_000,
      platform: "win32",
      cwd: "/tmp/ws",
      env: {},
    });
    expect(fit.ok).toBe(true);
    if (!fit.ok) throw new Error("expected ok");
    expect(fit.truncated).toBe(true);
    const last = fit.args.at(-1);
    if (last === undefined) throw new Error("expected prompt argument");
    expect(last.startsWith(preamble + BRIDGE_AGENT_PROMPT_SEPARATOR)).toBe(
      true,
    );
    expect(last).toContain(WIN_PROMPT_OMISSION_PREFIX);
    expect(last.endsWith("z")).toBe(true);
  });

  it("does not truncate when prompt fits", () => {
    const prompt = "short";
    const fit = fitPromptToWinCmdline("agent", fixedArgs, prompt, {
      maxCmdline: 50_000,
      platform: "win32",
      cwd: "/tmp/ws",
      env: {},
    });
    expect(fit.ok).toBe(true);
    if (!fit.ok) throw new Error("expected ok");
    expect(fit.truncated).toBe(false);
    expect(fit.args[fit.args.length - 1]).toBe(prompt);
  });
});
