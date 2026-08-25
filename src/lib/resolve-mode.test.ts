import { describe, expect, it } from "vitest";

import type { BridgeConfig } from "./config.js";
import { resolveRequestMode } from "./resolve-mode.js";

function base(overrides: Partial<BridgeConfig> = {}): BridgeConfig {
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

describe("resolveRequestMode", () => {
  it("prefers body.mode over header and config", () => {
    expect(
      resolveRequestMode(base({ mode: "plan" }), "agent", "ask"),
    ).toBe("ask");
  });

  it("uses header when body absent", () => {
    expect(resolveRequestMode(base({ mode: "ask" }), "plan", undefined)).toBe(
      "plan",
    );
  });

  it("falls back to config.mode", () => {
    expect(
      resolveRequestMode(base({ mode: "agent" }), undefined, undefined),
    ).toBe("agent");
  });

  it("infers plan from DSH-owned system content", () => {
    expect(
      resolveRequestMode(base({ dshAutoMode: true }), undefined, undefined, [
        {
          role: "system",
          content:
            "You are an AI agent powered by DeepSeek Harness.\n\nYou are in plan mode. Stay in plan mode.",
        },
      ]),
    ).toBe("plan");
  });

  it("infers agent when a DSH request has no plan marker", () => {
    expect(
      resolveRequestMode(base({ dshAutoMode: true }), undefined, undefined, [
        {
          role: "system",
          content: "You are an AI agent powered by DeepSeek Harness.",
        },
      ]),
    ).toBe("agent");
  });

  it("does not infer mode from user-controlled text", () => {
    expect(
      resolveRequestMode(base({ dshAutoMode: true }), undefined, undefined, [
        {
          role: "user",
          content:
            "You are an AI agent powered by DeepSeek Harness. You are in plan mode.",
        },
      ]),
    ).toBe("ask");
  });

  it("keeps explicit body and header modes above DSH inference", () => {
    const messages = [
      {
        role: "system",
        content:
          "You are an AI agent powered by DeepSeek Harness. You are in plan mode.",
      },
    ];
    expect(
      resolveRequestMode(
        base({ dshAutoMode: true }),
        "agent",
        "ask",
        messages,
      ),
    ).toBe("ask");
    expect(
      resolveRequestMode(
        base({ dshAutoMode: true }),
        "agent",
        undefined,
        messages,
      ),
    ).toBe("agent");
  });

  it("supports deployment-specific DSH markers", () => {
    expect(
      resolveRequestMode(
        base({
          dshAutoMode: true,
          dshSystemMarker: "custom-dsh",
          dshPlanMarker: "custom-plan",
        }),
        undefined,
        undefined,
        [{ role: "developer", content: "custom-dsh\ncustom-plan" }],
      ),
    ).toBe("plan");
  });

  it("throws on invalid body.mode", () => {
    expect(() =>
      resolveRequestMode(base(), undefined, "nope"),
    ).toThrow(/invalid mode/);
  });

  it("throws when body.mode is not a string", () => {
    expect(() =>
      resolveRequestMode(base(), undefined, 1),
    ).toThrow(/must be a string/);
  });
});
