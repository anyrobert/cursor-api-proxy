/**
 * Fake Cursor ACP agent whose tool calls go through the MCP SDK client, the
 * client the real agent bundles, so tests get its real timeout and
 * notifications/cancelled behaviour. FAKE_ACP_MCP_SCENARIO picks the turn:
 * - "echo_prompt": answers with the prompt text it was sent
 * - "retry_on_timeout": calls the first tool with a FAKE_ACP_MCP_TIMEOUT_MS
 *   MCP timeout and, like the model does, retries the same call after each
 *   timeout; answers "Tool result: <output> (attempt <n>)"
 */
import { createInterface } from "node:readline";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ErrorCode } from "@modelcontextprotocol/sdk/types.js";

const scenario = process.env.FAKE_ACP_MCP_SCENARIO ?? "";
const timeout = Number(process.env.FAKE_ACP_MCP_TIMEOUT_MS ?? 60_000);
const MAX_ATTEMPTS = 50;
const SESSION_ID = "sess-mcp";
let mcpServers = [];

function send(message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
}

function say(text) {
  send({
    method: "session/update",
    params: {
      sessionId: SESSION_ID,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text },
      },
    },
  });
}

async function connectMcp() {
  const server = mcpServers[0];
  if (!server?.url) throw new Error("session/new did not receive HTTP MCP");
  const headers = Object.fromEntries(
    (server.headers ?? []).map(({ name, value }) => [name, value]),
  );
  const transport = new StreamableHTTPClientTransport(new URL(server.url), {
    requestInit: { headers },
  });
  // A notification's send settles once the server has handled it.
  const notifications = [];
  const send = transport.send.bind(transport);
  transport.send = (message, options) => {
    const sent = send(message, options);
    if (!("id" in message)) notifications.push(sent);
    return sent;
  };
  const client = new Client({ name: "fake-cursor-agent", version: "1.0.0" });
  await client.connect(transport);
  return { client, notified: () => Promise.all(notifications) };
}

async function retryOnTimeout() {
  const { client, notified } = await connectMcp();
  const { tools } = await client.listTools();
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      const result = await client.callTool(
        { name: tools[0].name, arguments: { city: "Paris" } },
        undefined,
        { timeout },
      );
      say(`Tool result: ${result.content[0]?.text} (attempt ${attempt})`);
      return;
    } catch (error) {
      if (error?.code !== ErrorCode.RequestTimeout) throw error;
    }
    // The model needs a turn to retry, long after the SDK's
    // notifications/cancelled for the timed-out call has landed.
    await notified();
  }
  throw new Error(`Tool call timed out ${MAX_ATTEMPTS} times`);
}

async function runPrompt(params) {
  if (scenario === "echo_prompt") {
    say(params?.prompt?.[0]?.text ?? "");
    return;
  }
  if (scenario === "retry_on_timeout") {
    await retryOnTimeout();
    return;
  }
  throw new Error(`Unknown FAKE_ACP_MCP_SCENARIO: ${scenario}`);
}

createInterface({ input: process.stdin }).on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.id === undefined || !msg.method) return;
  if (msg.method === "initialize") {
    send({
      id: msg.id,
      result: {
        protocolVersion: 1,
        agentCapabilities: { mcpCapabilities: { http: true, sse: false } },
      },
    });
    return;
  }
  if (msg.method === "session/new") {
    mcpServers = msg.params?.mcpServers ?? [];
    send({ id: msg.id, result: { sessionId: SESSION_ID } });
    return;
  }
  if (msg.method === "session/prompt") {
    runPrompt(msg.params).then(
      () => send({ id: msg.id, result: { stopReason: "end_turn" } }),
      (error) =>
        send({
          id: msg.id,
          error: { code: -32603, message: String(error?.message ?? error) },
        }),
    );
    return;
  }
  send({ id: msg.id, result: {} });
});
