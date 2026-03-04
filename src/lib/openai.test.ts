import { describe, it, expect } from "vitest";
import {
  normalizeModelId,
  buildPromptFromMessages,
  type OpenAiChatCompletionRequest,
} from "./openai.js";

describe("normalizeModelId", () => {
  it("returns last part after slash for org/model format", () => {
    expect(normalizeModelId("org/cursor/model-id")).toBe("model-id");
  });

  it("returns model as-is when no slash", () => {
    expect(normalizeModelId("claude-3-opus")).toBe("claude-3-opus");
  });

  it("returns undefined for empty string", () => {
    expect(normalizeModelId("")).toBeUndefined();
  });

  it("returns undefined for whitespace-only string", () => {
    expect(normalizeModelId("   ")).toBeUndefined();
  });

  it("returns undefined for undefined", () => {
    expect(normalizeModelId(undefined)).toBeUndefined();
  });

  it("trims leading/trailing whitespace", () => {
    expect(normalizeModelId("  claude-3  ")).toBe("claude-3");
  });
});

describe("buildPromptFromMessages", () => {
  it("builds prompt from user and assistant messages", () => {
    const messages = [
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi there" },
      { role: "user", content: "How are you?" },
    ];
    const prompt = buildPromptFromMessages(messages);
    expect(prompt).toBe(
      "User: Hello\n\nAssistant: Hi there\n\nUser: How are you?\n\nAssistant:",
    );
  });

  it("prepends system message", () => {
    const messages = [
      { role: "system", content: "You are helpful." },
      { role: "user", content: "Hi" },
    ];
    const prompt = buildPromptFromMessages(messages);
    expect(prompt).toBe("System:\nYou are helpful.\n\nUser: Hi\n\nAssistant:");
  });

  it("joins multiple system messages with double newline", () => {
    const messages = [
      { role: "system", content: "First rule" },
      { role: "system", content: "Second rule" },
      { role: "user", content: "Hi" },
    ];
    const prompt = buildPromptFromMessages(messages);
    expect(prompt).toContain("First rule\n\nSecond rule");
  });

  it("handles developer role like system", () => {
    const messages = [
      { role: "developer", content: "Dev instructions" },
      { role: "user", content: "Hello" },
    ];
    const prompt = buildPromptFromMessages(messages);
    expect(prompt).toContain("System:\nDev instructions");
  });

  it("handles tool/function messages", () => {
    const messages = [
      { role: "user", content: "Use the calculator" },
      { role: "tool", content: "42" },
    ];
    const prompt = buildPromptFromMessages(messages);
    expect(prompt).toContain("Tool: 42");
  });

  it("handles array content (multimodal)", () => {
    const messages = [
      {
        role: "user",
        content: [
          { type: "text", text: "Describe this" },
          { type: "image_url", image_url: { url: "..." } },
        ],
      },
    ];
    const prompt = buildPromptFromMessages(messages);
    expect(prompt).toContain("User: Describe this");
  });

  it("handles empty messages", () => {
    const prompt = buildPromptFromMessages([]);
    expect(prompt).toBe("\n\nAssistant:");
  });

  it("handles undefined messages", () => {
    const prompt = buildPromptFromMessages(undefined as unknown as any[]);
    expect(prompt).toBe("\n\nAssistant:");
  });

  it("skips messages with empty content", () => {
    const messages = [
      { role: "user", content: "" },
      { role: "user", content: "Hello" },
    ];
    const prompt = buildPromptFromMessages(messages);
    expect(prompt).toBe("User: Hello\n\nAssistant:");
  });
});
