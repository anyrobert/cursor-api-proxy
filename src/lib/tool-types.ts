/** A member of a Responses `namespace` tool group, as the client named it. */
export type NamespacedToolName = {
  namespace: string;
  name: string;
};

export type ClientToolDefinition = {
  /** Unique name the agent sees; may carry a `<namespace>__` prefix. */
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  /** Client-side identity of a flattened `namespace` member. */
  namespaced?: NamespacedToolName;
};

export type ClientToolOutput = {
  callId: string;
  output: string;
  isError?: boolean;
};

export type PendingClientToolCall = {
  callId: string;
  itemId: string;
  /** Agent-visible tool name (see ClientToolDefinition.name). */
  name: string;
  arguments: string;
  namespaced?: NamespacedToolName;
};

export type ResolvedToolChoice = {
  tools: ClientToolDefinition[];
  instruction?: string;
  required: boolean;
  maxParallelToolCalls?: number;
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function schemaOrDefault(value: unknown): Record<string, unknown> {
  return (
    asRecord(value) ?? {
      type: "object",
      properties: {},
    }
  );
}

function pushUnique(
  out: ClientToolDefinition[],
  seen: Set<string>,
  definition: ClientToolDefinition,
): void {
  if (!definition.name.trim()) {
    throw new Error("Function tool is missing name");
  }
  if (seen.has(definition.name)) {
    throw new Error(`Duplicate function tool name: ${definition.name}`);
  }
  seen.add(definition.name);
  out.push(definition);
}

function functionDefinition(
  tool: Record<string, unknown>,
): ClientToolDefinition {
  const wrapped = asRecord(tool.function);
  const fn = wrapped ?? tool;
  if (typeof fn.name !== "string") {
    throw new Error("Function tool is missing name");
  }
  return {
    name: fn.name,
    description:
      typeof fn.description === "string" ? fn.description : undefined,
    inputSchema: schemaOrDefault(fn.parameters),
  };
}

function pushNamespaceMembers(
  out: ClientToolDefinition[],
  seen: Set<string>,
  topLevelNames: ReadonlySet<string>,
  group: Record<string, unknown>,
): void {
  const namespace = typeof group.name === "string" ? group.name.trim() : "";
  const members = Array.isArray(group.tools) ? group.tools : [];
  for (const member of members) {
    const nested = asRecord(member);
    if (!nested || nested.type !== "function") continue;
    const definition = functionDefinition(nested);
    if (!namespace) {
      pushUnique(out, seen, definition);
      continue;
    }
    const bare = definition.name;
    if (
      out.some(
        (tool) =>
          tool.namespaced?.namespace === namespace &&
          tool.namespaced.name === bare,
      )
    ) {
      throw new Error(`Duplicate function tool name: ${namespace}.${bare}`);
    }
    pushUnique(out, seen, {
      ...definition,
      name:
        topLevelNames.has(bare) || seen.has(bare)
          ? `${namespace}__${bare}`
          : bare,
      namespaced: { namespace, name: bare },
    });
  }
}

/**
 * Parse OpenAI Chat Completions (`function` wrapper), Responses (flat
 * function), and legacy Chat `functions` definitions.
 *
 * Responses `namespace` groups are flattened into their member functions.
 * A member keeps its bare name unless a top-level function or an earlier
 * member already uses it, in which case it becomes `<namespace>__<name>`.
 * Either way `namespaced` records the client's own (namespace, name) so
 * calls can be reported back the way the client declared them.
 *
 * Host-side builtin types (`web_search`, `file_search`, ...) are dropped;
 * the agent cannot execute them.
 */
export function parseOpenAiFunctionTools(
  tools?: readonly unknown[],
  functions?: readonly unknown[],
): ClientToolDefinition[] {
  const out: ClientToolDefinition[] = [];
  const seen = new Set<string>();
  const records = (tools ?? []).map((value) => {
    const tool = asRecord(value);
    if (!tool) throw new Error("Invalid tool definition");
    return tool;
  });

  // Reserve top-level names up front so a top-level function keeps its bare
  // name even when a colliding namespace group is listed before it.
  const topLevelNames = new Set<string>();
  for (const tool of records) {
    if (tool.type !== "function") continue;
    const name = (asRecord(tool.function) ?? tool).name;
    if (typeof name === "string") topLevelNames.add(name);
  }
  for (const value of functions ?? []) {
    const name = asRecord(value)?.name;
    if (typeof name === "string") topLevelNames.add(name);
  }

  for (const tool of records) {
    if (tool.type === "function") {
      pushUnique(out, seen, functionDefinition(tool));
    } else if (tool.type === "namespace") {
      pushNamespaceMembers(out, seen, topLevelNames, tool);
    }
  }

  for (const value of functions ?? []) {
    const fn = asRecord(value);
    if (!fn || typeof fn.name !== "string") {
      throw new Error("Function is missing name");
    }
    pushUnique(out, seen, {
      name: fn.name,
      description:
        typeof fn.description === "string" ? fn.description : undefined,
      inputSchema: schemaOrDefault(fn.parameters),
    });
  }

  return out;
}

export function parseAnthropicFunctionTools(
  tools?: readonly unknown[],
): ClientToolDefinition[] {
  const out: ClientToolDefinition[] = [];
  const seen = new Set<string>();
  for (const value of tools ?? []) {
    const tool = asRecord(value);
    if (!tool || typeof tool.name !== "string") {
      throw new Error("Anthropic tool is missing name");
    }
    pushUnique(out, seen, {
      name: tool.name,
      description:
        typeof tool.description === "string" ? tool.description : undefined,
      inputSchema: schemaOrDefault(tool.input_schema),
    });
  }
  return out;
}

/**
 * Names of the Anthropic-defined tools in a request (`web_search_20250305`,
 * `bash_20250124`, `text_editor_20250124`, ...). They carry a versioned
 * `type`, while client tools have no `type` or `custom`, and the request
 * holds no schema or description for them.
 */
export function anthropicBuiltinToolNames(
  tools?: readonly unknown[],
): Set<string> {
  const names = new Set<string>();
  for (const value of tools ?? []) {
    const tool = asRecord(value);
    if (
      tool &&
      typeof tool.type === "string" &&
      tool.type !== "custom" &&
      typeof tool.name === "string"
    ) {
      names.add(tool.name);
    }
  }
  return names;
}

function namedChoice(choice: unknown): string | undefined {
  const rec = asRecord(choice);
  if (!rec) return undefined;
  if (typeof rec.name === "string") return rec.name;
  const fn = asRecord(rec.function);
  if (fn && typeof fn.name === "string") return fn.name;
  return undefined;
}

export function resolveToolChoice(
  tools: readonly ClientToolDefinition[],
  choice: unknown,
  opts: { parallelToolCalls?: boolean } = {},
): ResolvedToolChoice {
  if (choice === "none" || asRecord(choice)?.type === "none") {
    return { tools: [], required: false };
  }

  const required =
    choice === "required" ||
    choice === "any" ||
    asRecord(choice)?.type === "any";
  const selected = namedChoice(choice);
  let resolved = [...tools];
  let instruction: string | undefined;

  if (selected) {
    const tool = tools.find((item) => item.name === selected);
    if (!tool) throw new Error(`Unknown tool_choice function: ${selected}`);
    resolved = [tool];
    instruction = `You must call the ${selected} tool.`;
  } else if (required) {
    if (tools.length === 0) {
      throw new Error(
        `tool_choice "${typeof choice === "string" ? choice : "any"}" requires a tool call, ` +
          "but the request has no callable function tools " +
          "(host-side builtins such as web_search are not supported)",
      );
    }
    instruction = "You must call at least one available tool.";
  }

  if (opts.parallelToolCalls === false && resolved.length > 0) {
    instruction = [instruction, "Call at most one tool at a time."]
      .filter(Boolean)
      .join(" ");
  }
  return {
    tools: resolved,
    required: required || selected !== undefined,
    ...(opts.parallelToolCalls === false ? { maxParallelToolCalls: 1 } : {}),
    ...(instruction ? { instruction } : {}),
  };
}

function stringifyOutput(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    const text = value
      .map((part) => {
        if (typeof part === "string") return part;
        const rec = asRecord(part);
        return rec?.type === "text" && typeof rec.text === "string"
          ? rec.text
          : "";
      })
      .filter(Boolean)
      .join("\n");
    if (text) return text;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function chatToolOutputs(
  messages: readonly unknown[],
): ClientToolOutput[] {
  const outputs: ClientToolOutput[] = [];
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = asRecord(messages[i]);
    if (!message || message.role !== "tool") break;
    if (typeof message.tool_call_id !== "string" || !message.tool_call_id) {
      throw new Error("Tool message is missing tool_call_id");
    }
    outputs.unshift({
      callId: message.tool_call_id,
      output: stringifyOutput(message.content),
    });
  }
  return outputs;
}

export function responsesToolOutputs(input: unknown): ClientToolOutput[] {
  if (!Array.isArray(input)) return [];
  const outputs: ClientToolOutput[] = [];
  for (const value of input) {
    const item = asRecord(value);
    if (!item || item.type !== "function_call_output") continue;
    if (typeof item.call_id !== "string" || !item.call_id) {
      throw new Error("function_call_output is missing call_id");
    }
    outputs.push({
      callId: item.call_id,
      output: stringifyOutput(item.output),
    });
  }
  return outputs;
}

const TURN_OPENING_ROLES = new Set(["user", "developer", "system"]);

/**
 * Index of the first `input` item of the model's current turn: everything
 * after the last user, developer or system message (a bare string is a user
 * message). What follows it is model output (`function_call`, assistant
 * `message`, `reasoning`) and the caller's `function_call_output` replies.
 */
function responsesTurnStart(input: readonly unknown[]): number {
  for (let i = input.length - 1; i >= 0; i -= 1) {
    const value = input[i];
    if (typeof value === "string") return i + 1;
    const item = asRecord(value);
    if (!item || (item.type != null && item.type !== "message")) continue;
    if (typeof item.role === "string" && TURN_OPENING_ROLES.has(item.role)) {
      return i + 1;
    }
  }
  return 0;
}

/**
 * The `function_call_output` items that answer the model's current turn.
 *
 * A client that resends its whole history instead of a
 * `previous_response_id` (Codex sends `store: false` and never chains) also
 * carries the outputs of turns that already finished. Those sit before the
 * latest user, developer or system message and must not resume anything, so
 * only outputs after it count.
 */
export function responsesTurnToolOutputs(input: unknown): ClientToolOutput[] {
  if (!Array.isArray(input)) return [];
  return responsesToolOutputs(input.slice(responsesTurnStart(input)));
}

/** Every `call_id` an input names, on `function_call` or its output. */
export function responsesCallIds(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const ids = new Set<string>();
  for (const value of input) {
    const item = asRecord(value);
    if (
      (item?.type === "function_call" ||
        item?.type === "function_call_output") &&
      typeof item.call_id === "string" &&
      item.call_id
    ) {
      ids.add(item.call_id);
    }
  }
  return [...ids];
}

export function anthropicToolOutputs(
  messages: readonly unknown[],
): ClientToolOutput[] {
  const last = asRecord(messages[messages.length - 1]);
  if (!last || last.role !== "user" || !Array.isArray(last.content)) return [];
  const outputs: ClientToolOutput[] = [];
  for (const value of last.content) {
    const block = asRecord(value);
    if (!block || block.type !== "tool_result") continue;
    if (typeof block.tool_use_id !== "string" || !block.tool_use_id) {
      throw new Error("tool_result is missing tool_use_id");
    }
    outputs.push({
      callId: block.tool_use_id,
      output: stringifyOutput(block.content),
      isError: block.is_error === true,
    });
  }
  return outputs;
}
