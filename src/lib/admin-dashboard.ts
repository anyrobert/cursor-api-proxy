import { execSync, spawn } from "node:child_process";
import * as fs from "node:fs";
import type * as http from "node:http";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import type { BridgeConfig } from "./config.js";
import { computeSessionStats, readLastLines } from "./session-log.js";

const PLIST_LABEL = "com.cursor-api-proxy";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".png": "image/png",
};

function packageRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
}

const START_TIME = Date.now();

function json(res: http.ServerResponse, status: number, body: unknown): void {
  const buf = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": buf.length,
    "cache-control": "no-store",
  });
  res.end(buf);
}

function notFound(res: http.ServerResponse): void {
  res.writeHead(404, { "content-type": "text/plain" });
  res.end("not found\n");
}

function safeJoin(root: string, rel: string): string | null {
  const target = path.normalize(path.join(root, rel));
  if (!target.startsWith(root)) return null;
  return target;
}

function serveFile(res: http.ServerResponse, filePath: string): void {
  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      notFound(res);
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    const mime = MIME[ext] ?? "application/octet-stream";
    res.writeHead(200, {
      "content-type": mime,
      "content-length": stat.size,
      "cache-control": "no-cache",
    });
    fs.createReadStream(filePath).pipe(res);
  });
}

function launchdLoadedSync(): boolean {
  try {
    const out = execSync("launchctl list 2>/dev/null", { encoding: "utf8" });
    return out.split("\n").some((l) => l.trim().endsWith(PLIST_LABEL));
  } catch {
    return false;
  }
}

function storagePaths(config: BridgeConfig) {
  const storageDir = path.dirname(config.sessionsLogPath);
  const pidFile = path.join(storageDir, "proxy.pid");
  const serviceLog = path.join(storageDir, "proxy.log");
  return { storageDir, pidFile, serviceLog };
}

function getStatus(
  config: BridgeConfig,
  version: string,
  cb: (s: Record<string, unknown>) => void,
): void {
  const root = packageRoot();
  const publicDir = path.join(root, "public");
  const docsDir = path.join(root, "docs");
  const { storageDir, pidFile, serviceLog } = storagePaths(config);

  let pid: number | null = null;
  try {
    const raw = fs.readFileSync(pidFile, "utf8").trim();
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) pid = n;
  } catch {
    /* no pid file */
  }

  let running = pid === process.pid;
  if (!running && pid) {
    try {
      process.kill(pid, 0);
      running = true;
    } catch {
      running = false;
    }
  }

  const ownPidIsCurrent = pid === process.pid;
  if (!ownPidIsCurrent) {
    try {
      fs.mkdirSync(storageDir, { recursive: true });
      fs.writeFileSync(pidFile, String(process.pid));
      pid = process.pid;
      running = true;
    } catch {
      /* ignore */
    }
  }

  const home = process.env["HOME"] ?? process.env["USERPROFILE"] ?? "";
  const plistPath = path.join(
    home,
    "Library/LaunchAgents",
    `${PLIST_LABEL}.plist`,
  );
  const launchdLoaded =
    process.platform === "darwin" ? launchdLoadedSync() : false;

  const env = process.env;
  cb({
    running,
    pid,
    port: config.port,
    host: config.host,
    version,
    uptimeSeconds: Math.floor((Date.now() - START_TIME) / 1000),
    launchdLoaded,
    plistPath,
    packageRoot: root,
    publicDir,
    docsDir,
    storageDir,
    sessionsLogPath: config.sessionsLogPath,
    serviceLog,
    pidFile,
    apiKeyConfigured: Boolean(
      env["CURSOR_API_KEY"] ?? env["CURSOR_AUTH_TOKEN"],
    ),
    bridgeApiKeyRequired: Boolean(config.requiredKey),
    node: process.version,
    platform: `${process.platform} ${process.arch}`,
    startedAt: new Date(START_TIME).toISOString(),
  });
}

function sanitizedBridgeConfig(config: BridgeConfig): Record<string, unknown> {
  return {
    agentBin: config.agentBin,
    useAcp: config.useAcp,
    host: config.host,
    port: config.port,
    defaultModel: config.defaultModel,
    mode: config.mode,
    force: config.force,
    approveMcps: config.approveMcps,
    strictModel: config.strictModel,
    workspace: config.workspace,
    timeoutMs: config.timeoutMs,
    sessionsLogPath: config.sessionsLogPath,
    chatOnlyWorkspace: config.chatOnlyWorkspace,
    verbose: config.verbose,
    maxMode: config.maxMode,
    requiredKey: Boolean(config.requiredKey),
    tlsEnabled: Boolean(config.tlsCertPath && config.tlsKeyPath),
    configDirsCount: config.configDirs.length,
    multiPort: config.multiPort,
    contextPreamble: config.contextPreamble,
    bridgePackageVersion: config.bridgePackageVersion,
    contextExtraConfigured: Boolean(config.contextExtra),
  };
}

function runControl(
  action: string,
  config: BridgeConfig,
  cb: (
    err: Error | null,
    result?: { ok: boolean; action: string; scheduled: boolean },
  ) => void,
): void {
  const allowed = ["start", "stop", "restart", "enable", "disable"];
  if (!allowed.includes(action)) {
    cb(new Error(`invalid action: ${action}`));
    return;
  }
  const home = process.env["HOME"] ?? process.env["USERPROFILE"] ?? "";
  const cliPath = path.join(home, ".local", "bin", "cursor-api-proxy");
  if (!fs.existsSync(cliPath)) {
    cb(new Error(`CLI not found at ${cliPath} (see docs/WIKI.md)`));
    return;
  }
  const { serviceLog } = storagePaths(config);
  try {
    fs.mkdirSync(path.dirname(serviceLog), { recursive: true });
  } catch {
    /* ignore */
  }
  const cmd = `sleep 0.4 && '${cliPath.replace(/'/g, "'\\''")}' ${action} >> '${serviceLog.replace(/'/g, "'\\''")}' 2>&1`;
  const child = spawn("sh", ["-c", cmd], {
    detached: true,
    stdio: "ignore",
    cwd: packageRoot(),
    env: process.env,
  });
  child.unref();
  cb(null, { ok: true, action, scheduled: true });
}

function parseQuery(url: string): Record<string, string> {
  const i = url.indexOf("?");
  const out: Record<string, string> = {};
  if (i < 0) return out;
  for (const kv of url.slice(i + 1).split("&")) {
    const [k, v = ""] = kv.split("=");
    if (k) out[decodeURIComponent(k)] = decodeURIComponent(v);
  }
  return out;
}

export type AdminDashboardOpts = {
  version: string;
  config: BridgeConfig;
};

export function adminDashboardMatches(req: http.IncomingMessage): boolean {
  const url = req.url ?? "";
  const pathname = url.split("?")[0] ?? "";
  if (req.method === "GET" && (pathname === "/" || pathname === "/wiki"))
    return true;
  if (req.method === "GET" && pathname.startsWith("/static/")) return true;
  if (req.method === "GET" && pathname.startsWith("/api/")) return true;
  if (req.method === "POST" && pathname === "/api/control") return true;
  if (req.method === "POST" && pathname === "/api/log/clear") return true;
  return false;
}

export function handleAdminDashboard(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  opts: AdminDashboardOpts,
): void {
  const { config, version } = opts;
  const root = packageRoot();
  const publicDir = path.join(root, "public");
  const wikiFile = path.join(root, "docs", "WIKI.md");
  const url = req.url ?? "/";
  const pathname = url.split("?")[0] ?? "/";
  const q = parseQuery(url);

  if (req.method === "GET" && pathname === "/") {
    serveFile(res, path.join(publicDir, "index.html"));
    return;
  }
  if (req.method === "GET" && pathname === "/wiki") {
    serveFile(res, path.join(publicDir, "wiki.html"));
    return;
  }
  if (req.method === "GET" && pathname.startsWith("/static/")) {
    const rel = pathname.slice("/static/".length);
    const target = safeJoin(publicDir, rel);
    if (!target) {
      notFound(res);
      return;
    }
    serveFile(res, target);
    return;
  }

  if (req.method === "GET" && pathname === "/api/status") {
    getStatus(config, version, (s) => json(res, 200, s));
    return;
  }
  if (req.method === "GET" && pathname === "/api/config") {
    json(res, 200, sanitizedBridgeConfig(config));
    return;
  }
  if (req.method === "GET" && pathname === "/api/log") {
    const n = Math.min(5000, Math.max(1, Number(q["lines"]) || 100));
    readLastLines(config.sessionsLogPath, n, (err, lines) => {
      if (err) {
        json(res, 500, { error: String(err) });
        return;
      }
      json(res, 200, { path: config.sessionsLogPath, lines });
    });
    return;
  }
  if (req.method === "POST" && pathname === "/api/log/clear") {
    // Archive+truncate the sessions log.
    const logPath = config.sessionsLogPath;
    const dir = path.dirname(logPath);
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch {
      /* ignore */
    }

    const archivedAt = new Date().toISOString().replace(/[:.]/g, "-");
    const archivePath = `${logPath}.${archivedAt}.archive`;

    try {
      if (fs.existsSync(logPath)) {
        const st = fs.statSync(logPath);
        if (st.size > 0) fs.renameSync(logPath, archivePath);
        else fs.writeFileSync(archivePath, "", "utf8");
      } else {
        fs.writeFileSync(archivePath, "", "utf8");
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      json(res, 500, { error: msg });
      return;
    }

    // Ensure dashboard polling continues to work immediately.
    try {
      fs.writeFileSync(logPath, "", "utf8");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      json(res, 500, { error: msg });
      return;
    }

    json(res, 200, { archivePath });
    return;
  }
  if (req.method === "GET" && pathname === "/api/stats") {
    const hours = Math.min(168, Math.max(1, Number(q["hours"]) || 24));
    readLastLines(config.sessionsLogPath, 20_000, (err, lines) => {
      if (err) {
        json(res, 500, { error: String(err) });
        return;
      }
      json(res, 200, computeSessionStats(lines, hours));
    });
    return;
  }
  if (req.method === "GET" && pathname === "/api/wiki") {
    fs.readFile(wikiFile, "utf8", (err, data) => {
      if (err) {
        json(res, 500, { error: "wiki not readable" });
        return;
      }
      res.writeHead(200, {
        "content-type": "text/markdown; charset=utf-8",
        "cache-control": "no-cache",
      });
      res.end(data);
    });
    return;
  }
  if (req.method === "POST" && pathname === "/api/control") {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      let body: { action?: string } = {};
      try {
        body = JSON.parse(raw || "{}") as { action?: string };
      } catch {
        json(res, 400, { error: "invalid json" });
        return;
      }
      runControl(String(body.action ?? ""), config, (err, result) => {
        if (err) {
          json(res, 400, { error: err.message });
          return;
        }
        json(res, 200, result);
      });
    });
    return;
  }

  notFound(res);
}
