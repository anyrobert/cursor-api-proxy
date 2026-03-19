import { describe, it, expect, vi } from "vitest";
import { run, runStreaming } from "./process.js";

const node = process.execPath;

describe("run", () => {
  it("returns stdout and stderr", async () => {
    const result = await run(node, [
      "-e",
      "console.log('hello'); console.error('world')",
    ]);
    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe("hello");
    expect(result.stderr.trim()).toBe("world");
  });

  it("uses spawnChild on all platforms (non-Windows uses normal spawn path)", async () => {
    const result = await run(node, ["-e", "process.stdout.write('ok')"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("ok");
  });

  it("passes stdinContent to child stdin", async () => {
    const result = await run(node, ["-e", "process.stdin.on('data', d => process.stdout.write(d))"], {
      stdinContent: "hello from stdin",
    });
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("hello from stdin");
  });
});

describe("runStreaming", () => {
  it("calls onLine for each line of stdout", async () => {
    const onLine = vi.fn();
    const result = await runStreaming(
      node,
      ["-e", "console.log('a'); console.log('b'); console.log('c')"],
      {
        onLine,
      },
    );
    expect(result.code).toBe(0);
    expect(onLine).toHaveBeenCalledTimes(3);
    expect(onLine).toHaveBeenNthCalledWith(1, "a");
    expect(onLine).toHaveBeenNthCalledWith(2, "b");
    expect(onLine).toHaveBeenNthCalledWith(3, "c");
  });

  it("passes lines to parser (createStreamParser-compatible shape)", async () => {
    const lines: string[] = [];
    const onLine = (line: string) => lines.push(line);
    await runStreaming(node, [
      "-e",
      `console.log('{"type":"assistant","message":{"content":[{"type":"text","text":"hi"}]}}');
       console.log('{"type":"result","subtype":"success"}');`,
    ], { onLine });
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]).type).toBe("assistant");
    expect(JSON.parse(lines[1]).type).toBe("result");
  });

  it("flushes the final buffered line even without a trailing newline", async () => {
    const onLine = vi.fn();

    const result = await runStreaming(node, ["-e", "process.stdout.write('tail')"], {
      onLine,
    });

    expect(result.code).toBe(0);
    expect(onLine).toHaveBeenCalledTimes(1);
    expect(onLine).toHaveBeenCalledWith("tail");
  });
});
