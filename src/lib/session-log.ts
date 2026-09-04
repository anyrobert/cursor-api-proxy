import * as fs from "node:fs";

const SESSION_LINE_RE =
  /^(\S+) (GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS) (\S+) (\S+) (\d{3})$/;

export type SessionRequest = {
  ts: string;
  method: string;
  pathname: string;
  remoteAddress: string;
  status: number;
};

export type SessionStats = {
  windowHours: number;
  total: number;
  errors: number;
  byPath: Record<string, number>;
  recent: Omit<SessionRequest, "remoteAddress">[];
};

export function readLastLines(
  filePath: string,
  maxLines: number,
  cb: (err: Error | null, lines: string[]) => void,
): void {
  fs.stat(filePath, (err, stat) => {
    if (err) return cb(null, []);
    const size = stat.size;
    const chunk = 64 * 1024;
    const start = Math.max(0, size - chunk * 4);
    const stream = fs.createReadStream(filePath, { start, end: size });
    let buf = "";
    stream.on("data", (data) => (buf += data.toString("utf8")));
    stream.on("end", () => {
      const lines = buf.split("\n");
      if (start > 0 && lines.length) lines.shift();
      const trimmed = lines.filter((line) => line.length > 0);
      cb(null, trimmed.slice(-maxLines));
    });
    stream.on("error", (streamErr) => cb(streamErr, []));
  });
}

export function parseSessionLine(line: string): SessionRequest | null {
  const match = line.match(SESSION_LINE_RE);
  if (!match) return null;

  const ts = Date.parse(match[1]);
  const status = Number(match[5]);
  if (!Number.isFinite(ts) || !Number.isInteger(status)) return null;

  return {
    ts: match[1],
    method: match[2],
    pathname: match[3],
    remoteAddress: match[4],
    status,
  };
}

export function recentSessionRequests(
  lines: string[],
  limit: number,
): SessionRequest[] {
  const requests: SessionRequest[] = [];
  for (let i = lines.length - 1; i >= 0 && requests.length < limit; i--) {
    const request = parseSessionLine(lines[i]);
    if (request) requests.push(request);
  }
  return requests;
}

export function computeSessionStats(
  lines: string[],
  hours: number,
): SessionStats {
  const cutoff = Date.now() - hours * 3600_000;
  const stats: SessionStats = {
    windowHours: hours,
    total: 0,
    errors: 0,
    byPath: {},
    recent: [],
  };

  for (const line of lines) {
    const request = parseSessionLine(line);
    if (!request || Date.parse(request.ts) < cutoff) continue;

    stats.total++;
    if (request.status >= 400) stats.errors++;
    stats.byPath[request.pathname] = (stats.byPath[request.pathname] ?? 0) + 1;
    stats.recent.push({
      ts: request.ts,
      method: request.method,
      pathname: request.pathname,
      status: request.status,
    });
  }

  stats.recent = stats.recent.slice(-40).reverse();
  return stats;
}
