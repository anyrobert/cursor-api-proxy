/**
 * Every test file runs with a throwaway home, so no code under test and no
 * agent child it spawns can read or write the developer's real Cursor config,
 * proxy accounts or keychain link. fake-acp-server.mjs refuses to run with
 * the real home, and src/lib/test-sandbox.test.ts checks this setup.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterAll } from "vitest";

/** Variables that point the proxy or the Cursor CLI at a real config. */
const SANDBOXED_ENV = [
  "HOME",
  "USERPROFILE",
  "XDG_CONFIG_HOME",
  "CURSOR_CONFIG_DIR",
  "CURSOR_CONFIG_DIRS",
  "CURSOR_ACCOUNT_DIRS",
] as const;

const saved = new Map(SANDBOXED_ENV.map((key) => [key, process.env[key]]));
const home = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-proxy-test-home-"));
for (const key of SANDBOXED_ENV) delete process.env[key];
process.env.HOME = home;
process.env.USERPROFILE = home;

afterAll(() => {
  for (const [key, value] of saved) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(home, { recursive: true, force: true });
});
