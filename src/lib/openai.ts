type JsonRecord = {
  [key: string]: unknown;
  arguments?: unknown;
  content?: unknown;
  description?: unknown;
  image_url?: unknown;
  name?: unknown;
  output?: unknown;
  parameters?: unknown;
  role?: unknown;
  source?: unknown;
  text?: unknown;
  type?: unknown;
  url?: unknown;
  function?: unknown;
};

function asRecord(value: unknown): JsonRecord | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return undefined;
  return value as JsonRecord;
}

export type OpenAiChatCompletionRequest = {
  model?: string;
  /** Cursor CLI mode override: agent | ask | plan */
  mode?: string;
  messages: JsonRecord[];
  stream?: boolean;
  tools?: unknown[];
  tool_choice?: unknown;
  parallel_tool_calls?: boolean;
  functions?: unknown[];
  function_call?: unknown;
  reasoning_effort?: string;
};

export type OpenAiResponsesRequest = {
  model?: string;
  /** Cursor CLI mode override: agent | ask | plan */
  mode?: string;
  input?: unknown;
  instructions?: string | null;
  stream?: boolean;
  tools?: unknown[];
  tool_choice?: unknown;
  max_output_tokens?: number | null;
  metadata?: Record<string, unknown> | null;
  parallel_tool_calls?: boolean;
  previous_response_id?: string | null;
  reasoning?: unknown;
  service_tier?: string | null;
  store?: boolean | null;
  temperature?: number | null;
  text?: unknown;
  top_p?: number | null;
  truncation?: string | null;
  user?: string | null;
};

export function normalizeModelId(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const parts = trimmed.split("/");
  return parts[parts.length - 1] || undefined;
}

function imageUrlToText(imageUrl: unknown): string {
  if (!imageUrl) return "[Image]";
  const url: string =
    typeof imageUrl === "string"
      ? imageUrl
      : typeof asRecord(imageUrl)?.url === "string"
        ? (asRecord(imageUrl)?.url as string)
        : "";
  if (!url) return "[Image]";
  if (url.startsWith("data:")) {
    const mime = url.slice(5, url.indexOf(";")) || "image";
    return `[Image: base64 ${mime}]`;
  }
  return `[Image: ${url}]`;
}

function messageContentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => {
        if (!p) return "";
        if (typeof p === "string") return p;
        const part = asRecord(p);
        if (!part) return "";
        if (part.type === "text" && typeof part.text === "string")
          return part.text;
        if (part.type === "image_url") return imageUrlToText(part.image_url);
        if (part.type === "image") {
          const source = asRecord(part.source);
          return imageUrlToText(source?.url ?? part.url ?? part.source);
        }
        return "";
      })
      .filter(Boolean)
      .join(" ");
  }
  return "";
}

function responseItemContentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => {
        if (!p) return "";
        if (typeof p === "string") return p;
        const part = asRecord(p);
        if (!part) return "";
        if (
          (part.type === "input_text" ||
            part.type === "output_text" ||
            part.type === "text") &&
          typeof part.text === "string"
        ) {
          return part.text;
        }
        if (part.type === "input_image" || part.type === "image_url") {
          return imageUrlToText(part.image_url ?? part.url);
        }
        if (typeof part.output === "string") return part.output;
        return "";
      })
      .filter(Boolean)
      .join(" ");
  }
  const record = asRecord(content);
  if (typeof record?.text === "string") return record.text;
  if (typeof record?.output === "string") return record.output;
  return "";
}

/** Convert OpenAI Responses API `input` (+ optional `instructions`) into chat messages. */
export function responsesInputToMessages(
  body: OpenAiResponsesRequest,
): Array<{ role: string; content: string }> {
  const messages: Array<{ role: string; content: string }> = [];
  const instructions =
    typeof body.instructions === "string" ? body.instructions.trim() : "";

  if (instructions) {
    messages.push({ role: "system", content: instructions });
  }

  const input = body.input;
  if (typeof input === "string") {
    messages.push({ role: "user", content: input });
    return messages;
  }

  if (!Array.isArray(input)) {
    return messages;
  }

  for (const item of input) {
    if (!item) continue;
    if (typeof item === "string") {
      messages.push({ role: "user", content: item });
      continue;
    }

    const record = asRecord(item);
    if (!record) continue;

    if (
      record.type === "function_call_output" ||
      record.type === "custom_tool_call_output"
    ) {
      const output = responseItemContentToText(record.output ?? record.content);
      if (output) messages.push({ role: "tool", content: output });
      continue;
    }

    if (record.type === "function_call") {
      const name = typeof record.name === "string" ? record.name : "function";
      const args =
        typeof record.arguments === "string"
          ? record.arguments
          : JSON.stringify(record.arguments ?? {});
      messages.push({
        role: "assistant",
        content: `Function call ${name}: ${args}`,
      });
      continue;
    }

    const role = typeof record.role === "string" ? record.role : "user";
    const content = responseItemContentToText(record.content ?? record.text);
    if (content) messages.push({ role, content });
  }

  return messages;
}

/**
 * Serialise tool/function schemas into a text block for the system prompt.
 * This allows the model to be aware of available tools even though we can't
 * return tool_call deltas natively.
 */
export function toolsToSystemText(
  tools?: unknown[],
  functions?: unknown[],
): string | undefined {
  const defs: JsonRecord[] = [];

  if (tools && tools.length > 0) {
    for (const t of tools) {
      const tool = asRecord(t);
      const fn = tool?.type === "function" ? asRecord(tool.function) : tool;
      if (fn) defs.push(fn);
    }
  }
  if (functions && functions.length > 0) {
    for (const fn of functions) {
      const record = asRecord(fn);
      if (record) defs.push(record);
    }
  }

  if (defs.length === 0) return undefined;

  const lines = [
    "Available tools (respond with a JSON object to call one):",
    "",
    ...defs.map((fn) => {
      const params = fn.parameters
        ? JSON.stringify(fn.parameters, null, 2)
        : "{}";
      return `Function: ${fn.name}\nDescription: ${fn.description ?? ""}\nParameters: ${params}`;
    }),
  ];
  return lines.join("\n");
}

export function buildPromptFromMessages(messages?: JsonRecord[]): string {
  const systemParts: string[] = [];
  const convo: string[] = [];

  for (const m of messages || []) {
    const role = m.role;
    const text = messageContentToText(m.content);
    if (!text) continue;

    if (role === "system" || role === "developer") {
      systemParts.push(text);
      continue;
    }
    if (role === "user") {
      convo.push(`User: ${text}`);
      continue;
    }
    if (role === "assistant") {
      convo.push(`Assistant: ${text}`);
      continue;
    }
    if (role === "tool" || role === "function") {
      convo.push(`Tool: ${text}`);
    }
  }

  const system = systemParts.length
    ? `System:\n${systemParts.join("\n\n")}\n\n`
    : "";
  const transcript = convo.join("\n\n");
  return `${system + transcript}\n\nAssistant:`;
}
