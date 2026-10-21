import * as fs from "node:fs";
import * as http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import type { BridgeConfig } from "./config.js";
import { run, runStreaming } from "./process.js";
import { startBridgeServer } from "./server.js";

// Issue #101: a workspace or media failure the client caused keeps its
// 400/422 and specific message; one the proxy host caused (a temp dir that
// cannot be created) is a 500 that names no path, with the detail logged.

// The request listener's catch-all checks for CursorCliModelsError, so the
// mock keeps the module's real exports.
vi.mock("./cursor-cli.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./cursor-cli.js")>()),
  listCursorCliModels: vi
    .fn()
    .mockResolvedValue([{ id: "claude-3-opus", name: "Claude 3 Opus" }]),
}));

// No agent ever runs: every request here fails before it would start one.
vi.mock("./process.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./process.js")>()),
  run: vi.fn(),
  runStreaming: vi.fn(),
}));

const fakeAcpServer = join(
  process.cwd(),
  "src",
  "lib",
  "__tests__",
  "fake-acp-server.mjs",
);

const INTERNAL_MESSAGE =
  "The proxy could not handle the request. See server logs for details.";

let workDir: string;
let base: string;
let outside: string;
/** A TMPDIR that does not exist, so every temp dir the proxy makes fails. */
let missingTmp: string;
let sessionsLog: string;
const servers: http.Server[] = [];

beforeAll(() => {
  workDir = fs.mkdtempSync(join(tmpdir(), "input-errors-"));
  base = join(workDir, "base");
  outside = join(workDir, "outside");
  missingTmp = join(workDir, "no-tmp");
  sessionsLog = join(workDir, "sessions.log");
  fs.mkdirSync(join(base, "pkg"), { recursive: true });
  fs.mkdirSync(outside);
});

afterAll(() => {
  fs.rmSync(workDir, { recursive: true, force: true });
});

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  fs.rmSync(sessionsLog, { force: true });
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.mocked(run).mockReset();
  vi.mocked(runStreaming).mockReset();
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
          server.closeAllConnections();
        }),
    ),
  );
});

function config(overrides: Partial<BridgeConfig>): BridgeConfig {
  return {
    agentBin: join(workDir, "no-agent"),
    acpCommand: process.execPath,
    acpArgs: [fakeAcpServer],
    acpEnv: {},
    host: "127.0.0.1",
    port: 0,
    defaultModel: "default",
    mode: "ask",
    force: false,
    approveMcps: false,
    strictModel: true,
    workspace: base,
    timeoutMs: 10_000,
    sessionsLogPath: sessionsLog,
    chatOnlyWorkspace: true,
    chatOnlyWorkspaceExplicit: false,
    verbose: false,
    maxMode: false,
    promptViaStdin: false,
    useAcp: false,
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

async function start(overrides: Partial<BridgeConfig> = {}): Promise<string> {
  const [server] = startBridgeServer({ version: "test", config: config(overrides) });
  servers.push(server as http.Server);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No port");
  return `http://127.0.0.1:${address.port}`;
}

/** Makes every temp dir the proxy creates from now on fail with ENOENT. */
function breakTmpdir(): void {
  vi.stubEnv("TMPDIR", missingTmp);
  vi.stubEnv("TMP", missingTmp);
  vi.stubEnv("TEMP", missingTmp);
}

const base64 = (text: string) => Buffer.from(text).toString("base64");

type Api = {
  path: string;
  /** The `error.type` each API sends for a 500. */
  serverErrorType: string;
  /** A request whose one user message is "hi" followed by `part`, if any. */
  request: (part?: unknown) => Record<string, unknown>;
  /** A media part carrying base64 `data` of the given MIME type. */
  media: (kind: "image" | "video", mime: string, data: string) => unknown;
};

const APIS: Api[] = [
  {
    path: "/v1/chat/completions",
    serverErrorType: "server_error",
    request: (part) => ({
      model: "claude-3-opus",
      messages: [
        { role: "user", content: part ? [{ type: "text", text: "hi" }, part] : "hi" },
      ],
    }),
    media: (kind, mime, data) => ({
      type: `${kind}_url`,
      [`${kind}_url`]: { url: `data:${mime};base64,${data}` },
    }),
  },
  {
    path: "/v1/messages",
    serverErrorType: "api_error",
    request: (part) => ({
      model: "claude-3-opus",
      max_tokens: 64,
      messages: [
        { role: "user", content: part ? [{ type: "text", text: "hi" }, part] : "hi" },
      ],
    }),
    media: (kind, mime, data) => ({
      type: kind,
      source: { type: "base64", media_type: mime, data },
    }),
  },
  {
    path: "/v1/responses",
    serverErrorType: "server_error",
    request: (part) => ({
      model: "claude-3-opus",
      input: part
        ? [{ role: "user", content: [{ type: "input_text", text: "hi" }, part] }]
        : "hi",
    }),
    media: (kind, mime, data) => ({
      type: `input_${kind}`,
      [`${kind}_url`]: `data:${mime};base64,${data}`,
    }),
  },
];

async function post(
  baseUrl: string,
  api: Api,
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
): Promise<{ status: number; text: string; error: any }> {
  const response = await fetch(`${baseUrl}${api.path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, text, error: JSON.parse(text).error };
}

/** Asserts a host fault was answered as a safe 500 and logged in full. */
function expectHostFault(
  api: Api,
  result: { status: number; text: string; error: any },
  detail: string,
): void {
  expect(result.status).toBe(500);
  expect(result.error).toMatchObject({
    type: api.serverErrorType,
    code: "internal_error",
    message: INTERNAL_MESSAGE,
  });
  expect(result.text).not.toContain(workDir);
  expect(result.text).not.toContain(detail);
  const logged = vi
    .mocked(console.error)
    .mock.calls.map((call) => call.map(String).join(" "))
    .join("\n");
  expect(logged).toContain(detail);
  expect(logged).toContain(missingTmp);
  expect(fs.readFileSync(sessionsLog, "utf8")).toMatch(
    new RegExp(`ERROR POST ${api.path} \\S+ internal_error .*${detail}`),
  );
  expect(run).not.toHaveBeenCalled();
  expect(runStreaming).not.toHaveBeenCalled();
}

describe("workspace and media failures (#101)", () => {
  describe.each(APIS)("$path", (api) => {
    it("answers a chat-only workspace the host cannot create with a safe 500", async () => {
      const baseUrl = await start();
      breakTmpdir();
      const result = await post(baseUrl, api, api.request());
      expectHostFault(api, result, "mkdtemp");
    });

    it("keeps a 400 for an X-Cursor-Workspace outside the base", async () => {
      const baseUrl = await start({ chatOnlyWorkspace: false });
      const result = await post(baseUrl, api, api.request(), {
        "x-cursor-workspace": outside,
      });
      expect(result.status).toBe(400);
      expect(result.error).toMatchObject({
        type: "invalid_request_error",
        code: "invalid_workspace",
        message:
          "X-Cursor-Workspace must resolve to a directory under the configured workspace base",
      });
      expect(run).not.toHaveBeenCalled();
    });

    it("keeps a 400 for an X-Cursor-Workspace that does not exist", async () => {
      const baseUrl = await start({ chatOnlyWorkspace: false });
      const result = await post(baseUrl, api, api.request(), {
        "x-cursor-workspace": join(base, "missing"),
      });
      expect(result.status).toBe(400);
      expect(result.error).toMatchObject({
        type: "invalid_request_error",
        code: "invalid_workspace",
        message: "X-Cursor-Workspace must be an existing directory on the proxy host",
      });
      expect(run).not.toHaveBeenCalled();
    });

    it("answers a video the host cannot stage for ffmpeg with a safe 500", async () => {
      const baseUrl = await start({ useAcp: true });
      breakTmpdir();
      const result = await post(
        baseUrl,
        api,
        api.request(api.media("video", "video/mp4", base64("clip"))),
      );
      expectHostFault(api, result, "mkdtemp");
    });

    it("keeps a 422 for an image type it does not support", async () => {
      const baseUrl = await start({ useAcp: true });
      const result = await post(
        baseUrl,
        api,
        api.request(api.media("image", "image/bmp", base64("BM"))),
      );
      expect(result.status).toBe(422);
      expect(result.error).toMatchObject({
        type: "invalid_request_error",
        code: "unsupported_media",
        message: "unsupported image MIME type",
      });
    });
  });
});
