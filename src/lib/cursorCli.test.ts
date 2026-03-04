import { describe, it, expect } from "vitest";
import { parseCursorCliModels } from "./cursorCli.js";

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
});
