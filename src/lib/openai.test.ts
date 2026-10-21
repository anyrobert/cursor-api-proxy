import { describe, it, expect } from "vitest";
import {
  normalizeModelId,
  buildPromptFromMessages,
  responsesInputToMessages,
  toolsToSystemText,
  type OpenAiChatCompletionRequest,
} from "./openai.js";
import {
  parseAnthropicFunctionTools,
  parseOpenAiFunctionTools,
  resolveToolChoice,
} from "./tool-types.js";

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
  const header =
    "Tools defined by the client, for reference only. You cannot call them in this mode, so answer without them and do not write out calls to them.";
  const budget = 8_000;
  const lines = (text: string | undefined) => (text ?? "").split("\n");
  const functionLines = (text: string | undefined) =>
    lines(text).filter((line) => line.startsWith("Function:"));
  /** Everything after the header and its blank line. */
  const entries = (text: string | undefined) =>
    (text ?? "").slice(header.length + 2);

  const weather = {
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
  };
  const time = { type: "function", function: { name: "get_time" } };

  it("returns undefined when no callable tool is left", () => {
    expect(toolsToSystemText([])).toBeUndefined();
    expect(
      toolsToSystemText(
        parseOpenAiFunctionTools([
          { type: "web_search" },
          { type: "namespace", name: "multi_agent_v1", tools: [] },
        ]).tools,
      ),
    ).toBeUndefined();
  });

  it("renders Chat tools and legacy functions as reference only", () => {
    const text = toolsToSystemText(
      parseOpenAiFunctionTools(
        [weather],
        [
          {
            name: "legacy_add",
            description: "Add two numbers",
            parameters: { type: "object", properties: {} },
          },
        ],
      ).tools,
    );
    expect(text).toBe(
      [
        header,
        "",
        "Function: get_weather",
        "Description: Get current weather",
        'Parameters: {"type":"object","properties":{"city":{"type":"string"}},"required":["city"]}',
        "Function: legacy_add",
        "Description: Add two numbers",
        'Parameters: {"type":"object","properties":{}}',
      ].join("\n"),
    );
    expect(text).not.toMatch(/JSON object|respond with/i);
  });

  it("renders flat Responses functions", () => {
    expect(
      entries(
        toolsToSystemText(
          parseOpenAiFunctionTools([
            {
              type: "function",
              name: "lookup",
              description: "Look up a record",
              parameters: {
                type: "object",
                properties: { id: { type: "string" } },
              },
            },
            { type: "function", name: "ping" },
          ]).tools,
        ),
      ),
    ).toBe(
      [
        "Function: lookup",
        "Description: Look up a record",
        'Parameters: {"type":"object","properties":{"id":{"type":"string"}}}',
        "Function: ping",
        'Parameters: {"type":"object","properties":{}}',
      ].join("\n"),
    );
  });

  it("lists namespace members by flattened name and leaves out groups and builtins", () => {
    const search = { type: "function", name: "search" };
    const text = toolsToSystemText(
      parseOpenAiFunctionTools([
        { type: "web_search", external_web_access: true },
        { type: "namespace", name: "mcp__docs", tools: [search] },
        { type: "namespace", name: "mcp__wiki", tools: [search] },
        { type: "file_search", vector_store_ids: ["vs_1"] },
        { type: "custom", name: "apply_patch", format: { type: "text" } },
        { description: "no name" },
      ]).tools,
    );
    expect(functionLines(text)).toEqual([
      "Function: search",
      "Function: mcp__wiki__search",
    ]);
    expect(text).not.toMatch(
      /mcp__docs|web_search|file_search|apply_patch|undefined/,
    );
  });

  it("renders Anthropic input_schema", () => {
    expect(
      entries(
        toolsToSystemText(
          parseAnthropicFunctionTools([
            {
              name: "lookup",
              description: "Look up a record",
              input_schema: {
                type: "object",
                properties: { id: { type: "string" } },
              },
            },
            { type: "custom", name: "custom_tool", input_schema: { type: "object" } },
          ]).tools,
        ),
      ),
    ).toBe(
      [
        "Function: lookup",
        "Description: Look up a record",
        'Parameters: {"type":"object","properties":{"id":{"type":"string"}}}',
        "Function: custom_tool",
        'Parameters: {"type":"object"}',
      ].join("\n"),
    );
  });

  it("renders nothing for tool_choice none and only the named tool otherwise", () => {
    const openAi = parseOpenAiFunctionTools([weather, time]).tools;
    const anthropic = parseAnthropicFunctionTools([
      { name: "get_weather" },
      { name: "get_time" },
    ]).tools;
    expect(
      toolsToSystemText(resolveToolChoice(openAi, "none").tools),
    ).toBeUndefined();
    expect(
      toolsToSystemText(
        resolveToolChoice(anthropic, { type: "none" }).tools,
      ),
    ).toBeUndefined();
    expect(
      functionLines(
        toolsToSystemText(
          resolveToolChoice(openAi, {
            type: "function",
            function: { name: "get_time" },
          }).tools,
        ),
      ),
    ).toEqual(["Function: get_time"]);
    expect(
      functionLines(
        toolsToSystemText(
          resolveToolChoice(anthropic, { type: "tool", name: "get_weather" })
            .tools,
        ),
      ),
    ).toEqual(["Function: get_weather"]);
  });

  describe("size budget", () => {
    const longText = (seed: string, length: number) =>
      `${seed} `.repeat(Math.ceil(length / (seed.length + 1))).slice(0, length);
    /** A Responses function with a long description and a sizeable schema. */
    const bigTool = (index: number) => ({
      type: "function",
      name: `tool_${String(index).padStart(2, "0")}`,
      description: longText(`Does task ${index}.\n`, 400),
      parameters: {
        type: "object",
        properties: Object.fromEntries(
          Array.from({ length: 12 }, (_, field) => [
            `field_${field}`,
            { type: "string", description: longText("A field.", 60) },
          ]),
        ),
      },
    });

    it("lists every tool and spends the rest on full schemas, in order", () => {
      const { tools } = parseOpenAiFunctionTools(
        Array.from({ length: 17 }, (_, index) => bigTool(index)),
      );
      const fullSize = tools
        .map((tool) => JSON.stringify(tool.inputSchema).length)
        .reduce((sum, size) => sum + size, 0);
      expect(fullSize).toBeGreaterThan(budget);

      const text = toolsToSystemText(tools);
      expect(lines(text)[0]).toBe(header);
      expect(entries(text).length).toBeLessThanOrEqual(budget);
      expect(functionLines(text)).toHaveLength(17);
      expect(text).not.toContain("more tool");

      const blocks = entries(text).split(/\n(?=Function: )/);
      const full = blocks.map((block) => block.includes("\nParameters: "));
      expect(full[0]).toBe(true);
      expect(full[16]).toBe(false);
      // Same-sized tools: upgrades stop at the first that no longer fits.
      expect(full.slice(full.indexOf(false)).every((isFull) => !isFull)).toBe(
        true,
      );
      // A full entry keeps its description whole; a brief one is cut short.
      expect(blocks[0]).toContain(tools[0].description!.trim());
      expect(lines(blocks[16])).toHaveLength(2);
      const briefDescription = lines(blocks[16])[1];
      expect(briefDescription.startsWith("Description: Does task 16. ")).toBe(
        true,
      );
      expect(briefDescription.length).toBeLessThanOrEqual(
        "Description: ".length + 200,
      );
      expect(briefDescription.endsWith("…")).toBe(true);
    });

    it("counts the tools that do not fit even as brief entries", () => {
      const many = parseOpenAiFunctionTools(
        Array.from({ length: 60 }, (_, index) => bigTool(index)),
      ).tools;
      const text = toolsToSystemText(many);
      const listed = functionLines(text).length;
      expect(listed).toBeGreaterThan(0);
      expect(listed).toBeLessThan(60);
      expect(lines(text).at(-1)).toBe(`(${60 - listed} more tools not listed)`);
      expect(entries(text).length).toBeLessThanOrEqual(
        budget + `\n(${60 - listed} more tools not listed)`.length,
      );
      expect(text).not.toContain("Parameters:");

      expect(lines(toolsToSystemText(many.slice(0, listed + 1))).at(-1)).toBe(
        "(1 more tool not listed)",
      );
    });
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
