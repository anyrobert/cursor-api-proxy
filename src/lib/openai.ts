import type { ClientToolDefinition } from "./tool-types.js";

export type OpenAiChatCompletionRequest = {
  model?: string;
  /** Cursor CLI mode override: agent | ask | plan */
  mode?: string;
  messages: any[];
  stream?: boolean;
  tools?: any[];
  tool_choice?: any;
  parallel_tool_calls?: boolean;
  functions?: any[];
  function_call?: any;
  reasoning_effort?: string;
};

export type OpenAiResponsesRequest = {
  model?: string;
  /** Cursor CLI mode override: agent | ask | plan */
  mode?: string;
  input?: any;
  instructions?: string | null;
  stream?: boolean;
  tools?: any[];
  tool_choice?: any;
  max_output_tokens?: number | null;
  metadata?: Record<string, unknown> | null;
  parallel_tool_calls?: boolean;
  previous_response_id?: string | null;
  reasoning?: any;
  service_tier?: string | null;
  store?: boolean | null;
  temperature?: number | null;
  text?: any;
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

function imageUrlToText(imageUrl: any): string {
  if (!imageUrl) return "[Image]";
  const url: string =
    typeof imageUrl === "string"
      ? imageUrl
      : typeof imageUrl?.url === "string"
        ? imageUrl.url
        : "";
  if (!url) return "[Image]";
  if (url.startsWith("data:")) {
    const mime = url.slice(5, url.indexOf(";")) || "image";
    return `[Image: base64 ${mime}]`;
  }
  return `[Image: ${url}]`;
}

function messageContentToText(content: any): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => {
        if (!p) return "";
        if (typeof p === "string") return p;
        if (p.type === "text" && typeof p.text === "string") return p.text;
        if (p.type === "image_url") return imageUrlToText(p.image_url);
        if (p.type === "image") return imageUrlToText(p.source?.url ?? p.url ?? p.source);
        return "";
      })
      .filter(Boolean)
      .join(" ");
  }
  return "";
}

function responseItemContentToText(content: any): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => {
        if (!p) return "";
        if (typeof p === "string") return p;
        if (
          (p.type === "input_text" ||
            p.type === "output_text" ||
            p.type === "text") &&
          typeof p.text === "string"
        ) {
          return p.text;
        }
        if (p.type === "input_image" || p.type === "image_url") {
          return imageUrlToText(p.image_url ?? p.url);
        }
        if (typeof p.output === "string") return p.output;
        return "";
      })
      .filter(Boolean)
      .join(" ");
  }
  if (typeof content?.text === "string") return content.text;
  if (typeof content?.output === "string") return content.output;
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

    if (item.type === "function_call_output") {
      const output = responseItemContentToText(item.output ?? item.content);
      if (output) messages.push({ role: "tool", content: output });
      continue;
    }

    if (item.type === "function_call") {
      const name = typeof item.name === "string" ? item.name : "function";
      const args =
        typeof item.arguments === "string"
          ? item.arguments
          : JSON.stringify(item.arguments ?? {});
      messages.push({
        role: "assistant",
        content: `Function call ${name}: ${args}`,
      });
      continue;
    }

    const role = typeof item.role === "string" ? item.role : "user";
    const content = responseItemContentToText(item.content ?? item.text);
    if (content) messages.push({ role, content });
  }

  return messages;
}

/**
 * Opens the CLI-mode tool block. Only ACP turns model output into client
 * tool calls, so here the tools are context and nothing parses a call the
 * model writes out.
 */
const TOOLS_TEXT_HEADER =
  "Tools defined by the client, for reference only. You cannot call them in this mode, so answer without them and do not write out calls to them.";

/**
 * Character budget for the tool entries, which every request repeats. Small
 * tool sets fit whole, but in full Codex's 17 tools take about 19K
 * characters and Claude Code's 23 about 64K. 8K (about 2K tokens) still
 * fits a brief entry for some 35 tools and keeps the block from crowding
 * argv prompt limits: on Windows the proxy keeps only the prompt's tail, so
 * the system prompt and this block are cut first.
 */
const TOOLS_TEXT_BUDGET = 8_000;

/** Longest description a tool listed without its schema keeps. */
const BRIEF_DESCRIPTION_MAX = 200;

function fullToolEntry(tool: ClientToolDefinition): string {
  const description = tool.description?.trim();
  return [
    `Function: ${tool.name}`,
    ...(description ? [`Description: ${description}`] : []),
    `Parameters: ${JSON.stringify(tool.inputSchema)}`,
  ].join("\n");
}

function briefToolEntry(tool: ClientToolDefinition): string {
  const description = tool.description?.replace(/\s+/g, " ").trim();
  if (!description) return `Function: ${tool.name}`;
  const short =
    description.length > BRIEF_DESCRIPTION_MAX
      ? `${description.slice(0, BRIEF_DESCRIPTION_MAX - 1).trimEnd()}…`
      : description;
  return `Function: ${tool.name}\nDescription: ${short}`;
}

/**
 * Describe the request's tools in a CLI-mode prompt, where the model can
 * see them but not call them.
 *
 * Takes the parsed definitions, so every API renders alike: Chat and flat
 * Responses functions, legacy `functions`, namespace members under their
 * flattened names, and Anthropic `input_schema`. Host-side builtins and
 * namespace groups never reach it, and `tool_choice` has already narrowed
 * the list.
 *
 * The entries stay within TOOLS_TEXT_BUDGET. Every tool first gets a brief
 * entry (name and a description cut to BRIEF_DESCRIPTION_MAX) while those
 * fit, and the rest are only counted. Leftover budget then upgrades brief
 * entries, in request order, to the full description and JSON schema, so a
 * set that fits whole renders in full.
 */
export function toolsToSystemText(
  tools: readonly ClientToolDefinition[],
): string | undefined {
  if (tools.length === 0) return undefined;
  const briefs = tools.map(briefToolEntry);
  // Each entry costs its length plus the newline that joins it.
  let used = 0;
  let listed = 0;
  while (
    listed < briefs.length &&
    used + briefs[listed].length + 1 <= TOOLS_TEXT_BUDGET
  ) {
    used += briefs[listed].length + 1;
    listed += 1;
  }
  const entries = briefs.slice(0, listed).map((brief, index) => {
    const full = fullToolEntry(tools[index]);
    const extra = full.length - brief.length;
    if (used + extra > TOOLS_TEXT_BUDGET) return brief;
    used += extra;
    return full;
  });
  const omitted = tools.length - listed;
  if (omitted > 0) {
    const noun = omitted === 1 ? "tool" : "tools";
    entries.push(`(${omitted} more ${noun} not listed)`);
  }
  return [TOOLS_TEXT_HEADER, "", ...entries].join("\n");
}

export function buildPromptFromMessages(messages: any[]): string {
  const systemParts: string[] = [];
  const convo: string[] = [];

  for (const m of messages || []) {
    const role = m?.role;
    const text = messageContentToText(m?.content);
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
      continue;
    }
  }

  const system = systemParts.length
    ? `System:\n${systemParts.join("\n\n")}\n\n`
    : "";
  const transcript = convo.join("\n\n");
  return system + transcript + "\n\nAssistant:";
}
