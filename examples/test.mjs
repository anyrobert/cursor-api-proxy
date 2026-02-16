#!/usr/bin/env node
/**
 * Test from cursor-api-proxy.
 *
 * Prereqs:
 *   1. Start the proxy: npm start (from repo root)
 *   2. Cursor CLI installed and logged in (agent login)
 *
 * Run: node examples/test.mjs
 */

const BASE_URL = process.env.CURSOR_PROXY_URL || "http://127.0.0.1:8765";

async function main() {
  console.log("Requesting", `${BASE_URL}/v1/chat/completions`);
  console.log("---");

  const res = await fetch(`${BASE_URL}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "auto",
      messages: [{ role: "user", content: "create a short story about a cat" }],
      stream: false,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    console.error("Error:", res.status, err);
    process.exit(1);
  }

  const data = await res.json();
  console.log(JSON.stringify(data, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
