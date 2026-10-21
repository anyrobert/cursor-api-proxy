import { describe, expect, it } from "vitest";

import {
  anthropicBuiltinToolNames,
  anthropicToolOutputs,
  chatToolOutputs,
  parseAnthropicFunctionTools,
  parseOpenAiFunctionTools,
  resolveToolChoice,
  responsesCallIds,
  responsesToolOutputs,
  responsesTurnToolOutputs,
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
        namespaced: { namespace: "multi_agent_v1", name: "close_agent" },
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
    expect(
      tools.map((tool) => ({ name: tool.name, namespaced: tool.namespaced })),
    ).toEqual([
      { name: "search", namespaced: undefined },
      {
        name: "mcp__docs__search",
        namespaced: { namespace: "mcp__docs", name: "search" },
      },
      {
        name: "mcp__wiki__search",
        namespaced: { namespace: "mcp__wiki", name: "search" },
      },
    ]);
  });

  it("keeps a top-level function's bare name when a namespace lists it first", () => {
    const tools = parseOpenAiFunctionTools([
      {
        type: "namespace",
        name: "mcp__docs",
        tools: [{ type: "function", name: "search" }],
      },
      { type: "function", name: "search" },
    ]);
    expect(tools.map((tool) => tool.name)).toEqual([
      "mcp__docs__search",
      "search",
    ]);
    expect(tools[1].namespaced).toBeUndefined();
  });

  it("rejects a namespace member declared twice", () => {
    expect(() =>
      parseOpenAiFunctionTools([
        {
          type: "namespace",
          name: "mcp__docs",
          tools: [
            { type: "function", name: "search" },
            { type: "function", name: "search" },
          ],
        },
      ]),
    ).toThrow(/Duplicate function tool name: mcp__docs\.search/);
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

  it("rejects a required tool_choice when no callable tool is left", () => {
    const builtinsOnly = parseOpenAiFunctionTools([{ type: "web_search" }]);
    expect(() => resolveToolChoice(builtinsOnly, "required")).toThrow(
      /tool_choice "required" requires a tool call, but the request has no callable function tools/,
    );
    expect(() => resolveToolChoice([], { type: "any" })).toThrow(
      /tool_choice "any" requires a tool call/,
    );
    expect(resolveToolChoice(builtinsOnly, "auto").tools).toEqual([]);
    expect(resolveToolChoice(builtinsOnly, "none").tools).toEqual([]);
  });

  it("names Anthropic-defined tools but not client tools", () => {
    expect(
      anthropicBuiltinToolNames([
        { type: "web_search_20250305", name: "web_search", max_uses: 5 },
        { type: "bash_20250124", name: "bash" },
        { type: "text_editor_20250124", name: "str_replace_editor" },
        { name: "lookup", input_schema: { type: "object" } },
        { type: "custom", name: "custom_tool", input_schema: {} },
        { type: "computer_20250124" },
        null,
      ]),
    ).toEqual(new Set(["web_search", "bash", "str_replace_editor"]));
    expect(anthropicBuiltinToolNames(undefined)).toEqual(new Set());
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

  describe("full-history Responses input", () => {
    const call = (id: string) => ({
      type: "function_call",
      call_id: id,
      name: "exec_command",
      arguments: "{}",
    });
    const output = (id: string) => ({
      type: "function_call_output",
      call_id: id,
      output: `${id}-out`,
    });
    const message = (role: string, text: string) => ({
      type: "message",
      role,
      content: [{ type: "input_text", text }],
    });

    it("keeps only the outputs after the latest user message", () => {
      expect(
        responsesTurnToolOutputs([
          message("developer", "rules"),
          message("user", "first"),
          call("call_old"),
          output("call_old"),
          message("assistant", "done"),
          message("user", "second"),
          { type: "reasoning", summary: [] },
          call("call_a"),
          output("call_a"),
          message("assistant", "next"),
          call("call_b"),
          output("call_b"),
        ]).map((item) => item.callId),
      ).toEqual(["call_a", "call_b"]);
    });

    it("finds no current-turn outputs once a new user turn starts", () => {
      const input = [message("user", "first"), call("call_1"), output("call_1")];
      expect(
        responsesTurnToolOutputs([...input, message("user", "second")]),
      ).toEqual([]);
      expect(responsesTurnToolOutputs([...input, "second"])).toEqual([]);
      expect(
        responsesTurnToolOutputs([...input, { role: "developer", content: "x" }]),
      ).toEqual([]);
    });

    it("treats an input of outputs only as the current turn", () => {
      expect(responsesTurnToolOutputs([output("call_1")])).toEqual([
        { callId: "call_1", output: "call_1-out" },
      ]);
      expect(responsesTurnToolOutputs("plain text")).toEqual([]);
    });

    it("lists every call id once", () => {
      expect(
        responsesCallIds([
          message("user", "first"),
          call("call_1"),
          output("call_1"),
          call("call_2"),
          { type: "function_call_output" },
        ]),
      ).toEqual(["call_1", "call_2"]);
    });
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
