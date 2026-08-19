import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  extractAcpUpdateText,
  resolveAcpModelConfigValue,
  runAcpStream,
  runAcpSync,
} from "./acp-client.js";

const node = process.execPath;
const cwd = process.cwd();
const fakeServerPath = join(cwd, "src", "lib", "__tests__", "fake-acp-server.mjs");

function parseLastSetConfig(stderr: string): Record<string, unknown> | null {
  const lines = stderr.split("\n").filter((l) => l.startsWith("__FAKE_ACP_SET_CONFIG__:"));
  if (lines.length === 0) return null;
  const last = lines[lines.length - 1];
  return JSON.parse(last.slice("__FAKE_ACP_SET_CONFIG__:".length)) as Record<string, unknown>;
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

describe("resolveAcpModelConfigValue", () => {
  it("returns display name when catalog is missing", () => {
    expect(resolveAcpModelConfigValue("gpt-4", undefined)).toBe("gpt-4");
  });

  it("returns display name when catalog is empty", () => {
    expect(resolveAcpModelConfigValue("gpt-4", [])).toBe("gpt-4");
  });

  it("maps name to modelId when matched", () => {
    expect(
      resolveAcpModelConfigValue("gpt-4", [
        { modelId: "gpt-4[fast=false]", name: "gpt-4" },
      ]),
    ).toBe("gpt-4[fast=false]");
  });

  it("falls back to default[] when name not in catalog", () => {
    expect(
      resolveAcpModelConfigValue("unknown", [{ modelId: "x[]", name: "gpt-4" }]),
    ).toBe("default[]");
  });

  it("uses first match when duplicate names", () => {
    expect(
      resolveAcpModelConfigValue("gpt-4", [
        { modelId: "first[]", name: "gpt-4" },
        { modelId: "second[]", name: "gpt-4" },
      ]),
    ).toBe("first[]");
  });

  it("maps CLI ids through their catalog display-name alias", () => {
    expect(
      resolveAcpModelConfigValue(
        "gpt-5.6-sol-high",
        [
          {
            modelId: "gpt-5.6-sol[reasoning=high]",
            name: "GPT-5.6 Sol High",
          },
        ],
        ["GPT-5.6 Sol High"],
      ),
    ).toBe("gpt-5.6-sol[reasoning=high]");
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
  });
});
