import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { runAcpStream, runAcpSync } from "./acp-client.js";
import {
  AcpConnection,
  type AcpConnectionOptions,
} from "./acp-connection.js";

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
