import type { BridgeConfig } from "./config.js";

/**
 * Build CLI arguments for running the Cursor agent.
 */
export function buildAgentCmdArgs(
  config: BridgeConfig,
  workspaceDir: string,
  model: string,
  prompt: string,
  stream: boolean,
): string[] {
  const args = ["--print"];
  if (config.approveMcps) args.push("--approve-mcps");
  if (config.force) args.push("--force");
  if (config.chatOnlyWorkspace) args.push("--trust");
  args.push("--mode", "ask");
  args.push("--workspace", workspaceDir);
  args.push("--model", model);
  if (stream) {
    args.push("--stream-partial-output", "--output-format", "stream-json");
  } else {
    args.push("--output-format", "text");
  }
  args.push(prompt);
  return args;
}
