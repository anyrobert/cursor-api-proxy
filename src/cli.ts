#!/usr/bin/env node

import fs from "node:fs";
import { fileURLToPath } from "node:url";

import pkg from "../package.json" with { type: "json" };
import { loadBridgeConfig } from "./lib/config.js";
import { startBridgeServer } from "./lib/server.js";

const __filename = fileURLToPath(import.meta.url);
const realArgv1 = process.argv[1]
  ? fs.realpathSync(process.argv[1])
  : "";
const isMainModule = realArgv1 === fs.realpathSync(__filename);

export function parseArgs(argv: string[]) {
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

  const config = loadBridgeConfig({ tailscale: args.tailscale });
  startBridgeServer({ version: pkg.version, config });
}

if (isMainModule) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
