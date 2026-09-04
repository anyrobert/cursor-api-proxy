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
    ).toMatchObject([
      {
        name: "chat",
        responseType: "function",
        responseName: "chat",
        inputSchema: { type: "object", properties: { x: {} } },
      },
      {
        name: "response",
        responseType: "function",
        responseName: "response",
        inputSchema: { type: "object", properties: { y: {} } },
      },
    ]);
    const legacyTools = parseOpenAiFunctionTools(undefined, [
      {
        name: "legacy",
        parameters: { type: "object", properties: {} },
      },
    ]);
    const legacy = legacyTools[0];
    expect(legacy).toBeDefined();
    if (!legacy) return;
    expect(legacy.name).toBe("legacy");
    const anthropicTools = parseAnthropicFunctionTools([
      {
        name: "anthropic",
        input_schema: { type: "object", properties: {} },
      },
    ]);
    const anthropic = anthropicTools[0];
    expect(anthropic).toBeDefined();
    if (!anthropic) return;
    expect(anthropic.inputSchema).toEqual({
      type: "object",
      properties: {},
    });
  });

  it("flattens Responses namespaces and wraps custom tools", () => {
    expect(
      parseOpenAiFunctionTools([
        {
          type: "namespace",
          name: "skills",
          tools: [
            {
              type: "function",
              name: "read",
              parameters: { type: "object", properties: { path: {} } },
            },
            {
              type: "custom",
              name: "exec",
              description: "Execute source text",
              format: {
                type: "grammar",
                syntax: "lark",
                definition: "start: /.+/",
              },
            },
          ],
        },
        {
          type: "custom",
          name: "apply_patch",
          description: "Apply a patch",
          format: {
            type: "grammar",
            syntax: "lark",
            definition: "start: /.+/",
          },
        },
      ]),
    ).toMatchObject([
      {
        name: "skills__read",
        responseType: "function",
        responseName: "read",
        responseNamespace: "skills",
      },
      {
        name: "skills__exec",
        responseType: "custom",
        responseName: "exec",
        responseNamespace: "skills",
        inputSchema: {
          type: "object",
          required: ["input"],
          additionalProperties: false,
        },
      },
      {
        name: "apply_patch",
        responseType: "custom",
        responseName: "apply_patch",
      },
    ]);
  });

  it("ignores provider-executed tools and rejects unknown/duplicate tools", () => {
    expect(
      parseOpenAiFunctionTools(
        [
          { type: "web_search" },
          {
            type: "tool_search",
            execution: "server",
            description: "Search deferred tools",
            parameters: { type: "object", properties: {} },
          },
        ],
        undefined,
        { ignoreProviderExecutedTools: true },
      ),
    ).toEqual([]);
    expect(() => parseOpenAiFunctionTools([{ type: "computer" }])).toThrow(
      /Unsupported tool type/,
    );
    expect(() =>
      parseOpenAiFunctionTools([
        { type: "function", name: "same" },
        { type: "function", function: { name: "same" } },
      ]),
    ).toThrow(/Duplicate/);
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

  it("reads Responses function and custom tool outputs", () => {
    expect(
      responsesToolOutputs([
        {
          type: "function_call_output",
          call_id: "call_2",
          output: "done",
        },
        {
          type: "custom_tool_call_output",
          call_id: "call_4",
          output: "patched",
        },
      ]),
    ).toEqual([
      { callId: "call_2", output: "done" },
      { callId: "call_4", output: "patched" },
    ]);
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
    ).toEqual([{ callId: "call_3", output: "failed", isError: true }]);
  });
});
