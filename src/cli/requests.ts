import {
  readLastLines,
  recentSessionRequests,
  type SessionRequest,
} from "../lib/session-log.js";

const ANSI = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  dim: "\x1b[2m",
};

export type RequestsOutput = {
  write(chunk: string): unknown;
  columns?: number;
  isTTY?: boolean;
};

export type FormatRequestsOptions = {
  logPath: string;
  width?: number | undefined;
  color?: boolean | undefined;
};

export type HandleRequestsOptions = {
  logPath: string;
  limit: number;
  watch: boolean;
  intervalMs: number;
  output?: RequestsOutput;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
};

function truncate(value: string, width: number): string {
  if (value.length <= width) return value;
  if (width <= 1) return value.slice(0, width);
  return `${value.slice(0, width - 1)}…`;
}

function pad(value: string, width: number): string {
  return truncate(value, width).padEnd(width);
}

function localTimestamp(value: string): string {
  const date = new Date(value);
  const two = (n: number) => String(n).padStart(2, "0");
  return [
    date.getFullYear(),
    "-",
    two(date.getMonth() + 1),
    "-",
    two(date.getDate()),
    " ",
    two(date.getHours()),
    ":",
    two(date.getMinutes()),
    ":",
    two(date.getSeconds()),
  ].join("");
}

function paint(value: string, code: string, enabled: boolean): string {
  return enabled ? `${code}${value}${ANSI.reset}` : value;
}

function statusColor(status: number): string {
  if (status >= 500) return ANSI.red;
  if (status >= 400) return ANSI.yellow;
  return ANSI.green;
}

export function formatRequests(
  requests: SessionRequest[],
  opts: FormatRequestsOptions,
): string {
  const width = Math.max(50, opts.width ?? 100);
  const color = opts.color ?? false;
  const compact = width < 80;
  const whenWidth = compact ? 8 : 19;
  const methodWidth = compact ? 6 : 7;
  const statusWidth = compact ? 3 : 6;
  const remoteWidth = compact ? 10 : 20;
  const separators = 8;
  const fixedWidth =
    whenWidth + methodWidth + statusWidth + remoteWidth + separators;
  const pathWidth = Math.max(12, width - fixedWidth);
  const title = truncate(
    `Latest requests (${requests.length}) · ${opts.logPath}`,
    width,
  );

  if (requests.length === 0) {
    return [
      paint(title, ANSI.bold, color),
      paint("No requests found.", ANSI.dim, color),
    ].join("\n");
  }

  const columns = [
    pad("WHEN", whenWidth),
    pad("METHOD", methodWidth),
    pad("STATUS", statusWidth),
    pad("FROM", remoteWidth),
    pad("PATH", pathWidth),
  ];
  const lines = [
    paint(title, ANSI.bold, color),
    paint(columns.join("  "), ANSI.dim, color),
    paint("─".repeat(width), ANSI.dim, color),
  ];

  for (const request of requests) {
    const timestamp = localTimestamp(request.ts);
    const method = pad(request.method, methodWidth);
    const status = pad(String(request.status), statusWidth);
    const row = [
      pad(compact ? timestamp.slice(11) : timestamp, whenWidth),
      paint(method, ANSI.cyan, color),
      paint(status, statusColor(request.status), color),
      pad(request.remoteAddress, remoteWidth),
      pad(request.pathname, pathWidth),
    ];
    lines.push(row.join("  "));
  }

  return lines.join("\n");
}

export function readRecentRequests(
  logPath: string,
  limit: number,
): Promise<SessionRequest[]> {
  const linesToRead = Math.min(20_000, Math.max(100, limit * 4));
  return new Promise((resolve, reject) => {
    readLastLines(logPath, linesToRead, (err, lines) => {
      if (err) reject(err);
      else resolve(recentSessionRequests(lines, limit));
    });
  });
}

export async function handleRequests(
  opts: HandleRequestsOptions,
): Promise<void> {
  const output = opts.output ?? process.stdout;
  const env = opts.env ?? process.env;
  const color = Boolean(output.isTTY) && env["NO_COLOR"] === undefined;
  const render = async (redraw: boolean): Promise<void> => {
    const requests = await readRecentRequests(opts.logPath, opts.limit);
    const formatted = formatRequests(requests, {
      logPath: opts.logPath,
      width: output.columns,
      color,
    });
    if (redraw && output.isTTY) output.write("\x1b[2J\x1b[H");
    output.write(`${formatted}\n`);
  };

  await render(false);
  if (!opts.watch) return;

  await new Promise<void>((resolve, reject) => {
    let rendering = false;
    let stopped = false;
    const removeStopListener = () => {
      if (opts.signal) opts.signal.removeEventListener("abort", stop);
      else process.off("SIGINT", stop);
    };
    const stop = () => {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      removeStopListener();
      if (output.isTTY) output.write("\n");
      resolve();
    };
    const timer = setInterval(() => {
      if (rendering || stopped) return;
      rendering = true;
      render(true)
        .catch((err) => {
          clearInterval(timer);
          removeStopListener();
          reject(err);
        })
        .finally(() => {
          rendering = false;
        });
    }, opts.intervalMs);

    if (opts.signal) {
      if (opts.signal.aborted) stop();
      else opts.signal.addEventListener("abort", stop, { once: true });
    } else {
      process.once("SIGINT", stop);
    }
  });
}
