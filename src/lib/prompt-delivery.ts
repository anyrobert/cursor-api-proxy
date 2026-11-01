import type { BridgeConfig } from "./config.js";

/**
 * Linux MAX_ARG_STRLEN: one argv string, its trailing NUL included, may not
 * be longer than 32 pages. A longer prompt fails the spawn with E2BIG.
 */
export const POSIX_MAX_ARG_BYTES = 128 * 1024;

/**
 * Whether the agent gets the prompt on stdin (or ACP) instead of as its last
 * argv entry. Outside Windows a prompt too long for one argv string always
 * goes on stdin; Windows keeps its own tail truncation instead.
 */
export function sendsPromptOnStdin(
  config: Pick<BridgeConfig, "promptViaStdin" | "useAcp">,
  prompt: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (config.promptViaStdin || config.useAcp) return true;
  return (
    platform !== "win32" &&
    Buffer.byteLength(prompt, "utf8") >= POSIX_MAX_ARG_BYTES
  );
}
