import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { describe, expect, it } from "vitest";

import { cursorConfigDir } from "./acp-config-dir.js";
import { buildAcpSpawnEnv } from "./acp-spawn.js";

const fakeServerPath = path.join(
  process.cwd(),
  "src",
  "lib",
  "__tests__",
  "fake-acp-server.mjs",
);

const realHome = fs.realpathSync(os.userInfo().homedir);

function insideRealHome(dir: string): boolean {
  const real = fs.existsSync(dir) ? fs.realpathSync(dir) : path.resolve(dir);
  return real === realHome || real.startsWith(`${realHome}${path.sep}`);
}

/** Start the fake agent with `env` only, answer one initialize, then end. */
function startFake(env: NodeJS.ProcessEnv) {
  return spawnSync(process.execPath, [fakeServerPath], {
    env: { PATH: process.env.PATH, ...env },
    input: `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })}\n`,
    encoding: "utf8",
    timeout: 10_000,
  });
}

describe("test sandbox (vitest.setup.ts)", () => {
  it("runs every test file with a throwaway home and no Cursor config overrides", () => {
    expect(insideRealHome(os.homedir())).toBe(false);
    expect(fs.realpathSync(os.homedir()).startsWith(fs.realpathSync(os.tmpdir()))).toBe(true);
    for (const key of ["CURSOR_CONFIG_DIR", "XDG_CONFIG_HOME", "CURSOR_CONFIG_DIRS", "CURSOR_ACCOUNT_DIRS"]) {
      expect(process.env[key]).toBeUndefined();
    }
  });

  it("makes an ACP run without pool or chat-only copy its config from the sandbox", () => {
    const source = cursorConfigDir(buildAcpSpawnEnv());
    expect(source).toBe(path.join(os.homedir(), ".cursor"));
    expect(insideRealHome(source)).toBe(false);
  });

  it("makes the fake agent refuse a real home or a config dir inside it", () => {
    const sandbox = os.homedir();
    const refusals = [
      { HOME: realHome, USERPROFILE: realHome },
      { HOME: sandbox, USERPROFILE: sandbox, CURSOR_CONFIG_DIR: path.join(realHome, ".cursor") },
      { HOME: sandbox, USERPROFILE: sandbox, XDG_CONFIG_HOME: path.join(realHome, ".config") },
    ];
    for (const env of refusals) {
      const run = startFake(env);
      expect(run.status).toBe(70);
      expect(run.stderr).toContain("__FAKE_ACP_REAL_HOME__");
      expect(run.stdout).toBe("");
    }
    const allowed = startFake({ HOME: sandbox, USERPROFILE: sandbox });
    expect(allowed.status).toBe(0);
    expect(allowed.stdout).toContain('"protocolVersion"');
  });
});
