import type { BridgeConfig } from "./config.js";
import {
  parseExecutionModeFromRequest,
  type CursorExecutionMode,
} from "./execution-mode.js";

const DEFAULT_DSH_SYSTEM_MARKER =
  "You are an AI agent powered by DeepSeek Harness.";
const DEFAULT_DSH_PLAN_MARKER = "You are in plan mode.";

function textContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if (
        typeof part === "object" &&
        part !== null &&
        "text" in part &&
        typeof part.text === "string"
      ) {
        return part.text;
      }
      return "";
    })
    .join("\n");
}

export function inferDshExecutionMode(
  config: BridgeConfig,
  messages: unknown,
): CursorExecutionMode | undefined {
  if (!config.dshAutoMode || !Array.isArray(messages)) return undefined;

  const trustedText = messages
    .filter(
      (message) =>
        typeof message === "object" &&
        message !== null &&
        "role" in message &&
        (message.role === "system" || message.role === "developer"),
    )
    .map((message) =>
      textContent(
        "content" in (message as object)
          ? (message as { content?: unknown }).content
          : undefined,
      ),
    )
    .join("\n");

  const systemMarker = config.dshSystemMarker ?? DEFAULT_DSH_SYSTEM_MARKER;
  if (!trustedText.includes(systemMarker)) return undefined;

  const planMarker = config.dshPlanMarker ?? DEFAULT_DSH_PLAN_MARKER;
  return trustedText.includes(planMarker) ? "plan" : "agent";
}

export function resolveRequestMode(
  config: BridgeConfig,
  headerMode: string | string[] | undefined,
  bodyMode: unknown,
  messages?: unknown,
): CursorExecutionMode {
  if (bodyMode !== undefined && bodyMode !== null) {
    if (typeof bodyMode !== "string") {
      throw new Error("Request body mode must be a string");
    }
    if (bodyMode.trim()) {
      return parseExecutionModeFromRequest(bodyMode, "body.mode");
    }
  }
  const h = Array.isArray(headerMode) ? headerMode[0] : headerMode;
  if (typeof h === "string" && h.trim()) {
    return parseExecutionModeFromRequest(h, "X-Cursor-Mode header");
  }
  const inferred = inferDshExecutionMode(config, messages);
  if (inferred) return inferred;
  return config.mode;
}
