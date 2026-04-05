import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runAcpStream, runAcpSync } from "./acp-client.js";

const node = process.execPath;
const cwd = process.cwd();
const fakeServerPath = join(cwd, "src", "lib", "__tests__", "fake-acp-server.mjs");

describe("runAcpSync", () => {
  it("returns stdout content from session/update agent_message_chunk", async () => {
    const resultPromise = runAcpSync(node, [fakeServerPath], "test prompt", {
      cwd,
      timeoutMs: 5000,
      skipAuthenticate: true,
    });
    const result = await resultPromise;
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Hello from fake ACP");
  });

  it("skips authenticate when skipAuthenticate is true", async () => {
    const resultPromise = runAcpSync(node, [fakeServerPath], "test", {
      cwd,
      timeoutMs: 5000,
      skipAuthenticate: true,
    });
    const result = await resultPromise;
    expect(result.code).toBe(0);
    expect(result.stdout).toBeTruthy();
  });

  it("sends authenticate when skipAuthenticate is false", async () => {
    const resultPromise = runAcpSync(node, [fakeServerPath], "test", {
      cwd,
      timeoutMs: 5000,
      skipAuthenticate: false,
    });
    const result = await resultPromise;
    expect(result.code).toBe(0);
    expect(result.stdout).toBeTruthy();
  });

  it("applies session/set_config_option when model is set", async () => {
    const result = await runAcpSync(node, [fakeServerPath], "hi", {
      cwd,
      timeoutMs: 5000,
      skipAuthenticate: true,
      model: "gpt-4",
    });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Hello from fake ACP");
  });
});

describe("runAcpStream", () => {
  it("streams chunks from session/update", async () => {
    const chunks: string[] = [];
    const result = await runAcpStream(
      node,
      [fakeServerPath],
      "stream test",
      {
        cwd,
        timeoutMs: 5000,
        skipAuthenticate: true,
      },
      (t) => chunks.push(t),
    );
    expect(result.code).toBe(0);
    expect(chunks.join("")).toContain("Hello from fake ACP");
  });
});
