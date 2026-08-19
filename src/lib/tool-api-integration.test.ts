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

  it("rejects unsupported tool types and store=false tool loops", async () => {
    const base = await start();
    const unsupported = await post(base, "/v1/chat/completions", {
      model: "gpt-4",
      messages: [{ role: "user", content: "Search" }],
      tools: [{ type: "web_search" }],
    });
    expect(unsupported.status).toBe(400);
    expect(JSON.parse(unsupported.text).error.code).toBe("invalid_tools");

    const noStore = await post(base, "/v1/responses", {
      model: "gpt-4",
      input: "Weather?",
      store: false,
      tools: [
        {
          type: "function",
          name: "weather",
          parameters: { type: "object", properties: {} },
        },
      ],
    });
    expect(noStore.status).toBe(400);
    expect(JSON.parse(noStore.text).error.code).toBe("invalid_store");
  });
});
