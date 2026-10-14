import { describe, it, expect } from "vitest";
import {
  normalizeModelId,
  buildPromptFromMessages,
  responsesInputToMessages,
  toolsToSystemText,
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

  it("handles array content (multimodal) with image placeholder", () => {
    const messages = [
      {
        role: "user",
        content: [
          { type: "text", text: "Describe this" },
          {
            type: "image_url",
            image_url: { url: "https://example.com/img.png" },
          },
        ],
      },
    ];
    const prompt = buildPromptFromMessages(messages);
    expect(prompt).toContain("Describe this");
    expect(prompt).toContain("[Image: https://example.com/img.png]");
  });

  it("includes base64 image placeholder without leaking data", () => {
    const messages = [
      {
        role: "user",
        content: [
          {
            type: "image_url",
            image_url: { url: "data:image/jpeg;base64,/9j/..." },
          },
        ],
      },
    ];
    const prompt = buildPromptFromMessages(messages);
    expect(prompt).toContain("[Image: base64 image/jpeg]");
    expect(prompt).not.toContain("/9j/");
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

describe("toolsToSystemText", () => {
  it("returns undefined when no tools or functions", () => {
    expect(toolsToSystemText()).toBeUndefined();
    expect(toolsToSystemText([], [])).toBeUndefined();
  });

  it("serialises tools array into readable text", () => {
    const tools = [
      {
        type: "function",
        function: {
          name: "get_weather",
          description: "Get current weather",
          parameters: { type: "object", properties: {} },
        },
      },
    ];
    const result = toolsToSystemText(tools);
    expect(result).toBeDefined();
    expect(result).toContain("get_weather");
    expect(result).toContain("Get current weather");
    expect(result).toContain("Available tools");
  });

  it("serialises legacy functions array", () => {
    const functions = [
      { name: "add", description: "Add two numbers", parameters: {} },
    ];
    const result = toolsToSystemText(undefined, functions);
    expect(result).toContain("add");
    expect(result).toContain("Add two numbers");
  });

  it("merges tools and functions together", () => {
    const tools = [
      { type: "function", function: { name: "foo", description: "foo fn" } },
    ];
    const functions = [{ name: "bar", description: "bar fn" }];
    const result = toolsToSystemText(tools, functions);
    expect(result).toContain("foo");
    expect(result).toContain("bar");
  });

  const functionLines = (text: string | undefined) =>
    (text ?? "").split("\n").filter((line) => line.startsWith("Function:"));

  it("skips namespace groups, Responses builtins and nameless entries", () => {
    const result = toolsToSystemText([
      { type: "web_search", external_web_access: true },
      {
        type: "namespace",
        name: "mcp__docs",
        tools: [{ type: "function", name: "search" }],
      },
      { type: "file_search", vector_store_ids: ["vs_1"] },
      { description: "no name" },
      { type: "function", function: { name: "keep" } },
    ]);
    expect(functionLines(result)).toEqual(["Function: keep"]);
    expect(result).not.toContain("undefined");
  });

  it("skips Anthropic builtin tool types but keeps client tools", () => {
    const result = toolsToSystemText([
      { type: "web_search_20250305", name: "web_search", max_uses: 5 },
      { type: "bash_20250124", name: "bash" },
      { type: "text_editor_20250124", name: "str_replace_editor" },
      { name: "lookup", input_schema: { type: "object" } },
      { type: "custom", name: "custom_tool", input_schema: { type: "object" } },
    ]);
    expect(functionLines(result)).toEqual([
      "Function: lookup",
      "Function: custom_tool",
    ]);
  });

  it("returns undefined when only builtins and namespace groups remain", () => {
    expect(
      toolsToSystemText([
        { type: "web_search" },
        { type: "namespace", name: "multi_agent_v1", tools: [] },
      ]),
    ).toBeUndefined();
  });

  it("still leaves flat Responses function tools out", () => {
    expect(
      toolsToSystemText([{ type: "function", name: "flat", parameters: {} }]),
    ).toBeUndefined();
  });

  it("renders Chat Completions and Anthropic tools exactly as before", () => {
    expect(
      toolsToSystemText(
        [
          {
            type: "function",
            function: {
              name: "get_weather",
              description: "Get current weather",
              parameters: {
                type: "object",
                properties: { city: { type: "string" } },
                required: ["city"],
              },
            },
          },
        ],
        [
          {
            name: "legacy_add",
            description: "Add two numbers",
            parameters: { type: "object", properties: {} },
          },
        ],
      ),
    ).toBe(
      [
        "Available tools (respond with a JSON object to call one):",
        "",
        "Function: get_weather",
        "Description: Get current weather",
        "Parameters: {",
        '  "type": "object",',
        '  "properties": {',
        '    "city": {',
        '      "type": "string"',
        "    }",
        "  },",
        '  "required": [',
        '    "city"',
        "  ]",
        "}",
        "Function: legacy_add",
        "Description: Add two numbers",
        "Parameters: {",
        '  "type": "object",',
        '  "properties": {}',
        "}",
      ].join("\n"),
    );
    expect(
      toolsToSystemText([
        {
          name: "lookup",
          description: "Look up a record",
          input_schema: {
            type: "object",
            properties: { id: { type: "string" } },
          },
        },
        {
          type: "custom",
          name: "custom_tool",
          description: "Custom",
          input_schema: { type: "object" },
        },
      ]),
    ).toBe(
      [
        "Available tools (respond with a JSON object to call one):",
        "",
        "Function: lookup",
        "Description: Look up a record",
        "Parameters: {}",
        "Function: custom_tool",
        "Description: Custom",
        "Parameters: {}",
      ].join("\n"),
    );
  });
});

describe("responsesInputToMessages", () => {
  it("converts string input and instructions", () => {
    const result = responsesInputToMessages({
      instructions: "Be concise.",
      input: "Hello",
    });
    expect(result).toEqual([
      { role: "system", content: "Be concise." },
      { role: "user", content: "Hello" },
    ]);
  });

  it("converts Responses message items", () => {
    const result = responsesInputToMessages({
      input: [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "What is 2+2?" }],
        },
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "4" }],
        },
      ],
    });
    expect(result).toEqual([
      { role: "user", content: "What is 2+2?" },
      { role: "assistant", content: "4" },
    ]);
  });

  it("converts function call output items as tool messages", () => {
    const result = responsesInputToMessages({
      input: [{ type: "function_call_output", call_id: "call_1", output: "42" }],
    });
    expect(result).toEqual([{ role: "tool", content: "42" }]);
  });
});
