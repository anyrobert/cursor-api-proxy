/**
 * Minimal fake ACP server for integration tests.
 * Reads JSON-RPC from stdin, responds to initialize, authenticate, session/new, session/prompt.
 *
 * Env:
 * - FAKE_ACP_SCENARIO: unset | empty_models | dup_names | fail_set_config
 *
 * Emits to stderr for assertions: __FAKE_ACP_SET_CONFIG__:<json>\n
 */
import { createInterface } from "node:readline";

const scenario = process.env.FAKE_ACP_SCENARIO || "";

function sessionNewResult() {
  if (scenario === "empty_models") {
    return { sessionId: "sess-1", models: { availableModels: [] } };
  }
  if (scenario === "dup_names") {
    return {
      sessionId: "sess-1",
      models: {
        availableModels: [
          { modelId: "first-id[]", name: "gpt-4" },
          { modelId: "second-id[]", name: "gpt-4" },
        ],
      },
    };
  }
  return {
    sessionId: "sess-1",
    models: {
      availableModels: [{ modelId: "gpt-4[fast=false]", name: "gpt-4" }],
    },
  };
}

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  try {
    const msg = JSON.parse(line);
    if (msg.id != null && msg.method) {
      if (msg.method === "session/set_config_option") {
        process.stderr.write(`__FAKE_ACP_SET_CONFIG__:${JSON.stringify(msg.params)}\n`);
      }

      if (msg.method === "session/set_config_option" && scenario === "fail_set_config") {
        process.stdout.write(
          JSON.stringify({
            jsonrpc: "2.0",
            id: msg.id,
            error: { code: -32603, message: "Internal error" },
          }) + "\n",
        );
        return;
      }

      let result = {};
      if (msg.method === "initialize") result = { protocolVersion: 1 };
      else if (msg.method === "authenticate") result = {};
      else if (msg.method === "session/new") result = sessionNewResult();
      else if (msg.method === "session/set_config_option") result = {};
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
