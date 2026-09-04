import type { BridgeConfig } from "./config.js";
import type { CursorExecutionMode } from "./execution-mode.js";

/**
 * CLI flags and options for the Cursor agent, excluding the final prompt argument.
 */
export function buildAgentFixedArgs(
  config: BridgeConfig,
  workspaceDir: string,
  model: string,
  stream: boolean,
  mode: CursorExecutionMode,
  effectiveChatOnly: boolean,
): string[] {
  const args = ["--print"];
  if (config.approveMcps) args.push("--approve-mcps");
  if (config.force) args.push("--force");
  // Proxy runs non-interactively; without --trust the CLI exits on workspace trust prompts.
  if (effectiveChatOnly || config.force) args.push("--trust");
  // cursor-agent only accepts --mode plan|ask; agent mode is the default
  // and rejects --mode agent with "argument 'agent' is invalid".
  if (mode !== "agent") {
    args.push("--mode", mode);
  }
  args.push("--workspace", workspaceDir);
  args.push("--model", model);
  if (stream) {
    args.push("--stream-partial-output", "--output-format", "stream-json");
  } else {
    args.push("--output-format", "text");
  }
  return args;
}

/**
 * Build CLI arguments for running the Cursor agent.
 */
export function buildAgentCmdArgs(
  config: BridgeConfig,
  workspaceDir: string,
  model: string,
  prompt: string,
  stream: boolean,
  mode: CursorExecutionMode,
  effectiveChatOnly: boolean,
): string[] {
  return [
    ...buildAgentFixedArgs(
      config,
      workspaceDir,
      model,
      stream,
      mode,
      effectiveChatOnly,
    ),
    prompt,
  ];
}
