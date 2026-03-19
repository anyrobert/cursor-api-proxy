/**
 * Minimal fake ACP server for integration tests.
 * Reads JSON-RPC from stdin, responds to initialize, authenticate, session/new, session/prompt.
 */
import { createInterface } from "node:readline";

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  try {
    const msg = JSON.parse(line);
    if (msg.id != null && msg.method) {
      let result = {};
      if (msg.method === "initialize") result = { protocolVersion: 1 };
      else if (msg.method === "authenticate") result = {};
      else if (msg.method === "session/new") result = { sessionId: "sess-1" };
      else if (msg.method === "session/prompt") {
        result = {};
        process.stdout.write(
          JSON.stringify({
            jsonrpc: "2.0",
            method: "session/update",
            params: {
              update: {
                sessionUpdate: "agent_message_chunk",
                content: { text: "Hello from fake ACP" },
              },
            },
          }) + "\n",
        );
      }
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }) + "\n");
    }
  } catch {
    /* ignore */
  }
});
