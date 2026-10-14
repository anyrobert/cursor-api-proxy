import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Readable } from "node:stream";
import { IncomingMessage, ServerResponse } from "node:http";
import {
  extractBearerToken,
  json,
  readBody,
  setDefaultSseKeepaliveIntervalMsForTests,
  startSseKeepalive,
} from "./http.js";

function mockRequest(headers: Record<string, string | string[] | undefined> = {}): IncomingMessage {
  return {
    headers,
  } as IncomingMessage;
}

function mockRequestBody(body: string): IncomingMessage {
  const stream = Readable.from([body]);
  return Object.assign(stream, { headers: {} }) as IncomingMessage;
}

describe("extractBearerToken", () => {
  it("returns token when Authorization header has Bearer prefix", () => {
    const req = mockRequest({ authorization: "Bearer sk-abc123" });
    expect(extractBearerToken(req)).toBe("sk-abc123");
  });

  it("is case-insensitive for Bearer", () => {
    const req = mockRequest({ authorization: "bearer sk-xyz789" });
    expect(extractBearerToken(req)).toBe("sk-xyz789");
  });

  it("returns undefined when Authorization header is missing", () => {
    const req = mockRequest({});
    expect(extractBearerToken(req)).toBeUndefined();
  });

  it("returns undefined when Authorization is not Bearer", () => {
    const req = mockRequest({ authorization: "Basic dXNlcjpwYXNz" });
    expect(extractBearerToken(req)).toBeUndefined();
  });

  it("handles array Authorization header", () => {
    const req = mockRequest({ authorization: ["Bearer token-from-array"] });
    expect(extractBearerToken(req)).toBe("token-from-array");
  });
});

describe("json", () => {
  it("writes status and JSON body", () => {
    const res = {
      writeHead: vi.fn(),
      end: vi.fn(),
    } as unknown as ServerResponse;

    json(res, 200, { ok: true });

    expect(res.writeHead).toHaveBeenCalledWith(200, { "Content-Type": "application/json" });
    expect(res.end).toHaveBeenCalledWith(JSON.stringify({ ok: true }));
  });

  it("handles error response", () => {
    const res = {
      writeHead: vi.fn(),
      end: vi.fn(),
    } as unknown as ServerResponse;

    json(res, 401, { error: { message: "Unauthorized", code: "unauthorized" } });

    expect(res.writeHead).toHaveBeenCalledWith(401, { "Content-Type": "application/json" });
    expect(res.end).toHaveBeenCalledWith(
      JSON.stringify({ error: { message: "Unauthorized", code: "unauthorized" } }),
    );
  });
});

describe("readBody", () => {
  it("collects request body", async () => {
    const req = mockRequestBody("hello world");
    const body = await readBody(req);
    expect(body).toBe("hello world");
  });

  it("resolves empty body", async () => {
    const req = mockRequestBody("");
    const body = await readBody(req);
    expect(body).toBe("");
  });

  it("collects JSON body", async () => {
    const payload = JSON.stringify({ model: "claude-3", messages: [] });
    const req = mockRequestBody(payload);
    const body = await readBody(req);
    expect(body).toBe(payload);
  });
});

describe("startSseKeepalive", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    setDefaultSseKeepaliveIntervalMsForTests();
    vi.useRealTimers();
  });

  function mockSseResponse() {
    const listeners = new Map<string, Array<() => void>>();
    const write = vi.fn();
    const res = {
      write,
      writableEnded: false,
      destroyed: false,
      on(event: string, cb: () => void) {
        const list = listeners.get(event) ?? [];
        list.push(cb);
        listeners.set(event, list);
        return res;
      },
      off(event: string, cb: () => void) {
        const list = listeners.get(event) ?? [];
        listeners.set(
          event,
          list.filter((listener) => listener !== cb),
        );
        return res;
      },
    };
    return {
      res: res as unknown as ServerResponse,
      write,
      emit(event: string) {
        for (const cb of listeners.get(event) ?? []) cb();
      },
    };
  }

  it("writes SSE comment heartbeats on the interval", () => {
    const { res, write } = mockSseResponse();

    const stop = startSseKeepalive(res, 1000);
    expect(write).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1000);
    expect(write).toHaveBeenCalledWith(": keepalive\n\n");

    vi.advanceTimersByTime(1000);
    expect(write).toHaveBeenCalledTimes(2);

    stop();
    vi.advanceTimersByTime(2000);
    expect(write).toHaveBeenCalledTimes(2);
  });

  it("skips writes after the response ends", () => {
    const { res, write } = mockSseResponse();

    const stop = startSseKeepalive(res, 500);
    (res as { writableEnded: boolean }).writableEnded = true;
    vi.advanceTimersByTime(500);
    expect(write).not.toHaveBeenCalled();
    stop();
  });

  it("uses the test default interval when no interval is passed", () => {
    setDefaultSseKeepaliveIntervalMsForTests(250);
    const { res, write } = mockSseResponse();

    const stop = startSseKeepalive(res);
    vi.advanceTimersByTime(249);
    expect(write).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(write).toHaveBeenCalledWith(": keepalive\n\n");
    stop();
  });

  it("stops automatically when the response closes", () => {
    const { res, write, emit } = mockSseResponse();

    startSseKeepalive(res, 100);
    vi.advanceTimersByTime(100);
    expect(write).toHaveBeenCalledTimes(1);

    emit("close");
    vi.advanceTimersByTime(500);
    expect(write).toHaveBeenCalledTimes(1);
  });
});
