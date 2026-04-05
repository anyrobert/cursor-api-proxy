import * as fs from "node:fs";
import * as http from "node:http";
import * as https from "node:https";

import type { BridgeConfig } from "./config.js";
import { createRequestListener } from "./request-listener.js";
import { initAccountPool } from "./account-pool.js";
import { killAllChildProcesses } from "./process.js";

function acpLauncherLabel(acpArgs: string[]): string {
  const first = acpArgs[0];
  if (first && /\.[cm]?js$/i.test(first)) return "node + script";
  return "cmd";
}

export type BridgeServerOptions = {
  version: string;
  config: BridgeConfig;
};

export function startBridgeServer(
  opts: BridgeServerOptions,
): (http.Server | https.Server)[] {
  const { config } = opts;
  const servers: (http.Server | https.Server)[] = [];

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
 * Register SIGTERM / SIGINT handlers for graceful shutdown.
 * Closes all HTTP(S) servers, kills in-flight agent processes, then exits.
 */
export function setupGracefulShutdown(
  servers: (http.Server | https.Server)[],
  timeoutMs = 10_000,
): void {
  let shuttingDown = false;

  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(
      `\n[${new Date().toISOString()}] ${signal} received — shutting down gracefully…`,
    );

    // Stop accepting new connections and kill all in-flight agent processes
    killAllChildProcesses();

    const closePromises = servers.map(
      (s) =>
        new Promise<void>((resolve) => {
          // closeAllConnections available since Node 18.2
          if (typeof (s as any).closeAllConnections === "function") {
            (s as any).closeAllConnections();
          }
          s.close(() => resolve());
        }),
    );

    const forceExit = setTimeout(() => {
      console.error(
        "[shutdown] Timed out waiting for connections to drain — forcing exit.",
      );
      process.exit(1);
    }, timeoutMs).unref();

    Promise.all(closePromises).then(() => {
      clearTimeout(forceExit);
      process.exit(0);
    });
  };

  process.once("SIGTERM", () => shutdown("SIGTERM"));
  process.once("SIGINT", () => shutdown("SIGINT"));
}

function startSingleServer(
  opts: BridgeServerOptions,
): http.Server | https.Server {
  const { config } = opts;

  const requestListener = createRequestListener(opts);

  const useTls = Boolean(config.tlsCertPath && config.tlsKeyPath);
  let server: http.Server | https.Server;

  if (useTls) {
    const cert = fs.readFileSync(config.tlsCertPath!, "utf8");
    const key = fs.readFileSync(config.tlsKeyPath!, "utf8");
    server = https.createServer({ cert, key }, requestListener);
  } else {
    server = http.createServer(requestListener);
  }

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
