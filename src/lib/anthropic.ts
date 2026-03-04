/**
 * Anthropic Messages API support.
 * Converts Anthropic request format to the prompt format used by Cursor CLI.
 */

import { buildPromptFromMessages } from "./openai.js";

export type AnthropicMessageParam = {
  role: "user" | "assistant";
  content: string | Array<{ type?: string; text?: string }>;
};

export type AnthropicMessagesRequest = {
  model?: string;
  max_tokens: number;
  messages: AnthropicMessageParam[];
  system?: string | Array<{ type?: string; text?: string }>;
  stream?: boolean;
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

function anthropicContentToText(content: AnthropicMessageParam["content"]): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((p) => {
      if (!p) return "";
      if (typeof p === "string") return p;
      if (p.type === "text" && typeof p.text === "string") return p.text;
      return "";
    })
    .join("");
}

/**
 * Convert Anthropic messages + optional system prompt to the prompt format
 * expected by buildPromptFromMessages (OpenAI-style messages array).
 */
export function buildPromptFromAnthropicMessages(
  messages: AnthropicMessageParam[] | undefined,
  system?: AnthropicMessagesRequest["system"]
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
