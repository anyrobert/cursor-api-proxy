import { describe, expect, it } from "vitest";

import {
  anthropicToolOutputs,
  callIdentity,
  chatToolOutputs,
  droppedToolsNote,
  freeformArguments,
  freeformInput,
  isResponsesToolOutput,
  parseAnthropicFunctionTools,
  parseOpenAiFunctionTools,
  resolveToolChoice,
  responsesCallIds,
  responsesToolOutputs,
  responsesTurnToolOutputs,
  type ClientToolDefinition,
  type ParsedClientTools,
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
      ]).tools,
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
      ]).tools[0].name,
    ).toBe("legacy");
    expect(
      parseAnthropicFunctionTools([
        {
          name: "anthropic",
          input_schema: { type: "object", properties: {} },
        },
      ]).tools[0].inputSchema,
    ).toEqual({ type: "object", properties: {} });
  });

  it("ignores host-side builtin tools and rejects duplicates", () => {
    expect(parseOpenAiFunctionTools([{ type: "web_search" }])).toEqual({
      tools: [],
      dropped: [{ type: "web_search" }],
    });
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
      ]).tools,
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
    const { tools } = parseOpenAiFunctionTools([
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
    const { tools } = parseOpenAiFunctionTools([
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
    ).toEqual({ tools: [], dropped: [] });
  });

  it("reports every tool it drops", () => {
    expect(
      parseOpenAiFunctionTools([
        { type: "web_search", external_web_access: true },
        { type: "mcp", server_label: "deepwiki" },
        {
          type: "namespace",
          name: "mcp__img",
          tools: [
            { type: "image_generation", name: "draw" },
            { type: "function", name: "crop" },
          ],
        },
        { description: "no type" },
      ]),
    ).toEqual({
      tools: [
        {
          name: "crop",
          description: undefined,
          inputSchema: { type: "object", properties: {} },
          namespaced: { namespace: "mcp__img", name: "crop" },
        },
      ],
      dropped: [
        { type: "web_search" },
        { type: "mcp" },
        { type: "image_generation", name: "mcp__img.draw" },
        { type: "untyped" },
      ],
    });
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
    const builtinsOnly = parseOpenAiFunctionTools([
      { type: "web_search" },
    ]).tools;
    expect(() => resolveToolChoice(builtinsOnly, "required")).toThrow(
      /tool_choice "required" requires a tool call, but the request has no callable function tools/,
    );
    expect(() => resolveToolChoice([], { type: "any" })).toThrow(
      /tool_choice "any" requires a tool call/,
    );
    expect(resolveToolChoice(builtinsOnly, "auto").tools).toEqual([]);
    expect(resolveToolChoice(builtinsOnly, "none").tools).toEqual([]);
  });

  it("drops Anthropic-defined tools and keeps client tools", () => {
    expect(
      parseAnthropicFunctionTools([
        { type: "web_search_20250305", name: "web_search", max_uses: 5 },
        { type: "bash_20250124", name: "bash" },
        { type: "text_editor_20250728", name: "str_replace_based_edit_tool" },
        { type: "code_execution_20250825", name: "code_execution" },
        { type: "mcp_toolset", mcp_server_name: "docs" },
        { name: "lookup", input_schema: { type: "object" } },
        { type: "custom", name: "custom_tool", input_schema: {} },
      ]),
    ).toEqual({
      tools: [
        {
          name: "lookup",
          description: undefined,
          inputSchema: { type: "object" },
        },
        { name: "custom_tool", description: undefined, inputSchema: {} },
      ],
      dropped: [
        { type: "web_search_20250305", name: "web_search" },
        { type: "bash_20250124", name: "bash" },
        { type: "text_editor_20250728", name: "str_replace_based_edit_tool" },
        { type: "code_execution_20250825", name: "code_execution" },
        { type: "mcp_toolset" },
      ],
    });
    expect(parseAnthropicFunctionTools(undefined)).toEqual({
      tools: [],
      dropped: [],
    });
    expect(() => parseAnthropicFunctionTools([null])).toThrow(/missing name/);
  });

  it("rejects an Anthropic tool_choice only a server tool could satisfy", () => {
    const serverOnly = parseAnthropicFunctionTools([
      { type: "web_search_20250305", name: "web_search" },
      { type: "bash_20250124", name: "bash" },
    ]);
    const choose = (parsed: ParsedClientTools, choice: unknown) =>
      resolveToolChoice(parsed.tools, choice, { dropped: parsed.dropped });
    const webSearch = { type: "tool", name: "web_search" };
    expect(() => choose(serverOnly, { type: "any" })).toThrow(
      'tool_choice "any" requires a tool call, but the request has no ' +
        "callable function tools; the agent cannot run web_search " +
        "(web_search_20250305), bash (bash_20250124)",
    );
    expect(() => choose(serverOnly, webSearch)).toThrow(
      "tool_choice names web_search, a web_search_20250305 tool the agent " +
        "cannot run",
    );
    expect(choose(serverOnly, { type: "auto" }).tools).toEqual([]);

    const mixed = parseAnthropicFunctionTools([
      { type: "web_search_20250305", name: "web_search" },
      { name: "lookup" },
    ]);
    expect(() => choose(mixed, webSearch)).toThrow(
      /web_search_20250305 tool the agent cannot run/,
    );
    expect(
      choose(mixed, { type: "any" }).tools.map((tool) => tool.name),
    ).toEqual(["lookup"]);
  });

  it("names dropped tools in one verbose-log line", () => {
    expect(droppedToolsNote([])).toBeUndefined();
    expect(
      droppedToolsNote(
        parseAnthropicFunctionTools([
          { type: "web_search_20250305", name: "web_search" },
          { type: "mcp_toolset", mcp_server_name: "docs" },
        ]).dropped,
      ),
    ).toBe(
      "ignored tools the agent cannot run: web_search (web_search_20250305), mcp_toolset",
    );
  });
});

describe("freeform custom tools", () => {
  const inputSchema = {
    type: "object",
    properties: {
      input: {
        type: "string",
        description: "The tool's raw input text, passed on unchanged.",
      },
    },
    required: ["input"],
    additionalProperties: false,
  };
  const inputNote =
    "Pass the tool's whole input as raw text in the `input` string.";

  it("maps a custom tool to a function of one input string", () => {
    expect(
      parseOpenAiFunctionTools([
        {
          type: "custom",
          name: "apply_patch",
          description: "Edit files. This is a FREEFORM tool.",
          format: {
            type: "grammar",
            syntax: "lark",
            definition: "start: begin_patch hunk+ end_patch",
          },
        },
      ]),
    ).toEqual({
      tools: [
        {
          name: "apply_patch",
          description: [
            "Edit files. This is a FREEFORM tool.",
            inputNote,
            "The text must match this Lark grammar:\nstart: begin_patch hunk+ end_patch",
          ].join("\n\n"),
          inputSchema,
          freeform: true,
        },
      ],
      dropped: [],
    });
  });

  it("describes each input format", () => {
    const descriptionFor = (format?: unknown) =>
      parseOpenAiFunctionTools([{ type: "custom", name: "t", format }])
        .tools[0].description;
    expect(descriptionFor()).toBe(inputNote);
    expect(descriptionFor({ type: "text" })).toBe(inputNote);
    expect(
      descriptionFor({ type: "grammar", syntax: "regex", definition: "^\\d+$" }),
    ).toBe(`${inputNote}\n\nThe text must match this regular expression:\n^\\d+$`);
    expect(
      descriptionFor({ type: "grammar", syntax: "peg", definition: "a <- 'a'" }),
    ).toBe(`${inputNote}\n\nThe text must match this grammar:\na <- 'a'`);
  });

  it("reads Chat's nested shape and namespace members", () => {
    const { tools } = parseOpenAiFunctionTools([
      { type: "custom", custom: { name: "chat_patch", description: "Chat." } },
      {
        type: "namespace",
        name: "mcp__fs",
        tools: [
          { type: "custom", name: "chat_patch" },
          { type: "custom", name: "write" },
        ],
      },
    ]);
    expect(
      tools.map(({ name, freeform, namespaced }) => ({
        name,
        freeform,
        namespaced,
      })),
    ).toEqual([
      { name: "chat_patch", freeform: true, namespaced: undefined },
      {
        name: "mcp__fs__chat_patch",
        freeform: true,
        namespaced: { namespace: "mcp__fs", name: "chat_patch" },
      },
      {
        name: "write",
        freeform: true,
        namespaced: { namespace: "mcp__fs", name: "write" },
      },
    ]);
    expect(tools[0].description).toBe(`Chat.\n\n${inputNote}`);
    expect(() =>
      parseOpenAiFunctionTools([{ type: "custom", custom: {} }]),
    ).toThrow(/Custom tool is missing name/);
    expect(() =>
      parseOpenAiFunctionTools([
        { type: "function", name: "apply_patch" },
        { type: "custom", name: "apply_patch" },
      ]),
    ).toThrow(/Duplicate function tool name: apply_patch/);
  });

  it("selects a custom tool by name in either API's tool_choice", () => {
    const { tools } = parseOpenAiFunctionTools([
      { type: "function", name: "shell" },
      { type: "custom", name: "apply_patch" },
    ]);
    for (const choice of [
      { type: "custom", name: "apply_patch" },
      { type: "custom", custom: { name: "apply_patch" } },
    ]) {
      const resolved = resolveToolChoice(tools, choice);
      expect(resolved.tools.map((tool) => tool.name)).toEqual(["apply_patch"]);
      expect(resolved.required).toBe(true);
      expect(resolved.instruction).toBe("You must call the apply_patch tool.");
    }
  });

  it("turns the agent's arguments back into the raw text", () => {
    const patch = '*** Begin Patch\n*** Add File: "a".txt\n+hi\n*** End Patch';
    expect(freeformInput(freeformArguments(patch))).toBe(patch);
    expect(freeformInput('{"input":"x","extra":1}')).toBe("x");
    // Without an input string the text passes on as the agent sent it.
    expect(freeformInput('{"city":"Paris"}')).toBe('{"city":"Paris"}');
    expect(freeformInput('{"input":42}')).toBe('{"input":42}');
    expect(freeformInput("not json")).toBe("not json");
    expect(freeformArguments(undefined)).toBe('{"input":""}');
  });

  it("copies only the identity fields a tool sets", () => {
    const namespaced = { namespace: "mcp__fs", name: "write" };
    const definition: ClientToolDefinition = {
      name: "mcp__fs__write",
      description: "Write a file.",
      inputSchema: {},
      namespaced,
      freeform: true,
    };
    expect(callIdentity(definition)).toEqual({ namespaced, freeform: true });
    expect(callIdentity({})).toEqual({});
    expect(callIdentity({ freeform: false })).toEqual({});
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

    it("treats custom tool calls and outputs like function calls", () => {
      const customCall = (id: string) => ({
        type: "custom_tool_call",
        call_id: id,
        name: "apply_patch",
        input: "*** Begin Patch",
      });
      const customOutput = (id: string) => ({
        type: "custom_tool_call_output",
        call_id: id,
        output: `${id}-out`,
      });
      const input = [
        message("user", "first"),
        customCall("call_old"),
        customOutput("call_old"),
        message("user", "second"),
        call("call_a"),
        output("call_a"),
        customCall("call_b"),
        customOutput("call_b"),
      ];
      expect(responsesTurnToolOutputs(input)).toEqual([
        { callId: "call_a", output: "call_a-out" },
        { callId: "call_b", output: "call_b-out" },
      ]);
      expect(responsesCallIds(input)).toEqual([
        "call_old",
        "call_a",
        "call_b",
      ]);
      expect(responsesCallIds([customCall("call_parked")])).toEqual([
        "call_parked",
      ]);
    });
  });

  it("reads Responses custom_tool_call_output", () => {
    expect(
      responsesToolOutputs([
        { type: "custom_tool_call", call_id: "call_4", input: "x" },
        { type: "custom_tool_call_output", call_id: "call_4", output: "ok" },
      ]),
    ).toEqual([{ callId: "call_4", output: "ok" }]);
    expect(() =>
      responsesToolOutputs([{ type: "custom_tool_call_output", output: "ok" }]),
    ).toThrow("custom_tool_call_output is missing call_id");
    expect(isResponsesToolOutput({ type: "custom_tool_call_output" })).toBe(
      true,
    );
    expect(isResponsesToolOutput({ type: "function_call_output" })).toBe(true);
    expect(isResponsesToolOutput({ type: "custom_tool_call" })).toBe(false);
    expect(isResponsesToolOutput(null)).toBe(false);
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
