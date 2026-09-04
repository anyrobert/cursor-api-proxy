import { describe, expect, it } from "vitest";

import { buildAgentFixedArgs } from "./agent-cmd-args.js";
import type { BridgeConfig } from "./config.js";

function cfg(overrides: Partial<BridgeConfig> = {}): BridgeConfig {
  return {
    agentBin: "agent",
    acpCommand: "agent",
    acpArgs: ["acp"],
    acpEnv: {},
    host: "127.0.0.1",
    port: 8765,
    defaultModel: "default",
    mode: "ask",
    force: false,
    approveMcps: false,
    strictModel: true,
    workspace: "/w",
    timeoutMs: 30_000,
    sessionsLogPath: "/tmp/s.log",
    chatOnlyWorkspace: true,
    chatOnlyWorkspaceExplicit: false,
    verbose: false,
    maxMode: false,
    promptViaStdin: false,
    useAcp: false,
    acpSkipAuthenticate: true,
    acpRawDebug: false,
    configDirs: [],
    multiPort: false,
    winCmdlineMax: 30_000,
    contextPreamble: true,
    bridgePackageVersion: "0.0.0-test",
    ...overrides,
  };
}

describe("buildAgentFixedArgs", () => {
  it("omits --mode when mode is agent (cursor-agent default)", () => {
    const args = buildAgentFixedArgs(
      cfg(),
      "/ws",
      "gpt-5",
      false,
      "agent",
      true,
    );
    // cursor-agent rejects `--mode agent`; agent is its default behavior.
    expect(args).not.toContain("--mode");
    expect(args).toContain("--trust");
  });

  it("passes --mode ask when mode is ask", () => {
    const args = buildAgentFixedArgs(cfg(), "/ws", "gpt-5", false, "ask", true);
    expect(args).toContain("--mode");
    expect(args[args.indexOf("--mode") + 1]).toBe("ask");
  });

  it("passes --mode plan when mode is plan", () => {
    const args = buildAgentFixedArgs(
      cfg(),
      "/ws",
      "gpt-5",
      false,
      "plan",
      true,
    );
    expect(args).toContain("--mode");
    expect(args[args.indexOf("--mode") + 1]).toBe("plan");
  });

  it("omits --trust when not effectiveChatOnly", () => {
    const args = buildAgentFixedArgs(
      cfg({ chatOnlyWorkspace: true }),
      "/ws",
      "gpt-5",
      false,
      "ask",
      false,
    );
    expect(args).not.toContain("--trust");
  });
});
