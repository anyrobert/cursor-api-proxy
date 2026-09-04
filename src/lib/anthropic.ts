/**
 * Anthropic Messages API support.
 * Converts Anthropic request format to the prompt format used by Cursor CLI.
 */

import { buildPromptFromMessages } from "./openai.js";

export type AnthropicMessageParam = {
  role: "user" | "assistant";
  content:
    | string
    | Array<{
        type?: string;
        text?: string;
        id?: string;
        name?: string;
        input?: unknown;
        tool_use_id?: string;
        content?: unknown;
        is_error?: boolean;
      }>;
};

type JsonRecord = {
  [key: string]: unknown;
  media_type?: unknown;
  source?: unknown;
  text?: unknown;
  title?: unknown;
  type?: unknown;
  url?: unknown;
};

export type AnthropicMessagesRequest = {
  model?: string;
  /** Cursor CLI mode override: agent | ask | plan */
  mode?: string;
  max_tokens: number;
  messages: AnthropicMessageParam[];
  system?: string | Array<{ type?: string; text?: string }>;
  stream?: boolean;
  tools?: Array<{
    name: string;
    description?: string;
    input_schema: Record<string, unknown>;
  }>;
  tool_choice?:
    | { type: "auto" | "any" | "none"; disable_parallel_tool_use?: boolean }
    | { type: "tool"; name: string; disable_parallel_tool_use?: boolean };
};

function systemToText(system: AnthropicMessagesRequest["system"]): string {
  if (system == null) return "";
  if (typeof system === "string") return system.trim();
  if (!Array.isArray(system)) return "";
  return system
    .map((p) => {
      if (!p || typeof p !== "object") return "";
      if (p.type === "text" && typeof p.text === "string") return p.text;
      return "";
    })
    .join("\n");
}

function anthropicBlockToText(p: unknown): string {
  if (!p) return "";
  if (typeof p === "string") return p;
  if (typeof p !== "object" || Array.isArray(p)) return "";
  const block = p as JsonRecord;
  if (block.type === "text" && typeof block.text === "string")
    return block.text;
  if (block.type === "image") {
    const src = block.source;
    if (!src || typeof src !== "object" || Array.isArray(src)) return "[Image]";
    const source = src as JsonRecord;
    if (source.type === "base64")
      return `[Image: base64 ${String(source.media_type ?? "image")}]`;
    if (source.type === "url" && typeof source.url === "string")
      return `[Image: ${source.url}]`;
    return "[Image]";
  }
  if (block.type === "document") {
    const source = block.source;
    const sourceUrl =
      source && typeof source === "object" && !Array.isArray(source)
        ? (source as JsonRecord).url
        : undefined;
    const title = block.title ?? sourceUrl ?? "";
    return title ? `[Document: ${title}]` : "[Document]";
  }
  return "";
}

function anthropicContentToText(
  content: AnthropicMessageParam["content"],
): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map(anthropicBlockToText).filter(Boolean).join(" ");
}

/**
 * Convert Anthropic messages + optional system prompt to the prompt format
 * expected by buildPromptFromMessages (OpenAI-style messages array).
 */
export function buildPromptFromAnthropicMessages(
  messages: AnthropicMessageParam[] | undefined,
  system?: AnthropicMessagesRequest["system"],
): string {
  const openaiMessages: Array<{ role: string; content: string }> = [];

  const systemText = systemToText(system);
  if (systemText) {
    openaiMessages.push({ role: "system", content: systemText });
  }

  for (const m of messages || []) {
    const text = anthropicContentToText(m.content);
    if (!text) continue;
    const role = m.role === "user" || m.role === "assistant" ? m.role : "user";
    openaiMessages.push({ role, content: text });
  }

  return buildPromptFromMessages(openaiMessages);
}
