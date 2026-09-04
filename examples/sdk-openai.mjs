#!/usr/bin/env bun

/**
 * Example: use the SDK with the OpenAI client (getOpenAIOptionsAsync).
 * The proxy starts in the background automatically if not already running,
 * and the SDK stops it when this script exits.
 *
 * Prereqs: Cursor CLI installed and logged in (agent login). Install OpenAI SDK: bun add openai
 *
 * Run: bun examples/sdk-openai.mjs
 */

import { getOpenAIOptionsAsync } from "cursor-api-proxy";
import OpenAI from "openai";

async function main() {
  const opts = await getOpenAIOptionsAsync();
  const client = new OpenAI(opts);

  console.log(
    "Chat completion via OpenAI SDK + cursor-api-proxy (proxy starts automatically if needed)",
  );
  console.log("---");

  const completion = await client.chat.completions.create({
    model: "auto",
    messages: [{ role: "user", content: "Say hello in one short sentence." }],
  });

  const content = completion.choices[0]?.message?.content ?? "(no content)";
  console.log("Response:", content);
  console.log("---");
  console.log("Usage:", completion.usage ?? "N/A");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
