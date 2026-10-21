import { join } from "node:path";
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
  it("answers cursor/* requests with the documented shapes by default", async () => {
    let text = "";
    const connection = connect("cursor_extensions", {
      onAgentTextChunk: (chunk) => {
        text += chunk;
      },
    });
    const sessionId = await connection.openSession({ cwd, skipAuthenticate: true });
    await connection.prompt(sessionId, "Plan it");
    expect(JSON.parse(text)).toEqual({
      "cursor/ask_question": {
        outcome: {
          outcome: "answered",
          answers: [{ questionId: "q1", selectedOptionIds: ["a"] }],
        },
      },
      "cursor/create_plan": { outcome: { outcome: "accepted" } },
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

describe("one-shot ACP turns", () => {
  it("keeps the cursor/* answers the plain path has always sent", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const result = await runAcpSync(node, [fakeServerPath], "Plan it", {
      cwd,
      timeoutMs: 5_000,
      skipAuthenticate: true,
      env: { FAKE_ACP_SCENARIO: "cursor_extensions" },
    });
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      "cursor/ask_question": {},
      "cursor/create_plan": { approved: true },
    });
  });

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
