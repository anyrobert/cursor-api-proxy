import type { CursorExecutionMode } from "../lib/execution-mode.js";
import { parseExecutionModeFromRequest } from "../lib/execution-mode.js";

export type ParsedArgs = {
  tailscale: boolean;
  verbose: boolean;
  help: boolean;
  requests: boolean;
  requestLimit: number;
  watch: boolean;
  watchIntervalMs: number;
  login: boolean;
  accountsList: boolean;
  logout: boolean;
  accountName: string;
  proxies: string[];
  resetHwid: boolean;
  deepClean: boolean;
  dryRun: boolean;
  /** Set via `--mode`; default applied in config when omitted. */
  mode?: CursorExecutionMode;
};

export function parseArgs(argv: string[]): ParsedArgs {
  let tailscale = false;
  let verbose = false;
  let help = false;
  let requests = false;
  let requestLimit = 20;
  let watch = false;
  let watchIntervalMs = 2000;
  let requestOptionUsed = false;
  let login = false;
  let accountsList = false;
  let logout = false;
  let accountName = "";
  let proxies: string[] = [];
  let resetHwid = false;
  let deepClean = false;
  let dryRun = false;
  let mode: CursorExecutionMode | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (arg === "requests") {
      requests = true;
      continue;
    }

    if (arg === "--limit" || arg.startsWith("--limit=")) {
      const value =
        arg === "--limit" ? argv[++i] : arg.slice("--limit=".length);
      if (!value || value.startsWith("-")) {
        throw new Error("--limit requires a positive integer");
      }
      requestLimit = Number(value);
      if (
        !Number.isInteger(requestLimit) ||
        requestLimit < 1 ||
        requestLimit > 5000
      ) {
        throw new Error("--limit must be an integer between 1 and 5000");
      }
      requestOptionUsed = true;
      continue;
    }

    if (arg === "--watch") {
      watch = true;
      requestOptionUsed = true;
      continue;
    }

    if (arg === "--interval" || arg.startsWith("--interval=")) {
      const value =
        arg === "--interval" ? argv[++i] : arg.slice("--interval=".length);
      if (!value || value.startsWith("-")) {
        throw new Error(
          "--interval requires a positive number between 0.001 and 86400 seconds",
        );
      }
      const seconds = Number(value);
      if (!Number.isFinite(seconds) || seconds < 0.001 || seconds > 86_400) {
        throw new Error(
          "--interval requires a positive number between 0.001 and 86400 seconds",
        );
      }
      watchIntervalMs = Math.round(seconds * 1000);
      requestOptionUsed = true;
      continue;
    }

    if (arg === "login" || arg === "add-account") {
      login = true;
      if (i + 1 < argv.length && !argv[i + 1].startsWith("-")) {
        accountName = argv[++i];
      }
      continue;
    }

    if (arg === "logout" || arg === "remove-account") {
      logout = true;
      if (i + 1 < argv.length && !argv[i + 1].startsWith("-")) {
        accountName = argv[++i];
      }
      continue;
    }

    if (arg === "accounts" || arg === "list-accounts") {
      accountsList = true;
      continue;
    }

    if (arg === "reset-hwid" || arg === "reset") {
      resetHwid = true;
      continue;
    }

    if (arg === "--deep-clean") {
      deepClean = true;
      continue;
    }

    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }

    if (arg === "--tailscale") {
      tailscale = true;
      continue;
    }

    if (arg === "--verbose") {
      verbose = true;
      continue;
    }

    if (arg === "--mode") {
      if (i + 1 >= argv.length || argv[i + 1]?.startsWith("-")) {
        throw new Error("--mode requires a value (agent, ask, or plan)");
      }
      mode = parseExecutionModeFromRequest(argv[++i]!, "--mode");
      continue;
    }

    if (arg.startsWith("--mode=")) {
      mode = parseExecutionModeFromRequest(
        arg.slice("--mode=".length),
        "--mode",
      );
      continue;
    }

    if (arg === "--help" || arg === "-h") {
      help = true;
      continue;
    }

    if (arg.startsWith("--proxy=")) {
      proxies = arg
        .slice("--proxy=".length)
        .split(",")
        .map((p) => p.trim())
        .filter(Boolean);
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  if (requestOptionUsed && !requests) {
    throw new Error(
      "--limit, --watch, and --interval require requests command",
    );
  }

  return {
    tailscale,
    verbose,
    help,
    requests,
    requestLimit,
    watch,
    watchIntervalMs,
    login,
    accountsList,
    logout,
    accountName,
    proxies,
    resetHwid,
    deepClean,
    dryRun,
    mode,
  };
}

export function printHelp(version: string): void {
  console.log(`cursor-api-proxy v${version}`);
  console.log("");
  console.log("Usage:");
  console.log("  cursor-api-proxy [options]");
  console.log("");
  console.log("Commands:");
  console.log(
    "  login [name]              Log into a Cursor account (saved to ~/.cursor-api-proxy/accounts/)",
  );
  console.log(
    "  login [name] --proxy=...  Same, but open Chrome through a random proxy from a comma-separated list",
  );
  console.log("  logout <name>             Remove a saved Cursor account");
  console.log("  accounts                  List saved accounts with plan info");
  console.log(
    "  reset-hwid                Reset Cursor machine/telemetry IDs (anti-ban)",
  );
  console.log(
    "  reset-hwid --deep-clean   Also wipe session storage and cookies",
  );
  console.log("  requests                  Show latest completed API requests");
  console.log(
    "  requests --watch          Refresh latest requests continuously",
  );
  console.log("");
  console.log("Options:");
  console.log("  --tailscale     Bind to 0.0.0.0 for tailnet/LAN access");
  console.log("  --verbose       Enable verbose request/model logs");
  console.log(
    "  --mode <agent|ask|plan>  Default Cursor CLI mode (overridden by env or per-request)",
  );
  console.log("  --limit <n>     Requests to show (1-5000, default 20)");
  console.log("  --watch         Refresh requests continuously");
  console.log("  --interval <s>  Watch refresh interval (default 2)");
  console.log("  -h, --help      Show this help message");
}
