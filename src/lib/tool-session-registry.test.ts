import type { IncomingHttpHeaders, IncomingMessage } from "node:http";
import { describe, expect, it } from "vitest";

import type { AcpToolSession } from "./acp-tool-session.js";
import {
  ToolSessionError,
  ToolSessionRegistry,
  toolSessionOwnerKey,
} from "./tool-session-registry.js";

/**
 * Stands in for AcpToolSession: `closed` flips at once, every close() call
 * shares one teardown, and the teardown finishes when the test says so.
 */
class FakeSession {
  closed = false;
  readonly terminal = false;
  tornDown = false;
  #finish!: () => void;
  readonly #gate = new Promise<void>((resolve) => {
    this.#finish = resolve;
  });
  #closing?: Promise<void>;

  constructor(readonly callIds: string[] = []) {}

  hasCall(callId: string): boolean {
    return this.callIds.includes(callId);
  }

  close(): Promise<void> {
    this.closed = true;
    this.#closing ??= this.#gate.then(() => {
      this.tornDown = true;
    });
    return this.#closing;
  }

  finishTeardown(): void {
    this.#finish();
  }
}

function park(
  registry: ToolSessionRegistry,
  session: FakeSession,
  ownerKey = "owner",
) {
  return registry.createRecord({
    api: "chat",
    ownerKey,
    model: "gpt-4",
    session: session as unknown as AcpToolSession,
  });
}

async function settled(promise: Promise<unknown>): Promise<boolean> {
  let done = false;
  void promise.then(
    () => (done = true),
    () => (done = true),
  );
  await new Promise((resolve) => setImmediate(resolve));
  return done;
}

describe("toolSessionOwnerKey (#102)", () => {
  const owner = (headers: IncomingHttpHeaders, remoteAddress = "10.0.0.1") =>
    toolSessionOwnerKey({ headers } as IncomingMessage, remoteAddress);

  it("keys an owner by its API key, whichever header carries it", () => {
    expect(owner({ "x-api-key": "key-a" }, "10.0.0.1")).toBe(
      owner({ authorization: "Bearer key-a" }, "10.0.0.2"),
    );
  });

  it("tells clients with different x-api-key values apart", () => {
    expect(owner({ "x-api-key": "key-a" })).not.toBe(owner({ "x-api-key": "key-b" }));
  });

  it("keys a client without an API key by its remote address", () => {
    expect(owner({}, "10.0.0.1")).toBe(owner({}, "10.0.0.1"));
    expect(owner({}, "10.0.0.1")).not.toBe(owner({}, "10.0.0.2"));
    expect(owner({}, "10.0.0.1")).not.toBe(owner({ "x-api-key": "10.0.0.1" }));
  });
});

describe("ToolSessionRegistry.closeAll (#90)", () => {
  it("closes parked sessions and waits for every teardown", async () => {
    const registry = new ToolSessionRegistry();
    const first = new FakeSession(["call_a"]);
    const second = new FakeSession(["call_b"]);
    park(registry, first);
    park(registry, second);

    const closing = registry.closeAll();
    expect(first.closed && second.closed).toBe(true);
    expect(registry.size).toBe(0);

    first.finishTeardown();
    expect(await settled(closing)).toBe(false);
    second.finishTeardown();
    await closing;
    expect(first.tornDown && second.tornDown).toBe(true);
  });

  it("waits for teardowns started elsewhere, after their records left", async () => {
    const registry = new ToolSessionRegistry();
    const failedTurn = new FakeSession(["call_a"]);
    const expired = new FakeSession(["call_b"]);
    const failedRecord = park(registry, failedTurn);
    park(registry, expired);

    // A handler drops a failed turn, then closes it.
    registry.remove(failedRecord);
    void failedTurn.close();
    // The TTL closes a parked turn; the next lookup sweeps its record.
    void expired.close();
    expect(registry.size).toBe(0);

    const closing = registry.closeAll();
    expect(await settled(closing)).toBe(false);
    failedTurn.finishTeardown();
    expect(await settled(closing)).toBe(false);
    expired.finishTeardown();
    await closing;
    expect(failedTurn.tornDown && expired.tornDown).toBe(true);
  });

  it("refuses and closes a session that arrives during shutdown", async () => {
    const registry = new ToolSessionRegistry();
    const parked = new FakeSession(["call_a"]);
    park(registry, parked);
    const closing = registry.closeAll();

    const late = new FakeSession(["call_b"]);
    let refusal: unknown;
    try {
      park(registry, late);
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toBeInstanceOf(ToolSessionError);
    expect(refusal).toMatchObject({
      status: 503,
      code: "server_shutting_down",
    });
    expect(late.closed).toBe(true);

    parked.finishTeardown();
    expect(await settled(closing)).toBe(false);
    late.finishTeardown();
    await closing;
    expect(late.tornDown).toBe(true);
  });

  it("waits for a session refused over the owner limit", async () => {
    const registry = new ToolSessionRegistry();
    const parked = Array.from({ length: 8 }, (_, i) => new FakeSession([`c${i}`]));
    for (const session of parked) park(registry, session);
    const refused = new FakeSession(["c8"]);
    expect(() => park(registry, refused)).toThrow(/Too many parked/);
    expect(refused.closed).toBe(true);

    for (const session of parked) session.finishTeardown();
    const closing = registry.closeAll();
    expect(await settled(closing)).toBe(false);
    refused.finishTeardown();
    await closing;
    expect(refused.tornDown).toBe(true);
  });

  it("resolves every caller once the teardowns finish", async () => {
    const registry = new ToolSessionRegistry();
    const session = new FakeSession(["call_a"]);
    park(registry, session);

    const first = registry.closeAll();
    const second = registry.closeAll();
    expect(await settled(second)).toBe(false);
    session.finishTeardown();
    await Promise.all([first, second]);
    expect(session.tornDown).toBe(true);
    await expect(registry.closeAll()).resolves.toBeUndefined();
  });
});
