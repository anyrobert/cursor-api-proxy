#!/usr/bin/env bun
/**
 * Latency breakdown: spawn/setup vs inference, CLI vs ACP vs client tools.
 *
 * Prereqs:
 *   - bun run build  (for ephemeral proxy + optional direct ACP import)
 *   - Cursor CLI installed + logged in (or CURSOR_API_KEY / account pool)
 *
 * Run:
 *   bun examples/benchmark-latency.mjs
 *
 * Env:
 *   CURSOR_PROXY_URL       existing proxy (default http://127.0.0.1:8765)
 *   BENCH_SKIP_EPHEMERAL=1 skip spawned ACP/tool proxies
 *   BENCH_COMPARE_AGENT=1  also run agent-mode completion (slower path)
 *   BENCH_MAX_MODE=1       enable CURSOR_BRIDGE_MAX_MODE on ephemeral proxies
 *   BENCH_MODEL, BENCH_PROMPT, CURSOR_CONFIG_DIR, CURSOR_BRIDGE_API_KEY
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import { createServer } from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const CLI_PATH = path.join(REPO_ROOT, "dist/cli.js");

const DEFAULT_PROXY_URL =
  process.env.CURSOR_PROXY_URL ?? "http://127.0.0.1:8765";
const AGENT_BIN = process.env.CURSOR_AGENT_BIN ?? "agent";
const PROMPT = process.env.BENCH_PROMPT ?? 'Reply with exactly one word: "ok"';
const MODEL_ENV = process.env.BENCH_MODEL ?? "auto";
let MODEL = MODEL_ENV;
const PROXY_API_KEY = process.env.CURSOR_BRIDGE_API_KEY;
const SKIP_EPHEMERAL = process.env.BENCH_SKIP_EPHEMERAL === "1";
const COMPARE_AGENT = process.env.BENCH_COMPARE_AGENT === "1";
const BENCH_MAX_MODE = process.env.BENCH_MAX_MODE === "1";
const HEALTH_TIMEOUT_MS = 30_000;

const WEATHER_TOOL = {
  type: "function",
  function: {
    name: "weather",
    description: "Return weather for a city",
    parameters: {
      type: "object",
      properties: { city: { type: "string" } },
      required: ["city"],
    },
  },
};

const TOOL_PROMPT =
  process.env.BENCH_TOOL_PROMPT ??
  "Use the weather tool for Paris. Reply with the tool result only.";

function discoverAccountConfigDir() {
  if (process.env.CURSOR_CONFIG_DIR) return process.env.CURSOR_CONFIG_DIR;
  const root = path.join(
    process.env.HOME ?? process.env.USERPROFILE ?? "",
    ".cursor-api-proxy",
    "accounts",
  );
  try {
    const names = fs
      .readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
    if (names.length === 0) return undefined;
    return path.join(root, names[0]);
  } catch {
    return undefined;
  }
}

function discoverAccountConfigDirs() {
  if (process.env.CURSOR_CONFIG_DIRS) {
    return process.env.CURSOR_CONFIG_DIRS.split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }
  const root = path.join(
    process.env.HOME ?? process.env.USERPROFILE ?? "",
    ".cursor-api-proxy",
    "accounts",
  );
  try {
    return fs
      .readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => path.join(root, d.name))
      .sort();
  } catch {
    return [];
  }
}

const PREFERRED_MODELS = [
  "composer-2.5",
  "gpt-5.2",
  "cursor-grok-4.6-high-fast",
  "claude-sonnet-5-thinking-high",
];

function parseModelIds(listStdout) {
  const ids = [];
  for (const line of listStdout.split("\n")) {
    const m = line.trim().match(/^([a-z0-9._-]+)\s+-/i);
    if (m) ids.push(m[1]);
  }
  return ids;
}

function parseFirstConcreteModel(listStdout) {
  const ids = parseModelIds(listStdout).filter((id) => id !== "auto");
  for (const preferred of PREFERRED_MODELS) {
    if (ids.includes(preferred)) return preferred;
  }
  return ids[0];
}

async function resolveBenchModel(listModelsResult) {
  if (MODEL_ENV !== "auto") return MODEL_ENV;
  const fromList = parseFirstConcreteModel(listModelsResult.stdout);
  if (fromList) return fromList;
  try {
    const res = await fetch(`${DEFAULT_PROXY_URL}/v1/models`);
    if (res.ok) {
      const data = await res.json();
      const id = data.data?.find((m) => m.id && m.id !== "auto")?.id;
      if (id) return id;
    }
  } catch {
    /* ignore */
  }
  return "gpt-5.2";
}

function chatOnlyEnv(workspaceDir, authConfigDir) {
  const cursorDir = authConfigDir ?? path.join(workspaceDir, ".cursor");
  const env = { CURSOR_CONFIG_DIR: cursorDir };
  if (authConfigDir) return env;
  env.HOME = workspaceDir;
  env.USERPROFILE = workspaceDir;
  if (process.platform === "win32") {
    env.APPDATA = path.join(workspaceDir, "AppData", "Roaming");
    env.LOCALAPPDATA = path.join(workspaceDir, "AppData", "Local");
  } else {
    env.XDG_CONFIG_HOME = path.join(workspaceDir, ".config");
  }
  return env;
}

function ms(start) {
  return Date.now() - start;
}

function fmt(n) {
  return `${n}ms`;
}

function printRow(label, duration, note = "") {
  const pad = label.padEnd(34);
  const noteStr = note ? `  (${note})` : "";
  console.log(`  ${pad} ${fmt(duration).padStart(8)}${noteStr}`);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((err) => (err ? reject(err) : resolve(port)));
    });
    server.on("error", reject);
  });
}

async function runCommand(label, cmd, args, opts = {}) {
  const start = Date.now();
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...opts.env },
      cwd: opts.cwd,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("close", (code) => {
      resolve({
        label,
        ms: ms(start),
        code: code ?? -1,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
      });
    });
    child.on("error", (err) => {
      resolve({
        label,
        ms: ms(start),
        code: -1,
        stdout: "",
        stderr: String(err),
      });
    });
  });
}

function makeChatOnlyWorkspace() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-proxy-bench-"));
  const cursorDir = path.join(tempDir, ".cursor");
  fs.mkdirSync(path.join(cursorDir, "rules"), { recursive: true });
  fs.writeFileSync(
    path.join(cursorDir, "cli-config.json"),
    JSON.stringify({
      version: 1,
      editor: { vimMode: false },
      permissions: { allow: [], deny: [] },
    }),
  );
  if (process.platform !== "win32") {
    fs.mkdirSync(path.join(tempDir, ".config"), { recursive: true });
  }
  return tempDir;
}

async function waitForHealth(baseUrl, timeoutMs = HEALTH_TIMEOUT_MS) {
  const start = Date.now();
  while (ms(start) < timeoutMs) {
    try {
      const res = await fetch(`${baseUrl}/health`);
      if (res.ok) return await res.json();
    } catch {
      /* retry */
    }
    await sleep(200);
  }
  throw new Error(
    `Proxy at ${baseUrl} did not become healthy within ${timeoutMs}ms`,
  );
}

class EphemeralProxy {
  #child = null;
  #port = 0;
  bootLog = "";

  constructor(name, envOverrides = {}) {
    this.name = name;
    this.envOverrides = envOverrides;
  }

  get baseUrl() {
    return `http://127.0.0.1:${this.#port}`;
  }

  async start(authConfigDirs) {
    if (!fs.existsSync(CLI_PATH)) {
      throw new Error(`Missing ${CLI_PATH} — run bun run build first`);
    }
    this.#port = await getFreePort();
    const env = {
      ...process.env,
      CURSOR_BRIDGE_HOST: "127.0.0.1",
      CURSOR_BRIDGE_PORT: String(this.#port),
      CURSOR_BRIDGE_CONTEXT_PREAMBLE: "false",
      CURSOR_BRIDGE_STRICT_MODEL: "false",
      CURSOR_BRIDGE_DEFAULT_MODEL: MODEL,
      ...this.envOverrides,
    };
    if (authConfigDirs.length > 0) {
      env.CURSOR_CONFIG_DIRS = authConfigDirs.join(",");
    }
    if (PROXY_API_KEY) env.CURSOR_BRIDGE_API_KEY = PROXY_API_KEY;
    if (process.env.CURSOR_API_KEY) {
      env.CURSOR_API_KEY = process.env.CURSOR_API_KEY;
    }

    this.#child = spawn(process.execPath, [CLI_PATH], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
      cwd: REPO_ROOT,
    });
    let bootLog = "";
    this.bootLog = "";
    this.#child.stderr?.on("data", (d) => {
      bootLog += d.toString();
      this.bootLog = bootLog;
      if (bootLog.length > 8000) bootLog = bootLog.slice(-8000);
    });
    this.#child.on("exit", (code) => {
      if (code != null && code !== 0) {
        this._exitError = new Error(
          `${this.name} proxy exited ${code}: ${bootLog.slice(-400)}`,
        );
      }
    });

    const health = await waitForHealth(this.baseUrl);
    this.health = health;
    return health;
  }

  async stop() {
    if (!this.#child) return;
    const child = this.#child;
    this.#child = null;
    child.kill("SIGTERM");
    await Promise.race([
      new Promise((resolve) => child.once("exit", resolve)),
      sleep(3000),
    ]);
    if (!child.killed) child.kill("SIGKILL");
  }
}

async function proxyFetch(baseUrl, pathname, body, apiKey = PROXY_API_KEY) {
  const headers = { "Content-Type": "application/json" };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  const start = Date.now();
  const res = await fetch(`${baseUrl}${pathname}`, {
    method: body ? "POST" : "GET",
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { ms: ms(start), status: res.status, text };
}

async function proxyChatSync(baseUrl, label, opts = {}) {
  const start = Date.now();
  const body = {
    model: MODEL,
    messages: [{ role: "user", content: opts.prompt ?? PROMPT }],
    stream: false,
    ...(opts.mode ? { mode: opts.mode } : {}),
    ...(opts.tools ? { tools: opts.tools } : {}),
    ...(opts.tool_choice ? { tool_choice: opts.tool_choice } : {}),
  };
  const result = await proxyFetch(baseUrl, "/v1/chat/completions", body);
  let content = "";
  let toolCalls;
  let finishReason;
  try {
    const parsed = JSON.parse(result.text);
    content = parsed.choices?.[0]?.message?.content ?? "";
    toolCalls = parsed.choices?.[0]?.message?.tool_calls;
    finishReason = parsed.choices?.[0]?.finish_reason;
  } catch {
    content = result.text.slice(0, 120);
  }
  return {
    label,
    ms: ms(start),
    status: result.status,
    content: String(content ?? "")
      .trim()
      .slice(0, 80),
    toolCalls,
    finishReason,
    raw: result.text,
  };
}

async function proxyChatStream(baseUrl) {
  const headers = { "Content-Type": "application/json" };
  if (PROXY_API_KEY) headers.Authorization = `Bearer ${PROXY_API_KEY}`;
  const start = Date.now();
  let ttfb = null;
  let chunks = 0;
  const res = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: "user", content: PROMPT }],
      stream: true,
    }),
  });
  if (!res.ok) {
    return {
      label: "proxy stream chat",
      status: res.status,
      ms: ms(start),
      ttfb: null,
      chunks: 0,
      error: await res.text(),
    };
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (ttfb == null) ttfb = ms(start);
    chunks++;
    decoder.decode(value, { stream: true });
  }
  return {
    label: "proxy stream chat",
    status: res.status,
    ms: ms(start),
    ttfb,
    chunks,
  };
}

async function proxyToolRoundTrip(baseUrl) {
  const totalStart = Date.now();
  const initial = await proxyChatSync(baseUrl, "tool round-trip #1", {
    prompt: TOOL_PROMPT,
    tools: [WEATHER_TOOL],
    tool_choice: { type: "function", function: { name: "weather" } },
  });
  if (initial.status !== 200 || !initial.toolCalls?.length) {
    return {
      ok: false,
      initial,
      follow: null,
      totalMs: ms(totalStart),
      error:
        initial.status !== 200
          ? initial.raw?.slice(0, 200)
          : "model did not return tool_calls",
    };
  }
  const call = initial.toolCalls[0];
  const followStart = Date.now();
  const followBody = {
    model: MODEL,
    stream: false,
    messages: [
      { role: "user", content: TOOL_PROMPT },
      { role: "assistant", content: null, tool_calls: [call] },
      {
        role: "tool",
        tool_call_id: call.id,
        content: JSON.stringify({
          city: "Paris",
          temp_c: 22,
          condition: "sunny",
        }),
      },
    ],
    tools: [WEATHER_TOOL],
  };
  const followRes = await proxyFetch(
    baseUrl,
    "/v1/chat/completions",
    followBody,
  );
  const followMs = ms(followStart);
  let followContent = "";
  try {
    followContent =
      JSON.parse(followRes.text).choices?.[0]?.message?.content ?? "";
  } catch {
    followContent = followRes.text.slice(0, 120);
  }
  return {
    ok: followRes.status === 200,
    initialMs: initial.ms,
    followMs,
    totalMs: ms(totalStart),
    initial,
    followStatus: followRes.status,
    followContent: String(followContent).trim().slice(0, 80),
    error: followRes.status === 200 ? undefined : followRes.text.slice(0, 200),
  };
}

async function proxyHealth(baseUrl) {
  try {
    const res = await fetch(`${baseUrl}/health`);
    if (!res.ok) return null;
    return res.json();
  } catch {
    return null;
  }
}

async function directAcpSync(authConfigDir) {
  if (!fs.existsSync(path.join(REPO_ROOT, "dist/lib/acp-client.js"))) {
    return { skipped: true, reason: "dist not built" };
  }
  const workspace = makeChatOnlyWorkspace();
  try {
    const { runAcpSync } = await import(
      path.join(REPO_ROOT, "dist/lib/acp-client.js")
    );
    const { resolveAgentCommand } = await import(
      path.join(REPO_ROOT, "dist/lib/env.js")
    );
    const resolved = resolveAgentCommand(AGENT_BIN, ["acp"]);
    const acpIdx = resolved.args.indexOf("acp");
    const args =
      acpIdx === -1
        ? [
            ...resolved.args,
            "--workspace",
            workspace,
            "--model",
            MODEL,
            "--mode",
            "ask",
          ]
        : [
            ...resolved.args.slice(0, acpIdx),
            "--workspace",
            workspace,
            ...resolved.args.slice(acpIdx),
            "--model",
            MODEL,
            "--mode",
            "ask",
          ];
    const env = {
      ...resolved.env,
      ...chatOnlyEnv(workspace, authConfigDir),
    };
    if (process.env.CURSOR_API_KEY) {
      env.CURSOR_API_KEY = process.env.CURSOR_API_KEY;
      env.CURSOR_AUTH_TOKEN = process.env.CURSOR_API_KEY;
    }
    const start = Date.now();
    const out = await runAcpSync(resolved.command, args, PROMPT, {
      cwd: workspace,
      timeoutMs: 300_000,
      env,
      requestTimeoutMs: 300_000,
      skipAuthenticate: Boolean(process.env.CURSOR_API_KEY),
      spawnOptions: resolved.windowsVerbatimArguments
        ? { windowsVerbatimArguments: true }
        : undefined,
    });
    return {
      skipped: false,
      ms: ms(start),
      code: out.code,
      stdout: out.stdout.slice(0, 80),
      stderr: out.stderr.slice(0, 200),
    };
  } catch (err) {
    return {
      skipped: false,
      ms: 0,
      code: -1,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
}

async function runEphemeralPhase(name, envOverrides, authConfigDirs, runner) {
  const proxy = new EphemeralProxy(name, envOverrides);
  try {
    await proxy.start(authConfigDirs);
    return await runner(proxy.baseUrl, proxy.health, proxy);
  } finally {
    await proxy.stop();
  }
}

async function main() {
  console.log("cursor-api-proxy latency benchmark (full)");
  console.log("=========================================");
  console.log(`agent:     ${AGENT_BIN}`);
  console.log(`proxy:     ${DEFAULT_PROXY_URL}`);
  console.log(`model:     ${MODEL}`);
  console.log(`prompt:    ${JSON.stringify(PROMPT)}`);
  console.log(
    `build:     ${fs.existsSync(CLI_PATH) ? CLI_PATH : "MISSING — bun run build"}`,
  );
  const authConfigDir = discoverAccountConfigDir();
  const authConfigDirs = discoverAccountConfigDirs();
  if (authConfigDir) {
    console.log(`auth:      ${authConfigDir} (account pool)`);
  } else if (process.env.CURSOR_API_KEY) {
    console.log("auth:      CURSOR_API_KEY");
  } else {
    console.log("auth:      default CLI login (~/.cursor)");
  }
  console.log("");

  const results = {};

  console.log("Phase 1 — CLI spawn / setup (no inference)");
  const version = await runCommand("agent --version", AGENT_BIN, ["--version"]);
  printRow("agent --version", version.ms, "process spawn only");

  const listModels = await runCommand(
    "agent --list-models",
    AGENT_BIN,
    ["--list-models"],
    authConfigDir ? { env: { CURSOR_CONFIG_DIR: authConfigDir } } : {},
  );
  MODEL = await resolveBenchModel(listModels);
  printRow("agent --list-models", listModels.ms, "spawn + model catalog");
  console.log(
    `    resolved model: ${MODEL}${MODEL !== MODEL_ENV ? ` (from ${MODEL_ENV})` : ""}`,
  );
  results.listModels = listModels.ms;

  console.log("");
  console.log("Phase 2 — Direct CLI completion (spawn + inference)");
  const workspace = makeChatOnlyWorkspace();
  try {
    const direct = await runCommand(
      "agent --print direct",
      AGENT_BIN,
      [
        "--print",
        "--trust",
        "--mode",
        "ask",
        "--workspace",
        workspace,
        "--model",
        MODEL,
        "--output-format",
        "text",
        PROMPT,
      ],
      {
        env: chatOnlyEnv(workspace, authConfigDir),
        cwd: workspace,
      },
    );
    printRow("agent --print (ask)", direct.ms, `exit ${direct.code}`);
    results.directAsk = direct.code === 0 ? direct.ms : null;
    if (direct.code !== 0) {
      console.log(`    stderr: ${direct.stderr.slice(0, 200)}`);
    } else {
      console.log(`    reply:  ${direct.stdout.slice(0, 80)}`);
    }

    if (COMPARE_AGENT) {
      const agentMode = await runCommand(
        "agent --print agent",
        AGENT_BIN,
        [
          "--print",
          "--trust",
          "--workspace",
          workspace,
          "--model",
          MODEL,
          "--output-format",
          "text",
          PROMPT,
        ],
        {
          env: chatOnlyEnv(workspace, authConfigDir),
          cwd: workspace,
        },
      );
      printRow(
        "agent --print (agent mode)",
        agentMode.ms,
        `exit ${agentMode.code}`,
      );
      results.directAgent = agentMode.code === 0 ? agentMode.ms : null;
      if (agentMode.code !== 0) {
        console.log(`    stderr: ${agentMode.stderr.slice(0, 200)}`);
      }
    }
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }

  console.log("");
  console.log("Phase 3 — Direct ACP (no proxy, dist/acp-client)");
  const directAcp = await directAcpSync(authConfigDir);
  if (directAcp.skipped) {
    console.log(`  skipped — ${directAcp.reason}`);
  } else if (directAcp.error) {
    printRow("runAcpSync (direct)", directAcp.ms, "error");
    console.log(`    ${directAcp.error}`);
  } else {
    printRow("runAcpSync (direct)", directAcp.ms, `exit ${directAcp.code}`);
    results.directAcp = directAcp.code === 0 ? directAcp.ms : null;
    if (directAcp.code !== 0) {
      console.log(`    stderr: ${directAcp.stderr}`);
    } else {
      console.log(`    reply:  ${directAcp.stdout}`);
    }
  }

  console.log("");
  console.log("Phase 4 — Existing proxy (CLI path, if running)");
  const health = await proxyHealth(DEFAULT_PROXY_URL);
  if (!health) {
    console.log(`  ${DEFAULT_PROXY_URL} not reachable — skip`);
  } else {
    console.log(
      `  version=${health.version} mode=${health.mode} strictModel=${health.strictModel}`,
    );
    const models = await proxyFetch(DEFAULT_PROXY_URL, "/v1/models");
    printRow("GET /v1/models", models.ms, `HTTP ${models.status}`);

    const sync1 = await proxyChatSync(DEFAULT_PROXY_URL, "proxy sync #1");
    printRow("POST sync #1", sync1.ms, `HTTP ${sync1.status}`);
    results.proxySync1 = sync1.ms;

    const sync2 = await proxyChatSync(DEFAULT_PROXY_URL, "proxy sync #2");
    printRow("POST sync #2 (warm cache)", sync2.ms, `HTTP ${sync2.status}`);
    results.proxySync2 = sync2.ms;
    if (sync2.status === 200) console.log(`    reply: ${sync2.content}`);

    const stream = await proxyChatStream(DEFAULT_PROXY_URL);
    printRow("POST stream total", stream.ms, `HTTP ${stream.status}`);
    if (stream.ttfb != null) {
      printRow("POST stream TTFB", stream.ttfb, `${stream.chunks} chunks`);
      results.streamTtfb = stream.ttfb;
    }
  }

  if (!SKIP_EPHEMERAL) {
    const ephemeralEnv = {
      CURSOR_BRIDGE_USE_ACP: "true",
      ...(BENCH_MAX_MODE ? { CURSOR_BRIDGE_MAX_MODE: "true" } : {}),
    };

    console.log("");
    console.log("Phase 5 — Ephemeral proxy + ACP (no tools)");
    try {
      await runEphemeralPhase(
        "acp-plain",
        ephemeralEnv,
        authConfigDirs,
        async (baseUrl, _health, proxy) => {
          const sync = await proxyChatSync(baseUrl, "acp proxy sync");
          printRow("ACP proxy sync", sync.ms, `HTTP ${sync.status}`);
          results.acpProxySync = sync.ms;
          if (sync.status !== 200) {
            console.log(`    ${sync.raw?.slice(0, 200)}`);
            if (proxy.bootLog) {
              console.log(`    proxy log: ${proxy.bootLog.slice(-400)}`);
            }
          } else {
            console.log(`    reply: ${sync.content}`);
          }
        },
      );
    } catch (err) {
      console.log(`  failed: ${err instanceof Error ? err.message : err}`);
    }

    console.log("");
    console.log("Phase 6 — Ephemeral proxy + ACP + client tools (2-step)");
    try {
      await runEphemeralPhase(
        "acp-tools",
        ephemeralEnv,
        authConfigDirs,
        async (baseUrl, _health, proxy) => {
          const trip = await proxyToolRoundTrip(baseUrl);
          if (!trip.ok) {
            printRow("tool call #1", trip.initial?.ms ?? 0, "failed");
            console.log(`    ${trip.error ?? "unknown error"}`);
            if (proxy.bootLog) {
              console.log(`    proxy log: ${proxy.bootLog.slice(-400)}`);
            }
            return;
          }
          printRow("tool call #1 (to tool_calls)", trip.initialMs, "HTTP 200");
          printRow(
            "tool call #2 (with result)",
            trip.followMs,
            `HTTP ${trip.followStatus}`,
          );
          printRow("tool round-trip total", trip.totalMs, "");
          results.toolCall1 = trip.initialMs;
          results.toolCall2 = trip.followMs;
          results.toolTotal = trip.totalMs;
          console.log(`    final: ${trip.followContent}`);
        },
      );
    } catch (err) {
      console.log(`  failed: ${err instanceof Error ? err.message : err}`);
    }

    if (COMPARE_AGENT) {
      console.log("");
      console.log("Phase 7 — Ephemeral ACP proxy, agent mode");
      try {
        await runEphemeralPhase(
          "acp-agent",
          { ...ephemeralEnv, CURSOR_BRIDGE_MODE: "agent" },
          authConfigDirs,
          async (baseUrl) => {
            const sync = await proxyChatSync(baseUrl, "acp agent mode", {
              mode: "agent",
            });
            printRow("ACP proxy sync (agent)", sync.ms, `HTTP ${sync.status}`);
            results.acpAgentSync = sync.ms;
          },
        );
      } catch (err) {
        console.log(`  failed: ${err instanceof Error ? err.message : err}`);
      }
    }
  } else {
    console.log("");
    console.log("Phases 5–7 skipped (BENCH_SKIP_EPHEMERAL=1)");
  }

  console.log("");
  console.log("Summary");
  console.log("-------");
  if (results.directAsk != null) {
    console.log(`  Direct CLI (ask):     ${fmt(results.directAsk)}`);
  }
  if (results.directAcp != null) {
    console.log(`  Direct ACP:           ${fmt(results.directAcp)}`);
    if (results.directAsk != null) {
      const delta = results.directAcp - results.directAsk;
      console.log(
        `  ACP vs CLI direct:    ${delta >= 0 ? "+" : ""}${fmt(delta)}`,
      );
    }
  }
  if (results.proxySync2 != null && results.directAsk != null) {
    const overhead = results.proxySync2 - results.directAsk;
    console.log(
      `  Proxy overhead:       ${overhead >= 0 ? "+" : ""}${fmt(overhead)}  (sync #2 − direct CLI)`,
    );
  }
  if (results.acpProxySync != null && results.proxySync2 != null) {
    const delta = results.acpProxySync - results.proxySync2;
    console.log(
      `  ACP proxy vs CLI proxy: ${delta >= 0 ? "+" : ""}${fmt(delta)}`,
    );
  }
  if (results.toolTotal != null) {
    console.log(
      `  Tool round-trip:      ${fmt(results.toolTotal)}  (#1 ${fmt(results.toolCall1)} + #2 ${fmt(results.toolCall2)})`,
    );
  }
  console.log("");
  console.log("How to read this for issue #37:");
  console.log(
    "  • ~1s on list-models, ~5–10s on direct CLI → normal; 60s+ is elsewhere.",
  );
  console.log("  • ACP >> CLI → ACP handshake/MCP startup cost.");
  console.log("  • tool #1 >> plain sync → tool session + MCP bridge.");
  console.log("  • agent mode >> ask → heavier Cursor path.");
  console.log("  • Paste full output when replying on GitHub.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
