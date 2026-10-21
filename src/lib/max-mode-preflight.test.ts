import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { enableMaxMode } from "./max-mode-preflight.js";

const created: string[] = [];

afterEach(() => {
  for (const dir of created.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function configDir(cliConfig?: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "max-mode-"));
  created.push(dir);
  if (cliConfig !== undefined) {
    fs.writeFileSync(path.join(dir, "cli-config.json"), cliConfig);
  }
  return dir;
}

function readConfig(dir: string): unknown {
  return JSON.parse(fs.readFileSync(path.join(dir, "cli-config.json"), "utf8"));
}

describe("enableMaxMode", () => {
  it("sets maxMode at the top and on the saved model, keeping the rest", () => {
    const dir = configDir(
      `﻿${JSON.stringify({ version: 1, model: { modelId: "gpt-4" }, editor: {} })}`,
    );
    enableMaxMode(dir);
    expect(readConfig(dir)).toEqual({
      version: 1,
      model: { modelId: "gpt-4", maxMode: true },
      editor: {},
      maxMode: true,
    });
  });

  it("writes only the given config dir", () => {
    const target = configDir(JSON.stringify({ version: 1, editor: {} }));
    const other = configDir(JSON.stringify({ version: 1, editor: {} }));
    enableMaxMode(target);
    expect(readConfig(target)).toMatchObject({ maxMode: true });
    expect(readConfig(other)).toEqual({ version: 1, editor: {} });
  });

  it("leaves a missing, stub or unreadable config alone", () => {
    const missing = configDir();
    enableMaxMode(missing);
    expect(fs.readdirSync(missing)).toEqual([]);

    for (const content of ['{"version":1}', "not json", "[1,2]"]) {
      const dir = configDir(content);
      enableMaxMode(dir);
      expect(fs.readFileSync(path.join(dir, "cli-config.json"), "utf8")).toBe(content);
    }
  });
});
