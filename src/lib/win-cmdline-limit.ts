import { BRIDGE_AGENT_PROMPT_SEPARATOR } from "./bridge-context-preamble.js";
import type { AgentCommand } from "./env.js";
import { type EnvOptions, resolveAgentCommand } from "./env.js";

/** Shown at the start of the prompt when earlier text was dropped on Windows. */
export const WIN_PROMPT_OMISSION_PREFIX =
  "[Earlier messages omitted: Windows command-line length limit.]\n\n";

export type FitPromptOk = {
  ok: true;
  args: string[];
  truncated: boolean;
  originalLength: number;
  finalPromptLength: number;
};

export type FitPromptErr = {
  ok: false;
  error: string;
};

export type FitPromptResult = FitPromptOk | FitPromptErr;

/**
 * Pessimistic upper bound on UTF-16 code units in the Windows command line
 * Node/libuv passes to CreateProcess (see libuv `make_program_args` sizing).
 */
export function estimateCmdlineLength(resolved: AgentCommand): number {
  const argv = [resolved.command, ...resolved.args];
  if (resolved.windowsVerbatimArguments) {
    let n = 0;
    for (const a of argv) {
      n += a.length;
    }
    n += Math.max(0, argv.length - 1);
    return n + 512;
  }
  let dstLen = 0;
  for (const a of argv) {
    dstLen += a.length;
  }
  dstLen = dstLen * 2 + argv.length * 2 + Math.max(0, argv.length - 1);
  return dstLen + 512;
}

/**
 * On Windows, shrinks the prompt (keeping the tail) so spawn argv stays under
 * `maxCmdline`. Other platforms return the full prompt unchanged.
 */
export function fitPromptToWinCmdline(
  agentBin: string,
  fixedArgs: string[],
  prompt: string,
  opts: {
    maxCmdline: number;
    platform: NodeJS.Platform;
    cwd?: string;
    env?: EnvOptions["env"];
  },
): FitPromptResult {
  const { maxCmdline, platform, cwd, env } = opts;
  const resolveOpts: EnvOptions = { cwd, env, platform };

  if (platform !== "win32") {
    return {
      ok: true,
      args: [...fixedArgs, prompt],
      truncated: false,
      originalLength: prompt.length,
      finalPromptLength: prompt.length,
    };
  }

  const measured = (p: string) =>
    estimateCmdlineLength(
      resolveAgentCommand(agentBin, [...fixedArgs, p], resolveOpts),
    );

  const emptyTail = measured("");
  if (emptyTail > maxCmdline) {
    return {
      ok: false,
      error:
        "Windows command line exceeds the configured limit even without a prompt; shorten workspace path, model id, or CURSOR_BRIDGE_WIN_CMDLINE_MAX.",
    };
  }

  if (measured(prompt) <= maxCmdline) {
    return {
      ok: true,
      args: [...fixedArgs, prompt],
      truncated: false,
      originalLength: prompt.length,
      finalPromptLength: prompt.length,
    };
  }

  const sep = BRIDGE_AGENT_PROMPT_SEPARATOR;
  const sepIdx = prompt.indexOf(sep);
  if (sepIdx > 0 && sepIdx + sep.length < prompt.length) {
    const preamble = prompt.slice(0, sepIdx);
    const body = prompt.slice(sepIdx + sep.length);
    const innerPrefix = WIN_PROMPT_OMISSION_PREFIX;
    const head = preamble + sep + innerPrefix;
    if (measured(head) <= maxCmdline) {
      let lo = 0;
      let hi = body.length;
      let best = 0;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const tail = mid === 0 ? "" : body.slice(-mid);
        const candidate = head + tail;
        if (measured(candidate) <= maxCmdline) {
          best = mid;
          lo = mid + 1;
        } else {
          hi = mid - 1;
        }
      }
      const finalPrompt = best === 0 ? head : head + body.slice(-best);
      return {
        ok: true,
        args: [...fixedArgs, finalPrompt],
        truncated: true,
        originalLength: prompt.length,
        finalPromptLength: finalPrompt.length,
      };
    }
  }

  const prefix = WIN_PROMPT_OMISSION_PREFIX;
  if (measured(prefix) > maxCmdline) {
    return {
      ok: false,
      error:
        "Windows command line too long to fit even the truncation notice; shorten workspace path or flags.",
    };
  }

  let lo = 0;
  let hi = prompt.length;
  let best = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const tail = mid === 0 ? "" : prompt.slice(-mid);
    const candidate = prefix + tail;
    if (measured(candidate) <= maxCmdline) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }

  const finalPrompt = best === 0 ? prefix : prefix + prompt.slice(-best);
  return {
    ok: true,
    args: [...fixedArgs, finalPrompt],
    truncated: true,
    originalLength: prompt.length,
    finalPromptLength: finalPrompt.length,
  };
}

export function warnPromptTruncated(
  originalLength: number,
  finalLength: number,
): void {
  console.warn(
    `[${new Date().toISOString()}] Windows: prompt truncated for CreateProcess limit (${originalLength} -> ${finalLength} chars, tail preserved).`,
  );
}
