import { describe, expect, it } from "vitest";
import type { BridgeConfig } from "./config.js";
import { rememberResolvedModel, resolveModel } from "./resolve-model.js";

function config(overrides: Partial<BridgeConfig> = {}): BridgeConfig {
  return {
    agentBin: "agent",
    acpCommand: "agent",
    acpArgs: ["acp"],
    acpEnv: {},
    host: "127.0.0.1",
    port: 8765,
    defaultModel: "auto",
    mode: "ask",
    force: false,
    approveMcps: false,
    strictModel: true,
    workspace: process.cwd(),
    timeoutMs: 30_000,
    sessionsLogPath: "/tmp/test.log",
    chatOnlyWorkspace: true,
    chatOnlyWorkspaceExplicit: false,
    verbose: false,
    maxMode: false,
    promptViaStdin: false,
    useAcp: false,
    acpSkipAuthenticate: false,
    acpRawDebug: false,
    configDirs: [],
    multiPort: false,
    winCmdlineMax: 30_000,
    contextPreamble: true,
    bridgePackageVersion: "0.0.0-test",
    ...overrides,
  };
}

describe("resolveModel memory behavior", () => {
  it("does not persist explicit model before validation", () => {
    const ref: { current?: string } = {};
    const resolved = resolveModel("claude-sonnet-4-5-20250929", ref, config());
    expect(resolved).toBe("claude-sonnet-4-5-20250929");
    expect(ref.current).toBeUndefined();
  });

  it("stores only final validated model", () => {
    const ref: { current?: string } = {};
    rememberResolvedModel("sonnet-4.5", ref);
    expect(ref.current).toBe("sonnet-4.5");
  });

  it("does not store default sentinel", () => {
    const ref: { current?: string } = {};
    rememberResolvedModel("default", ref);
    expect(ref.current).toBeUndefined();
  });
});
