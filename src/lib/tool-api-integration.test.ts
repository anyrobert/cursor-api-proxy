import * as http from "node:http";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { BridgeConfig } from "./config.js";
import { startBridgeServer } from "./server.js";

vi.mock("./cursor-cli.js", () => ({
  listCursorCliModels: vi.fn().mockResolvedValue([
    { id: "gpt-4", name: "gpt-4" },
  ]),
}));

const fakeServerPath = join(
  process.cwd(),
  "src",
  "lib",
  "__tests__",
  "fake-acp-server.mjs",
);
const servers: http.Server[] = [];

function config(scenario = "tool_call"): BridgeConfig {
  return {
    agentBin: "agent",
    acpCommand: process.execPath,
    acpArgs: [fakeServerPath],
    acpEnv: { FAKE_ACP_SCENARIO: scenario },
    host: "127.0.0.1",
    port: 0,
    defaultModel: "gpt-4",
    mode: "ask",
    force: false,
    approveMcps: false,
    strictModel: true,
    workspace: process.cwd(),
    timeoutMs: 10_000,
    sessionsLogPath: "/tmp/cursor-api-proxy-tool-test.log",
    chatOnlyWorkspace: true,
    chatOnlyWorkspaceExplicit: false,
    verbose: false,
    maxMode: false,
    promptViaStdin: false,
    useAcp: true,
    acpSkipAuthenticate: true,
    acpRawDebug: false,
    configDirs: [],
    multiPort: false,
    winCmdlineMax: 30_000,
    contextPreamble: false,
    bridgePackageVersion: "0.0.0-test",
  };
}

async function start(scenario = "tool_call") {
  const [server] = startBridgeServer({
    version: "test",
    config: config(scenario),
  });
  servers.push(server as http.Server);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No port");
  return `http://127.0.0.1:${address.port}`;
}

async function post(
  base: string,
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
) {
  const response = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  return {
    status: response.status,
    text: await response.text(),
  };
}

function sseData(text: string): any[] {
  return text
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data: ") && line !== "data: [DONE]")
    .map((line) => JSON.parse(line.slice(6)));
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => server.close(() => resolve())),
    ),
  );
});

describe.each([false, true])("ACP tool APIs stream=%s", (stream) => {
  it("round-trips Chat Completions tool calls", async () => {
    const base = await start();
    const initial = await post(base, "/v1/chat/completions", {
      model: "gpt-4",
      stream,
      messages: [{ role: "user", content: "Weather?" }],
      tools: [
        {
          type: "function",
          function: {
            name: "weather",
            description: "Get weather",
            parameters: {
              type: "object",
              properties: { city: { type: "string" } },
            },
          },
        },
      ],
    });
    expect(initial.status).toBe(200);
    const chunks = stream ? sseData(initial.text) : [];
    const payload = stream ? undefined : JSON.parse(initial.text);
    const call = stream
      ? chunks
          .flatMap((chunk) => chunk.choices ?? [])
          .flatMap((choice: any) => choice.delta?.tool_calls ?? [])[0]
      : payload.choices[0].message.tool_calls[0];
    expect(call.function.name).toBe("weather");
    expect(
      stream
        ? chunks.some(
            (chunk) => chunk.choices?.[0]?.finish_reason === "tool_calls",
          )
        : payload.choices[0].finish_reason === "tool_calls",
    ).toBe(true);

    const follow = await post(base, "/v1/chat/completions", {
      model: "gpt-4",
      stream: false,
      messages: [
        { role: "user", content: "Weather?" },
        {
          role: "assistant",
          content: null,
          tool_calls: [call],
        },
        {
          role: "tool",
          tool_call_id: call.id,
          content: "sunny",
        },
      ],
    });
    expect(follow.status).toBe(200);
    expect(JSON.parse(follow.text).choices[0].message.content).toContain(
      "Tool result: sunny",
    );
  });

  it("round-trips Responses function calls", async () => {
    const base = await start();
    const initial = await post(base, "/v1/responses", {
      model: "gpt-4",
      stream,
      input: "Weather?",
      tools: [
        {
          type: "function",
          name: "weather",
          description: "Get weather",
          parameters: {
            type: "object",
            properties: { city: { type: "string" } },
          },
        },
      ],
    });
    expect(initial.status).toBe(200);
    const events = stream ? sseData(initial.text) : [];
    const payload = stream
      ? events.find((event) => event.type === "response.completed").response
      : JSON.parse(initial.text);
    const call = payload.output.find(
      (item: any) => item.type === "function_call",
    );
    expect(call.name).toBe("weather");

    const follow = await post(base, "/v1/responses", {
      model: "gpt-4",
      stream: false,
      previous_response_id: payload.id,
      input: [
        {
          type: "function_call_output",
          call_id: call.call_id,
          output: "sunny",
        },
      ],
    });
    expect(follow.status).toBe(200);
    expect(JSON.parse(follow.text).output_text).toContain("Tool result: sunny");
  });

  it("reports namespaced Responses calls under their client namespace", async () => {
    const base = await start("tool_parallel");
    const search = {
      type: "function",
      name: "search",
      parameters: { type: "object", properties: { query: { type: "string" } } },
    };
    const initial = await post(base, "/v1/responses", {
      model: "gpt-4",
      stream,
      input: "Search both",
      tools: [
        { type: "namespace", name: "mcp__docs", tools: [search] },
        { type: "namespace", name: "mcp__wiki", tools: [search] },
        { type: "web_search" },
      ],
    });
    expect(initial.status).toBe(200);
    const events = stream ? sseData(initial.text) : [];
    const payload = stream
      ? events.find((event) => event.type === "response.completed").response
      : JSON.parse(initial.text);
    const calls = payload.output.filter(
      (item: any) => item.type === "function_call",
    );
    expect(
      calls.map((call: any) => [call.namespace, call.name]).sort(),
    ).toEqual([
      ["mcp__docs", "search"],
      ["mcp__wiki", "search"],
    ]);
    if (stream) {
      const added = events
        .filter(
          (event) =>
            event.type === "response.output_item.added" &&
            event.item.type === "function_call",
        )
        .map((event) => [event.item.namespace, event.item.name])
        .sort();
      expect(added).toEqual([
        ["mcp__docs", "search"],
        ["mcp__wiki", "search"],
      ]);
    }

    const follow = await post(base, "/v1/responses", {
      model: "gpt-4",
      stream: false,
      previous_response_id: payload.id,
      input: calls.map((call: any) => ({
        type: "function_call_output",
        call_id: call.call_id,
        output: `${call.namespace}-hit`,
      })),
    });
    expect(follow.status).toBe(200);
    expect(JSON.parse(follow.text).output_text).toContain(
      "Tool result: mcp__docs-hit, mcp__wiki-hit",
    );
  });

  it("round-trips Anthropic tool_use blocks", async () => {
    const base = await start();
    const initial = await post(base, "/v1/messages", {
      model: "gpt-4",
      max_tokens: 256,
      stream,
      messages: [{ role: "user", content: "Weather?" }],
      tools: [
        {
          name: "weather",
          description: "Get weather",
          input_schema: {
            type: "object",
            properties: { city: { type: "string" } },
          },
        },
      ],
    });
    expect(initial.status).toBe(200);
    const events = stream ? sseData(initial.text) : [];
    const payload = stream ? undefined : JSON.parse(initial.text);
    const call = stream
      ? events.find(
          (event) =>
            event.type === "content_block_start" &&
            event.content_block?.type === "tool_use",
        ).content_block
      : payload.content.find((block: any) => block.type === "tool_use");
    expect(call.name).toBe("weather");
    expect(call.caller).toEqual({ type: "direct" });
    if (stream) {
      expect(
        events.some(
          (event) =>
            event.type === "content_block_delta" &&
            event.delta?.type === "input_json_delta",
        ),
      ).toBe(true);
    } else {
      expect(payload.stop_reason).toBe("tool_use");
    }

    const follow = await post(base, "/v1/messages", {
      model: "gpt-4",
      max_tokens: 256,
      stream: false,
      messages: [
        { role: "user", content: "Weather?" },
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: call.id,
              name: call.name,
              input: call.input,
            },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: call.id,
              content: "sunny",
            },
          ],
        },
      ],
    });
    expect(follow.status).toBe(200);
    expect(JSON.parse(follow.text).content[0].text).toContain(
      "Tool result: sunny",
    );
  });
});

describe("ACP tool sessions with media", () => {
  const redPng =
    "iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAAKElEQVR4nO3NMQEAAAjDMMC/ZzDBvlRA01vZJvwHAAAAAAAAAAAAbx2jxAE/i2AjOgAAAABJRU5ErkJggg==";
  // Resolving this URL fails, so a 200 proves the resumed turn did not
  // re-fetch media that the opening prompt already delivered.
  const unfetchableImage = "https://127.0.0.1/gone.png";

  it("does not re-resolve history media on a Chat Completions tool result", async () => {
    const base = await start();
    const tools = [
      {
        type: "function",
        function: {
          name: "weather",
          description: "Get weather",
          parameters: { type: "object", properties: { city: { type: "string" } } },
        },
      },
    ];
    const initial = await post(base, "/v1/chat/completions", {
      model: "gpt-4",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Weather where this photo was taken?" },
            { type: "image_url", image_url: { url: `data:image/png;base64,${redPng}` } },
          ],
        },
      ],
      tools,
    });
    expect(initial.status).toBe(200);
    const call = JSON.parse(initial.text).choices[0].message.tool_calls[0];

    const follow = await post(base, "/v1/chat/completions", {
      model: "gpt-4",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Weather where this photo was taken?" },
            { type: "image_url", image_url: { url: unfetchableImage } },
          ],
        },
        { role: "assistant", content: null, tool_calls: [call] },
        { role: "tool", tool_call_id: call.id, content: "sunny" },
      ],
    });
    expect(follow.status).toBe(200);
    expect(JSON.parse(follow.text).choices[0].message.content).toContain(
      "Tool result: sunny",
    );
  });

  it("does not re-resolve history media on an Anthropic tool_result", async () => {
    const base = await start();
    const initial = await post(base, "/v1/messages", {
      model: "gpt-4",
      max_tokens: 256,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Weather where this photo was taken?" },
            { type: "image", source: { type: "base64", media_type: "image/png", data: redPng } },
          ],
        },
      ],
      tools: [
        {
          name: "weather",
          description: "Get weather",
          input_schema: { type: "object", properties: { city: { type: "string" } } },
        },
      ],
    });
    expect(initial.status).toBe(200);
    const call = JSON.parse(initial.text).content.find(
      (block: any) => block.type === "tool_use",
    );

    const follow = await post(base, "/v1/messages", {
      model: "gpt-4",
      max_tokens: 256,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Weather where this photo was taken?" },
            { type: "image", source: { type: "url", url: unfetchableImage } },
          ],
        },
        {
          role: "assistant",
          content: [{ type: "tool_use", id: call.id, name: call.name, input: call.input }],
        },
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: call.id, content: "sunny" }],
        },
      ],
    });
    expect(follow.status).toBe(200);
    expect(JSON.parse(follow.text).content[0].text).toContain(
      "Tool result: sunny",
    );
  });
});

describe("ACP tool session errors", () => {
  it("returns conflict for unknown tool call ids", async () => {
    const base = await start();
    const response = await post(base, "/v1/chat/completions", {
      model: "gpt-4",
      messages: [
        { role: "tool", tool_call_id: "call_missing", content: "result" },
      ],
    });
    expect(response.status).toBe(409);
    expect(JSON.parse(response.text).error.code).toBe("tool_session_expired");
  });

  it("supports partial parallel results", async () => {
    const base = await start("tool_parallel");
    const initial = await post(base, "/v1/chat/completions", {
      model: "gpt-4",
      messages: [{ role: "user", content: "Both?" }],
      tools: [
        {
          type: "function",
          function: {
            name: "weather",
            parameters: { type: "object", properties: {} },
          },
        },
        {
          type: "function",
          function: {
            name: "time",
            parameters: { type: "object", properties: {} },
          },
        },
      ],
    });
    const calls = JSON.parse(initial.text).choices[0].message.tool_calls;
    expect(calls).toHaveLength(2);

    const partial = await post(base, "/v1/chat/completions", {
      model: "gpt-4",
      messages: [
        {
          role: "tool",
          tool_call_id: calls[0].id,
          content: "weather-result",
        },
      ],
    });
    const remaining = JSON.parse(partial.text).choices[0].message.tool_calls;
    expect(remaining).toHaveLength(1);
    expect(remaining[0].id).toBe(calls[1].id);

    const final = await post(base, "/v1/chat/completions", {
      model: "gpt-4",
      messages: [
        {
          role: "tool",
          tool_call_id: calls[1].id,
          content: "time-result",
        },
      ],
    });
    expect(JSON.parse(final.text).choices[0].message.content).toContain(
      "weather-result, time-result",
    );
  });

  it("binds pending calls to the initiating API owner", async () => {
    const base = await start();
    const initial = await post(
      base,
      "/v1/chat/completions",
      {
        model: "gpt-4",
        messages: [{ role: "user", content: "Weather?" }],
        tools: [
          {
            type: "function",
            function: {
              name: "weather",
              parameters: { type: "object", properties: {} },
            },
          },
        ],
      },
      { authorization: "Bearer owner-a" },
    );
    const call = JSON.parse(initial.text).choices[0].message.tool_calls[0];
    const wrongOwner = await post(
      base,
      "/v1/chat/completions",
      {
        model: "gpt-4",
        messages: [
          {
            role: "tool",
            tool_call_id: call.id,
            content: "stolen",
          },
        ],
      },
      { authorization: "Bearer owner-b" },
    );
    expect(wrongOwner.status).toBe(409);
  });

  it("serializes concurrent results for one parallel turn", async () => {
    const base = await start("tool_parallel");
    const initial = await post(base, "/v1/chat/completions", {
      model: "gpt-4",
      messages: [{ role: "user", content: "Both?" }],
      tools: [
        {
          type: "function",
          function: {
            name: "weather",
            parameters: { type: "object", properties: {} },
          },
        },
        {
          type: "function",
          function: {
            name: "time",
            parameters: { type: "object", properties: {} },
          },
        },
      ],
    });
    const calls = JSON.parse(initial.text).choices[0].message.tool_calls;
    const replies = await Promise.all(
      calls.map((call: any) =>
        post(base, "/v1/chat/completions", {
          model: "gpt-4",
          messages: [
            {
              role: "tool",
              tool_call_id: call.id,
              content: `${call.function.name}-result`,
            },
          ],
        }),
      ),
    );
    expect(replies.every((reply) => reply.status === 200)).toBe(true);
    const payloads = replies.map((reply) => JSON.parse(reply.text));
    expect(
      payloads.some((payload) =>
        payload.choices[0].message.content?.includes(
          "weather-result, time-result",
        ),
      ),
    ).toBe(true);
  });

  it("ignores host builtin tool types", async () => {
    const base = await start();
    const unsupported = await post(base, "/v1/chat/completions", {
      model: "gpt-4",
      messages: [{ role: "user", content: "Search" }],
      tools: [
        { type: "web_search" },
        {
          type: "namespace",
          name: "mcp__weather",
          tools: [
            {
              type: "function",
              name: "weather",
              parameters: { type: "object", properties: {} },
            },
          ],
        },
      ],
    });
    expect(unsupported.status).toBe(200);
    expect(
      JSON.parse(unsupported.text).choices[0].message.tool_calls[0].function
        .name,
    ).toBe("weather");
  });

  it("rejects tool_choice required when only builtins were sent", async () => {
    const base = await start();
    const responses = await post(base, "/v1/responses", {
      model: "gpt-4",
      input: "Search",
      tool_choice: "required",
      tools: [{ type: "web_search" }],
    });
    const chat = await post(base, "/v1/chat/completions", {
      model: "gpt-4",
      messages: [{ role: "user", content: "Search" }],
      tool_choice: "required",
      tools: [{ type: "web_search" }],
    });
    for (const reply of [responses, chat]) {
      expect(reply.status).toBe(400);
      const error = JSON.parse(reply.text).error;
      expect(error.code).toBe("invalid_tools");
      expect(error.message).toMatch(/no callable function tools/);
    }
  });

  it("keeps Anthropic server tools away from the agent", async () => {
    const base = await start();
    const reply = await post(base, "/v1/messages", {
      model: "gpt-4",
      max_tokens: 256,
      messages: [{ role: "user", content: "Weather?" }],
      tools: [
        { type: "web_search_20250305", name: "web_search", max_uses: 3 },
        { type: "bash_20250124", name: "bash" },
        {
          name: "weather",
          input_schema: {
            type: "object",
            properties: { city: { type: "string" } },
          },
        },
      ],
    });
    expect(reply.status).toBe(200);
    const blocks = JSON.parse(reply.text).content;
    expect(
      blocks
        .filter((block: any) => block.type === "tool_use")
        .map((block: any) => block.name),
    ).toEqual(["weather"]);
  });

  it("rejects an Anthropic tool_choice only server tools could satisfy", async () => {
    const base = await start();
    const request = (toolChoice: unknown) =>
      post(base, "/v1/messages", {
        model: "gpt-4",
        max_tokens: 256,
        messages: [{ role: "user", content: "Search" }],
        tool_choice: toolChoice,
        tools: [
          { type: "web_search_20250305", name: "web_search" },
          { type: "text_editor_20250728", name: "str_replace_based_edit_tool" },
        ],
      });
    const cases: Array<[unknown, RegExp]> = [
      [
        { type: "any" },
        /no callable function tools; the agent cannot run web_search \(web_search_20250305\)/,
      ],
      [
        { type: "tool", name: "web_search" },
        /tool_choice names web_search, a web_search_20250305 tool the agent cannot run/,
      ],
    ];
    for (const [toolChoice, message] of cases) {
      const reply = await request(toolChoice);
      expect(reply.status).toBe(400);
      const error = JSON.parse(reply.text).error;
      expect(error.type).toBe("invalid_request_error");
      expect(error.message).toMatch(message);
    }
  });
});

const weatherTool = {
  type: "function",
  name: "weather",
  description: "Get weather",
  parameters: { type: "object", properties: { city: { type: "string" } } },
};

function userMessage(text: string) {
  return { type: "message", role: "user", content: [{ type: "input_text", text }] };
}

/**
 * A request shaped like Codex CLI's: the whole history every time, the same
 * instructions, store=false and no previous_response_id.
 */
function transcriptTurn(input: unknown[], stream = false) {
  return {
    model: "gpt-4",
    instructions: "You are a coding agent.",
    input,
    tools: [weatherTool],
    tool_choice: "auto",
    parallel_tool_calls: true,
    store: false,
    stream,
  };
}

function responseFrom(reply: { status: number; text: string }, stream = false) {
  expect(reply.status).toBe(200);
  return stream
    ? sseData(reply.text).find((event) => event.type === "response.completed")
        .response
    : JSON.parse(reply.text);
}

function functionCalls(response: any): any[] {
  return response.output.filter((item: any) => item.type === "function_call");
}

/** The call and its result as a client records them in its history. */
function answered(call: any, output: string) {
  return [
    {
      type: "function_call",
      id: call.id,
      call_id: call.call_id,
      name: call.name,
      arguments: call.arguments,
    },
    { type: "function_call_output", call_id: call.call_id, output },
  ];
}

describe.each([false, true])("Responses transcript clients stream=%s", (stream) => {
  it("resumes a store=false turn by call_id", async () => {
    const base = await start();
    const question = userMessage("Weather?");
    const first = responseFrom(
      await post(base, "/v1/responses", transcriptTurn([question], stream)),
      stream,
    );
    expect(first.store).toBe(false);
    const [call] = functionCalls(first);
    expect(call.name).toBe("weather");

    const second = responseFrom(
      await post(
        base,
        "/v1/responses",
        transcriptTurn([question, ...answered(call, "sunny")], stream),
      ),
      stream,
    );
    expect(second.output_text).toContain("Tool result: sunny");
    expect(second.previous_response_id).toBeNull();
    expect(functionCalls(second)).toEqual([]);
  });
});

describe("Responses transcript clients", () => {
  it("skips outputs already resolved earlier in the same turn", async () => {
    const base = await start("tool_two_round");
    const question = userMessage("Weather twice?");
    const first = responseFrom(
      await post(base, "/v1/responses", transcriptTurn([question])),
    );
    const [callA] = functionCalls(first);

    const second = responseFrom(
      await post(
        base,
        "/v1/responses",
        transcriptTurn([question, ...answered(callA, "a-out")]),
      ),
    );
    const [callB] = functionCalls(second);
    expect(callB.call_id).not.toBe(callA.call_id);

    const third = responseFrom(
      await post(
        base,
        "/v1/responses",
        transcriptTurn([
          question,
          ...answered(callA, "a-out"),
          ...answered(callB, "b-out"),
        ]),
      ),
    );
    expect(third.output_text).toContain("Tool result: a-out, b-out");
  });

  it("starts a new tool turn after a completed one in a full-history resend", async () => {
    const base = await start();
    const question = userMessage("Weather?");
    const first = responseFrom(
      await post(base, "/v1/responses", transcriptTurn([question])),
    );
    const [call] = functionCalls(first);
    const finished = responseFrom(
      await post(
        base,
        "/v1/responses",
        transcriptTurn([question, ...answered(call, "sunny")]),
      ),
    );

    const next = responseFrom(
      await post(
        base,
        "/v1/responses",
        transcriptTurn([
          question,
          ...answered(call, "sunny"),
          ...finished.output,
          userMessage("And tomorrow?"),
        ]),
      ),
    );
    const [nextCall] = functionCalls(next);
    expect(nextCall.name).toBe("weather");
    expect(nextCall.call_id).not.toBe(call.call_id);
  });

  it("does not resume a parked call from an earlier turn's output", async () => {
    const base = await start("tool_transcript");
    const question = userMessage("Weather?");
    const first = responseFrom(
      await post(base, "/v1/responses", transcriptTurn([question])),
    );
    const [call] = functionCalls(first);

    const moved = responseFrom(
      await post(
        base,
        "/v1/responses",
        transcriptTurn([
          question,
          ...answered(call, "sunny"),
          userMessage("Never mind, summarize."),
        ]),
      ),
    );
    expect(moved.output_text).toContain("Answer from transcript: sunny");
    expect(moved.output_text).not.toContain("Tool result");
    // A new user turn is not a rebuilt one, so it gets no continuation note.
    expect(moved.output_text).not.toContain("[continued]");

    // The new turn closed the parked session it moved past.
    const late = await post(base, "/v1/responses", {
      model: "gpt-4",
      previous_response_id: first.id,
      input: [{ type: "function_call_output", call_id: call.call_id, output: "late" }],
    });
    expect(late.status).toBe(409);
  });

  it("rebuilds an unknown or expired call from the transcript", async () => {
    const base = await start("tool_transcript");
    const unknown = {
      id: "fc_gone",
      call_id: "call_gone",
      name: "weather",
      arguments: "{}",
    };
    const rebuilt = responseFrom(
      await post(
        base,
        "/v1/responses",
        transcriptTurn([userMessage("Weather?"), ...answered(unknown, "rainy")]),
      ),
    );
    expect(rebuilt.output_text).toContain(
      "[continued] Answer from transcript: rainy",
    );

    const bare = await post(base, "/v1/responses", {
      model: "gpt-4",
      store: false,
      input: [{ type: "function_call_output", call_id: "call_gone", output: "rainy" }],
    });
    expect(bare.status).toBe(409);
    expect(JSON.parse(bare.text).error.code).toBe("tool_session_expired");
  });

  it("never resumes another owner's parked call", async () => {
    const base = await start("tool_transcript");
    const owner = { authorization: "Bearer owner-a" };
    const intruder = { authorization: "Bearer owner-b" };
    const question = userMessage("Weather?");
    const first = responseFrom(
      await post(base, "/v1/responses", transcriptTurn([question]), owner),
    );
    const [call] = functionCalls(first);

    const replay = responseFrom(
      await post(
        base,
        "/v1/responses",
        transcriptTurn([question, ...answered(call, "stolen")]),
        intruder,
      ),
    );
    expect(replay.output_text).toContain("Answer from transcript: stolen");
    const bare = await post(
      base,
      "/v1/responses",
      {
        model: "gpt-4",
        store: false,
        input: [{ type: "function_call_output", call_id: call.call_id, output: "stolen" }],
      },
      intruder,
    );
    expect(bare.status).toBe(409);

    const resumed = responseFrom(
      await post(
        base,
        "/v1/responses",
        transcriptTurn([question, ...answered(call, "sunny")]),
        owner,
      ),
    );
    expect(resumed.output_text).toContain("Tool result: sunny");
  });

  it("rejects outputs that answer two different parked turns", async () => {
    const base = await start();
    const first = responseFrom(
      await post(base, "/v1/responses", transcriptTurn([userMessage("Paris?")])),
    );
    const second = responseFrom(
      await post(base, "/v1/responses", transcriptTurn([userMessage("London?")])),
    );
    const reply = await post(
      base,
      "/v1/responses",
      transcriptTurn([
        userMessage("Both?"),
        ...answered(functionCalls(first)[0], "a"),
        ...answered(functionCalls(second)[0], "b"),
      ]),
    );
    expect(reply.status).toBe(400);
    expect(JSON.parse(reply.text).error.code).toBe("invalid_tool_resume");
  });

  it("keeps previous_response_id resumes strict", async () => {
    const base = await start();
    const first = responseFrom(
      await post(base, "/v1/responses", {
        model: "gpt-4",
        input: "Weather?",
        tools: [weatherTool],
      }),
    );
    const [call] = functionCalls(first);
    const output = {
      type: "function_call_output",
      call_id: call.call_id,
      output: "sunny",
    };

    const mixed = await post(base, "/v1/responses", {
      model: "gpt-4",
      previous_response_id: first.id,
      input: [userMessage("Weather?"), output],
    });
    expect(mixed.status).toBe(400);
    expect(JSON.parse(mixed.text).error.code).toBe("invalid_tool_resume");

    const withInstructions = await post(base, "/v1/responses", {
      model: "gpt-4",
      previous_response_id: first.id,
      instructions: "new rules",
      input: [output],
    });
    expect(withInstructions.status).toBe(400);
    expect(JSON.parse(withInstructions.text).error.code).toBe(
      "invalid_tool_resume",
    );

    const unknown = await post(base, "/v1/responses", {
      model: "gpt-4",
      previous_response_id: "resp_missing",
      input: [output],
    });
    expect(unknown.status).toBe(409);
    expect(JSON.parse(unknown.text).error.code).toBe("tool_session_expired");

    const resumed = responseFrom(
      await post(base, "/v1/responses", {
        model: "gpt-4",
        previous_response_id: first.id,
        input: [output],
      }),
    );
    expect(resumed.output_text).toContain("Tool result: sunny");
    expect(resumed.previous_response_id).toBe(first.id);
  });
});
