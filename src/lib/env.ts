import * as fs from "node:fs";
import * as path from "node:path";

import type { CursorExecutionMode } from "./execution-mode.js";
import { tryParseExecutionModeEnv } from "./execution-mode.js";

export type EnvSource = Record<string, string | undefined>;

export type EnvOptions = {
  tailscale?: boolean;
  env?: EnvSource;
  cwd?: string;
  platform?: NodeJS.Platform;
  /** CLI `--mode` (overridden by CURSOR_BRIDGE_MODE when set). */
  mode?: CursorExecutionMode;
};

export type LoadedEnv = {
  agentBin: string;
  agentNode?: string;
  agentScript?: string;
  commandShell: string;
  host: string;
  port: number;
  requiredKey?: string;
  defaultModel: string;
  force: boolean;
  approveMcps: boolean;
  strictModel: boolean;
  workspace: string;
  timeoutMs: number;
  tlsCertPath?: string;
  tlsKeyPath?: string;
  sessionsLogPath: string;
  chatOnlyWorkspace: boolean;
  /** True when CURSOR_BRIDGE_CHAT_ONLY_WORKSPACE key exists in env. */
  chatOnlyWorkspaceExplicit: boolean;
  mode?: CursorExecutionMode;
  dshAutoMode: boolean;
  dshSystemMarker?: string;
  dshPlanMarker?: string;
  verbose: boolean;
  /** When true, set maxMode in cli-config.json before each run (larger context, more tools). */
  maxMode: boolean;
  /** When true, pass the user prompt via stdin instead of argv (avoids Windows argv truncation). */
  promptViaStdin: boolean;
  /** When true, use ACP (Agent Client Protocol) over stdio instead of CLI argv (fixes prompt delivery on Windows). */
  useAcp: boolean;
  /** Pool of cursor configuration directories for round-robin account rotation. */
  configDirs: string[];
  /** When true, runs each config dir on its own incrementing port starting from `port` */
  multiPort: boolean;
  /**
   * Upper bound (UTF-16 code units, pessimistic) for the Windows CreateProcess command line.
   * On win32 the proxy truncates the prompt tail to stay under this budget.
   */
  winCmdlineMax: number;
  /**
   * When true, prepend a short factual block to the agent prompt describing the
   * bridge, HTTP route, workspace paths, and optional client headers.
   */
  contextPreamble: boolean;
  /**
   * Optional free-text block appended to the bridge preamble (operator facts).
   * From `CURSOR_BRIDGE_CONTEXT_EXTRA`; stripped of NUL, max 400 UTF-16 units.
   */
  contextExtra?: string;
};

export type AgentCommand = {
  command: string;
  args: string[];
  env: EnvSource;
  windowsVerbatimArguments?: boolean;
  /** Path to agent entry script (e.g. index.js). Set when using node+script so max-mode preflight can find config. */
  agentScriptPath?: string;
  /** Cursor config dir (cli-config.json). Set so CLI reads the same config preflight wrote to. */
  configDir?: string;
};

function getEnvSource(env?: EnvSource): EnvSource {
  return env ?? process.env;
}

function getCwd(cwd?: string): string {
  return cwd ?? process.cwd();
}

function firstDefined(env: EnvSource, names: string[]): string | undefined {
  for (const name of names) {
    const value = env[name];
    if (value != null) return value;
  }
  return undefined;
}

function envString(env: EnvSource, names: string[]): string | undefined {
  const value = firstDefined(env, names);
  if (value == null) return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function envBool(
  env: EnvSource,
  names: string[],
  defaultValue: boolean,
): boolean {
  const raw = envString(env, names);
  if (raw == null) return defaultValue;
  const value = raw.toLowerCase();
  if (value === "1" || value === "true" || value === "yes" || value === "on")
    return true;
  if (value === "0" || value === "false" || value === "no" || value === "off")
    return false;
  return defaultValue;
}

function envNumber(
  env: EnvSource,
  names: string[],
  defaultValue: number,
): number {
  const raw = envString(env, names);
  if (raw == null) return defaultValue;
  const value = Number(raw);
  return Number.isFinite(value) ? value : defaultValue;
}

const CONTEXT_EXTRA_MAX = 400;

/** Optional multiline operator notes for the bridge preamble (no secrets). */
function envContextExtra(env: EnvSource): string | undefined {
  const raw = firstDefined(env, ["CURSOR_BRIDGE_CONTEXT_EXTRA"]);
  if (raw == null) return undefined;
  const noNul = String(raw).replace(/\0/g, "");
  const trimmed = noNul.trim();
  if (!trimmed) return undefined;
  if (trimmed.length <= CONTEXT_EXTRA_MAX) return trimmed;
  return `${trimmed.slice(0, CONTEXT_EXTRA_MAX - 1)}…`;
}

function normalizeModelId(raw: string | undefined): string {
  if (!raw) return "default";
  const parts = raw.split("/");
  return parts[parts.length - 1] || "default";
}

function resolveAbsolutePath(
  raw: string | undefined,
  cwd: string,
): string | undefined {
  if (!raw) return undefined;
  return path.resolve(cwd, raw);
}

function executableOnPath(
  name: string,
  env: EnvSource,
  platform: NodeJS.Platform,
): string | undefined {
  const rawPath = env.PATH ?? env.Path ?? env.path;
  if (!rawPath) return undefined;
  const extensions =
    platform === "win32"
      ? (env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";")
      : [""];
  for (const directory of rawPath.split(path.delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      const candidate = path.join(
        directory,
        platform === "win32" ? `${name}${extension}` : name,
      );
      try {
        const stat = fs.statSync(candidate);
        if (!stat.isFile()) continue;
        if (platform !== "win32") fs.accessSync(candidate, fs.constants.X_OK);
        return candidate;
      } catch {
        // Try the next PATH entry.
      }
    }
  }
  return undefined;
}

function resolveAgentBinary(
  env: EnvSource,
  platform: NodeJS.Platform,
): string {
  const explicit = envString(env, [
    "CURSOR_AGENT_BIN",
    "CURSOR_CLI_BIN",
    "CURSOR_CLI_PATH",
  ]);
  if (explicit) return explicit;
  return (
    executableOnPath("cursor-agent", env, platform) ??
    executableOnPath("agent", env, platform) ??
    "agent"
  );
}

/** Version dir name format: YYYY.MM.DD-commit (matches cursor-agent.ps1). */
const VERSION_DIR_REGEX = /^(\d{4})\.(\d{1,2})\.(\d{1,2})-[a-f0-9]+$/;

function parseVersionToInt(name: string): number {
  const m = name.match(VERSION_DIR_REGEX);
  if (!m) return 0;
  const [, year, month, day] = m;
  const y = year!.padStart(4, "0");
  const mo = month!.padStart(2, "0");
  const d = day!.padStart(2, "0");
  return parseInt(y + mo + d, 10);
}

/**
 * Find the latest version directory under dir/versions/ (e.g. cursor-agent/versions/2026.03.11-6dfa30c).
 * Returns the full path to the version dir, or undefined if none found.
 */
function findLatestVersionDir(dir: string): string | undefined {
  const versionsDir = path.join(dir, "versions");
  if (!fs.existsSync(versionsDir) || !fs.statSync(versionsDir).isDirectory()) {
    return undefined;
  }
  const entries = fs.readdirSync(versionsDir, { withFileTypes: true });
  const versionDirs = entries
    .filter((e) => e.isDirectory() && VERSION_DIR_REGEX.test(e.name))
    .sort((a, b) => parseVersionToInt(b.name) - parseVersionToInt(a.name));
  if (versionDirs.length === 0) return undefined;
  return path.join(versionsDir, versionDirs[0]!.name);
}

function configDirFromAgentDir(dir: string): string | undefined {
  const configDir = path.join(dir, "..", "data", "config");
  return fs.existsSync(path.join(configDir, "cli-config.json"))
    ? configDir
    : undefined;
}

function resolveCmdShim(
  cmdPath: string,
  args: string[],
  env: EnvSource,
  nodeOverride?: string,
): AgentCommand | undefined {
  const dir = path.dirname(cmdPath);
  const nodeBin = path.join(dir, "node.exe");
  const script = path.join(dir, "index.js");
  if (fs.existsSync(script) && (nodeOverride || fs.existsSync(nodeBin))) {
    return {
      command: nodeOverride ?? nodeBin,
      args: [script, ...args],
      env: { ...env, CURSOR_INVOKED_AS: "agent.cmd" },
      agentScriptPath: script,
      configDir: configDirFromAgentDir(dir),
    };
  }
  const versionDir = findLatestVersionDir(dir);
  if (versionDir) {
    const versionNode = path.join(versionDir, "node.exe");
    const versionScript = path.join(versionDir, "index.js");
    if (
      fs.existsSync(versionScript) &&
      (nodeOverride || fs.existsSync(versionNode))
    ) {
      return {
        command: nodeOverride ?? versionNode,
        args: [versionScript, ...args],
        env: { ...env, CURSOR_INVOKED_AS: "agent.cmd" },
        agentScriptPath: versionScript,
        configDir: configDirFromAgentDir(dir),
      };
    }
  }
  return undefined;
}

function resolveCmdFallback(
  cmd: string,
  args: string[],
  env: EnvSource,
  shell: string,
): AgentCommand {
  const quotedArgs = args
    .map((arg) => (arg.includes(" ") ? `"${arg}"` : arg))
    .join(" ");
  const cmdLine = `""${cmd}" ${quotedArgs}"`;
  return {
    command: shell,
    args: ["/d", "/s", "/c", cmdLine],
    env,
    windowsVerbatimArguments: true,
  };
}

/**
 * Auto-discovers configuration directories located inside ~/.cursor-api-proxy/accounts/
 */
function isAuthenticatedAccountDir(dir: string): boolean {
  const configFile = path.join(dir, "cli-config.json");
  if (!fs.existsSync(configFile)) return false;
  try {
    const config = JSON.parse(fs.readFileSync(configFile, "utf-8")) as {
      authInfo?: { email?: string };
    };
    return Boolean(config?.authInfo?.email);
  } catch {
    return false;
  }
}

function discoverAccountDirs(homeDir: string | undefined): string[] {
  if (!homeDir) return [];
  const accountsDir = path.join(homeDir, ".cursor-api-proxy", "accounts");
  if (!fs.existsSync(accountsDir)) return [];

  try {
    const entries = fs.readdirSync(accountsDir, { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory())
      .map((e) => path.join(accountsDir, e.name))
      .filter(isAuthenticatedAccountDir);
  } catch {
    return [];
  }
}

export function loadEnvConfig(opts: EnvOptions = {}): LoadedEnv {
  const env = getEnvSource(opts.env);
  const cwd = getCwd(opts.cwd);
  const platform = opts.platform ?? process.platform;

  const host =
    envString(env, ["CURSOR_BRIDGE_HOST"]) ??
    (opts.tailscale ? "0.0.0.0" : "127.0.0.1");
  const portValue = envNumber(env, ["CURSOR_BRIDGE_PORT"], 8765);
  const port = Number.isFinite(portValue) && portValue > 0 ? portValue : 8765;

  const home = envString(env, ["HOME", "USERPROFILE"]);

  const sessionsLogPath = (() => {
    const explicit = resolveAbsolutePath(
      envString(env, ["CURSOR_BRIDGE_SESSIONS_LOG"]),
      cwd,
    );
    if (explicit) return explicit;
    if (home) return path.join(home, ".cursor-api-proxy", "sessions.log");
    return path.join(cwd, "sessions.log");
  })();

  const force = envBool(env, ["CURSOR_BRIDGE_FORCE"], false);

  const rawConfigDirs = envString(env, [
    "CURSOR_CONFIG_DIRS",
    "CURSOR_ACCOUNT_DIRS",
  ]);

  let configDirs = rawConfigDirs
    ? rawConfigDirs
        .split(",")
        .map((d) => resolveAbsolutePath(d.trim(), cwd))
        .filter((d): d is string => d !== undefined)
    : [];

  if (configDirs.length === 0) {
    configDirs = discoverAccountDirs(home);
  }

  const winCmdlineRaw = envNumber(
    env,
    ["CURSOR_BRIDGE_WIN_CMDLINE_MAX"],
    30_000,
  );
  const winCmdlineMax = Math.min(
    32_700,
    Math.max(4096, Number.isFinite(winCmdlineRaw) ? winCmdlineRaw : 30_000),
  );

  const contextPreamble = envBool(
    env,
    ["CURSOR_BRIDGE_CONTEXT_PREAMBLE"],
    true,
  );

  const contextExtra = envContextExtra(env);

  const chatOnlyWorkspaceExplicit = Object.prototype.hasOwnProperty.call(
    env,
    "CURSOR_BRIDGE_CHAT_ONLY_WORKSPACE",
  );

  const mode = tryParseExecutionModeEnv(firstDefined(env, ["CURSOR_BRIDGE_MODE"]));
  const dshAutoMode = envBool(env, ["CURSOR_BRIDGE_DSH_AUTO_MODE"], false);

  return {
    agentBin: resolveAgentBinary(env, platform),
    agentNode: envString(env, ["CURSOR_AGENT_NODE"]),
    agentScript: envString(env, ["CURSOR_AGENT_SCRIPT"]),
    commandShell: envString(env, ["COMSPEC"]) ?? "cmd.exe",
    host,
    port,
    requiredKey: envString(env, ["CURSOR_BRIDGE_API_KEY"]),
    defaultModel: normalizeModelId(
      envString(env, ["CURSOR_BRIDGE_DEFAULT_MODEL"]),
    ),
    force,
    approveMcps: envBool(env, ["CURSOR_BRIDGE_APPROVE_MCPS"], false),
    strictModel: envBool(env, ["CURSOR_BRIDGE_STRICT_MODEL"], true),
    workspace:
      resolveAbsolutePath(envString(env, ["CURSOR_BRIDGE_WORKSPACE"]), cwd) ??
      cwd,
    timeoutMs: envNumber(env, ["CURSOR_BRIDGE_TIMEOUT_MS"], 300_000),
    tlsCertPath: resolveAbsolutePath(
      envString(env, ["CURSOR_BRIDGE_TLS_CERT"]),
      cwd,
    ),
    tlsKeyPath: resolveAbsolutePath(
      envString(env, ["CURSOR_BRIDGE_TLS_KEY"]),
      cwd,
    ),
    sessionsLogPath,
    chatOnlyWorkspaceExplicit,
    chatOnlyWorkspace: envBool(
      env,
      ["CURSOR_BRIDGE_CHAT_ONLY_WORKSPACE"],
      true,
    ),
    mode,
    dshAutoMode,
    dshSystemMarker: envString(env, ["CURSOR_BRIDGE_DSH_SYSTEM_MARKER"]),
    dshPlanMarker: envString(env, ["CURSOR_BRIDGE_DSH_PLAN_MARKER"]),
    verbose: envBool(env, ["CURSOR_BRIDGE_VERBOSE"], false),
    maxMode: envBool(env, ["CURSOR_BRIDGE_MAX_MODE"], false),
    promptViaStdin: envBool(env, ["CURSOR_BRIDGE_PROMPT_VIA_STDIN"], false),
    useAcp: envBool(env, ["CURSOR_BRIDGE_USE_ACP"], false),
    configDirs,
    multiPort: envBool(env, ["CURSOR_BRIDGE_MULTI_PORT"], false),
    winCmdlineMax,
    contextPreamble,
    contextExtra,
  };
}

export function resolveAgentCommand(
  cmd: string,
  args: string[],
  opts: EnvOptions = {},
): AgentCommand {
  const env = getEnvSource(opts.env);
  const loaded = loadEnvConfig(opts);
  const platform = opts.platform ?? process.platform;
  const cwd = getCwd(opts.cwd);

  if (platform === "win32") {
    if (loaded.agentNode && loaded.agentScript) {
      const agentScriptPath = path.isAbsolute(loaded.agentScript)
        ? loaded.agentScript
        : path.resolve(cwd, loaded.agentScript);
      if (/\.cmd$/i.test(loaded.agentScript)) {
        const resolved = resolveCmdShim(
          agentScriptPath,
          args,
          env,
          loaded.agentNode,
        );
        if (resolved) return resolved;
        return resolveCmdFallback(
          loaded.agentScript,
          args,
          env,
          loaded.commandShell,
        );
      }
      const agentDir = path.dirname(agentScriptPath);
      const out: AgentCommand = {
        command: loaded.agentNode,
        args: [loaded.agentScript, ...args],
        env: { ...env, CURSOR_INVOKED_AS: "agent.cmd" },
        agentScriptPath,
        configDir: configDirFromAgentDir(agentDir),
      };
      return out;
    }

    if (/\.cmd$/i.test(cmd)) {
      const cmdResolved = path.resolve(cwd, cmd);
      const resolved = resolveCmdShim(cmdResolved, args, env);
      if (resolved) return resolved;
      return resolveCmdFallback(cmd, args, env, loaded.commandShell);
    }
  }

  return { command: cmd, args, env };
}
