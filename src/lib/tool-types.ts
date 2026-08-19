export type ClientToolDefinition = {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
};

export type ClientToolOutput = {
  callId: string;
  output: string;
  isError?: boolean;
};

export type PendingClientToolCall = {
  callId: string;
  itemId: string;
  name: string;
  arguments: string;
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

/**
 * Parse OpenAI Chat Completions (`function` wrapper), Responses (flat
 * function), and legacy Chat `functions` definitions.
 */
export function parseOpenAiFunctionTools(
  tools?: readonly unknown[],
  functions?: readonly unknown[],
): ClientToolDefinition[] {
  const out: ClientToolDefinition[] = [];
  const seen = new Set<string>();

  for (const value of tools ?? []) {
    const tool = asRecord(value);
    if (!tool) throw new Error("Invalid tool definition");
    if (tool.type !== "function") {
      throw new Error(
        `Unsupported tool type: ${
          typeof tool.type === "string" ? tool.type : "unknown"
        }`,
      );
    }
    const wrapped = asRecord(tool.function);
    const fn = wrapped ?? tool;
    if (typeof fn.name !== "string") {
      throw new Error("Function tool is missing name");
    }
    pushUnique(out, seen, {
      name: fn.name,
      description:
        typeof fn.description === "string" ? fn.description : undefined,
      inputSchema: schemaOrDefault(fn.parameters),
    });
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
  opts: { parallelToolCalls?: boolean; anthropic?: boolean } = {},
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
