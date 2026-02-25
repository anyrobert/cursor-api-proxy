#!/usr/bin/env node
/**
 * Test streaming from cursor-api-proxy.
 *
 * Prereqs:
 *   1. Start the proxy: npm start (from repo root)
 *   2. Cursor CLI installed and logged in (agent login)
 *
 * Run: node examples/test-stream.mjs
 */

const BASE_URL = process.env.CURSOR_PROXY_URL || "http://127.0.0.1:8765";

async function main() {
  console.log("Streaming request to", `${BASE_URL}/v1/chat/completions`);
  console.log("---");

  const res = await fetch(`${BASE_URL}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "auto",
      messages: [{ role: "user", content: "create a short story about a cat" }],
      stream: true,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    console.error("Error:", res.status, err);
    process.exit(1);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let fullContent = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) {
      if (line.startsWith("data: ")) {
        const data = line.slice(6);
        if (data === "[DONE]") {
          console.log("\n--- [DONE]");
          continue;
        }
        try {
          const obj = JSON.parse(data);
          const delta = obj.choices?.[0]?.delta;
          if (delta?.content) {
            process.stdout.write(delta.content);
            fullContent += delta.content;
          }
        } catch (_) {
          // ignore parse errors for non-JSON lines
        }
      }
    }
  }

  if (buffer.startsWith("data: ") && buffer.slice(6) !== "[DONE]") {
    try {
      const obj = JSON.parse(buffer.slice(6));
      const delta = obj.choices?.[0]?.delta;
      if (delta?.content) {
        process.stdout.write(delta.content);
        fullContent += delta.content;
      }
    } catch (_) {}
  }

  console.log("\n---\nStreamed", fullContent.length, "chars total.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
