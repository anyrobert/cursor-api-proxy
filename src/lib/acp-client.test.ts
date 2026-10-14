import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  acpModelSelectionError,
  planAcpModelSelection,
} from "./acp-model.js";
import {
  extractAcpUpdateText,
  runAcpStream,
  runAcpSync,
} from "./acp-client.js";

const node = process.execPath;
const cwd = process.cwd();
const fakeServerPath = join(cwd, "src", "lib", "__tests__", "fake-acp-server.mjs");

const SET_CONFIG_PREFIX = "__FAKE_ACP_SET_CONFIG__:";

function parseSetConfigs(stderr: string): Array<Record<string, unknown>> {
  return stderr
    .split("\n")
    .filter((line) => line.startsWith(SET_CONFIG_PREFIX))
    .map((line) => JSON.parse(line.slice(SET_CONFIG_PREFIX.length)) as Record<string, unknown>);
}

function parseLastSetConfig(stderr: string): Record<string, unknown> | null {
  const configs = parseSetConfigs(stderr);
  return configs.length === 0 ? null : configs[configs.length - 1]!;
}

describe("extractAcpUpdateText", () => {
  it("reads string content.text", () => {
    expect(extractAcpUpdateText({ text: "hi" })).toBe("hi");
  });

  it("joins array content parts", () => {
    expect(
      extractAcpUpdateText([
        { text: "a" },
        { content: { text: "b" } },
      ]),
    ).toBe("ab");
  });
});

describe("planAcpModelSelection", () => {
  it("passes the requested id through when the catalog is missing", () => {
    expect(planAcpModelSelection("gpt-4", undefined)).toEqual({
      action: "passthrough",
      modelId: "gpt-4",
    });
  });

  it("passes the requested id through when the catalog is empty", () => {
    expect(planAcpModelSelection("gpt-4", [])).toEqual({
      action: "passthrough",
      modelId: "gpt-4",
    });
  });

  it("maps name to modelId when matched", () => {
    expect(
      planAcpModelSelection("gpt-4", [
        { modelId: "gpt-4[fast=false]", name: "gpt-4" },
      ]),
    ).toEqual({ action: "set", modelId: "gpt-4[fast=false]" });
  });

  it("reports a miss when the name is not in the catalog", () => {
    expect(
      planAcpModelSelection("unknown", [{ modelId: "x[]", name: "gpt-4" }])
        .action,
    ).toBe("missing");
  });

  it("uses first match when duplicate names", () => {
    expect(
      planAcpModelSelection("gpt-4", [
        { modelId: "first[]", name: "gpt-4" },
        { modelId: "second[]", name: "gpt-4" },
      ]),
    ).toEqual({ action: "set", modelId: "first[]" });
  });

  it("maps CLI ids through their catalog display-name alias", () => {
    expect(
      planAcpModelSelection(
        "gpt-5.6-sol-high",
        [
          {
            modelId: "gpt-5.6-sol[reasoning=high]",
            name: "GPT-5.6 Sol High",
          },
        ],
        ["GPT-5.6 Sol High"],
      ),
    ).toEqual({ action: "set", modelId: "gpt-5.6-sol[reasoning=high]" });
  });

  it("maps auto onto the catalog default row", () => {
    expect(
      planAcpModelSelection("auto", [
        { modelId: "default", name: "Auto" },
        { modelId: "glm-5.2", name: "GLM 5.2" },
      ]),
    ).toEqual({ action: "set", modelId: "default" });
  });

  it("plans parameterized effort, thinking, and fast variants", () => {
    const catalog = [
      { modelId: "default", name: "Auto" },
      { modelId: "glm-5.2", name: "GLM 5.2" },
      { modelId: "claude-opus-5", name: "Claude Opus 5" },
      { modelId: "gpt-5.6-sol", name: "GPT-5.6 Sol" },
      { modelId: "composer-2.5", name: "Composer 2.5" },
    ];
    expect(planAcpModelSelection("glm-5.2-max", catalog)).toEqual({
      action: "set",
      modelId: "glm-5.2",
      parameters: { effort: "max", thinking: false, fast: false },
    });
    expect(planAcpModelSelection("claude-opus-5-thinking-low", catalog)).toEqual({
      action: "set",
      modelId: "claude-opus-5",
      parameters: { effort: "low", thinking: true, fast: false },
    });
    expect(planAcpModelSelection("gpt-5.6-sol-low-fast", catalog)).toEqual({
      action: "set",
      modelId: "gpt-5.6-sol",
      parameters: { effort: "low", thinking: false, fast: true },
    });
    expect(planAcpModelSelection("composer-2.5", catalog)).toEqual({
      action: "set",
      modelId: "composer-2.5",
    });
    expect(planAcpModelSelection("auto", catalog)).toEqual({
      action: "set",
      modelId: "default",
    });
  });

  it("rejects a legacy bracket row that encodes a different variant", () => {
    expect(
      planAcpModelSelection("glm-5.2-max", [
        { modelId: "glm-5.2[reasoning=high]", name: "glm-5.2" },
      ]).action,
    ).toBe("missing");
  });

  it("resolves every public Grok reasoning and fast variant", () => {
    // Generated from suffix rules (prefix + family + effort + optional fast),
    // not a hard-coded map of each public id.
    const catalog = [
      { modelId: "default", name: "Auto" },
      { modelId: "grok-4.5", name: "Grok 4.5" },
      { modelId: "grok-4.6", name: "Grok 4.6" },
      { modelId: "grok-4.7", name: "Grok 4.7" },
    ];
    const families: Array<[prefix: string, base: string, efforts: string[]]> = [
      ["cursor-grok-", "grok-4.5", ["low", "medium", "high"]],
      ["cursor-grok-", "grok-4.6", ["low", "medium", "high", "xhigh"]],
      ["", "grok-4.7", ["low", "medium", "high", "xhigh"]],
    ];
    for (const [prefix, base, efforts] of families) {
      const publicBase = prefix ? `${prefix}${base.replace(/^grok-/, "")}` : base;
      for (const effort of efforts) {
        for (const fast of [false, true]) {
          const requested = `${publicBase}-${effort}${fast ? "-fast" : ""}`;
          expect(planAcpModelSelection(requested, catalog), requested).toEqual({
            action: "set",
            modelId: base,
            parameters: { effort, thinking: false, fast },
          });
        }
      }
    }
  });

  it("keeps applying options when the alias equals the base row name", () => {
    const catalog = [{ modelId: "grok-4.5", name: "Grok 4.5" }];
    expect(
      planAcpModelSelection("cursor-grok-4.5-high", catalog, ["Grok 4.5"]),
    ).toEqual({
      action: "set",
      modelId: "grok-4.5",
      parameters: { effort: "high", thinking: false, fast: false },
    });
  });

  it("prefers an exact catalog row over base plus options", () => {
    const catalog = [
      { modelId: "grok-4.6", name: "Grok 4.6" },
      { modelId: "grok-4.6-medium", name: "Grok 4.6 Medium" },
    ];
    expect(
      planAcpModelSelection("cursor-grok-4.6-medium", catalog),
    ).toEqual({ action: "set", modelId: "grok-4.6-medium" });
  });

  it("keeps composer-2.5-fast as a generic base plus fast variant", () => {
    const catalog = [
      { modelId: "composer-2.5", name: "Composer 2.5" },
    ];
    expect(planAcpModelSelection("composer-2.5-fast", catalog)).toEqual({
      action: "set",
      modelId: "composer-2.5",
      parameters: { effort: undefined, thinking: false, fast: true },
    });
  });

  it("reports base candidates when no Grok row matches", () => {
    const plan = planAcpModelSelection("cursor-grok-4.6-medium", [
      { modelId: "gpt-5.6-sol", name: "GPT-5.6 Sol" },
    ]);
    expect(plan.action).toBe("missing");
    if (plan.action === "missing") {
      expect(plan.candidates).toContain("cursor-grok-4.6");
      expect(plan.candidates).toContain("grok-4.6");
    }
  });
});

describe("acpModelSelectionError", () => {
  it("lists the other ids that were tried", () => {
    expect(
      acpModelSelectionError("cursor-grok-4.6-medium", [
        "cursor-grok-4.6-medium",
        "grok-4.6-medium",
        "cursor-grok-4.6",
        "grok-4.6",
      ]),
    ).toBe(
      'ACP model catalog has no match for "cursor-grok-4.6-medium" (also tried: grok-4.6-medium, cursor-grok-4.6, grok-4.6)',
    );
  });

  it("keeps the legacy message when no candidates are supplied", () => {
    expect(acpModelSelectionError("glm-5.2-max")).toBe(
      'ACP model catalog has no match for "glm-5.2-max"',
    );
  });
});

describe("runAcpSync", () => {
  it("returns stdout content from session/update agent_message_chunk", async () => {
    const resultPromise = runAcpSync(node, [fakeServerPath], "test prompt", {
      cwd,
      timeoutMs: 5000,
      skipAuthenticate: true,
    });
    const result = await resultPromise;
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Hello from fake ACP");
  });

  it("keeps agent_thought_chunk out of stdout content", async () => {
    const result = await runAcpSync(node, [fakeServerPath], "test prompt", {
      cwd,
      timeoutMs: 5000,
      skipAuthenticate: true,
      env: { FAKE_ACP_SCENARIO: "with_thought" },
    });
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("Hello from fake ACP");
    expect(result.stdout).not.toContain("SECRET_THOUGHT");
    expect(result.reasoning).toBe("SECRET_THOUGHT");
  });

  it("skips authenticate when skipAuthenticate is true", async () => {
    const resultPromise = runAcpSync(node, [fakeServerPath], "test", {
      cwd,
      timeoutMs: 5000,
      skipAuthenticate: true,
    });
    const result = await resultPromise;
    expect(result.code).toBe(0);
    expect(result.stdout).toBeTruthy();
  });

  it("sends authenticate when skipAuthenticate is false", async () => {
    const resultPromise = runAcpSync(node, [fakeServerPath], "test", {
      cwd,
      timeoutMs: 5000,
      skipAuthenticate: false,
    });
    const result = await resultPromise;
    expect(result.code).toBe(0);
    expect(result.stdout).toBeTruthy();
  });

  it("sends session/set_config_option with configId and resolved value", async () => {
    const result = await runAcpSync(node, [fakeServerPath], "hi", {
      cwd,
      timeoutMs: 5000,
      skipAuthenticate: true,
      model: "gpt-4",
    });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Hello from fake ACP");
    const cfg = parseLastSetConfig(result.stderr);
    expect(cfg).toEqual({
      sessionId: "sess-1",
      configId: "model",
      value: "gpt-4[fast=false]",
    });
  });

  it("passes through model when availableModels is empty", async () => {
    const result = await runAcpSync(node, [fakeServerPath], "hi", {
      cwd,
      timeoutMs: 5000,
      skipAuthenticate: true,
      model: "gpt-4",
      env: { FAKE_ACP_SCENARIO: "empty_models" },
    });
    expect(result.code).toBe(0);
    const cfg = parseLastSetConfig(result.stderr);
    expect(cfg).toEqual({
      sessionId: "sess-1",
      configId: "model",
      value: "gpt-4",
    });
  });

  it("skips session/set_config_option when model is default with no catalog match", async () => {
    const result = await runAcpSync(node, [fakeServerPath], "hi", {
      cwd,
      timeoutMs: 5000,
      skipAuthenticate: true,
      model: "default",
    });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Hello from fake ACP");
    expect(parseLastSetConfig(result.stderr)).toBeNull();
  });

  it("uses first catalog modelId when duplicate display names", async () => {
    const result = await runAcpSync(node, [fakeServerPath], "hi", {
      cwd,
      timeoutMs: 5000,
      skipAuthenticate: true,
      model: "gpt-4",
      env: { FAKE_ACP_SCENARIO: "dup_names" },
    });
    expect(result.code).toBe(0);
    const cfg = parseLastSetConfig(result.stderr);
    expect(cfg?.value).toBe("first-id[]");
  });

  it("fails when session/set_config_option returns error", async () => {
    const result = await runAcpSync(node, [fakeServerPath], "hi", {
      cwd,
      timeoutMs: 5000,
      skipAuthenticate: true,
      model: "gpt-4",
      env: { FAKE_ACP_SCENARIO: "fail_set_config" },
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Internal error");
  });

  it("reports a catalog miss instead of an empty failure", async () => {
    const result = await runAcpSync(node, [fakeServerPath], "hi", {
      cwd,
      timeoutMs: 5000,
      skipAuthenticate: true,
      model: "glm-5.2-max",
      strictModel: true,
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("no match");
    expect(result.stderr).toContain("glm-5.2-max");
  });

  it("sets parameterized family and variant options", async () => {
    const result = await runAcpSync(node, [fakeServerPath], "hi", {
      cwd,
      timeoutMs: 5000,
      skipAuthenticate: true,
      model: "glm-5.2-max",
      strictModel: true,
      env: { FAKE_ACP_SCENARIO: "parameterized_models" },
    });
    expect(result.code).toBe(0);
    expect(parseSetConfigs(result.stderr)).toEqual([
      { sessionId: "sess-1", configId: "model", value: "glm-5.2" },
      { sessionId: "sess-1", configId: "reasoning", value: "max" },
    ]);
  });

  it("selects auto as the parameterized default model", async () => {
    const result = await runAcpSync(node, [fakeServerPath], "hi", {
      cwd,
      timeoutMs: 5000,
      skipAuthenticate: true,
      model: "auto",
      strictModel: true,
      env: { FAKE_ACP_SCENARIO: "parameterized_models" },
    });
    expect(result.code).toBe(0);
    expect(parseSetConfigs(result.stderr)).toEqual([
      { sessionId: "sess-1", configId: "model", value: "default" },
    ]);
  });

  it("sets effort, thinking, and fast from a CLI variant id", async () => {
    const result = await runAcpSync(node, [fakeServerPath], "hi", {
      cwd,
      timeoutMs: 5000,
      skipAuthenticate: true,
      model: "claude-opus-5-low",
      strictModel: true,
      env: { FAKE_ACP_SCENARIO: "parameterized_models" },
    });
    expect(result.code).toBe(0);
    expect(parseSetConfigs(result.stderr)).toEqual([
      { sessionId: "sess-1", configId: "model", value: "claude-opus-5" },
      { sessionId: "sess-1", configId: "effort", value: "low" },
      { sessionId: "sess-1", configId: "thinking", value: "false" },
      { sessionId: "sess-1", configId: "fast", value: "false" },
    ]);
  });

  it("leaves family defaults alone when the CLI id has no variant suffix", async () => {
    const result = await runAcpSync(node, [fakeServerPath], "hi", {
      cwd,
      timeoutMs: 5000,
      skipAuthenticate: true,
      model: "composer-2.5",
      strictModel: true,
      env: { FAKE_ACP_SCENARIO: "parameterized_models" },
    });
    expect(result.code).toBe(0);
    expect(parseSetConfigs(result.stderr)).toEqual([
      { sessionId: "sess-1", configId: "model", value: "composer-2.5" },
    ]);
  });

  it("reports why the child exited before answering", async () => {
    const result = await runAcpSync(
      node,
      ["-e", "console.log('Error: Authentication required.'); process.exit(1)"],
      "hi",
      { cwd, timeoutMs: 5000, skipAuthenticate: true },
    );
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Error: Authentication required.");
    expect(result.stderr).toContain("ACP child exited with code 1");
  });

  it("surfaces an unavailable reasoning level", async () => {
    const result = await runAcpSync(node, [fakeServerPath], "hi", {
      cwd,
      timeoutMs: 5000,
      skipAuthenticate: true,
      model: "glm-5.2-low",
      strictModel: true,
      env: { FAKE_ACP_SCENARIO: "parameterized_models" },
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('does not offer reasoning "low"');
  });

  it("sets the Grok base model and normal speed for a non-fast id", async () => {
    const result = await runAcpSync(node, [fakeServerPath], "hi", {
      cwd,
      timeoutMs: 5000,
      skipAuthenticate: true,
      model: "cursor-grok-4.6-medium",
      strictModel: true,
      env: { FAKE_ACP_SCENARIO: "grok_models" },
    });
    expect(result.code).toBe(0);
    expect(parseSetConfigs(result.stderr)).toEqual([
      { sessionId: "sess-1", configId: "model", value: "grok-4.6" },
      { sessionId: "sess-1", configId: "fast", value: "false" },
    ]);
  });

  it("sets Grok reasoning and keeps the fast default for a -fast id", async () => {
    const result = await runAcpSync(node, [fakeServerPath], "hi", {
      cwd,
      timeoutMs: 5000,
      skipAuthenticate: true,
      model: "cursor-grok-4.6-xhigh-fast",
      strictModel: true,
      env: { FAKE_ACP_SCENARIO: "grok_models" },
    });
    expect(result.code).toBe(0);
    expect(parseSetConfigs(result.stderr)).toEqual([
      { sessionId: "sess-1", configId: "model", value: "grok-4.6" },
      { sessionId: "sess-1", configId: "reasoning", value: "xhigh" },
    ]);
  });

  it("sets Grok 4.5 low and explicit fast options", async () => {
    const result = await runAcpSync(node, [fakeServerPath], "hi", {
      cwd,
      timeoutMs: 5000,
      skipAuthenticate: true,
      model: "cursor-grok-4.5-low-fast",
      strictModel: true,
      env: { FAKE_ACP_SCENARIO: "grok_models" },
    });
    expect(result.code).toBe(0);
    expect(parseSetConfigs(result.stderr)).toEqual([
      { sessionId: "sess-1", configId: "model", value: "grok-4.5" },
      { sessionId: "sess-1", configId: "reasoning", value: "low" },
    ]);
  });

  it("sets a per-variant catalog row by id without extra options", async () => {
    const result = await runAcpSync(node, [fakeServerPath], "hi", {
      cwd,
      timeoutMs: 5000,
      skipAuthenticate: true,
      model: "cursor-grok-4.6-medium",
      strictModel: true,
      env: { FAKE_ACP_SCENARIO: "grok_variant_rows" },
    });
    expect(result.code).toBe(0);
    expect(parseSetConfigs(result.stderr)).toEqual([
      { sessionId: "sess-1", configId: "model", value: "grok-4.6-medium" },
    ]);
  });

  it("surfaces a Grok reasoning level the ACP model does not offer", async () => {
    const result = await runAcpSync(node, [fakeServerPath], "hi", {
      cwd,
      timeoutMs: 5000,
      skipAuthenticate: true,
      model: "cursor-grok-4.5-xhigh",
      strictModel: true,
      env: { FAKE_ACP_SCENARIO: "grok_models" },
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Requested public model: cursor-grok-4.5-xhigh");
    expect(result.stderr).toContain("matched ACP base model: grok-4.5");
    expect(result.stderr).toContain('does not offer reasoning "xhigh"');
    expect(result.stderr).toContain("low, medium, high");
    expect(result.stderr).toContain("advertised ACP options:");
  });

  it("reports tried base ids on a Grok catalog miss", async () => {
    const result = await runAcpSync(node, [fakeServerPath], "hi", {
      cwd,
      timeoutMs: 5000,
      skipAuthenticate: true,
      model: "cursor-grok-4.6-medium",
      strictModel: true,
      env: { FAKE_ACP_SCENARIO: "parameterized_models" },
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("no match");
    expect(result.stderr).toContain("cursor-grok-4.6");
    expect(result.stderr).toContain("grok-4.6");
  });

  it("sets composer-2.5-fast via the fast option", async () => {
    const result = await runAcpSync(node, [fakeServerPath], "hi", {
      cwd,
      timeoutMs: 5000,
      skipAuthenticate: true,
      model: "composer-2.5-fast",
      strictModel: true,
      env: { FAKE_ACP_SCENARIO: "parameterized_models" },
    });
    expect(result.code).toBe(0);
    expect(parseSetConfigs(result.stderr)).toEqual([
      { sessionId: "sess-1", configId: "model", value: "composer-2.5" },
    ]);
  });
});

describe("runAcpStream", () => {
  it("streams chunks from session/update", async () => {
    const chunks: string[] = [];
    const result = await runAcpStream(
      node,
      [fakeServerPath],
      "stream test",
      {
        cwd,
        timeoutMs: 5000,
        skipAuthenticate: true,
      },
      (t) => chunks.push(t),
    );
    expect(result.code).toBe(0);
    expect(chunks.join("")).toContain("Hello from fake ACP");
  });

  it("streams message chunks and ignores thought chunks", async () => {
    const chunks: string[] = [];
    const result = await runAcpStream(
      node,
      [fakeServerPath],
      "stream test",
      {
        cwd,
        timeoutMs: 5000,
        skipAuthenticate: true,
        env: { FAKE_ACP_SCENARIO: "with_thought" },
      },
      (t) => chunks.push(t),
    );
    expect(result.code).toBe(0);
    expect(chunks.join("")).toBe("Hello from fake ACP");
    expect(chunks.join("")).not.toContain("SECRET_THOUGHT");
  });

  it("sends session/set_config_option with configId when model is set", async () => {
    const chunks: string[] = [];
    const result = await runAcpStream(node, [fakeServerPath], "stream", {
      cwd,
      timeoutMs: 5000,
      skipAuthenticate: true,
      model: "gpt-4",
    }, (t) => chunks.push(t));
    expect(result.code).toBe(0);
    expect(chunks.join("")).toContain("Hello from fake ACP");
    const cfg = parseLastSetConfig(result.stderr);
    expect(cfg).toEqual({
      sessionId: "sess-1",
      configId: "model",
      value: "gpt-4[fast=false]",
    });
  });

  it("fails when session/set_config_option returns error (stream)", async () => {
    const chunks: string[] = [];
    const result = await runAcpStream(node, [fakeServerPath], "x", {
      cwd,
      timeoutMs: 5000,
      skipAuthenticate: true,
      model: "gpt-4",
      env: { FAKE_ACP_SCENARIO: "fail_set_config" },
    }, (t) => chunks.push(t));
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Internal error");
  });

  it("reports why the child exited before answering (stream)", async () => {
    const result = await runAcpStream(
      node,
      ["-e", "console.log('Error: Authentication required.'); process.exit(1)"],
      "x",
      { cwd, timeoutMs: 5000, skipAuthenticate: true },
      () => {},
    );
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Error: Authentication required.");
    expect(result.stderr).toContain("ACP child exited with code 1");
  });
});
