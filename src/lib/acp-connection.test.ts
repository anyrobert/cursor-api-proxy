import { join } from "node:path";
import { format } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";

import { runAcpStream, runAcpSync } from "./acp-client.js";
import {
  AcpChildExitError,
  AcpConnection,
  type AcpConnectionOptions,
} from "./acp-connection.js";
import { AcpToolSession } from "./acp-tool-session.js";

const CLIENT_SAFE_EXIT =
  "The Cursor agent process exited with code 1 before responding. See server logs for details.";
const CLI_STDERR = "agent: unknown option '--bogus-flag'";
const CLI_STDOUT = "Error: Authentication required.";
const QUESTIONS_SKIPPED = {
  outcome: {
    outcome: "skipped",
    reason:
      "No interactive user is available to answer; proceed with your best judgement and state your assumptions.",
  },
};
const PLAN_ACCEPTED = { outcome: { outcome: "accepted" } };

const node = process.execPath;
const cwd = process.cwd();
const fakeServerPath = join(
  cwd,
  "src",
  "lib",
  "__tests__",
  "fake-acp-server.mjs",
);

const connections: AcpConnection[] = [];

function connect(
  scenario: string,
  overrides: Partial<AcpConnectionOptions> = {},
): AcpConnection {
  const connection = new AcpConnection(node, [fakeServerPath], {
    cwd,
    env: { FAKE_ACP_SCENARIO: scenario },
    requestTimeoutMs: 5_000,
    ...overrides,
  });
  connections.push(connection);
  return connection;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(connections.splice(0).map((connection) => connection.close()));
});

describe("AcpConnection", () => {
  it("answers cursor/* requests with the documented shapes", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    let text = "";
    const connection = connect("cursor_extensions", {
      onAgentTextChunk: (chunk) => {
        text += chunk;
      },
    });
    const sessionId = await connection.openSession({ cwd, skipAuthenticate: true });
    await connection.prompt(sessionId, "Plan it");
    expect(JSON.parse(text)).toStrictEqual({
      "cursor/ask_question": QUESTIONS_SKIPPED,
      "cursor/create_plan": PLAN_ACCEPTED,
    });
  });

  it("keeps the turn alive when an output listener throws", async () => {
    const connection = connect("", {
      onAgentTextChunk: () => {
        throw new Error("listener bug");
      },
    });
    const sessionId = await connection.openSession({ cwd, skipAuthenticate: true });
    await expect(connection.prompt(sessionId, "hi")).resolves.toEqual({});
  });
});

describe("cursor/* requests on both ACP paths (#93)", () => {
  type CursorRequest = { method: string; params: Record<string, unknown> };

  /** As CLI 2026.10.19 sends it (ask-question-handler.ts). */
  const DOCUMENTED_QUESTIONS: CursorRequest = {
    method: "cursor/ask_question",
    params: {
      toolCallId: "call_123",
      title: "Need input",
      questions: [
        {
          id: "db",
          prompt: "Which database?",
          options: [
            { id: "pg", label: "Postgres" },
            { id: "sqlite", label: "SQLite" },
          ],
          allowMultiple: false,
        },
        {
          id: "extras",
          prompt: "Which extras?",
          options: [
            { id: "auth", label: "Auth" },
            { id: "logs", label: "Logs" },
          ],
          allowMultiple: true,
        },
        { id: "notes", prompt: "Anything else?", options: [] },
      ],
    },
  };
  /** The undocumented form the plain path used to answer with `selectedId`. */
  const LEGACY_OPTIONS: CursorRequest = {
    method: "cursor/ask_question",
    params: {
      options: [
        { id: "a", label: "A" },
        { id: "b", label: "B" },
      ],
    },
  };
  /** As CLI 2026.10.19 sends it (create-plan-handler.ts). */
  const CREATE_PLAN: CursorRequest = {
    method: "cursor/create_plan",
    params: {
      toolCallId: "call_124",
      name: "Add caching",
      overview: "Cache hot reads",
      plan: "# Add caching\n\n1. Add a cache layer",
      todos: [{ id: "t1", content: "Add a cache layer", status: "pending" }],
      isProject: false,
      phases: [
        {
          name: "Build",
          todos: [{ id: "t1", content: "Add a cache layer", status: "pending" }],
        },
      ],
    },
  };
  /** Documented as a notification, but the CLI sends it as a request. */
  const UPDATE_TODOS: CursorRequest = {
    method: "cursor/update_todos",
    params: {
      toolCallId: "call_125",
      todos: [{ id: "t1", content: "Add a cache layer", status: "in_progress" }],
      merge: true,
    },
  };

  const CASES: Array<[string, CursorRequest, Record<string, unknown>]> = [
    [
      "the documented questions form by skipping it with a reason",
      DOCUMENTED_QUESTIONS,
      QUESTIONS_SKIPPED,
    ],
    [
      "the legacy options form by skipping it in the documented shape",
      LEGACY_OPTIONS,
      QUESTIONS_SKIPPED,
    ],
    ["cursor/create_plan by accepting the plan", CREATE_PLAN, PLAN_ACCEPTED],
    ["cursor/update_todos with an empty result", UPDATE_TODOS, {}],
  ];

  function cursorRequestsEnv(requests: CursorRequest[]) {
    return {
      FAKE_ACP_SCENARIO: "cursor_requests",
      FAKE_ACP_CURSOR_REQUESTS: JSON.stringify(requests),
    };
  }

  /** The replies the agent got, in order, on a one-shot turn. */
  async function plainReplies(requests: CursorRequest[]): Promise<unknown> {
    const result = await runAcpSync(node, [fakeServerPath], "Plan it", {
      cwd,
      timeoutMs: 5_000,
      skipAuthenticate: true,
      env: cursorRequestsEnv(requests),
    });
    expect(result.code).toBe(0);
    return JSON.parse(result.stdout);
  }

  /** The replies the agent got, in order, on a client-tool turn. */
  async function toolReplies(requests: CursorRequest[]): Promise<unknown> {
    const session = new AcpToolSession({
      command: node,
      args: [fakeServerPath],
      cwd,
      env: cursorRequestsEnv(requests),
      timeoutMs: 5_000,
      skipAuthenticate: true,
      tools: [{ name: "weather", inputSchema: { type: "object" } }],
    });
    try {
      await session.start("Plan it");
      const result = await session.collect();
      expect(result.status).toBe("completed");
      return JSON.parse(result.text);
    } finally {
      await session.close();
    }
  }

  describe.each([
    ["plain", plainReplies],
    ["tool", toolReplies],
  ])("on the %s path", (_path, repliesTo) => {
    it.each(CASES)("answers %s", async (_name, request, expected) => {
      vi.spyOn(console, "warn").mockImplementation(() => undefined);
      expect(await repliesTo([request])).toStrictEqual([expected]);
    });

    it("warns about skipped questions and unknown requests only", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      const unknown = { method: "cursor/not_yet_invented", params: {} };
      const replies = await repliesTo([
        DOCUMENTED_QUESTIONS,
        LEGACY_OPTIONS,
        CREATE_PLAN,
        UPDATE_TODOS,
        unknown,
      ]);
      expect(replies).toStrictEqual([
        QUESTIONS_SKIPPED,
        QUESTIONS_SKIPPED,
        PLAN_ACCEPTED,
        {},
        {},
      ]);
      expect(warn.mock.calls.map((args) => format(...args))).toStrictEqual([
        '[cursor-api-proxy:acp] cursor/ask_question skipped, no interactive user to answer: db "Which database?", extras "Which extras?", notes "Anything else?"',
        "[cursor-api-proxy:acp] cursor/ask_question skipped, no interactive user to answer: (no questions)",
        "[cursor-api-proxy:acp] auto-responding to unknown cursor/not_yet_invented with empty result",
      ]);
    });
  });
});

describe("one-shot ACP turns", () => {
  it("reports a turn that outlives timeoutMs with exit code 124", async () => {
    const result = await runAcpSync(node, [fakeServerPath], "hi", {
      cwd,
      timeoutMs: 300,
      skipAuthenticate: true,
      env: { FAKE_ACP_SCENARIO: "hang_prompt" },
    });
    expect(result.code).toBe(124);
    expect(result.error).toBeUndefined();
  });

  it("kills the child on abort and reports its exit", async () => {
    const controller = new AbortController();
    const pending = runAcpStream(
      node,
      [fakeServerPath],
      "hi",
      {
        cwd,
        timeoutMs: 5_000,
        skipAuthenticate: true,
        env: { FAKE_ACP_SCENARIO: "hang_prompt" },
        signal: controller.signal,
      },
      () => undefined,
    );
    setTimeout(() => controller.abort(), 200);
    const result = await pending;
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("before responding");
    expect(result.error).toBeUndefined();
  });

  it("rejects when the agent cannot be spawned", async () => {
    await expect(
      runAcpSync(join(cwd, "no-such-agent-binary"), [], "hi", {
        cwd,
        timeoutMs: 5_000,
      }),
    ).rejects.toThrow(/ENOENT/);
  });
});

describe("the CLI's end-of-turn RetriableError trailer (#76)", () => {
  const ANSWER = "The image shows a red square.";

  it("is not in a sync answer", async () => {
    const result = await runAcpSync(node, [fakeServerPath], "What is this?", {
      cwd,
      timeoutMs: 5_000,
      skipAuthenticate: true,
      env: { FAKE_ACP_SCENARIO: "retriable_trailer" },
    });
    expect(result.code).toBe(0);
    expect(result.stdout).toBe(ANSWER);
  });

  it("is not in a streamed answer", async () => {
    const chunks: string[] = [];
    const result = await runAcpStream(
      node,
      [fakeServerPath],
      "What is this?",
      {
        cwd,
        timeoutMs: 5_000,
        skipAuthenticate: true,
        env: { FAKE_ACP_SCENARIO: "retriable_trailer" },
      },
      (chunk) => chunks.push(chunk),
    );
    expect(result.code).toBe(0);
    expect(chunks.join("")).toBe(ANSWER);
  });

  it("releases held text before a tool call and drops the trailer at the end", async () => {
    const events: string[] = [];
    const connection = connect("retriable_trailer_after_tool_call", {
      onAgentTextChunk: (text) => events.push(`text:${text}`),
      onSessionUpdate: (update) => {
        if (update.sessionUpdate === "tool_call") events.push("tool_call");
      },
    });
    const sessionId = await connection.openSession({ cwd, skipAuthenticate: true });
    await connection.prompt(sessionId, "What is this?");
    expect(events).toEqual([
      "text:Let me look.",
      "text:\n\n",
      "tool_call",
      "text:It is a red square.",
    ]);
  });
});

describe("ACP child that exits before replying", () => {
  async function startFailure(
    overrides: Partial<AcpConnectionOptions> = {},
  ): Promise<AcpChildExitError> {
    const failure = await connect("start_failure", overrides)
      .initialize()
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    expect(failure).toBeInstanceOf(AcpChildExitError);
    return failure as AcpChildExitError;
  }

  it("rejects with a client-safe reason and logs the CLI output", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const exit = await startFailure();
    expect(exit.message).toBe(CLIENT_SAFE_EXIT);
    expect(exit.exitCode).toBe(1);
    expect(exit.diagnostics).toContain(CLI_STDERR);
    expect(exit.diagnostics).toContain(CLI_STDOUT);
    expect(exit.diagnostics).toContain("before responding");
    expect(logged).toHaveBeenCalledTimes(1);
    const line = String(logged.mock.calls[0]?.[0]);
    expect(line).toContain("exited with code 1");
    expect(line).toContain(CLI_STDERR);
    expect(line).toContain(CLI_STDOUT);
  });

  it("leaves logging to callers that opt out", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const exit = await startFailure({ logUnexpectedExit: false });
    expect(exit.diagnostics).toContain(CLI_STDERR);
    expect(logged).not.toHaveBeenCalled();
  });

  it("fails a tool turn with the client-safe reason only", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const session = new AcpToolSession({
      command: node,
      args: [fakeServerPath],
      cwd,
      env: { FAKE_ACP_SCENARIO: "start_failure" },
      timeoutMs: 5_000,
      skipAuthenticate: true,
      tools: [{ name: "weather", inputSchema: { type: "object" } }],
    });
    const failure = await session.start("Use weather").then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe(CLIENT_SAFE_EXIT);
    expect(session.closed).toBe(true);
  });

  it("keeps the plain path's server-side stderr and generic client error", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const result = await runAcpSync(node, [fakeServerPath], "hi", {
      cwd,
      timeoutMs: 5_000,
      env: { FAKE_ACP_SCENARIO: "start_failure" },
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(CLI_STDERR);
    expect(result.stderr).toContain(CLI_STDOUT);
    expect(result.error).toBeUndefined();
    expect(logged).not.toHaveBeenCalled();
  });
});
