import { describe, expect, it } from "vitest";

import {
  anthropicToolOutputs,
  chatToolOutputs,
  parseAnthropicFunctionTools,
  parseOpenAiFunctionTools,
  resolveToolChoice,
  responsesToolOutputs,
} from "./tool-types.js";

describe("tool normalization", () => {
  it("accepts Chat, Responses, legacy, and Anthropic function schemas", () => {
    expect(
      parseOpenAiFunctionTools([
        {
          type: "function",
          function: {
            name: "chat",
            parameters: { type: "object", properties: { x: {} } },
          },
        },
        {
          type: "function",
          name: "response",
          parameters: { type: "object", properties: { y: {} } },
        },
      ]),
    ).toEqual([
      {
        name: "chat",
        description: undefined,
        inputSchema: { type: "object", properties: { x: {} } },
      },
      {
        name: "response",
        description: undefined,
        inputSchema: { type: "object", properties: { y: {} } },
      },
    ]);
    expect(
      parseOpenAiFunctionTools(undefined, [
        {
          name: "legacy",
          parameters: { type: "object", properties: {} },
        },
      ])[0].name,
    ).toBe("legacy");
    expect(
      parseAnthropicFunctionTools([
        {
          name: "anthropic",
          input_schema: { type: "object", properties: {} },
        },
      ])[0].inputSchema,
    ).toEqual({ type: "object", properties: {} });
  });

  it("ignores host-side builtin tools and rejects duplicates", () => {
    expect(parseOpenAiFunctionTools([{ type: "web_search" }])).toEqual([]);
    expect(() =>
      parseOpenAiFunctionTools([
        { type: "function", name: "same" },
        { type: "function", function: { name: "same" } },
      ]),
    ).toThrow(/Duplicate/);
  });

  it("flattens namespace tool groups", () => {
    expect(
      parseOpenAiFunctionTools([
        {
          type: "namespace",
          name: "multi_agent_v1",
          description: "Tools for spawning and managing sub-agents.",
          tools: [
            {
              type: "function",
              name: "close_agent",
              description: "Close an agent.",
              parameters: { type: "object", properties: { id: {} } },
            },
          ],
        },
      ]),
    ).toEqual([
      {
        name: "close_agent",
        description: "Close an agent.",
        inputSchema: { type: "object", properties: { id: {} } },
      },
    ]);
  });

  it("prefixes namespaced tools whose bare name already exists", () => {
    const tools = parseOpenAiFunctionTools([
      { type: "function", name: "search" },
      {
        type: "namespace",
        name: "mcp__docs",
        tools: [{ type: "function", name: "search" }],
      },
      {
        type: "namespace",
        name: "mcp__wiki",
        tools: [{ type: "function", name: "search" }],
      },
    ]);
    expect(tools.map((tool) => tool.name)).toEqual([
      "search",
      "mcp__docs__search",
      "mcp__wiki__search",
    ]);
  });

  it("ignores empty or malformed namespace groups", () => {
    expect(
      parseOpenAiFunctionTools([
        { type: "namespace", name: "empty", tools: [] },
        { type: "namespace", name: "no-tools-field" },
      ]),
    ).toEqual([]);
  });

  it("implements none, required, named, and no-parallel choices", () => {
    const tools = [
      {
        name: "one",
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: "two",
        inputSchema: { type: "object", properties: {} },
      },
    ];
    expect(resolveToolChoice(tools, "none").tools).toEqual([]);
    expect(resolveToolChoice(tools, "required").instruction).toMatch(/must/);
    expect(
      resolveToolChoice(tools, {
        type: "function",
        function: { name: "two" },
      }).tools.map((tool) => tool.name),
    ).toEqual(["two"]);
    expect(
      resolveToolChoice(tools, "auto", { parallelToolCalls: false })
        .instruction,
    ).toMatch(/at most one/i);
    expect(() =>
      resolveToolChoice(tools, { type: "tool", name: "missing" }),
    ).toThrow(/Unknown/);
  });
});

describe("tool output correlation", () => {
  it("reads Chat tool_call_id", () => {
    expect(
      chatToolOutputs([
        { role: "user", content: "x" },
        { role: "tool", tool_call_id: "call_1", content: { ok: true } },
      ]),
    ).toEqual([{ callId: "call_1", output: '{"ok":true}' }]);
  });

  it("reads Responses function_call_output", () => {
    expect(
      responsesToolOutputs([
        {
          type: "function_call_output",
          call_id: "call_2",
          output: "done",
        },
      ]),
    ).toEqual([{ callId: "call_2", output: "done" }]);
  });

  it("reads Anthropic tool_result and error state", () => {
    expect(
      anthropicToolOutputs([
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "call_3",
              content: [{ type: "text", text: "failed" }],
              is_error: true,
            },
          ],
        },
      ]),
    ).toEqual([
      { callId: "call_3", output: "failed", isError: true },
    ]);
  });
});
