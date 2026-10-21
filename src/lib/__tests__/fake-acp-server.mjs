/**
 * Fake ACP server. Tool scenarios act as an MCP HTTP client so tests exercise
 * the real proxy-owned MCP transport and parked tools/call lifecycle.
 */
import { closeSync, openSync, readFileSync } from "node:fs";
import { devNull } from "node:os";
import { createInterface } from "node:readline";

const scenario = process.env.FAKE_ACP_SCENARIO || "";
const waiting = new Map();
let mcpServers = [];
let nextMcpId = 1;
let nextClientRequestId = 10_000;
let selectedModel = "default";
const parameterValues = {};

const PARAMETERIZED_MODELS = ["default", "glm-5.2", "claude-opus-5", "gpt-5.6-sol", "composer-2.5"];
const GROK_MODELS = ["default", "grok-4.5", "grok-4.6"];
const GROK_VARIANT_ROWS = ["default", "grok-4.6", "grok-4.6-medium"];
const PARAMETER_DEFAULTS = {
  "glm-5.2": {
    reasoning: { current: "high", values: ["high", "max"] },
  },
  "claude-opus-5": {
    thinking: { current: "true", values: ["false", "true"] },
    effort: { current: "high", values: ["low", "medium", "high", "xhigh", "max"] },
    fast: { current: "true", values: ["false", "true"] },
  },
  "gpt-5.6-sol": {
    reasoning: { current: "medium", values: ["none", "low", "medium", "high", "xhigh", "max"] },
    fast: { current: "false", values: ["false", "true"] },
  },
  "composer-2.5": {
    fast: { current: "true", values: ["false", "true"] },
  },
  "grok-4.5": {
    reasoning: { current: "medium", values: ["low", "medium", "high"] },
    fast: { current: "true", values: ["false", "true"] },
  },
  "grok-4.6": {
    reasoning: { current: "medium", values: ["low", "medium", "high", "xhigh"] },
    fast: { current: "true", values: ["false", "true"] },
  },
};

/**
 * "real_catalog" replays a captured Cursor CLI: `--model <public id>` resolves
 * the way the real `session/new` resolved it, unknown ids fail at startup like
 * the CLI does, and FAKE_ACP_CURRENT_MODEL overrides the CLI's pick (e.g.
 * "default"). Like the CLI, option values are remembered per family:
 * set_config_option(model) returns what `--model` just resolved for that
 * family, else the captured per-family options. The prompt answer is the JSON
 * selection ({ model, values, calls }) the turn ran with, sent on stdout so it
 * cannot race the JSON-RPC reply.
 */
const realCatalog =
  scenario === "real_catalog"
    ? JSON.parse(
        readFileSync(new URL("./acp-real-catalog.json", import.meta.url), "utf8"),
      )
    : undefined;
const realStored = {};
let realOptions = [];
const realCalls = [];

function cliModelArg() {
  const index = process.argv.indexOf("--model");
  return index >= 0 ? process.argv[index + 1] : undefined;
}

if (realCatalog && cliModelArg() && !realCatalog.sessions[cliModelArg()]) {
  process.stderr.write(`Cannot use this model: ${cliModelArg()}.\n`);
  process.exit(1);
}

function realConfigOptions() {
  const sample = realCatalog.sessionNewSample.result.configOptions;
  return [
    sample.find((option) => option.id === "mode"),
    {
      ...sample.find((option) => option.id === "model"),
      currentValue: selectedModel,
    },
    ...realOptions,
  ];
}

function realFamilyOptions(family) {
  realStored[family] ??= structuredClone(realCatalog.familyOptions[family] ?? []);
  return realStored[family];
}

function realSessionNew() {
  const requested = cliModelArg();
  const captured = requested ? realCatalog.sessions[requested] : undefined;
  selectedModel =
    process.env.FAKE_ACP_CURRENT_MODEL ?? captured?.currentModelId ?? "default";
  realOptions = realFamilyOptions(selectedModel);
  for (const option of realOptions) {
    option.currentValue = captured?.values[option.id] ?? option.currentValue;
  }
  const sample = structuredClone(realCatalog.sessionNewSample.result);
  return {
    ...sample,
    sessionId: "sess-1",
    models: { ...sample.models, currentModelId: selectedModel },
    configOptions: realConfigOptions(),
  };
}

function invalidParams(message) {
  return { error: { code: -32602, message: "Invalid params", data: { message } } };
}

function realConfigResult(params) {
  realCalls.push(`${params?.configId}=${params?.value}`);
  if (params?.configId === "model") {
    if (!realCatalog.familyOptions[params.value]) {
      return invalidParams(`Invalid model value: ${params.value}`);
    }
    selectedModel = params.value;
    realOptions = realFamilyOptions(params.value);
  } else {
    const option = realOptions.find((item) => item.id === params?.configId);
    if (!option?.options.some((item) => item.value === params.value)) {
      return invalidParams(`Invalid value for ${params?.configId}: ${params?.value}`);
    }
    option.currentValue = params.value;
  }
  return { result: { configOptions: realConfigOptions() } };
}

function send(message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
}

function sessionNewResult() {
  if (realCatalog) return realSessionNew();
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
  if (scenario === "grok_models") {
    return {
      sessionId: "sess-1",
      models: {
        availableModels: [
          { modelId: "default", name: "Auto" },
          { modelId: "grok-4.5", name: "Grok 4.5" },
          { modelId: "grok-4.6", name: "Grok 4.6" },
        ],
      },
    };
  }
  if (scenario === "grok_variant_rows") {
    return {
      sessionId: "sess-1",
      models: {
        availableModels: [
          { modelId: "default", name: "Auto" },
          { modelId: "grok-4.6", name: "Grok 4.6" },
          { modelId: "grok-4.6-medium", name: "Grok 4.6 Medium" },
        ],
      },
    };
  }
  if (scenario === "parameterized_models") {
    return {
      sessionId: "sess-1",
      models: {
        availableModels: [
          { modelId: "default", name: "Auto" },
          { modelId: "glm-5.2", name: "GLM 5.2" },
          { modelId: "claude-opus-5", name: "Claude Opus 5" },
          { modelId: "gpt-5.6-sol", name: "GPT-5.6 Sol" },
          { modelId: "composer-2.5", name: "Composer 2.5" },
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

async function runToolPrompt(params) {
  if (scenario === "tool_transcript") {
    // A session rebuilt from a transcript answers from the "Tool:" lines it
    // was given; a resumed session would report "Tool result:" instead.
    // "[continued]" marks a prompt that says those calls already ran.
    const prompt = params?.prompt?.[0]?.text ?? "";
    const results = [...prompt.matchAll(/^Tool: (.*)$/gm)].map((m) => m[1]);
    if (results.length > 0) {
      const continued = prompt.includes("already ran") ? "[continued] " : "";
      update("agent_message_chunk", {
        content: {
          text: `${continued}Answer from transcript: ${results.join(", ")}`,
        },
      });
      return;
    }
  }
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

/**
 * Ask the documented cursor/* blocking requests. The answer text is the JSON
 * of each reply, sent on stdout so it cannot race the JSON-RPC reply.
 */
async function runCursorExtensionsPrompt() {
  const requests = [
    [
      "cursor/ask_question",
      {
        toolCallId: "ask-1",
        questions: [
          {
            id: "q1",
            prompt: "Which?",
            options: [
              { id: "a", label: "A" },
              { id: "b", label: "B" },
            ],
          },
        ],
      },
    ],
    [
      "cursor/create_plan",
      { toolCallId: "plan-1", plan: "# Plan", todos: [] },
    ],
  ];
  const answers = {};
  for (const [method, params] of requests) {
    answers[method] = await askClient(method, params);
  }
  update("agent_message_chunk", { content: { text: JSON.stringify(answers) } });
}

function parameterizedConfigResult(params) {
  const models =
    scenario === "grok_models"
      ? GROK_MODELS
      : scenario === "grok_variant_rows"
        ? GROK_VARIANT_ROWS
        : PARAMETERIZED_MODELS;
  if (params?.configId === "model") {
    if (!models.includes(params.value)) {
      return {
        error: {
          code: -32602,
          message: "Invalid params",
          data: { message: `Invalid model value: ${params.value}` },
        },
      };
    }
    selectedModel = params.value;
    for (const key of Object.keys(parameterValues)) delete parameterValues[key];
  } else if (params?.configId) {
    const spec = PARAMETER_DEFAULTS[selectedModel]?.[params.configId];
    if (!spec || !spec.values.includes(params.value)) {
      return {
        error: {
          code: -32602,
          message: "Invalid params",
          data: { message: `Invalid value for ${params.configId}: ${params.value}` },
        },
      };
    }
    parameterValues[params.configId] = params.value;
  }
  const specs = PARAMETER_DEFAULTS[selectedModel] ?? {};
  const configOptions = [
    {
      id: "model",
      currentValue: selectedModel,
      options: models.map((value) => ({ value })),
    },
    ...Object.entries(specs).map(([id, spec]) => ({
      id,
      currentValue: parameterValues[id] ?? spec.current,
      options: spec.values.map((value) => ({ value })),
    })),
  ];
  return { result: { configOptions } };
}

function isToolScenario() {
  return scenario.startsWith("tool_");
}

/**
 * Fail like a CLI that rejects its flags or login: plain text on stdout and
 * stderr, exit 1, no JSON-RPC reply. Exit only once both writes flushed.
 */
function failStartup() {
  let unflushed = 2;
  const exit = () => {
    unflushed -= 1;
    if (unflushed === 0) process.exit(1);
  };
  process.stdout.write("Error: Authentication required.\n", exit);
  process.stderr.write("agent: unknown option '--bogus-flag'\n", exit);
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
    if (scenario === "start_failure") {
      failStartup();
      return;
    }
    if (scenario === "closed_stdin_after_initialize") {
      // Close before acknowledging initialize, so the parent cannot write
      // session/new until the pipe reader is already gone.
      rl.close();
      closeSync(0);
      // Keep fd 0 taken. Otherwise libuv can reuse it for an internal handle
      // and abort when closing it ("Assertion failed: (fd > STDERR_FILENO)"
      // on macOS), so the child dies before the parent ever sees EPIPE.
      openSync(devNull, "r");
      setTimeout(() => process.exit(1), 200);
    }
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
    if (realCatalog) {
      send({ id: msg.id, ...realConfigResult(msg.params) });
      return;
    }
    if (
      scenario === "parameterized_models" ||
      scenario === "grok_models" ||
      scenario === "grok_variant_rows"
    ) {
      const outcome = parameterizedConfigResult(msg.params);
      send({ id: msg.id, ...outcome });
      return;
    }
    send({ id: msg.id, result: {} });
    return;
  }
  if (msg.method === "session/prompt") {
    if (realCatalog) {
      const values = Object.fromEntries(
        realOptions.map((option) => [option.id, option.currentValue]),
      );
      const text = JSON.stringify({ model: selectedModel, values, calls: realCalls });
      update("agent_message_chunk", { content: { text } });
      send({ id: msg.id, result: {} });
      return;
    }
    if (scenario === "process_exit") {
      setTimeout(() => process.exit(7), 10);
      return;
    }
    if (scenario === "hang_prompt") {
      // Never answer, so the caller's abort or overall timeout ends the turn.
      return;
    }
    if (scenario === "retriable_trailer") {
      // The real CLI reports a stream that broke after the answer as one more
      // chunk, then still ends the turn normally (#76).
      update("agent_message_chunk", {
        content: { text: "The image shows a red square." },
      });
      update("agent_message_chunk", {
        content: { text: "\n\nError: RetriableError: WritableIterable is closed" },
      });
      send({ id: msg.id, result: { stopReason: "end_turn" } });
      return;
    }
    if (scenario === "retriable_trailer_after_tool_call") {
      update("agent_message_chunk", { content: { text: "Let me look.\n\n" } });
      update("tool_call", {
        toolCallId: "read-1",
        title: "Read image",
        kind: "read",
        status: "pending",
      });
      update("tool_call_update", { toolCallId: "read-1", status: "completed" });
      update("agent_message_chunk", { content: { text: "It is a red square." } });
      update("agent_message_chunk", {
        content: { text: "\n\nError: RetriableError: WritableIterable is closed" },
      });
      send({ id: msg.id, result: { stopReason: "end_turn" } });
      return;
    }
    const operation = isToolScenario()
      ? runToolPrompt(msg.params)
      : scenario === "builtin_permission"
        ? runBuiltinPermissionPrompt()
        : scenario === "cursor_extensions"
          ? runCursorExtensionsPrompt()
          : Promise.resolve().then(async () => {
            if (scenario === "with_thought") {
              update("agent_thought_chunk", {
                content: { text: "SECRET_THOUGHT" },
              });
            }
            if (scenario === "slow_text") {
              await new Promise((resolve) => setTimeout(resolve, 120));
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
