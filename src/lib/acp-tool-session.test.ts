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
      modelCandidates: ["gpt-5.6-sol-high", "GPT-5.6 Sol High"],
      strictModel: true,
    });
    await session.start("Hello");
    const result = await session.collect();
    expect(result.status).toBe("completed");
    expect(result.status === "completed" && result.stderr).toContain(
      '"value":"gpt-5.6-sol[reasoning=high]"',
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
