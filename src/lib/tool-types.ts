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
  /**
   * A freeform `custom` tool: the agent passes the tool's raw text as its
   * one `input` argument, and the client gets that text back as a custom
   * tool call instead of JSON arguments.
   */
  freeform?: boolean;
};

/**
 * How the client declared a tool, beyond the name the agent sees. Its calls
 * carry it, so each API reports them the way the tool was declared.
 */
export type ClientToolIdentity = Pick<
  ClientToolDefinition,
  "namespaced" | "freeform"
>;

export type ClientToolOutput = {
  callId: string;
  output: string;
  isError?: boolean;
};

export type PendingClientToolCall = ClientToolIdentity & {
  callId: string;
  itemId: string;
  /** Agent-visible tool name (see ClientToolDefinition.name). */
  name: string;
  arguments: string;
};

/**
 * A declared tool the agent cannot run: an OpenAI host-side builtin, an
 * Anthropic server tool, or a type the API cannot report calls for.
 */
export type DroppedTool = {
  type: string;
  /** The client's name for it, `<namespace>.<name>` for a namespace member. */
  name?: string;
};

/** A request's tools: those the agent can call, and those it cannot. */
export type ParsedClientTools = {
  tools: ClientToolDefinition[];
  dropped: DroppedTool[];
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

/**
 * The fields that declare a tool: Chat nests them under a key named after
 * the tool's type (`{type: "function", function: {name}}`, `{type:
 * "custom", custom: {name}}`), while Responses keeps them on the tool.
 */
function declaration(tool: Record<string, unknown>): Record<string, unknown> {
  return (typeof tool.type === "string" && asRecord(tool[tool.type])) || tool;
}

/** Collects a request's tools under unique agent-visible names. */
class ToolSet {
  readonly #tools: ClientToolDefinition[] = [];
  readonly #names = new Set<string>();
  readonly #dropped: DroppedTool[] = [];

  has(name: string): boolean {
    return this.#names.has(name);
  }

  /** Whether `namespace` already declared a member called `name`. */
  hasMember(namespace: string, name: string): boolean {
    return this.#tools.some(
      (tool) =>
        tool.namespaced?.namespace === namespace &&
        tool.namespaced.name === name,
    );
  }

  add(definition: ClientToolDefinition): void {
    if (!definition.name.trim()) {
      throw new Error("Function tool is missing name");
    }
    if (this.#names.has(definition.name)) {
      throw new Error(`Duplicate function tool name: ${definition.name}`);
    }
    this.#names.add(definition.name);
    this.#tools.push(definition);
  }

  /** Records a tool the agent cannot run. */
  drop(tool: Record<string, unknown>, namespace?: string): void {
    const type = typeof tool.type === "string" ? tool.type : "untyped";
    const name = declaration(tool).name;
    this.#dropped.push({
      type,
      ...(typeof name === "string" && name
        ? { name: namespace ? `${namespace}.${name}` : name }
        : {}),
    });
  }

  result(): ParsedClientTools {
    return { tools: this.#tools, dropped: this.#dropped };
  }
}

function functionDefinition(
  tool: Record<string, unknown>,
): ClientToolDefinition {
  const fn = declaration(tool);
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

/** The one argument the agent passes a freeform tool's raw text in. */
const FREEFORM_INPUT = "input";

/** How a freeform tool's description names each grammar `syntax`. */
const GRAMMAR_SYNTAX = new Map([
  ["lark", "Lark grammar"],
  ["regex", "regular expression"],
]);

/**
 * Tells the agent how to fill `input`, and passes on the grammar the client
 * constrains the text with, which the JSON schema cannot carry.
 */
function freeformDescription(custom: Record<string, unknown>): string {
  const format = asRecord(custom.format);
  const grammar =
    format?.type === "grammar" && typeof format.definition === "string"
      ? `The text must match this ${GRAMMAR_SYNTAX.get(String(format.syntax)) ?? "grammar"}:\n${format.definition}`
      : "";
  return [
    typeof custom.description === "string" ? custom.description.trim() : "",
    `Pass the tool's whole input as raw text in the \`${FREEFORM_INPUT}\` string.`,
    grammar,
  ]
    .filter(Boolean)
    .join("\n\n");
}

/**
 * A freeform `custom` tool, such as Codex's `apply_patch`, takes raw text
 * rather than JSON arguments. MCP tools take a JSON object, so the agent
 * sees a function with one `input` string.
 */
function customToolDefinition(
  tool: Record<string, unknown>,
): ClientToolDefinition {
  const custom = declaration(tool);
  if (typeof custom.name !== "string") {
    throw new Error("Custom tool is missing name");
  }
  return {
    name: custom.name,
    description: freeformDescription(custom),
    inputSchema: {
      type: "object",
      properties: {
        [FREEFORM_INPUT]: {
          type: "string",
          description: "The tool's raw input text, passed on unchanged.",
        },
      },
      required: [FREEFORM_INPUT],
      additionalProperties: false,
    },
    freeform: true,
  };
}

/** A `function` or freeform `custom` tool; anything else is not callable. */
function callableDefinition(
  tool: Record<string, unknown>,
): ClientToolDefinition | undefined {
  if (tool.type === "function") return functionDefinition(tool);
  if (tool.type === "custom") return customToolDefinition(tool);
  return undefined;
}

/**
 * The raw text of a freeform call: the agent's `input` argument. Arguments
 * without an `input` string pass on as their JSON text, which the client
 * can still reject with a result the agent sees.
 */
export function freeformInput(args: string): string {
  try {
    const input = asRecord(JSON.parse(args))?.[FREEFORM_INPUT];
    if (typeof input === "string") return input;
  } catch {
    // Not JSON: pass the text on as it is.
  }
  return args;
}

/** The arguments the agent sends a freeform tool for the raw `input`. */
export function freeformArguments(input: unknown): string {
  return JSON.stringify({
    [FREEFORM_INPUT]: typeof input === "string" ? input : "",
  });
}

/** The identity fields a definition or call sets, for a call to carry. */
export function callIdentity(source: ClientToolIdentity): ClientToolIdentity {
  return {
    ...(source.namespaced ? { namespaced: source.namespaced } : {}),
    ...(source.freeform ? { freeform: true } : {}),
  };
}

function addNamespaceMembers(
  set: ToolSet,
  topLevelNames: ReadonlySet<string>,
  group: Record<string, unknown>,
): void {
  const namespace = typeof group.name === "string" ? group.name.trim() : "";
  const members = Array.isArray(group.tools) ? group.tools : [];
  for (const member of members) {
    const nested = asRecord(member);
    if (!nested) continue;
    const definition = callableDefinition(nested);
    if (!definition) {
      set.drop(nested, namespace || undefined);
      continue;
    }
    if (!namespace) {
      set.add(definition);
      continue;
    }
    const bare = definition.name;
    if (set.hasMember(namespace, bare)) {
      throw new Error(`Duplicate function tool name: ${namespace}.${bare}`);
    }
    set.add({
      ...definition,
      name:
        topLevelNames.has(bare) || set.has(bare)
          ? `${namespace}__${bare}`
          : bare,
      namespaced: { namespace, name: bare },
    });
  }
}

/**
 * Parse OpenAI Chat Completions (`function` wrapper), Responses (flat
 * function), and legacy Chat `functions` definitions, plus freeform
 * `custom` tools in either API's shape (see customToolDefinition).
 *
 * Responses `namespace` groups are flattened into their member tools.
 * A member keeps its bare name unless a top-level tool or an earlier
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
): ParsedClientTools {
  const set = new ToolSet();
  const records = (tools ?? []).map((value) => {
    const tool = asRecord(value);
    if (!tool) throw new Error("Invalid tool definition");
    return tool;
  });

  // Reserve top-level names up front so a top-level tool keeps its bare
  // name even when a colliding namespace group is listed before it.
  const topLevelNames = new Set<string>();
  for (const tool of records) {
    if (tool.type !== "function" && tool.type !== "custom") continue;
    const name = declaration(tool).name;
    if (typeof name === "string") topLevelNames.add(name);
  }
  for (const value of functions ?? []) {
    const name = asRecord(value)?.name;
    if (typeof name === "string") topLevelNames.add(name);
  }

  for (const tool of records) {
    if (tool.type === "namespace") {
      addNamespaceMembers(set, topLevelNames, tool);
      continue;
    }
    const definition = callableDefinition(tool);
    if (definition) set.add(definition);
    else set.drop(tool);
  }

  for (const value of functions ?? []) {
    const fn = asRecord(value);
    if (!fn || typeof fn.name !== "string") {
      throw new Error("Function is missing name");
    }
    set.add({
      name: fn.name,
      description:
        typeof fn.description === "string" ? fn.description : undefined,
      inputSchema: schemaOrDefault(fn.parameters),
    });
  }

  return set.result();
}

/**
 * Anthropic-defined tools carry a versioned `type` (`web_search_20250305`,
 * `bash_20250124`, `text_editor_20250728`, `mcp_toolset`, ...), while
 * client tools have no `type` or `custom`. Anthropic runs some of them
 * itself (web search, web fetch, code execution) and builds the schema of
 * the rest (bash, text editor, computer use, memory) into Claude, so the
 * request holds no schema the agent could call them with.
 */
function isAnthropicServerTool(tool: Record<string, unknown>): boolean {
  return typeof tool.type === "string" && tool.type !== "custom";
}

/**
 * Parse Anthropic Messages client tools. Anthropic-defined tools are
 * dropped, as OpenAI host-side builtins are: offered to the agent without a
 * schema, they would come back as `tool_use` blocks the client never
 * expected to receive.
 */
export function parseAnthropicFunctionTools(
  tools?: readonly unknown[],
): ParsedClientTools {
  const set = new ToolSet();
  for (const value of tools ?? []) {
    const tool = asRecord(value);
    if (tool && isAnthropicServerTool(tool)) {
      set.drop(tool);
      continue;
    }
    if (!tool || typeof tool.name !== "string") {
      throw new Error("Anthropic tool is missing name");
    }
    set.add({
      name: tool.name,
      description:
        typeof tool.description === "string" ? tool.description : undefined,
      inputSchema: schemaOrDefault(tool.input_schema),
    });
  }
  return set.result();
}

/**
 * Names dropped tools for a log line or an error, e.g.
 * `web_search (web_search_20250305), file_search`.
 */
function describeDroppedTools(dropped: readonly DroppedTool[]): string {
  return dropped
    .map((tool) => (tool.name ? `${tool.name} (${tool.type})` : tool.type))
    .join(", ");
}

/** The verbose-log line for the tools a parser dropped, if it dropped any. */
export function droppedToolsNote(
  dropped: readonly DroppedTool[],
): string | undefined {
  return dropped.length > 0
    ? `ignored tools the agent cannot run: ${describeDroppedTools(dropped)}`
    : undefined;
}

/**
 * The tool a choice names: `{type: "function" | "custom" | "tool", name}`,
 * Chat's `{type: "function", function: {name}}` and `{type: "custom",
 * custom: {name}}`, or a legacy `function_call: {name}`.
 */
function namedChoice(choice: unknown): string | undefined {
  const rec = asRecord(choice);
  const name = rec && declaration(rec).name;
  return typeof name === "string" ? name : undefined;
}

/**
 * Apply `tool_choice` to the parsed tools. A choice that demands a call no
 * callable tool can satisfy (`required` or `any` with none left, or a named
 * tool the request lacks or the parser dropped) throws, so the handler
 * answers 400 instead of starting a turn that cannot comply.
 */
export function resolveToolChoice(
  tools: readonly ClientToolDefinition[],
  choice: unknown,
  opts: {
    parallelToolCalls?: boolean;
    /** What the parser dropped, named in the error when a choice needs it. */
    dropped?: readonly DroppedTool[];
  } = {},
): ResolvedToolChoice {
  if (choice === "none" || asRecord(choice)?.type === "none") {
    return { tools: [], required: false };
  }

  const required =
    choice === "required" ||
    choice === "any" ||
    asRecord(choice)?.type === "any";
  const selected = namedChoice(choice);
  const dropped = opts.dropped ?? [];
  let resolved = [...tools];
  let instruction: string | undefined;

  if (selected) {
    const tool = tools.find((item) => item.name === selected);
    if (!tool) {
      const unsupported = dropped.find((item) => item.name === selected);
      throw new Error(
        unsupported
          ? `tool_choice names ${selected}, a ${unsupported.type} tool the agent cannot run`
          : `Unknown tool_choice function: ${selected}`,
      );
    }
    resolved = [tool];
    instruction = `You must call the ${selected} tool.`;
  } else if (required) {
    if (tools.length === 0) {
      throw new Error(
        `tool_choice "${typeof choice === "string" ? choice : "any"}" requires a tool call, ` +
          "but the request has no callable function tools" +
          (dropped.length > 0
            ? `; the agent cannot run ${describeDroppedTools(dropped)}`
            : ""),
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

/** Responses input items that record a client tool call. */
const RESPONSES_CALL_TYPES: ReadonlySet<unknown> = new Set([
  "function_call",
  "custom_tool_call",
]);

/** Responses input items that answer a client tool call. */
const RESPONSES_OUTPUT_TYPES: ReadonlySet<unknown> = new Set([
  "function_call_output",
  "custom_tool_call_output",
]);

/**
 * Whether a Responses input item answers a client tool call: a
 * `function_call_output` or a `custom_tool_call_output`.
 */
export function isResponsesToolOutput(value: unknown): boolean {
  return RESPONSES_OUTPUT_TYPES.has(asRecord(value)?.type);
}

export function responsesToolOutputs(input: unknown): ClientToolOutput[] {
  if (!Array.isArray(input)) return [];
  const outputs: ClientToolOutput[] = [];
  for (const value of input) {
    const item = asRecord(value);
    if (!item || !isResponsesToolOutput(item)) continue;
    if (typeof item.call_id !== "string" || !item.call_id) {
      throw new Error(`${String(item.type)} is missing call_id`);
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
 * message). What follows it is model output (`function_call`,
 * `custom_tool_call`, assistant `message`, `reasoning`) and the caller's
 * tool outputs.
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
 * The tool outputs that answer the model's current turn.
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

/** Every `call_id` an input names, on a tool call or its output. */
export function responsesCallIds(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const ids = new Set<string>();
  for (const value of input) {
    const item = asRecord(value);
    if (
      (RESPONSES_CALL_TYPES.has(item?.type) ||
        RESPONSES_OUTPUT_TYPES.has(item?.type)) &&
      typeof item?.call_id === "string" &&
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
