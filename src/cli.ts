#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadBridgeConfig } from "./lib/config.js";
import { startBridgeServer, setupGracefulShutdown } from "./lib/server.js";
import { parseArgs, printHelp } from "./cli/args.js";
import { handleAccountsList, handleLogout } from "./cli/accounts.js";
import { handleLogin } from "./cli/login.js";
import { handleResetHwid } from "./cli/reset-hwid.js";

// Re-export parseArgs so src/cli.test.ts can import it without a separate path
export { parseArgs } from "./cli/args.js";

// ---------------------------------------------------------------------------
// Package metadata
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const pkgPath = path.join(__dirname, "..", "package.json");
const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8")) as {
  version: string;
};

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    printHelp(pkg.version);
    return;
  }

  if (args.login) {
    await handleLogin(args.accountName, args.proxies);
    return;
  }

  if (args.logout) {
    await handleLogout(args.accountName);
    return;
  }

  if (args.accountsList) {
    await handleAccountsList();
    return;
  }

  if (args.resetHwid) {
    await handleResetHwid({ deepClean: args.deepClean, dryRun: args.dryRun });
    return;
  }

  const config = loadBridgeConfig({ tailscale: args.tailscale });
  const servers = startBridgeServer({ version: pkg.version, config });
  setupGracefulShutdown(servers);
}

const realArgv1 = process.argv[1] ? fs.realpathSync(process.argv[1]) : "";
const isMainModule = realArgv1 === fs.realpathSync(__filename);

if (isMainModule) {
  main().catch((err) => {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Error: ${msg}`);
    process.exit(1);
  });
}
