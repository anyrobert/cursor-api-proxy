import * as fs from "node:fs";
import * as http from "node:http";
import * as https from "node:https";

import type { BridgeConfig } from "./config.js";
import { createRequestListener } from "./request-listener.js";
import { initAccountPool } from "./account-pool.js";
import { killAllChildProcesses } from "./process.js";
import { ToolSessionRegistry } from "./tool-session-registry.js";

function acpLauncherLabel(acpArgs: string[]): string {
  const first = acpArgs[0];
  if (first && /\.[cm]?js$/i.test(first)) return "node + script";
  return "cmd";
}

export type BridgeServerOptions = {
  version: string;
  config: BridgeConfig;
};

export type BridgeHttpServer = http.Server | https.Server;

export function startBridgeServer(
  opts: BridgeServerOptions,
): BridgeHttpServer[] {
  const { config } = opts;
  const servers: BridgeHttpServer[] = [];

  if (config.configDirs && config.configDirs.length > 0) {
    if (config.multiPort) {
      // In multi-port mode, we don't need a central pool. We spawn a server for each configDir
      config.configDirs.forEach((dir, index) => {
        const port = config.port + index;
        const serverOpts = {
          ...opts,
          config: {
            ...config,
            port,
            configDirs: [dir], // each server gets only one configDir
            multiPort: false, // Disable multi-port for child servers to prevent recursion
          },
        };
        const server = startSingleServer(serverOpts);
        servers.push(server);
      });
      return servers;
    } else {
      initAccountPool(config.configDirs);
    }
  }

  servers.push(startSingleServer(opts));
  return servers;
}

/**
 * What a server leaves running that must finish before the process exits:
 * its tool sessions, and the requests still being handled, whose agents'
 * temp dirs are only removed once their turn ends (#90).
 */
type ServerCleanup = {
  toolSessions: ToolSessionRegistry;
  requests: Set<Promise<void>>;
};

const serverCleanup = new WeakMap<BridgeHttpServer, ServerCleanup>();

const DRAIN_TIMEOUT_MS = 10_000;
/** Below the 5 s the SDK and the launcher script wait before SIGKILL. */
const CLEANUP_TIMEOUT_MS = 3_000;

export type ShutdownOptions = {
  /** Most time to wait for the servers to close; exits with 1 after it. */
  drainTimeoutMs?: number;
  /** Most time to wait for tool sessions and running turns to clean up. */
  cleanupTimeoutMs?: number;
  /** Replaces process.exit (tests). */
  exit?: (code: number) => void;
};

export type GracefulShutdownOptions = ShutdownOptions & {
  /** Where SIGINT and SIGTERM arrive (tests); defaults to process. */
  signals?: Pick<NodeJS.EventEmitter, "on">;
};

function exitProcess(code: number): void {
  process.exit(code);
}

/** Whether `work` settles within `ms`. */
async function settlesWithin(
  work: Promise<unknown>,
  ms: number,
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<false>((resolve) => {
    timer = setTimeout(resolve, ms, false);
    timer.unref?.();
  });
  try {
    return await Promise.race([work.then(() => true, () => true), timedOut]);
  } finally {
    clearTimeout(timer);
  }
}

function closeServer(server: BridgeHttpServer): Promise<void> {
  return new Promise((resolve) => {
    // closeAllConnections is missing before Node 18.2.
    if (typeof server.closeAllConnections === "function") {
      server.closeAllConnections();
    }
    server.close(() => resolve());
  });
}

/**
 * Stop `servers`, then exit. Their tool sessions are closed first, which
 * cancels each turn, kills its agent and removes its run dirs; the remaining
 * agents are killed and open connections dropped. Exit waits for the
 * sessions' teardown and the requests still running (at most
 * `cleanupTimeoutMs`), and for the servers to close: 0 once they have, 1 if
 * they have not after `drainTimeoutMs`.
 */
export async function shutdownBridge(
  servers: readonly BridgeHttpServer[],
  opts: ShutdownOptions = {},
): Promise<void> {
  const exit = opts.exit ?? exitProcess;
  const cleanups = servers.flatMap((server) => serverCleanup.get(server) ?? []);

  const sessionsClosed = Promise.all(
    cleanups.map((cleanup) => cleanup.toolSessions.closeAll()),
  );
  killAllChildProcesses();
  const serversClosed = Promise.all(servers.map(closeServer));
  const requestsEnded = Promise.allSettled(
    cleanups.flatMap((cleanup) => [...cleanup.requests]),
  );

  const [cleanedUp, drained] = await Promise.all([
    settlesWithin(
      Promise.all([sessionsClosed, requestsEnded]),
      opts.cleanupTimeoutMs ?? CLEANUP_TIMEOUT_MS,
    ),
    settlesWithin(serversClosed, opts.drainTimeoutMs ?? DRAIN_TIMEOUT_MS),
  ]);
  if (!cleanedUp) {
    console.error(
      "[shutdown] Timed out waiting for agent sessions to clean up — some temp dirs may remain.",
    );
  }
  if (!drained) {
    console.error(
      "[shutdown] Timed out waiting for connections to drain — forcing exit.",
    );
  }
  exit(drained ? 0 : 1);
}

/**
 * Shut down gracefully on the first SIGINT or SIGTERM (`shutdownBridge`). A
 * second signal exits with 1 at once, without waiting for the cleanup.
 */
export function setupGracefulShutdown(
  servers: readonly BridgeHttpServer[],
  opts: GracefulShutdownOptions = {},
): void {
  const { signals = process, ...shutdownOpts } = opts;
  const exit = opts.exit ?? exitProcess;
  let shuttingDown = false;

  const onSignal = (signal: NodeJS.Signals) => {
    if (shuttingDown) {
      console.error(`[shutdown] ${signal} received again — exiting now.`);
      exit(1);
      return;
    }
    shuttingDown = true;
    console.log(
      `\n[${new Date().toISOString()}] ${signal} received — shutting down gracefully…`,
    );
    shutdownBridge(servers, shutdownOpts).catch((error: unknown) => {
      console.error("[shutdown] Failed:", error);
      exit(1);
    });
  };

  signals.on("SIGTERM", () => onSignal("SIGTERM"));
  signals.on("SIGINT", () => onSignal("SIGINT"));
}

function startSingleServer(opts: BridgeServerOptions): BridgeHttpServer {
  const { config } = opts;

  const toolSessions = new ToolSessionRegistry();
  const handleRequest = createRequestListener(opts, { toolSessions });
  const requests = new Set<Promise<void>>();
  const requestListener: http.RequestListener = (req, res) => {
    const handled = handleRequest(req, res);
    requests.add(handled);
    // Derived from `handled`, so a rejection still surfaces as unhandled.
    void handled.finally(() => requests.delete(handled));
  };

  const useTls = Boolean(config.tlsCertPath && config.tlsKeyPath);
  let server: BridgeHttpServer;

  if (useTls) {
    const cert = fs.readFileSync(config.tlsCertPath!, "utf8");
    const key = fs.readFileSync(config.tlsKeyPath!, "utf8");
    server = https.createServer({ cert, key }, requestListener);
  } else {
    server = http.createServer(requestListener);
  }
  serverCleanup.set(server, { toolSessions, requests });

  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      console.error(
        `\u274c Port ${config.port} is already in use. Set CURSOR_BRIDGE_PORT to use a different port.`,
      );
    } else {
      console.error(`\u274c Server error:`, err.message);
    }
    process.exit(1);
  });
  server.once("close", () => {
    void toolSessions.closeAll();
  });

  server.listen(config.port, config.host, () => {
    const scheme = useTls ? "https" : "http";
    console.log(
      `cursor-api-proxy listening on ${scheme}://${config.host}:${config.port}`,
    );
    console.log(`- agent bin: ${config.agentBin}`);
    console.log(
      `- ACP: ${config.useAcp ? "yes" : "no"}${config.useAcp ? ` (launcher: ${acpLauncherLabel(config.acpArgs)})` : ""}`,
    );
    console.log(`- workspace: ${config.workspace}`);
    console.log(`- mode: ${config.mode}`);
    console.log(`- default model: ${config.defaultModel}`);
    console.log(`- force: ${config.force}`);
    console.log(`- approve mcps: ${config.approveMcps}`);
    console.log(`- required api key: ${config.requiredKey ? "yes" : "no"}`);
    console.log(`- sessions log: ${config.sessionsLogPath}`);
    console.log(
      `- chat-only workspace: ${config.chatOnlyWorkspace ? "yes (isolated temp dir)" : "no"}`,
    );
    console.log(
      `- verbose traffic: ${config.verbose ? "yes (CURSOR_BRIDGE_VERBOSE=true)" : "no"}`,
    );
    console.log(
      `- max mode: ${config.maxMode ? "yes (CURSOR_BRIDGE_MAX_MODE=true)" : "no"}`,
    );
    console.log(
      `- Windows cmdline budget: ${config.winCmdlineMax} (prompt tail truncation when over limit; Windows only)`,
    );
    if (config.configDirs && config.configDirs.length > 0) {
      console.log(
        `- account pool: enabled with ${config.configDirs.length} configuration directories`,
      );
    }
  });

  return server;
}
