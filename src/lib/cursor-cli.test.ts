import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, it, expect } from "vitest";
import {
  CursorCliModelsError,
  listCursorCliModels,
  parseCursorCliModels,
} from "./cursor-cli.js";

const CLIENT_SAFE =
  "The Cursor CLI could not list models. See server logs for details.";
const SECRET_STDERR = "agent: token=secret-models-detail";

let workDir: string;

beforeAll(() => {
  workDir = fs.mkdtempSync(join(tmpdir(), "cursor-cli-test-"));
});

afterAll(() => {
  fs.rmSync(workDir, { recursive: true, force: true });
});

/** A stand-in `agent` that runs `script` (sh) and never talks to Cursor. */
function fakeAgent(name: string, script: string): string {
  const bin = join(workDir, name);
  fs.writeFileSync(bin, `#!/bin/sh\n${script}\n`, { mode: 0o755 });
  return bin;
}

async function modelsError(agentBin: string): Promise<CursorCliModelsError> {
  const error = await listCursorCliModels({ agentBin, timeoutMs: 10_000 }).then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(CursorCliModelsError);
  return error as CursorCliModelsError;
}

describe("listCursorCliModels", () => {
  it("returns the parsed catalog", async () => {
    const bin = fakeAgent("agent-ok", "echo 'auto - Auto (default)'\necho 'gpt-5 - GPT-5'");
    await expect(listCursorCliModels({ agentBin: bin, timeoutMs: 10_000 })).resolves.toEqual([
      { id: "auto", name: "Auto" },
      { id: "gpt-5", name: "GPT-5" },
    ]);
  });

  it("keeps the path and stderr of a failed check out of the message (#89)", async () => {
    const bin = fakeAgent("agent-exit", `echo '${SECRET_STDERR}' >&2\nexit 3`);
    const error = await modelsError(bin);
    expect(error.message).toBe(CLIENT_SAFE);
    expect(error.diagnostics).toContain(JSON.stringify(bin));
    expect(error.diagnostics).toContain("--list-models exited 3");
    expect(error.diagnostics).toContain(SECRET_STDERR);
  });

  it("reports a binary that cannot be run without its path", async () => {
    const bin = join(workDir, "missing-agent");
    const error = await modelsError(bin);
    expect(error.message).toBe(CLIENT_SAFE);
    expect(error.diagnostics).toContain(bin);
    expect(error.diagnostics).toContain("could not run");
  });

  it("reports a binary that prints no catalog without its output", async () => {
    const bin = fakeAgent("agent-other", `echo 'Usage: agent ${SECRET_STDERR}'`);
    const error = await modelsError(bin);
    expect(error.message).toBe(CLIENT_SAFE);
    expect(error.diagnostics).toContain("did not return a Cursor model catalog");
    expect(error.diagnostics).toContain(SECRET_STDERR);
  });
});

describe("parseCursorCliModels", () => {
  it("parses model lines with id and name", () => {
    const output = [
      "claude-3-opus - Claude 3 Opus",
      "claude-3-sonnet - Claude 3 Sonnet",
      "gpt-4o - GPT-4o",
    ].join("\n");
    const models = parseCursorCliModels(output);
    expect(models).toEqual([
      { id: "claude-3-opus", name: "Claude 3 Opus" },
      { id: "claude-3-sonnet", name: "Claude 3 Sonnet" },
      { id: "gpt-4o", name: "GPT-4o" },
    ]);
  });

  it("strips parenthetical suffix from name", () => {
    const output = "claude-3 - Claude 3 (recommended)";
    const models = parseCursorCliModels(output);
    expect(models).toEqual([{ id: "claude-3", name: "Claude 3" }]);
  });

  it("deduplicates by id", () => {
    const output = [
      "claude-3 - Claude 3",
      "claude-3 - Claude 3 Sonnet",
    ].join("\n");
    const models = parseCursorCliModels(output);
    expect(models).toHaveLength(1);
    expect(models[0].id).toBe("claude-3");
  });

  it("handles Windows line endings", () => {
    const output = "model-a - Model A\r\nmodel-b - Model B";
    const models = parseCursorCliModels(output);
    expect(models).toHaveLength(2);
  });

  it("handles empty output", () => {
    const models = parseCursorCliModels("");
    expect(models).toEqual([]);
  });

  it("skips non-matching lines", () => {
    const output = [
      "claude-3 - Claude 3",
      "some header or garbage",
      "gpt-4 - GPT-4",
    ].join("\n");
    const models = parseCursorCliModels(output);
    expect(models).toHaveLength(2);
  });

  it("handles model ids with slashes and colons", () => {
    const output = "org/models/claude-3:latest - Claude 3";
    const models = parseCursorCliModels(output);
    expect(models).toEqual([{ id: "org/models/claude-3:latest", name: "Claude 3" }]);
  });

  it("strips ANSI color codes from FORCE_COLOR output", () => {
    const output = [
      "\u001b[2mAvailable models\u001b[22m",
      "",
      "\u001b[36mauto\u001b[39m \u001b[2m- Auto\u001b[22m\u001b[2m (default)\u001b[22m",
      "\u001b[36mgpt-5.3-codex\u001b[39m \u001b[2m- Codex 5.3\u001b[22m",
    ].join("\n");
    const models = parseCursorCliModels(output);
    expect(models).toEqual([
      { id: "auto", name: "Auto" },
      { id: "gpt-5.3-codex", name: "Codex 5.3" },
    ]);
  });
});
