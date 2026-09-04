import { execFile } from "node:child_process";
import type { IncomingHttpHeaders } from "node:http";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Best-effort lookup of the working directory of the HTTP client that opened
 * the TCP connection to the proxy.
 *
 * The proxy and CLI client (e.g. `claude`, the OpenAI SDK, LangChain, ...) run
 * on the same machine over loopback. With the local socket's remote port we
 * can ask `lsof` which PID owns the client end, then read that PID's `cwd` to
 * know where the user actually launched their tool. That cwd is then forwarded
 * to the agent via the bridge preamble so it gains awareness of "where the
 * caller is sitting", even when the agent itself runs in a sandbox temp dir.
 *
 * The result is cached briefly by socket-id so a single keep-alive connection
 * does not spawn `lsof` on every request.
 */

export type ClientProcessOptions = {
  /** Override the lsof binary (mostly for tests). */
  lsofBin?: string;
  /** Allow tests to inject the executor. */
  exec?: (
    file: string,
    args: string[],
  ) => Promise<{ stdout: string; stderr: string }>;
  /** Force a value for the bridge's own PID (defaults to process.pid). */
  bridgePid?: number;
  /** Override platform (mostly for tests). Defaults to process.platform. */
  platform?: NodeJS.Platform;
  /** Hard ceiling for any lsof invocation. */
  timeoutMs?: number;
};

export type ClientProcessInfo = {
  pid: number;
  /** Absolute path of the client's current working directory at lookup time. */
  cwd: string;
  /** First token of the lsof COMMAND column (e.g. "claude", "node", "python"). */
  command?: string;
};

type CacheEntry = { value: ClientProcessInfo | null; at: number };

const CACHE_TTL_MS = 60_000;
const DEFAULT_TIMEOUT_MS = 1_500;

const cache = new Map<string, CacheEntry>();

function isLoopbackAddress(addr: string | undefined): boolean {
  if (!addr) return false;
  const a = addr.replace(/^::ffff:/, "");
  return a === "127.0.0.1" || a === "::1" || a === "localhost";
}

function cacheKey(addr: string, port: number): string {
  return `${addr.replace(/^::ffff:/, "")}:${port}`;
}

function prune(): void {
  if (cache.size < 200) return;
  const now = Date.now();
  for (const [k, v] of cache) {
    if (now - v.at > CACHE_TTL_MS) cache.delete(k);
  }
}

function parseLsofPidList(stdout: string): number[] {
  const pids = new Set<number>();
  for (const raw of stdout.split("\n")) {
    const line = raw.trim();
    if (!line?.startsWith("p")) continue;
    const n = Number(line.slice(1));
    if (Number.isInteger(n) && n > 0) pids.add(n);
  }
  return [...pids];
}

/**
 * Parse `lsof -nP -iTCP:<port> -sTCP:ESTABLISHED -F pcn`.
 *
 * lsof groups output in records: `p<pid>` then optional `c<command>` then one
 * or more `n<name>` lines. We keep records where one of the names looks like
 * `<localIp>:<port>->...` so the matched side is the client end (its local
 * port equals the bridge connection's remotePort).
 */
function parseLsofClientCandidates(
  stdout: string,
  port: number,
): { pid: number; command?: string }[] {
  const results: { pid: number; command?: string }[] = [];
  let pid: number | undefined;
  let command: string | undefined;
  let isClientSide = false;
  const flush = () => {
    if (pid != null && isClientSide) {
      results.push(command ? { pid, command } : { pid });
    }
    pid = undefined;
    command = undefined;
    isClientSide = false;
  };
  const portTag = `:${port}->`;
  for (const raw of stdout.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const tag = line[0];
    const value = line.slice(1);
    if (tag === "p") {
      flush();
      const n = Number(value);
      if (Number.isInteger(n) && n > 0) pid = n;
    } else if (tag === "c") {
      command = value || undefined;
    } else if (tag === "n") {
      if (value.includes(portTag)) isClientSide = true;
    }
  }
  flush();
  return results;
}

function parseCwdFromLsof(stdout: string): string | undefined {
  for (const raw of stdout.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("n") && line.length > 1) return line.slice(1);
  }
  return undefined;
}

async function runLsof(
  exec: NonNullable<ClientProcessOptions["exec"]>,
  bin: string,
  args: string[],
  timeoutMs: number,
): Promise<string | undefined> {
  try {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), timeoutMs).unref?.();
    void t;
    const { stdout } = await exec(bin, args);
    return stdout;
  } catch {
    return undefined;
  }
}

/**
 * Resolve the cwd of the process that opened a TCP connection to this server.
 *
 * Returns undefined on Windows, for non-loopback peers, or if lsof can't tell
 * us. Cached per socket for ~60s so keep-alive sessions cost one lsof call.
 */
export async function detectClientCwd(
  remoteAddress: string | undefined,
  remotePort: number | undefined,
  opts: ClientProcessOptions = {},
): Promise<ClientProcessInfo | undefined> {
  if (!remoteAddress || !remotePort || remotePort <= 0) return undefined;
  const platform = opts.platform ?? process.platform;
  if (platform === "win32") return undefined;
  if (!isLoopbackAddress(remoteAddress)) return undefined;

  const key = cacheKey(remoteAddress, remotePort);
  const cached = cache.get(key);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
    return cached.value ?? undefined;
  }

  const exec = opts.exec ?? defaultExec;
  const bin = opts.lsofBin ?? "lsof";
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const bridgePid = opts.bridgePid ?? process.pid;

  const established = await runLsof(
    exec,
    bin,
    ["-nP", `-iTCP:${remotePort}`, "-sTCP:ESTABLISHED", "-F", "pcn"],
    timeoutMs,
  );
  if (!established) {
    cache.set(key, { value: null, at: Date.now() });
    prune();
    return undefined;
  }

  const candidates = parseLsofClientCandidates(established, remotePort).filter(
    (c) => c.pid !== bridgePid,
  );
  if (candidates.length === 0) {
    cache.set(key, { value: null, at: Date.now() });
    prune();
    return undefined;
  }

  const clientPid = candidates[0]?.pid;
  const command = candidates[0]?.command;

  const cwdOut = await runLsof(
    exec,
    bin,
    ["-a", "-p", String(clientPid), "-d", "cwd", "-nP", "-F", "n"],
    timeoutMs,
  );
  const cwd = cwdOut ? parseCwdFromLsof(cwdOut) : undefined;
  if (!cwd) {
    cache.set(key, { value: null, at: Date.now() });
    prune();
    return undefined;
  }

  const info: ClientProcessInfo = command
    ? { pid: clientPid, cwd, command }
    : { pid: clientPid, cwd };
  cache.set(key, { value: info, at: Date.now() });
  prune();
  return info;
}

async function defaultExec(
  file: string,
  args: string[],
): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync(file, args, { timeout: DEFAULT_TIMEOUT_MS });
}

export type ResolveClientLaunchInput = {
  headers: IncomingHttpHeaders;
  remoteAddress?: string;
  remotePort?: number;
  /** Injected detector for tests. */
  detect?: (
    remoteAddress: string | undefined,
    remotePort: number | undefined,
    opts?: ClientProcessOptions,
  ) => Promise<ClientProcessInfo | undefined>;
};

export type ClientLaunchInfo = {
  /** Where the HTTP client (e.g. `claude`) was launched from. */
  cwd?: string;
  /** First token of the client process command (e.g. `claude`, `node`). */
  command?: string;
};

function readInvokeCwdHeader(headers: IncomingHttpHeaders): string | undefined {
  const raw = headers["x-cursor-invoke-cwd"];
  if (raw == null) return undefined;
  const s = Array.isArray(raw) ? raw[0] : raw;
  const t = typeof s === "string" ? s.trim() : "";
  return t || undefined;
}

/**
 * Resolve where the HTTP client was launched from, so the bridge preamble can
 * tell the agent. Explicit `X-Cursor-Invoke-Cwd` wins; otherwise we fall back
 * to lsof-based detection via `detectClientCwd`. Errors are swallowed — this
 * is best-effort and must never block a request.
 */
export async function resolveClientLaunchInfo(
  input: ResolveClientLaunchInput,
): Promise<ClientLaunchInfo> {
  const headerCwd = readInvokeCwdHeader(input.headers);
  if (headerCwd) return { cwd: headerCwd };
  const detect = input.detect ?? detectClientCwd;
  try {
    const info = await detect(input.remoteAddress, input.remotePort);
    if (info?.cwd) {
      return info.command
        ? { cwd: info.cwd, command: info.command }
        : { cwd: info.cwd };
    }
  } catch {
    /* best-effort — never block on lsof errors */
  }
  return {};
}

export const __testing = {
  cache,
  parseLsofClientCandidates,
  parseLsofPidList,
  parseCwdFromLsof,
  readInvokeCwdHeader,
};
