import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { logAgentError } from "./request-log.js";

describe("logAgentError", () => {
  const dir = mkdtempSync(join(tmpdir(), "request-log-test-"));
  const logPath = join(dir, "sessions.log");

  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterAll(() => {
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  it("keeps raw CLI stderr out of the client message", () => {
    const message = logAgentError(
      logPath,
      "POST",
      "/v1/chat/completions",
      "127.0.0.1",
      1,
      "token=secret-from-cli",
    );
    expect(message).toBe(
      "The Cursor agent process exited with code 1. See server logs for details.",
    );
    expect(readFileSync(logPath, "utf8")).toContain("token=secret-from-cli");
  });

  it("returns the proxy's failure reason when there is one", () => {
    const reason = 'ACP model catalog has no match for "x"';
    expect(
      logAgentError(logPath, "POST", "/v1/messages", "127.0.0.1", 1, "raw", reason),
    ).toBe(reason);
  });
});
