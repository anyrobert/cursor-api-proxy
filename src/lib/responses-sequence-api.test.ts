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
import { startBridgeServer } from "./server.js";

// Issue #94: every /v1/responses streaming event carries `sequence_number`,
// 0 for the first event of a response and one more for each event after it.
// Issue #103: `output_text` events and content parts carry the fields the
// OpenAI types require, `logprobs` and `annotations`, as empty lists.

vi.mock("./cursor-cli.js", () => ({
  listCursorCliModels: vi.fn().mockResolvedValue([{ id: "gpt-4", name: "gpt-4" }]),
}));

const fixtures = join(process.cwd(), "src", "lib", "__tests__");
const fakeAcpServer = join(fixtures, "fake-acp-server.mjs");
const fakeCliAgent = join(fixtures, "fake-cli-agent.mjs");

let workDir: string;
let agentBin: string;
const servers: http.Server[] = [];

beforeAll(() => {
  workDir = fs.mkdtempSync(join(tmpdir(), "responses-sequence-"));
  agentBin = join(workDir, "agent");
  fs.writeFileSync(
    agentBin,
    `#!/bin/sh\nexec "${process.execPath}" "${fakeCliAgent}" "$@"\n`,
    { mode: 0o755 },
  );
});

afterAll(() => {
  fs.rmSync(workDir, { recursive: true, force: true });
});

beforeEach(() => {
  // The server banner, request lines and failed turns go to the console.
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
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
    agentBin,
    acpCommand: process.execPath,
    acpArgs: [fakeAcpServer],
    acpEnv: {},
    host: "127.0.0.1",
    port: 0,
    defaultModel: "gpt-4",
    mode: "ask",
    force: false,
    approveMcps: false,
    strictModel: true,
    workspace: process.cwd(),
    timeoutMs: 10_000,
    sessionsLogPath: join(workDir, "sessions.log"),
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

/** Starts the proxy on the fake ACP agent playing `scenario`. */
function startAcp(scenario = ""): Promise<string> {
  return start({ useAcp: true, acpEnv: { FAKE_ACP_SCENARIO: scenario } });
}

async function streamResponse(
  base: string,
  body: Record<string, unknown>,
): Promise<string> {
  const response = await fetch(`${base}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "gpt-4", ...body, stream: true }),
  });
  expect(response.status).toBe(200);
  return response.text();
}

/** The SSE blocks of a stream, keepalive comments dropped. */
function sseBlocks(text: string): Array<{ event?: string; data: string }> {
  return text
    .split(/\r?\n\r?\n/)
    .map((block) => block.split(/\r?\n/).filter((line) => !line.startsWith(":")))
    .filter((lines) => lines.some((line) => line.startsWith("data: ")))
    .map((lines) => ({
      event: lines.find((line) => line.startsWith("event: "))?.slice(7),
      data: lines
        .filter((line) => line.startsWith("data: "))
        .map((line) => line.slice(6))
        .join("\n"),
    }));
}

/**
 * The events of one streamed response, after asserting each is named by its
 * `type` and that they are numbered 0, 1, 2, ... in order, with no gap or
 * repeat. A `[DONE]` line is not an event; when present it comes last.
 */
function sequencedEvents(text: string): any[] {
  const blocks = sseBlocks(text);
  const done = blocks.findIndex((block) => block.data === "[DONE]");
  if (done !== -1) expect(done).toBe(blocks.length - 1);
  const events = blocks
    .filter((block) => block.data !== "[DONE]")
    .map((block) => {
      const event = JSON.parse(block.data);
      expect(block.event).toBe(event.type);
      return event;
    });
  expect(events.length).toBeGreaterThan(0);
  expect(events.map((event) => event.sequence_number)).toEqual(
    events.map((_, index) => index),
  );
  return events;
}

function types(events: any[]): string[] {
  return events.map((event) => event.type);
}

/** The response a successful stream ends with. */
function completedResponse(events: any[]): any {
  const last = events[events.length - 1];
  expect(last.type).toBe("response.completed");
  return last.response;
}

const TEXT_STREAM = [
  "response.created",
  "response.output_item.added",
  "response.content_part.added",
  "response.output_text.delta",
  "response.output_text.done",
  "response.content_part.done",
  "response.output_item.done",
  "response.completed",
];

const weatherTool = {
  type: "function",
  name: "weather",
  parameters: { type: "object", properties: { city: { type: "string" } } },
};

/** A freeform tool shaped like Codex CLI's `apply_patch`. */
const applyPatchTool = {
  type: "custom",
  name: "apply_patch",
  description: "Edit files with a patch.",
  format: { type: "grammar", syntax: "lark", definition: "start: /.+/" },
};

const TOOL_STREAMS = [
  {
    label: "a function call",
    scenario: "tool_call",
    request: { tools: [weatherTool] },
    calls: 1,
    callEvents: "response.function_call_arguments",
  },
  {
    label: "parallel function calls",
    scenario: "tool_parallel",
    request: { tools: [weatherTool, { ...weatherTool, name: "time" }] },
    calls: 2,
    callEvents: "response.function_call_arguments",
  },
  {
    label: "a custom tool call",
    scenario: "tool_call",
    request: {
      tools: [applyPatchTool],
      tool_choice: { type: "custom", name: "apply_patch" },
    },
    calls: 1,
    callEvents: "response.custom_tool_call_input",
  },
];

describe("Responses stream sequence numbers (#94)", () => {
  describe("CLI agent", () => {
    it("numbers a text stream from response.created to response.completed", async () => {
      const text = await streamResponse(await start(), { input: "Hi" });
      // The fake CLI answers in two deltas.
      expect(types(sequencedEvents(text))).toEqual([
        ...TEXT_STREAM.slice(0, 4),
        "response.output_text.delta",
        ...TEXT_STREAM.slice(4),
      ]);
      expect(text.trimEnd().endsWith("data: [DONE]")).toBe(true);
    });

    it("continues the count into response.failed after partial text", async () => {
      vi.stubEnv("FAKE_CLI_SCENARIO", "exit_after_text");
      const text = await streamResponse(await start(), { input: "Hi" });
      expect(types(sequencedEvents(text))).toEqual([
        ...TEXT_STREAM.slice(0, 4),
        "response.failed",
      ]);
      expect(text).not.toContain("[DONE]");
    });

    it("numbers a plan-limit failure", async () => {
      vi.stubEnv("FAKE_CLI_SCENARIO", "plan_limit");
      const text = await streamResponse(await start(), { input: "Hi" });
      expect(types(sequencedEvents(text))).toEqual([
        "response.created",
        "response.failed",
      ]);
    });
  });

  describe("ACP agent", () => {
    it("numbers each of two concurrent text streams from 0", async () => {
      const base = await startAcp();
      const streams = await Promise.all([
        streamResponse(base, { input: "Hi" }),
        streamResponse(base, { input: "Hello" }),
      ]);
      for (const text of streams) {
        expect(types(sequencedEvents(text))).toEqual(TEXT_STREAM);
      }
    });

    it.each(TOOL_STREAMS)(
      "numbers a stream that ends in $label",
      async ({ scenario, request, calls, callEvents }) => {
        const base = await startAcp(scenario);
        const text = await streamResponse(base, {
          input: "Use the tools",
          ...request,
        });
        const events = sequencedEvents(text);
        // The agent's text comes first; then each call is announced,
        // streamed and closed in four events, and the response completes.
        expect(events[0].type).toBe("response.created");
        expect(types(events).slice(-1 - 4 * calls)).toEqual([
          ...Array.from({ length: calls }, () => [
            "response.output_item.added",
            `${callEvents}.delta`,
            `${callEvents}.done`,
            "response.output_item.done",
          ]).flat(),
          "response.completed",
        ]);
        expect(
          completedResponse(events).output.filter(
            (item: any) => item.type !== "message",
          ),
        ).toHaveLength(calls);
        expect(text.trimEnd().endsWith("data: [DONE]")).toBe(true);
      },
    );

    it("numbers a streamed previous_response_id resume from 0", async () => {
      const base = await startAcp("tool_call");
      const first = completedResponse(
        sequencedEvents(
          await streamResponse(base, { input: "Weather?", tools: [weatherTool] }),
        ),
      );
      const [call] = first.output.filter(
        (item: any) => item.type === "function_call",
      );

      const resumed = sequencedEvents(
        await streamResponse(base, {
          previous_response_id: first.id,
          input: [
            { type: "function_call_output", call_id: call.call_id, output: "sunny" },
          ],
        }),
      );
      expect(resumed[0].type).toBe("response.created");
      expect(completedResponse(resumed).output_text).toContain(
        "Tool result: sunny",
      );
    });

    it("numbers a streamed transcript resume, matched by call_id, from 0", async () => {
      const base = await startAcp("tool_call");
      const question = {
        role: "user",
        content: [{ type: "input_text", text: "Weather?" }],
      };
      const turn = (input: unknown[]) => ({
        input,
        tools: [weatherTool],
        store: false,
      });
      const first = completedResponse(
        sequencedEvents(await streamResponse(base, turn([question]))),
      );
      const [call] = first.output.filter(
        (item: any) => item.type === "function_call",
      );

      const resumed = sequencedEvents(
        await streamResponse(
          base,
          turn([
            question,
            {
              type: "function_call",
              id: call.id,
              call_id: call.call_id,
              name: call.name,
              arguments: call.arguments,
            },
            { type: "function_call_output", call_id: call.call_id, output: "sunny" },
          ]),
        ),
      );
      expect(resumed[0].type).toBe("response.created");
      expect(completedResponse(resumed).output_text).toContain(
        "Tool result: sunny",
      );
    });

    it.each([
      ["tool", { input: "Weather?", tools: [weatherTool] }],
      ["plain", { input: "Hi" }],
    ])(
      "continues the count into response.failed when a %s turn's agent exits",
      async (_kind, request) => {
        const base = await startAcp("process_exit");
        const text = await streamResponse(base, request);
        expect(types(sequencedEvents(text))).toEqual([
          "response.created",
          "response.failed",
        ]);
        expect(text).not.toContain("[DONE]");
      },
    );
  });
});

/** An `output_text` content part with no citations or log probabilities. */
const outputTextPart = (text: unknown = expect.any(String)) => ({
  type: "output_text",
  text,
  annotations: [],
  logprobs: [],
});

/** The output_text parts of a response's message items. */
function messageParts(response: any): any[] {
  return response.output
    .filter((item: any) => item.type === "message")
    .flatMap((item: any) => item.content);
}

/**
 * Asserts the output_text fields of a text stream: `logprobs` on every
 * delta and done event, and both lists on every output_text part the
 * stream announces, closes or completes with.
 */
function expectOutputTextFields(events: any[]): void {
  const deltas = events.filter((e) => e.type === "response.output_text.delta");
  const done = events.filter((e) => e.type === "response.output_text.done");
  expect(deltas.length).toBeGreaterThan(0);
  expect(done).toHaveLength(1);
  for (const event of [...deltas, ...done]) {
    expect(event.logprobs).toEqual([]);
  }
  const { text } = done[0];
  expect(text).not.toBe("");

  const partEvents = events.filter((e) => e.type.startsWith("response.content_part."));
  expect(partEvents.map((event) => event.part)).toEqual([
    outputTextPart(""),
    outputTextPart(text),
  ]);
  const itemDone = events.find(
    (e) => e.type === "response.output_item.done" && e.item.type === "message",
  );
  expect(itemDone.item.content).toEqual([outputTextPart(text)]);
  expect(messageParts(completedResponse(events))).toEqual([outputTextPart(text)]);
}

describe("Responses output_text fields (#103)", () => {
  it("fills them on a CLI agent's text stream", async () => {
    const text = await streamResponse(await start(), { input: "Hi" });
    expectOutputTextFields(sequencedEvents(text));
  });

  it("fills them on an ACP agent's text stream", async () => {
    const text = await streamResponse(await startAcp(), { input: "Hi" });
    expectOutputTextFields(sequencedEvents(text));
  });

  it("fills them on an ACP tool turn's text before its call", async () => {
    const base = await startAcp("tool_call");
    const text = await streamResponse(base, {
      input: "Use the tools",
      tools: [weatherTool],
    });
    expectOutputTextFields(sequencedEvents(text));
  });

  it.each<[string, Partial<BridgeConfig>, Record<string, unknown>]>([
    ["a CLI agent's", {}, {}],
    ["an ACP agent's", { useAcp: true }, {}],
    [
      "an ACP tool turn's",
      { useAcp: true, acpEnv: { FAKE_ACP_SCENARIO: "tool_call" } },
      { tools: [weatherTool] },
    ],
  ])(
    "fills them on %s non-streamed response",
    async (_kind, overrides, request) => {
      const base = await start(overrides);
      const response = await fetch(`${base}/v1/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "gpt-4", input: "Hi", ...request }),
      });
      expect(response.status).toBe(200);
      const body: any = await response.json();
      expect(messageParts(body)).toEqual([outputTextPart(body.output_text)]);
      expect(body.output_text).not.toBe("");
    },
  );
});
