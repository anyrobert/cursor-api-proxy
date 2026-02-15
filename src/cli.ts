#!/usr/bin/env node

import { loadBridgeConfig } from "./lib/config.js";
import { startBridgeServer } from "./lib/server.js";

async function main() {
  const config = loadBridgeConfig();
  startBridgeServer({ version: "0.1.0", config });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
