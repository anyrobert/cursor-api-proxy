import * as http from "node:http";

/** A request header's first value, or undefined when it is absent or empty. */
function headerValue(req: http.IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return (Array.isArray(value) ? value[0] : value) || undefined;
}

function extractBearerToken(req: http.IncomingMessage): string | undefined {
  return headerValue(req, "authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
}

/**
 * The API key a client sent: the `Authorization: Bearer` token that OpenAI
 * SDKs send, or else the `x-api-key` header that Anthropic SDKs send. When a
 * request has both, the Bearer token is the key.
 */
export function extractApiKey(req: http.IncomingMessage): string | undefined {
  return extractBearerToken(req) ?? headerValue(req, "x-api-key");
}

export function json(
  res: http.ServerResponse,
  status: number,
  body: unknown,
  extraHeaders?: http.OutgoingHttpHeaders,
) {
  res.writeHead(status, {
    ...extraHeaders,
    "Content-Type": "application/json",
  });
  res.end(JSON.stringify(body));
}

export function writeSseHeaders(
  res: http.ServerResponse,
  extraHeaders?: http.OutgoingHttpHeaders,
): void {
  res.writeHead(200, {
    ...extraHeaders,
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
}

/** Default interval for SSE comment heartbeats during agent silence. */
export const SSE_KEEPALIVE_INTERVAL_MS = 15_000;

let defaultSseKeepaliveIntervalMs = SSE_KEEPALIVE_INTERVAL_MS;

/** Test-only override for the default keepalive interval (omit to restore). */
export function setDefaultSseKeepaliveIntervalMsForTests(ms?: number): void {
  defaultSseKeepaliveIntervalMs =
    ms === undefined ? SSE_KEEPALIVE_INTERVAL_MS : ms;
}

/**
 * Periodically write an SSE comment so idle clients (e.g. Codex) do not drop
 * the stream while the agent is silent. Returns a stop function.
 * Also stops automatically when the response closes or errors.
 */
export function startSseKeepalive(
  res: http.ServerResponse,
  intervalMs = defaultSseKeepaliveIntervalMs,
): () => void {
  const timer = setInterval(() => {
    if (res.writableEnded || res.destroyed) return;
    try {
      res.write(": keepalive\n\n");
    } catch {
      /* client gone */
    }
  }, intervalMs);
  timer.unref();

  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    res.off("close", stop);
    res.off("error", stop);
  };
  res.on("close", stop);
  res.on("error", stop);
  return stop;
}

export async function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      data += chunk;
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}
