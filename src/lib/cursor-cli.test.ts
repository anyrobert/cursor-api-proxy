import { describe, expect, it } from "vitest";
import { parseCursorCliModels } from "./cursor-cli.js";

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
    const output = ["claude-3 - Claude 3", "claude-3 - Claude 3 Sonnet"].join(
      "\n",
    );
    const models = parseCursorCliModels(output);
    expect(models).toHaveLength(1);
    const model = models[0];
    expect(model).toBeDefined();
    if (!model) return;
    expect(model.id).toBe("claude-3");
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
    expect(models).toEqual([
      { id: "org/models/claude-3:latest", name: "Claude 3" },
    ]);
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
