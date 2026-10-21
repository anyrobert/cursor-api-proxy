import { afterEach, describe, expect, it } from "vitest";

import { buildAcpSpawnEnv } from "./acp-spawn.js";

const SECRET_KEY = "CURSOR_API_PROXY_TEST_SECRET";

afterEach(() => {
  delete process.env[SECRET_KEY];
});

describe("buildAcpSpawnEnv", () => {
  it("inherits only the allowlisted parent variables", () => {
    process.env[SECRET_KEY] = "do-not-leak";
    const env = buildAcpSpawnEnv();
    expect(env[SECRET_KEY]).toBeUndefined();
    expect(env.PATH).toBe(process.env.PATH);
  });

  it("layers request variables on top and skips undefined ones", () => {
    const env = buildAcpSpawnEnv({
      HOME: "/tmp/chat-only-home",
      CURSOR_CONFIG_DIR: "/tmp/account",
      UNSET_VALUE: undefined,
    });
    expect(env.HOME).toBe("/tmp/chat-only-home");
    expect(env.CURSOR_CONFIG_DIR).toBe("/tmp/account");
    expect("UNSET_VALUE" in env).toBe(false);
  });
});
