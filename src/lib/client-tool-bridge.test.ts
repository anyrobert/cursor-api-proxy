import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ClientToolBridge } from "./client-tool-bridge.js";

/** Long enough for a request to reach the bridge before the client gives up. */
const AGENT_TIMEOUT_MS = 200;

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/**
 * A started bridge and the MCP SDK client the Cursor agent bundles, with the
 * SDK's own timeout and notifications/cancelled behaviour.
 */
async function connect() {
  const bridge = new ClientToolBridge([
    { name: "weather", inputSchema: { type: "object", properties: {} } },
    { name: "time", inputSchema: { type: "object", properties: {} } },
  ]);
  cleanups.push(() => bridge.close());
  await bridge.start();

  const { url, headers } = bridge.mcpServer;
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: {
      headers: Object.fromEntries(
        headers.map((header) => [header.name, header.value]),
      ),
    },
  });
  // A notification's send settles once the bridge has handled it, so this
  // tells a test when the bridge has seen a timeout's cancellation.
  const notifications: Array<Promise<void>> = [];
  const send = transport.send.bind(transport);
  transport.send = (message, options) => {
    const sent = send(message, options);
    if (!("id" in message)) notifications.push(sent);
    return sent;
  };
  const client = new Client({ name: "fake-cursor-agent", version: "1.0.0" });
  await client.connect(transport);
  cleanups.push(() => client.close());

  const call = (name: string, args: Record<string, unknown>, timeout?: number) =>
    client.callTool(
      { name, arguments: args },
      undefined,
      timeout ? { timeout } : undefined,
    );
  /** A call the agent gives up on, the way Cursor does after its MCP timeout. */
  const abandon = async (name: string, args: Record<string, unknown>) => {
    await expect(call(name, args, AGENT_TIMEOUT_MS)).rejects.toThrow(
      /timed out/,
    );
    await Promise.all(notifications);
  };
  const parked = async (count: number) => {
    await vi.waitFor(() => expect(bridge.pendingCalls()).toHaveLength(count));
    return bridge.pendingCalls();
  };
  return { bridge, call, abandon, parked };
}

function text(output: string) {
  return { content: [{ type: "text", text: output }] };
}

describe("ClientToolBridge retries of timed-out calls (#64)", () => {
  it("answers retries with the output of the call they repeat", async () => {
    const { bridge, call, abandon, parked } = await connect();
    await abandon("weather", { city: "Paris", units: "c" });
    const [original] = await parked(1);

    // A retry that times out again, then one that waits; the arguments
    // are the same in another key order.
    await abandon("weather", { units: "c", city: "Paris" });
    const retry = call("weather", { units: "c", city: "Paris" });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(bridge.pendingCalls()).toEqual([original]);
    expect(bridge.totalCalls).toBe(1);

    bridge.resolveOutputs([{ callId: original.callId, output: "sunny" }]);
    await expect(retry).resolves.toMatchObject(text("sunny"));
    expect(bridge.pendingCalls()).toEqual([]);
  });

  it("keeps an output that came after the timeout for the next retry", async () => {
    const { bridge, call, abandon, parked } = await connect();
    await abandon("weather", { city: "Paris" });
    const [original] = await parked(1);
    bridge.resolveOutputs([{ callId: original.callId, output: "sunny" }]);

    await expect(call("weather", { city: "Paris" })).resolves.toMatchObject(
      text("sunny"),
    );
    expect(bridge.totalCalls).toBe(1);
    expect(bridge.pendingCalls()).toEqual([]);
  });

  it("runs the same call again once its output reached the agent", async () => {
    const { bridge, call, parked } = await connect();
    const first = call("weather", { city: "Paris" });
    const [firstCall] = await parked(1);
    bridge.resolveOutputs([{ callId: firstCall.callId, output: "sunny" }]);
    await expect(first).resolves.toMatchObject(text("sunny"));

    const again = call("weather", { city: "Paris" });
    const [secondCall] = await parked(1);
    expect(secondCall.callId).not.toBe(firstCall.callId);
    bridge.resolveOutputs([{ callId: secondCall.callId, output: "rainy" }]);
    await expect(again).resolves.toMatchObject(text("rainy"));
    expect(bridge.totalCalls).toBe(2);
  });

  it("parks a duplicate made while the original is still awaited", async () => {
    const { bridge, call, parked } = await connect();
    const first = call("weather", { city: "Paris" });
    await parked(1);
    const second = call("weather", { city: "Paris" });
    const [a, b] = await parked(2);

    bridge.resolveOutputs([
      { callId: a.callId, output: "first" },
      { callId: b.callId, output: "second" },
    ]);
    await expect(first).resolves.toMatchObject(text("first"));
    await expect(second).resolves.toMatchObject(text("second"));
  });

  it("joins a repeat of a handed-out call even without its cancellation", async () => {
    const { bridge, call, parked } = await connect();
    // No cancellation reaches the bridge: the first request still looks live.
    const first = call("weather", { city: "Paris" });
    const [original] = await parked(1);
    bridge.markExposed([original.callId]);

    const repeat = call("weather", { city: "Paris" });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(bridge.pendingCalls()).toEqual([original]);
    bridge.resolveOutputs([{ callId: original.callId, output: "sunny" }]);
    await expect(repeat).resolves.toMatchObject(text("sunny"));
    await expect(first).resolves.toMatchObject(text("sunny"));
    expect(bridge.totalCalls).toBe(1);
  });

  it("treats other arguments as a new call", async () => {
    const { bridge, call, abandon, parked } = await connect();
    await abandon("weather", { city: "Paris" });
    const london = call("weather", { city: "London" });
    const [paris, other] = await parked(2);

    bridge.resolveOutputs([
      { callId: paris.callId, output: "sunny" },
      { callId: other.callId, output: "foggy" },
    ]);
    await expect(london).resolves.toMatchObject(text("foggy"));
  });

  it("drops a kept output once the agent calls something else", async () => {
    const { bridge, call, abandon, parked } = await connect();
    await abandon("weather", { city: "Paris" });
    const [stale] = await parked(1);
    bridge.resolveOutputs([{ callId: stale.callId, output: "stale" }]);

    const time = call("time", {});
    await parked(1);
    const weather = call("weather", { city: "Paris" });
    const [timeCall, weatherCall] = await parked(2);
    bridge.resolveOutputs([
      { callId: timeCall.callId, output: "noon" },
      { callId: weatherCall.callId, output: "fresh" },
    ]);
    await expect(time).resolves.toMatchObject(text("noon"));
    await expect(weather).resolves.toMatchObject(text("fresh"));
  });

  it("does not keep an output the agent moved on from before it came", async () => {
    const { bridge, call, abandon, parked } = await connect();
    await abandon("weather", { city: "Paris" });
    const time = call("time", {});
    const [stale, timeCall] = await parked(2);
    bridge.resolveOutputs([{ callId: stale.callId, output: "stale" }]);
    bridge.resolveOutputs([{ callId: timeCall.callId, output: "noon" }]);
    await expect(time).resolves.toMatchObject(text("noon"));

    const weather = call("weather", { city: "Paris" });
    const [weatherCall] = await parked(1);
    bridge.resolveOutputs([{ callId: weatherCall.callId, output: "fresh" }]);
    await expect(weather).resolves.toMatchObject(text("fresh"));
  });

  it("fails a waiting retry when the bridge closes", async () => {
    const { bridge, call, abandon, parked } = await connect();
    await abandon("weather", { city: "Paris" });
    await parked(1);
    const retry = call("weather", { city: "Paris" });
    await new Promise((resolve) => setTimeout(resolve, 50));
    await bridge.close();
    await expect(retry).rejects.toThrow();
  });
});
