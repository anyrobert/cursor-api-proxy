import { createHash, randomUUID } from "node:crypto";
import type * as http from "node:http";

import type {
  AcpToolSession,
  ToolTurnEvent,
  ToolTurnResult,
} from "./acp-tool-session.js";
import { extractBearerToken } from "./http.js";
import type { ClientToolOutput } from "./tool-types.js";

export type ToolApi = "chat" | "responses" | "anthropic";
const MAX_GLOBAL_TOOL_SESSIONS = 64;
const MAX_OWNER_TOOL_SESSIONS = 8;

class Mutex {
  #tail = Promise.resolve();

  async run<T>(operation: () => Promise<T>): Promise<T> {
    const prior = this.#tail;
    let release!: () => void;
    this.#tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await prior;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

export type ToolSessionRecord = {
  id: string;
  api: ToolApi;
  ownerKey: string;
  model: string;
  configDir?: string;
  session: AcpToolSession;
  mutex: Mutex;
  responseIds: Set<string>;
  createdAt: number;
  lastUsed: number;
};

export class ToolSessionError extends Error {
  constructor(
    message: string,
    readonly status = 409,
    readonly code = "tool_session_error",
  ) {
    super(message);
  }
}

export function toolSessionOwnerKey(
  req: http.IncomingMessage,
  remoteAddress: string,
): string {
  const bearer = extractBearerToken(req);
  return createHash("sha256")
    .update(bearer ? `bearer:${bearer}` : `remote:${remoteAddress}`)
    .digest("hex");
}

export class ToolSessionRegistry {
  readonly #records = new Set<ToolSessionRecord>();
  readonly #byResponseId = new Map<string, ToolSessionRecord>();
  /**
   * Every session handed to the registry until its teardown has finished,
   * with that teardown once it has started. It outlives the record, so
   * shutdown also waits for sessions a handler or TTL is still closing (#90).
   */
  readonly #sessions = new Map<AcpToolSession, Promise<void> | undefined>();
  #shutDown = false;

  createRecord(opts: {
    api: ToolApi;
    ownerKey: string;
    model: string;
    configDir?: string;
    session: AcpToolSession;
  }): ToolSessionRecord {
    this.#sweep();
    if (this.#shutDown) {
      void this.#close(opts.session);
      throw new ToolSessionError(
        "The proxy is shutting down",
        503,
        "server_shutting_down",
      );
    }
    const ownerCount = [...this.#records].filter(
      (record) => record.ownerKey === opts.ownerKey,
    ).length;
    if (
      this.#records.size >= MAX_GLOBAL_TOOL_SESSIONS ||
      ownerCount >= MAX_OWNER_TOOL_SESSIONS
    ) {
      void this.#close(opts.session);
      throw new ToolSessionError(
        "Too many parked tool sessions; finish or cancel an existing turn",
        429,
        "tool_session_limit",
      );
    }
    const record: ToolSessionRecord = {
      id: `toolsess_${randomUUID().replace(/-/g, "")}`,
      api: opts.api,
      ownerKey: opts.ownerKey,
      model: opts.model,
      configDir: opts.configDir,
      session: opts.session,
      mutex: new Mutex(),
      responseIds: new Set(),
      createdAt: Date.now(),
      lastUsed: Date.now(),
    };
    this.#records.add(record);
    this.#sessions.set(opts.session, undefined);
    return record;
  }

  aliasResponse(record: ToolSessionRecord, responseId: string): void {
    record.responseIds.add(responseId);
    this.#byResponseId.set(responseId, record);
  }

  findByCallIds(
    api: ToolApi,
    ownerKey: string,
    callIds: readonly string[],
  ): ToolSessionRecord | undefined {
    this.#sweep();
    if (callIds.length === 0) return undefined;
    return [...this.#records].find(
      (record) =>
        record.api === api &&
        record.ownerKey === ownerKey &&
        !record.session.closed &&
        callIds.every((callId) => record.session.hasCall(callId)),
    );
  }

  /**
   * The parked session a resent transcript continues, for clients that send
   * their history instead of a `previous_response_id`. Returns it with the
   * subset of `callIds` still waiting on it; ids parked nowhere for this
   * owner (answered earlier in the turn, from a finished turn, expired, or
   * another owner's) are skipped. Undefined when none is parked.
   *
   * Call ids are 122-bit random UUIDs that only their owner has seen, so a
   * match cannot be guessed across owners any more than a response id.
   */
  findPendingCalls(
    api: ToolApi,
    ownerKey: string,
    callIds: readonly string[],
  ): { record: ToolSessionRecord; callIds: string[] } | undefined {
    this.#sweep();
    const matches = new Map<ToolSessionRecord, string[]>();
    for (const callId of callIds) {
      const record = this.#parkedCall(api, ownerKey, callId);
      if (!record) continue;
      const ids = matches.get(record) ?? [];
      ids.push(callId);
      matches.set(record, ids);
    }
    if (matches.size > 1) {
      throw new ToolSessionError(
        "function_call_output items answer calls from different tool turns",
        400,
        "invalid_tool_resume",
      );
    }
    for (const [record, ids] of matches) return { record, callIds: ids };
    return undefined;
  }

  /**
   * Close this owner's parked sessions still waiting on any of `callIds`.
   * A client that resends its transcript and starts a new turn has moved
   * past those calls, so their agents would only idle until the TTL and
   * count against the per-owner session limit.
   */
  async closeSuperseded(
    api: ToolApi,
    ownerKey: string,
    callIds: readonly string[],
  ): Promise<number> {
    const waitsOn = (record: ToolSessionRecord) =>
      !record.session.closed &&
      callIds.some((callId) => record.session.hasCall(callId));
    const stale = [...this.#records].filter(
      (record) =>
        record.api === api && record.ownerKey === ownerKey && waitsOn(record),
    );
    const closed = await Promise.all(
      stale.map((record) =>
        record.mutex.run(async () => {
          if (!waitsOn(record)) return false;
          this.remove(record);
          await this.#close(record.session);
          return true;
        }),
      ),
    );
    return closed.filter(Boolean).length;
  }

  findByResponseId(
    ownerKey: string,
    responseId: string,
  ): ToolSessionRecord | undefined {
    this.#sweep();
    const record = this.#byResponseId.get(responseId);
    return record &&
      record.ownerKey === ownerKey &&
      !record.session.closed
      ? record
      : undefined;
  }

  async collect(
    record: ToolSessionRecord,
    listener?: (event: ToolTurnEvent) => void,
  ): Promise<ToolTurnResult> {
    return record.mutex.run(async () => {
      record.lastUsed = Date.now();
      try {
        return await record.session.collect(listener);
      } finally {
        if (record.session.closed || record.session.terminal) {
          this.remove(record);
        }
      }
    });
  }

  async resume(
    record: ToolSessionRecord,
    outputs: readonly ClientToolOutput[],
    listener?: (event: ToolTurnEvent) => void,
  ): Promise<ToolTurnResult> {
    return record.mutex.run(async () => {
      if (
        record.session.closed ||
        outputs.some((output) => !record.session.hasCall(output.callId))
      ) {
        throw new ToolSessionError(
          "Tool call is already resolved, unknown, or expired",
          409,
          "tool_session_expired",
        );
      }
      record.lastUsed = Date.now();
      try {
        return await record.session.resume(outputs, listener);
      } finally {
        if (record.session.closed || record.session.terminal) {
          this.remove(record);
        }
      }
    });
  }

  remove(record: ToolSessionRecord): void {
    this.#records.delete(record);
    for (const responseId of record.responseIds) {
      if (this.#byResponseId.get(responseId) === record) {
        this.#byResponseId.delete(responseId);
      }
    }
  }

  /**
   * Close every session and resolve once each teardown (agent killed, run
   * dirs removed) has finished, including teardowns started elsewhere. New
   * records are refused from then on, so a turn that starts during shutdown
   * is closed too.
   */
  async closeAll(): Promise<void> {
    this.#shutDown = true;
    this.#records.clear();
    this.#byResponseId.clear();
    while (this.#sessions.size > 0) {
      await Promise.all(
        [...this.#sessions.keys()].map((session) => this.#close(session)),
      );
    }
  }

  get size(): number {
    this.#sweep();
    return this.#records.size;
  }

  #sweep(): void {
    for (const record of this.#records) {
      if (record.session.closed) this.remove(record);
    }
    for (const [session, teardown] of this.#sessions) {
      if (!teardown && session.closed) void this.#close(session);
    }
  }

  /** Close `session`, or join its teardown, and forget it once finished. */
  #close(session: AcpToolSession): Promise<void> {
    let teardown = this.#sessions.get(session);
    if (!teardown) {
      teardown = session
        .close()
        .catch(() => undefined)
        .then(() => {
          this.#sessions.delete(session);
        });
      this.#sessions.set(session, teardown);
    }
    return teardown;
  }

  #parkedCall(
    api: ToolApi,
    ownerKey: string,
    callId: string,
  ): ToolSessionRecord | undefined {
    for (const record of this.#records) {
      if (
        record.api === api &&
        record.ownerKey === ownerKey &&
        !record.session.closed &&
        record.session.hasCall(callId)
      ) {
        return record;
      }
    }
    return undefined;
  }
}
