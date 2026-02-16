#!/usr/bin/env node

import { loadBridgeConfig } from "./lib/config.js";
import { startBridgeServer } from "./lib/server.js";

function parseArgs(argv: string[]) {
  let tailscale = false;
  let help = false;

  for (const arg of argv) {
    if (arg === "--tailscale") {
      tailscale = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      help = true;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return { tailscale, help };
}

function printHelp() {
  console.log("cursor-api-proxy");
  console.log("");
  console.log("Usage:");
  console.log("  cursor-api-proxy [--tailscale]");
  console.log("");
  console.log("Options:");
  console.log("  --tailscale  Bind to 0.0.0.0 for tailnet/LAN access");
  console.log("  -h, --help   Show this help message");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    printHelp();
    return;
  }

  if (args.tailscale && !process.env.CURSOR_BRIDGE_HOST) {
    process.env.CURSOR_BRIDGE_HOST = "0.0.0.0";
  }

  const config = loadBridgeConfig();
  startBridgeServer({ version: "0.1.0", config });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
