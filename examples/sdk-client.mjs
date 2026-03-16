#!/usr/bin/env node
/**
 * Example: use the SDK minimal client (createCursorProxyClient).
 * The proxy starts in the background automatically if not already running,
 * and the SDK stops it when this script exits.
 *
 * Prereq: Cursor CLI installed and logged in (agent login)
 *
 * Run: node examples/sdk-client.mjs
 */

import { createCursorProxyClient } from "cursor-api-proxy";

async function main() {
  const proxy = createCursorProxyClient();

  console.log("Proxy will start automatically if needed. Base URL:", proxy.baseUrl);
  console.log("---");

  const data = await proxy.chatCompletionsCreate({
    model: "auto",
    messages: [{ role: "user", content: "Say hello in one short sentence." }],
  });

  const content = data.choices?.[0]?.message?.content ?? "(no content)";
  console.log("Response:", content);
  console.log("---");
  console.log("Full response (choices):", JSON.stringify(data.choices, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
