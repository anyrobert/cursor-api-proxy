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
  #closePromise?: Promise<void>;

  createRecord(opts: {
    api: ToolApi;
    ownerKey: string;
    model: string;
    configDir?: string;
    session: AcpToolSession;
  }): ToolSessionRecord {
    this.#sweep();
    const ownerCount = [...this.#records].filter(
      (record) => record.ownerKey === opts.ownerKey,
    ).length;
    if (
      this.#records.size >= MAX_GLOBAL_TOOL_SESSIONS ||
      ownerCount >= MAX_OWNER_TOOL_SESSIONS
    ) {
      void opts.session.close();
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

  async closeAll(): Promise<void> {
    if (!this.#closePromise) {
      const records = [...this.#records];
      this.#records.clear();
      this.#byResponseId.clear();
      this.#closePromise = Promise.all(
        records.map((record) => record.session.close().catch(() => undefined)),
      ).then(() => undefined);
    }
    await this.#closePromise;
  }

  get size(): number {
    this.#sweep();
    return this.#records.size;
  }

  #sweep(): void {
    for (const record of this.#records) {
      if (record.session.closed) this.remove(record);
    }
  }
}
