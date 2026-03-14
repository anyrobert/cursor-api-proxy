import * as path from "node:path";

export type EnvSource = Record<string, string | undefined>;

export type EnvOptions = {
  tailscale?: boolean;
  env?: EnvSource;
  cwd?: string;
  platform?: NodeJS.Platform;
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
  verbose: boolean;
};

export type AgentCommand = {
  command: string;
  args: string[];
  env: EnvSource;
  windowsVerbatimArguments?: boolean;
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

function envBool(env: EnvSource, names: string[], defaultValue: boolean): boolean {
  const raw = envString(env, names);
  if (raw == null) return defaultValue;
  const value = raw.toLowerCase();
  if (value === "1" || value === "true" || value === "yes" || value === "on") return true;
  if (value === "0" || value === "false" || value === "no" || value === "off") return false;
  return defaultValue;
}

function envNumber(env: EnvSource, names: string[], defaultValue: number): number {
  const raw = envString(env, names);
  if (raw == null) return defaultValue;
  const value = Number(raw);
  return Number.isFinite(value) ? value : defaultValue;
}

function normalizeModelId(raw: string | undefined): string {
  if (!raw) return "auto";
  const parts = raw.split("/");
  return parts[parts.length - 1] || "auto";
}

function resolveAbsolutePath(raw: string | undefined, cwd: string): string | undefined {
  if (!raw) return undefined;
  return path.resolve(cwd, raw);
}

export function loadEnvConfig(opts: EnvOptions = {}): LoadedEnv {
  const env = getEnvSource(opts.env);
  const cwd = getCwd(opts.cwd);

  const host = envString(env, ["CURSOR_BRIDGE_HOST"]) ?? (opts.tailscale ? "0.0.0.0" : "127.0.0.1");
  const portValue = envNumber(env, ["CURSOR_BRIDGE_PORT"], 8765);
  const port = Number.isFinite(portValue) && portValue > 0 ? portValue : 8765;

  const sessionsLogPath = (() => {
    const explicit = resolveAbsolutePath(
      envString(env, ["CURSOR_BRIDGE_SESSIONS_LOG"]),
      cwd,
    );
    if (explicit) return explicit;

    const home = envString(env, ["HOME", "USERPROFILE"]);
    if (home) return path.join(home, ".cursor-api-proxy", "sessions.log");

    return path.join(cwd, "sessions.log");
  })();

  return {
    agentBin:
      envString(env, ["CURSOR_AGENT_BIN", "CURSOR_CLI_BIN", "CURSOR_CLI_PATH"]) ?? "agent",
    agentNode: envString(env, ["CURSOR_AGENT_NODE"]),
    agentScript: envString(env, ["CURSOR_AGENT_SCRIPT"]),
    commandShell: envString(env, ["COMSPEC"]) ?? "cmd.exe",
    host,
    port,
    requiredKey: envString(env, ["CURSOR_BRIDGE_API_KEY"]),
    defaultModel: normalizeModelId(envString(env, ["CURSOR_BRIDGE_DEFAULT_MODEL"])),
    force: envBool(env, ["CURSOR_BRIDGE_FORCE"], false),
    approveMcps: envBool(env, ["CURSOR_BRIDGE_APPROVE_MCPS"], false),
    strictModel: envBool(env, ["CURSOR_BRIDGE_STRICT_MODEL"], true),
    workspace:
      resolveAbsolutePath(envString(env, ["CURSOR_BRIDGE_WORKSPACE"]), cwd) ?? cwd,
    timeoutMs: envNumber(env, ["CURSOR_BRIDGE_TIMEOUT_MS"], 300_000),
    tlsCertPath: resolveAbsolutePath(envString(env, ["CURSOR_BRIDGE_TLS_CERT"]), cwd),
    tlsKeyPath: resolveAbsolutePath(envString(env, ["CURSOR_BRIDGE_TLS_KEY"]), cwd),
    sessionsLogPath,
    chatOnlyWorkspace: envBool(env, ["CURSOR_BRIDGE_CHAT_ONLY_WORKSPACE"], true),
    verbose: envBool(env, ["CURSOR_BRIDGE_VERBOSE"], false),
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

  if (platform === "win32") {
    if (loaded.agentNode && loaded.agentScript) {
      return {
        command: loaded.agentNode,
        args: [loaded.agentScript, ...args],
        env: { ...env, CURSOR_INVOKED_AS: "agent.cmd" },
      };
    }

    if (/\.cmd$/i.test(cmd)) {
      const quotedArgs = args.map((arg) => (arg.includes(" ") ? `"${arg}"` : arg)).join(" ");
      const cmdLine = `""${cmd}" ${quotedArgs}"`;
      return {
        command: loaded.commandShell,
        args: ["/d", "/s", "/c", cmdLine],
        env,
        windowsVerbatimArguments: true,
      };
    }
  }

  return { command: cmd, args, env };
}
