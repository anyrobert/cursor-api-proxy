import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { AcpToolSession } from "./acp-tool-session.js";
import type { ClientToolDefinition } from "./tool-types.js";

const node = process.execPath;
const cwd = process.cwd();
const fakeServerPath = join(
  cwd,
  "src",
  "lib",
  "__tests__",
  "fake-acp-server.mjs",
);
const fakeMcpClientAgentPath = join(
  cwd,
  "src",
  "lib",
  "__tests__",
  "fake-acp-mcp-client.mjs",
);

const sessions: AcpToolSession[] = [];

function createSession(
  scenario: string,
  tools: ClientToolDefinition[] = [
    {
      name: "weather",
      description: "Get weather",
      inputSchema: {
        type: "object",
        properties: { city: { type: "string" } },
      },
    },
  ],
  overrides: Partial<ConstructorParameters<typeof AcpToolSession>[0]> = {},
) {
  const session = new AcpToolSession({
    command: node,
    args: [fakeServerPath],
    cwd,
    env: { FAKE_ACP_SCENARIO: scenario },
    timeoutMs: 5_000,
    skipAuthenticate: true,
    tools,
    ...overrides,
  });
  sessions.push(session);
  return session;
}

afterEach(async () => {
  await Promise.all(sessions.splice(0).map((session) => session.close()));
});

describe("AcpToolSession", () => {
  it("fails a request without crashing the proxy when ACP stdin closes", async () => {
    const session = createSession("closed_stdin_after_initialize");
    await expect(session.start("Use weather")).rejects.toThrow(/EPIPE/);
  });

  it("attaches private HTTP MCP and parks tools/call", async () => {
    const session = createSession("tool_call");
    await session.start("Use weather");

    const first = await session.collect();
    expect(first.status).toBe("tool_calls");
    if (first.status !== "tool_calls") return;
    expect(first.text).toBe("Checking tools.");
    expect(first.toolCalls).toHaveLength(1);
    expect(first.toolCalls[0]).toMatchObject({
      name: "weather",
    });
    expect(JSON.parse(first.toolCalls[0].arguments)).toMatchObject({
      city: "Paris",
    });

    const final = await session.resume([
      { callId: first.toolCalls[0].callId, output: "sunny" },
    ]);
    expect(final.status).toBe("completed");
    expect(final.text).toContain("Tool result: sunny");
  });

  it("answers the agent's retries of a timed-out call once (#64)", async () => {
    const session = createSession("retry_on_timeout", undefined, {
      args: [fakeMcpClientAgentPath],
      env: {
        FAKE_ACP_MCP_SCENARIO: "retry_on_timeout",
        FAKE_ACP_MCP_TIMEOUT_MS: "200",
      },
    });
    await session.start("Use weather");
    const first = await session.collect();
    expect(first.status).toBe("tool_calls");
    if (first.status !== "tool_calls") return;
    expect(first.toolCalls).toHaveLength(1);

    // The caller answers late; the agent times out and retries meanwhile.
    await new Promise((resolve) => setTimeout(resolve, 500));
    const final = await session.resume([
      { callId: first.toolCalls[0].callId, output: "sunny" },
    ]);
    expect(final.status).toBe("completed");
    const attempt = /^Tool result: sunny \(attempt (\d+)\)$/.exec(final.text);
    expect(Number(attempt?.[1])).toBeGreaterThan(1);
    expect(session.bridge.totalCalls).toBe(1);
  });

  it("tells the agent to use the caller's tools, not its own (#68)", async () => {
    const session = createSession("echo_prompt", undefined, {
      args: [fakeMcpClientAgentPath],
      env: { FAKE_ACP_MCP_SCENARIO: "echo_prompt" },
    });
    await session.start("User: run `echo first_turn_ok`\n\nAssistant:");
    const result = await session.collect();
    expect(result.status).toBe("completed");
    expect(result.text).toMatch(
      new RegExp(
        `^Tool use: .*the MCP server "${session.bridge.serverName}" \\(weather\\)\\..*built-in tools .* disabled`,
      ),
    );
    expect(result.text).toMatch(
      /do not call them\.\n\nUser: run `echo first_turn_ok`\n\nAssistant:$/,
    );
  });

  it("batches parallel tool calls", async () => {
    const session = createSession("tool_parallel", [
      {
        name: "weather",
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: "time",
        inputSchema: { type: "object", properties: {} },
      },
    ]);
    await session.start("Use both tools");
    const first = await session.collect();
    expect(first.status).toBe("tool_calls");
    if (first.status !== "tool_calls") return;
    expect(first.toolCalls.map((call) => call.name)).toEqual([
      "weather",
      "time",
    ]);

    const final = await session.resume(
      first.toolCalls.map((call) => ({
        callId: call.callId,
        output: `${call.name}-result`,
      })),
    );
    expect(final.status).toBe("completed");
    expect(final.text).toContain("weather-result, time-result");
  });

  it("keeps prompt alive across multiple tool rounds", async () => {
    const session = createSession("tool_two_round");
    await session.start("Use weather twice");
    const first = await session.collect();
    expect(first.status).toBe("tool_calls");
    if (first.status !== "tool_calls") return;

    const second = await session.resume([
      { callId: first.toolCalls[0].callId, output: "first" },
    ]);
    expect(second.status).toBe("tool_calls");
    if (second.status !== "tool_calls") return;
    expect(second.toolCalls[0].callId).not.toBe(first.toolCalls[0].callId);

    const final = await session.resume([
      { callId: second.toolCalls[0].callId, output: "second" },
    ]);
    expect(final.status).toBe("completed");
    expect(final.text).toContain("first, second");
  });

  it("rejects ambient built-in permissions", async () => {
    const session = createSession("builtin_permission");
    await session.start("Try built-in");
    const result = await session.collect();
    expect(result.status).toBe("completed");
    expect(result.text).toBe("Builtin handled");
    expect(result.status === "completed" && result.stderr).toContain(
      '"optionId":"reject-once"',
    );
  });

  it("fails clearly when ACP lacks HTTP MCP", async () => {
    const session = createSession("no_http");
    await expect(session.start("Use weather")).rejects.toThrow(
      /does not support HTTP MCP/,
    );
  });

  it("maps CLI display name to ACP model id", async () => {
    const session = createSession("display_model", undefined, {
      model: "gpt-5.6-sol-high",
      modelAliases: ["GPT-5.6 Sol High"],
      strictModel: true,
    });
    await session.start("Hello");
    const result = await session.collect();
    expect(result.status).toBe("completed");
    expect(result.status === "completed" && result.stderr).toContain(
      '"value":"gpt-5.6-sol[reasoning=high]"',
    );
  });

  it("maps a cursor-prefixed Grok id onto the ACP base row", async () => {
    const session = createSession("grok_models", undefined, {
      model: "cursor-grok-4.6-medium",
      modelAliases: ["Grok 4.6 Medium"],
      strictModel: true,
    });
    await session.start("Hello");
    const result = await session.collect();
    expect(result.status).toBe("completed");
    const stderr = result.status === "completed" ? result.stderr : "";
    expect(stderr).toContain('"configId":"model","value":"grok-4.6"');
    expect(stderr).toContain('"configId":"fast","value":"false"');
  });

  it("names the requested public id when an option is not offered", async () => {
    const session = createSession("grok_models", undefined, {
      model: "cursor-grok-4.5-xhigh",
      modelAliases: ["Grok 4.5 Extra High"],
      strictModel: true,
    });
    await expect(session.start("Hello")).rejects.toThrow(
      'Requested public model: cursor-grok-4.5-xhigh; matched ACP base model: grok-4.5; does not offer reasoning "xhigh"',
    );
  });

  it("expires parked tool turns after the configured TTL", async () => {
    const session = createSession("tool_call", undefined, {
      timeoutMs: 100,
    });
    await session.start("Use weather");
    const first = await session.collect();
    expect(first.status).toBe("tool_calls");
    await new Promise((resolve) => setTimeout(resolve, 180));
    expect(session.closed).toBe(true);
  });

  it("fails the live turn when the ACP process exits", async () => {
    const session = createSession("process_exit");
    await session.start("Exit");
    await expect(session.collect()).rejects.toThrow(/exited with code 7/);
    expect(session.closed).toBe(true);
  });

  it("cancels the ACP process on caller abort", async () => {
    const controller = new AbortController();
    const session = createSession("tool_delay", undefined, {
      signal: controller.signal,
    });
    await session.start("Use weather");
    const pending = session.collect();
    controller.abort();
    await expect(pending).rejects.toThrow(/exited|closed/i);
    expect(session.closed).toBe(true);
  });

  it("runs cleanup once on shutdown", async () => {
    let cleanupCalls = 0;
    const session = createSession("tool_call", undefined, {
      onClose: () => {
        cleanupCalls += 1;
      },
    });
    await session.start("Use weather");
    const first = await session.collect();
    expect(first.status).toBe("tool_calls");
    await session.close();
    await session.close();
    expect(cleanupCalls).toBe(1);
  });
});
