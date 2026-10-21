import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createRunConfigDir,
  cursorConfigDir,
  RUN_CONFIG_FILES,
} from "./run-config-dir.js";
import { runAgentStream, runAgentSync, startAgentToolSession } from "./agent-runner.js";
import type { BridgeConfig } from "./config.js";

// Runs with an account dir cache its token; never read the real keychain.
vi.mock("./token-cache.js", () => ({
  readKeychainToken: vi.fn().mockReturnValue(undefined),
  writeCachedToken: vi.fn(),
}));

const fakeServerPath = path.join(
  process.cwd(),
  "src",
  "lib",
  "__tests__",
  "fake-acp-server.mjs",
);

/** What `agent login` and interactive use leave in an account's config dir. */
const ACCOUNT_CLI_CONFIG = {
  version: 1,
  authInfo: { email: "pool-user@example.test" },
  model: { modelId: "user-choice" },
  selectedModel: { modelId: "user-choice", parameters: [] },
  modelSelectionHistory: ["user-choice"],
  permissions: { allow: ["Shell(ls)"], deny: [] },
};

const created: string[] = [];

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  created.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of created.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeConfigDir(dir: string): string {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "cli-config.json"),
    `${JSON.stringify(ACCOUNT_CLI_CONFIG, null, 2)}\n`,
  );
  fs.writeFileSync(
    path.join(dir, "acp-config.json"),
    JSON.stringify({ selectedModelVariantId: "user-variant" }),
  );
  fs.writeFileSync(path.join(dir, ".cursor-token"), "token");
  fs.mkdirSync(path.join(dir, "chats", "abc"), { recursive: true });
  return dir;
}

/** Every file under `dir` with its content, to show a run changed nothing. */
function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of fs.readdirSync(dir, { recursive: true, withFileTypes: true })) {
    const full = path.join(entry.parentPath, entry.name);
    const rel = path.relative(dir, full);
    out[rel] = entry.isFile() ? fs.readFileSync(full, "utf8") : "<dir>";
  }
  return out;
}

function config(overrides: Partial<BridgeConfig> = {}): BridgeConfig {
  return {
    agentBin: "agent-not-used",
    acpCommand: process.execPath,
    // "acp" lets agent-runner add --model like it does for the real CLI.
    acpArgs: [fakeServerPath, "acp"],
    acpEnv: { FAKE_ACP_SCENARIO: "persist_model_config" },
    host: "127.0.0.1",
    port: 0,
    defaultModel: "default",
    mode: "ask",
    force: false,
    approveMcps: false,
    strictModel: false,
    workspace: process.cwd(),
    timeoutMs: 10_000,
    sessionsLogPath: "/tmp/cursor-api-proxy-config-dir-test.log",
    chatOnlyWorkspace: true,
    chatOnlyWorkspaceExplicit: false,
    verbose: false,
    maxMode: false,
    promptViaStdin: false,
    useAcp: true,
    acpSkipAuthenticate: true,
    acpRawDebug: false,
    configDirs: [],
    multiPort: false,
    winCmdlineMax: 30_000,
    contextPreamble: false,
    bridgePackageVersion: "0.0.0-test",
    ...overrides,
  };
}

const CMD_ARGS = ["--print", "--mode", "ask", "--model", "gpt-4"];

/** A chat-only request's isolation root, as resolveWorkspace lays it out. */
function chatOnlyRoot(): { tempDir: string; workspaceDir: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-proxy-"));
  created.push(root);
  fs.mkdirSync(path.join(root, "workspace"));
  fs.mkdirSync(path.join(root, "home", ".cursor"), { recursive: true });
  return { tempDir: root, workspaceDir: path.join(root, "workspace") };
}

type RunReport = { configDir: string; seen: unknown };

function report(text: string): RunReport {
  return JSON.parse(text) as RunReport;
}

/** The run started from `source`'s settings, on a copy that is gone now. */
function expectPrivateCopy(run: RunReport, source: string): void {
  expect(path.resolve(run.configDir)).not.toBe(path.resolve(source));
  expect(run.seen).toEqual(ACCOUNT_CLI_CONFIG);
  expect(fs.existsSync(run.configDir)).toBe(false);
}

describe("cursorConfigDir", () => {
  it("resolves the config dir the way the Cursor CLI does", () => {
    expect(cursorConfigDir({ CURSOR_CONFIG_DIR: "/acct", HOME: "/home/u" })).toBe("/acct");
    expect(
      cursorConfigDir({ CURSOR_CONFIG_DIR: "  ", XDG_CONFIG_HOME: "/xdg", HOME: "/home/u" }),
    ).toBe(path.join("/xdg", "cursor"));
    expect(cursorConfigDir({ HOME: "/home/u" }, "linux")).toBe(
      path.join("/home/u", ".cursor"),
    );
    expect(
      cursorConfigDir({ HOME: "/msys/home", USERPROFILE: "C:\\Users\\u" }, "win32"),
    ).toBe(path.join("C:\\Users\\u", ".cursor"));
  });
});

describe("createRunConfigDir", () => {
  it("copies only the files the CLI reads, into a dir of its own", () => {
    const source = makeConfigDir(tempDir("account-"));
    fs.writeFileSync(path.join(source, "permissions.json"), "{}");
    fs.mkdirSync(path.join(source, "acp-sessions", "old"), { recursive: true });
    const run = createRunConfigDir(source);
    created.push(run.dir);
    expect(fs.readdirSync(run.dir).sort()).toEqual(
      ["acp-config.json", "cli-config.json", "permissions.json"].sort(),
    );
    expect(RUN_CONFIG_FILES).toContain("statsig-cache.json");
    expect(fs.readFileSync(path.join(run.dir, "cli-config.json"), "utf8")).toBe(
      fs.readFileSync(path.join(source, "cli-config.json"), "utf8"),
    );
    if (process.platform !== "win32") {
      expect(fs.statSync(run.dir).mode & 0o077).toBe(0);
    }
  });

  it("starts empty for a config dir that does not exist yet", () => {
    const run = createRunConfigDir(path.join(tempDir("missing-"), "nope"));
    created.push(run.dir);
    expect(fs.readdirSync(run.dir)).toEqual([]);
  });

  it("removes the copy once, however often it is disposed", () => {
    const run = createRunConfigDir(makeConfigDir(tempDir("account-")));
    fs.writeFileSync(path.join(run.dir, "cli-config.json"), "{}");
    run.dispose();
    run.dispose();
    expect(fs.existsSync(run.dir)).toBe(false);
  });
});

describe("ACP runs do not change the account's saved model (#63)", () => {
  it("keeps a pool account's config dir untouched by a chat-only sync run", async () => {
    const account = makeConfigDir(tempDir("account-"));
    const before = snapshot(account);
    const { tempDir: root, workspaceDir } = chatOnlyRoot();
    const out = await runAgentSync(
      config(),
      workspaceDir,
      true,
      CMD_ARGS,
      root,
      "hi",
      account,
    );
    expect(out.code).toBe(0);
    expectPrivateCopy(report(out.stdout), account);
    expect(snapshot(account)).toEqual(before);
    expect(fs.existsSync(root)).toBe(false);
  });

  it("keeps a pool account's config dir untouched by a streamed agent-mode run", async () => {
    const account = makeConfigDir(tempDir("account-"));
    const before = snapshot(account);
    let text = "";
    const out = await runAgentStream(
      config(),
      process.cwd(),
      false,
      ["--print", "--mode", "agent", "--model", "gpt-4"],
      (chunk) => {
        text += chunk;
      },
      undefined,
      "hi",
      account,
    );
    expect(out.code).toBe(0);
    expectPrivateCopy(report(text), account);
    expect(snapshot(account)).toEqual(before);
  });

  it("keeps the user's own config dir untouched without chat-only or a pool", async () => {
    const home = tempDir("home-");
    const userConfig = makeConfigDir(path.join(home, ".cursor"));
    const before = snapshot(userConfig);
    const out = await runAgentSync(
      config({ acpEnv: { FAKE_ACP_SCENARIO: "persist_model_config", HOME: home } }),
      process.cwd(),
      false,
      ["--print", "--mode", "agent", "--model", "gpt-4"],
      undefined,
      "hi",
    );
    expect(out.code).toBe(0);
    expectPrivateCopy(report(out.stdout), userConfig);
    expect(snapshot(userConfig)).toEqual(before);
  });

  it("keeps a pool account's config dir untouched by a tool session", async () => {
    const account = makeConfigDir(tempDir("account-"));
    const before = snapshot(account);
    const { tempDir: root, workspaceDir } = chatOnlyRoot();
    const session = await startAgentToolSession({
      config: config(),
      workspaceDir,
      effectiveChatOnly: false,
      cmdArgs: ["--print", "--mode", "agent", "--model", "gpt-4"],
      prompt: "hi",
      tools: [{ name: "weather", inputSchema: { type: "object" } }],
      tempDir: root,
      configDir: account,
    });
    const result = await session.collect();
    expect(result.status).toBe("completed");
    expectPrivateCopy(report(result.text), account);
    expect(snapshot(account)).toEqual(before);
    expect(fs.existsSync(root)).toBe(false);
  });

  it("gives concurrent runs on one account separate copies", async () => {
    const account = makeConfigDir(tempDir("account-"));
    const before = snapshot(account);
    const runs = await Promise.all(
      [1, 2, 3].map(() =>
        runAgentSync(config(), process.cwd(), false, CMD_ARGS, undefined, "hi", account),
      ),
    );
    const reports = runs.map((out) => report(out.stdout));
    expect(new Set(reports.map((run) => run.configDir)).size).toBe(3);
    for (const run of reports) expectPrivateCopy(run, account);
    expect(snapshot(account)).toEqual(before);
  });

  it("keeps using the chat-only temp home when there is no pool", async () => {
    const { tempDir: root, workspaceDir } = chatOnlyRoot();
    const out = await runAgentSync(config(), workspaceDir, true, CMD_ARGS, root, "hi");
    expect(out.code).toBe(0);
    expect(report(out.stdout).configDir).toBe(path.join(root, "home", ".cursor"));
    expect(fs.existsSync(root)).toBe(false);
  });
});
