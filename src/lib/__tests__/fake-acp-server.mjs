/**
 * Fake ACP server. Tool scenarios act as an MCP HTTP client so tests exercise
 * the real proxy-owned MCP transport and parked tools/call lifecycle.
 */
import { createInterface } from "node:readline";

const scenario = process.env.FAKE_ACP_SCENARIO || "";
const waiting = new Map();
let mcpServers = [];
let nextMcpId = 1;
let nextClientRequestId = 10_000;

function send(message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
}

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
  if (scenario === "display_model") {
    return {
      sessionId: "sess-1",
      models: {
        availableModels: [
          {
            modelId: "gpt-5.6-sol[reasoning=high]",
            name: "GPT-5.6 Sol High",
          },
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

function update(sessionUpdate, value = {}) {
  send({
    method: "session/update",
    params: { update: { sessionUpdate, ...value } },
  });
}

function askClient(method, params) {
  const id = nextClientRequestId++;
  return new Promise((resolve, reject) => {
    waiting.set(id, { resolve, reject });
    send({ id, method, params });
  });
}

function mcpHeaders(server, sessionId) {
  const headers = {
    accept: "application/json, text/event-stream",
    "content-type": "application/json",
    "mcp-protocol-version": "2025-03-26",
  };
  for (const header of server.headers ?? []) {
    headers[header.name] = header.value;
  }
  if (sessionId) headers["mcp-session-id"] = sessionId;
  return headers;
}

async function mcpPost(server, method, params, sessionId) {
  const id = nextMcpId++;
  const response = await fetch(server.url, {
    method: "POST",
    headers: mcpHeaders(server, sessionId),
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`MCP ${method} failed ${response.status}: ${text}`);
  }
  const parsed = JSON.parse(text);
  if (parsed.error) throw new Error(parsed.error.message);
  return {
    result: parsed.result,
    sessionId: response.headers.get("mcp-session-id") ?? sessionId,
  };
}

async function mcpNotify(server, method, params, sessionId) {
  const response = await fetch(server.url, {
    method: "POST",
    headers: mcpHeaders(server, sessionId),
    body: JSON.stringify({ jsonrpc: "2.0", method, params }),
  });
  if (!response.ok) {
    throw new Error(`MCP ${method} notification failed ${response.status}`);
  }
}

async function connectMcp() {
  const server = mcpServers[0];
  if (!server?.url) throw new Error("session/new did not receive HTTP MCP");
  const initialized = await mcpPost(
    server,
    "initialize",
    {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "fake-acp", version: "1" },
    },
    undefined,
  );
  await mcpNotify(
    server,
    "notifications/initialized",
    {},
    initialized.sessionId,
  );
  return { server, sessionId: initialized.sessionId };
}

async function requestToolPermission(name, index) {
  const toolCallId = `fake-tool-${index}`;
  update("tool_call", {
    toolCallId,
    title: "MCP: tool",
    kind: "other",
    status: "pending",
  });
  const response = await askClient("session/request_permission", {
    sessionId: "sess-1",
    toolCall: {
      toolCallId,
      title: "MCP: tool",
      kind: "other",
    },
    options: [
      { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
      {
        optionId: "reject-once",
        name: "Reject once",
        kind: "reject_once",
      },
    ],
  });
  process.stderr.write(
    `__FAKE_ACP_PERMISSION__:${JSON.stringify(response)}\n`,
  );
  if (response?.outcome?.optionId !== "allow-once") {
    throw new Error("Proxy rejected caller MCP tool");
  }
}

async function callTool(server, sessionId, tool, index) {
  await requestToolPermission(tool.name, index);
  const response = await mcpPost(
    server,
    "tools/call",
    {
      name: tool.name,
      arguments: { city: index === 0 ? "Paris" : "London", index },
    },
    sessionId,
  );
  return response.result?.content?.[0]?.text ?? "";
}

async function runToolPrompt() {
  const { server, sessionId } = await connectMcp();
  const listed = await mcpPost(server, "tools/list", {}, sessionId);
  const tools = listed.result?.tools ?? [];
  if (tools.length === 0) throw new Error("MCP returned no tools");
  if (scenario === "tool_delay") {
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  update("agent_message_chunk", { content: { text: "Checking tools. " } });
  const parallel = scenario === "tool_parallel";
  const count = parallel ? Math.min(2, tools.length) : 1;
  const outputs = parallel
    ? await Promise.all(
        Array.from({ length: count }, (_, index) =>
          callTool(server, sessionId, tools[index], index),
        ),
      )
    : [await callTool(server, sessionId, tools[0], 0)];
  if (scenario === "tool_two_round") {
    outputs.push(await callTool(server, sessionId, tools[0], 1));
  }
  update("agent_message_chunk", {
    content: { text: `Tool result: ${outputs.join(", ")}` },
  });
}

async function runBuiltinPermissionPrompt() {
  const response = await askClient("session/request_permission", {
    sessionId: "sess-1",
    toolCall: {
      toolCallId: "builtin-1",
      title: "Run shell command",
      kind: "execute",
    },
    options: [
      { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
      {
        optionId: "reject-once",
        name: "Reject once",
        kind: "reject_once",
      },
    ],
  });
  process.stderr.write(
    `__FAKE_ACP_PERMISSION__:${JSON.stringify(response)}\n`,
  );
  update("agent_message_chunk", { content: { text: "Builtin handled" } });
}

function isToolScenario() {
  return scenario.startsWith("tool_");
}

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }

  if (msg.id != null && !msg.method) {
    const waiter = waiting.get(msg.id);
    if (waiter) {
      waiting.delete(msg.id);
      if (msg.error) waiter.reject(new Error(msg.error.message));
      else waiter.resolve(msg.result);
    }
    return;
  }
  if (msg.id == null || !msg.method) return;

  if (msg.method === "session/set_config_option") {
    process.stderr.write(
      `__FAKE_ACP_SET_CONFIG__:${JSON.stringify(msg.params)}\n`,
    );
  }
  if (
    msg.method === "session/set_config_option" &&
    scenario === "fail_set_config"
  ) {
    send({
      id: msg.id,
      error: { code: -32603, message: "Internal error" },
    });
    return;
  }

  if (msg.method === "initialize") {
    send({
      id: msg.id,
      result: {
        protocolVersion: 1,
        agentCapabilities: {
          mcpCapabilities: {
            http: scenario !== "no_http",
            sse: false,
          },
        },
      },
    });
    return;
  }
  if (msg.method === "authenticate") {
    send({ id: msg.id, result: {} });
    return;
  }
  if (msg.method === "session/new") {
    mcpServers = msg.params?.mcpServers ?? [];
    process.stderr.write(
      `__FAKE_ACP_MCP_SERVERS__:${JSON.stringify(mcpServers)}\n`,
    );
    send({ id: msg.id, result: sessionNewResult() });
    return;
  }
  if (msg.method === "session/set_config_option") {
    send({ id: msg.id, result: {} });
    return;
  }
  if (msg.method === "session/prompt") {
    if (scenario === "process_exit") {
      setTimeout(() => process.exit(7), 10);
      return;
    }
    const operation = isToolScenario()
      ? runToolPrompt()
      : scenario === "builtin_permission"
        ? runBuiltinPermissionPrompt()
        : Promise.resolve().then(() => {
            if (scenario === "with_thought") {
              update("agent_thought_chunk", {
                content: { text: "SECRET_THOUGHT" },
              });
            }
            update("agent_message_chunk", {
              content: { text: "Hello from fake ACP" },
            });
          });
    operation.then(
      () => send({ id: msg.id, result: {} }),
      (error) => {
        process.stderr.write(`__FAKE_ACP_ERROR__:${error.stack ?? error}\n`);
        send({
          id: msg.id,
          error: { code: -32603, message: error.message },
        });
      },
    );
    return;
  }
  if (msg.method === "session/cancel") return;
  send({ id: msg.id, result: {} });
});
