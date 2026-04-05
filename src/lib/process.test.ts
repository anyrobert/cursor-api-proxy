import { describe, it, expect, vi } from "vitest";
import { run, runStreaming, killAllChildProcesses } from "./process.js";

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
    const result = await run(
      node,
      ["-e", "process.stdin.on('data', d => process.stdout.write(d))"],
      {
        stdinContent: "hello from stdin",
      },
    );
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("hello from stdin");
  });

  it("propagates configDir as CURSOR_CONFIG_DIR env var to child process", async () => {
    const result = await run(
      node,
      ["-e", "process.stdout.write(process.env.CURSOR_CONFIG_DIR || 'unset')"],
      { configDir: "/test/account/dir" },
    );
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("/test/account/dir");
  });

  it("does not set CURSOR_CONFIG_DIR when configDir is omitted", async () => {
    const result = await run(node, [
      "-e",
      "process.stdout.write(process.env.CURSOR_CONFIG_DIR || 'unset')",
    ]);
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("unset");
  });

  it("returns non-zero exit code when child exits with error", async () => {
    const result = await run(node, ["-e", "process.exit(42)"]);
    expect(result.code).toBe(42);
  });

  it("kills child and resolves after timeout", async () => {
    const start = Date.now();
    const result = await run(node, ["-e", "setTimeout(() => {}, 30000)"], {
      timeoutMs: 300,
    });
    const elapsed = Date.now() - start;
    expect(result.code).not.toBe(0);
    expect(elapsed).toBeLessThan(2000);
  }, 5000);
});

describe("runStreaming", () => {
  it("calls onLine for each line of stdout", async () => {
    const onLine = vi.fn();
    const result = await runStreaming(
      node,
      ["-e", "console.log('a'); console.log('b'); console.log('c')"],
      { onLine },
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
    await runStreaming(
      node,
      [
        "-e",
        `console.log('{"type":"assistant","message":{"content":[{"type":"text","text":"hi"}]}}');
       console.log('{"type":"result","subtype":"success"}');`,
      ],
      { onLine },
    );
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]).type).toBe("assistant");
    expect(JSON.parse(lines[1]).type).toBe("result");
  });

  it("flushes the final buffered line even without a trailing newline", async () => {
    const onLine = vi.fn();
    const result = await runStreaming(
      node,
      ["-e", "process.stdout.write('tail')"],
      {
        onLine,
      },
    );
    expect(result.code).toBe(0);
    expect(onLine).toHaveBeenCalledTimes(1);
    expect(onLine).toHaveBeenCalledWith("tail");
  });

  it("propagates configDir as CURSOR_CONFIG_DIR env var to child process", async () => {
    const lines: string[] = [];
    await runStreaming(
      node,
      ["-e", "console.log(process.env.CURSOR_CONFIG_DIR || 'unset')"],
      { onLine: (l) => lines.push(l), configDir: "/my/config/dir" },
    );
    expect(lines).toHaveLength(1);
    expect(lines[0]).toBe("/my/config/dir");
  });

  it("does not set CURSOR_CONFIG_DIR when configDir is omitted", async () => {
    const lines: string[] = [];
    await runStreaming(
      node,
      ["-e", "console.log(process.env.CURSOR_CONFIG_DIR || 'unset')"],
      { onLine: (l) => lines.push(l) },
    );
    expect(lines[0]).toBe("unset");
  });

  it("collects stderr output", async () => {
    const result = await runStreaming(
      node,
      ["-e", "console.error('err-output')"],
      { onLine: () => {} },
    );
    expect(result.stderr.trim()).toBe("err-output");
  });

  it("kills child and resolves after timeout", async () => {
    const start = Date.now();
    const result = await runStreaming(
      node,
      ["-e", "setTimeout(() => {}, 30000)"],
      { onLine: () => {}, timeoutMs: 300 },
    );
    const elapsed = Date.now() - start;
    expect(result.code).not.toBe(0);
    expect(elapsed).toBeLessThan(2000);
  }, 5000);

  it("handles multiple concurrent streams independently", async () => {
    const lines1: string[] = [];
    const lines2: string[] = [];
    await Promise.all([
      runStreaming(node, ["-e", "console.log('stream1')"], {
        onLine: (l) => lines1.push(l),
      }),
      runStreaming(node, ["-e", "console.log('stream2')"], {
        onLine: (l) => lines2.push(l),
      }),
    ]);
    expect(lines1).toEqual(["stream1"]);
    expect(lines2).toEqual(["stream2"]);
  });

  it("aborts the child process when AbortSignal is triggered", async () => {
    const controller = new AbortController();
    const start = Date.now();
    const resultPromise = runStreaming(
      node,
      ["-e", "setTimeout(() => {}, 30000)"],
      { onLine: () => {}, signal: controller.signal },
    );
    setTimeout(() => controller.abort(), 100);
    const result = await resultPromise;
    const elapsed = Date.now() - start;
    expect(result.code).not.toBe(0);
    expect(elapsed).toBeLessThan(2000);
  }, 5000);
});

describe("run AbortSignal", () => {
  it("aborts the child process when AbortSignal is triggered", async () => {
    const controller = new AbortController();
    const start = Date.now();
    const resultPromise = run(node, ["-e", "setTimeout(() => {}, 30000)"], {
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 100);
    const result = await resultPromise;
    const elapsed = Date.now() - start;
    expect(result.code).not.toBe(0);
    expect(elapsed).toBeLessThan(2000);
  }, 5000);

  it("kills immediately when signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const start = Date.now();
    const result = await run(node, ["-e", "setTimeout(() => {}, 30000)"], {
      signal: controller.signal,
    });
    const elapsed = Date.now() - start;
    expect(result.code).not.toBe(0);
    expect(elapsed).toBeLessThan(2000);
  }, 5000);
});

describe("killAllChildProcesses", () => {
  it("kills in-flight processes and subsequent calls are safe no-ops", async () => {
    const resultPromise = run(node, ["-e", "setTimeout(() => {}, 30000)"]);
    await new Promise((r) => setTimeout(r, 50));
    killAllChildProcesses();
    const result = await resultPromise;
    expect(result.code).not.toBe(0);
    expect(() => killAllChildProcesses()).not.toThrow();
  }, 5000);
});
