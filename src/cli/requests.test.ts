import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import type { SessionRequest } from "../lib/session-log.js";
import {
  formatRequests,
  handleRequests,
  readRecentRequests,
} from "./requests.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const requests: SessionRequest[] = [
  {
    ts: "2026-07-13T12:00:00.000Z",
    method: "POST",
    pathname: "/v1/chat/completions/with/a/very/long/path",
    remoteAddress: "127.0.0.1",
    status: 200,
  },
  {
    ts: "2026-07-13T12:00:01.000Z",
    method: "POST",
    pathname: "/v1/messages",
    remoteAddress: "::1",
    status: 429,
  },
  {
    ts: "2026-07-13T12:00:02.000Z",
    method: "GET",
    pathname: "/health",
    remoteAddress: "::1",
    status: 500,
  },
];

describe("requests command", () => {
  it("renders a plain, width-aware table", () => {
    const rendered = formatRequests(requests, {
      logPath: "/tmp/sessions.log",
      width: 60,
      color: false,
    });

    expect(rendered).toContain("WHEN");
    expect(rendered).toContain("FROM");
    expect(rendered).toContain("127.0.0.1");
    expect(rendered).toContain("/v1/chat/completions/wit…");
    for (const line of rendered.split("\n")) {
      expect(line.length).toBeLessThanOrEqual(60);
    }
  });

  it("colors status classes and includes remote addresses on wide terminals", () => {
    const rendered = formatRequests(requests, {
      logPath: "/tmp/sessions.log",
      width: 100,
      color: true,
    });

    expect(rendered).toContain("FROM");
    expect(rendered).toContain("127.0.0.1");
    expect(rendered).toContain("\x1b[32m200");
    expect(rendered).toContain("\x1b[33m429");
    expect(rendered).toContain("\x1b[31m500");
  });

  it("reads newest normal request lines and skips error records", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "requests-cli-"));
    tempDirs.push(dir);
    const logPath = path.join(dir, "sessions.log");
    fs.writeFileSync(
      logPath,
      [
        "2026-07-13T12:00:00.000Z GET /first ::1 200",
        "2026-07-13T12:00:01.000Z ERROR GET /first ::1 agent_exit_1 failed",
        "2026-07-13T12:00:02.000Z POST /second ::1 500",
      ].join("\n"),
      "utf8",
    );

    const result = await readRecentRequests(logPath, 1);
    expect(result).toHaveLength(1);
    expect(result[0].pathname).toBe("/second");
  });

  it("prints an empty state for a missing log", async () => {
    let output = "";
    await handleRequests({
      logPath: "/path/that/does/not/exist/sessions.log",
      limit: 20,
      watch: false,
      intervalMs: 2000,
      output: {
        isTTY: false,
        columns: 80,
        write(chunk) {
          output += chunk;
        },
      },
      env: {},
    });

    expect(output).toContain("Latest requests (0)");
    expect(output).toContain("No requests found.");
    expect(output).not.toContain("\x1b[");
  });

  it("refreshes in watch mode until aborted", async () => {
    let output = "";
    const controller = new AbortController();
    const running = handleRequests({
      logPath: "/path/that/does/not/exist/sessions.log",
      limit: 20,
      watch: true,
      intervalMs: 5,
      signal: controller.signal,
      output: {
        isTTY: false,
        columns: 80,
        write(chunk) {
          output += chunk;
        },
      },
      env: {},
    });

    await new Promise((resolve) => setTimeout(resolve, 25));
    controller.abort();
    await running;

    expect(output.match(/Latest requests \(0\)/g)?.length).toBeGreaterThan(1);
  });
});
