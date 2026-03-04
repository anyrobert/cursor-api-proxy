import { describe, it, expect } from "vitest";

// We need to test parseArgs - it's not exported. We can either:
// 1. Export it from cli.ts
// 2. Test via the module

// For now, let's test the behavior by extracting the logic.
// Actually the cleanest approach is to export parseArgs from cli.ts for testability.
// Let me check the cli again - parseArgs is a local function. I'll add an export for it
// so we can test it, or we could move it to a separate module. The simplest is to export it.

// I'll need to add an export to cli.ts. Let me do that.
import { parseArgs } from "./cli.js";

describe("parseArgs", () => {
  it("parses empty argv", () => {
    expect(parseArgs([])).toEqual({ tailscale: false, help: false });
  });

  it("parses --tailscale", () => {
    expect(parseArgs(["--tailscale"])).toEqual({ tailscale: true, help: false });
  });

  it("parses --help", () => {
    expect(parseArgs(["--help"])).toEqual({ tailscale: false, help: true });
  });

  it("parses -h", () => {
    expect(parseArgs(["-h"])).toEqual({ tailscale: false, help: true });
  });

  it("parses combined flags", () => {
    expect(parseArgs(["--tailscale", "--help"])).toEqual({ tailscale: true, help: true });
  });

  it("throws on unknown argument", () => {
    expect(() => parseArgs(["--unknown"])).toThrow("Unknown argument: --unknown");
  });

  it("throws on positional argument", () => {
    expect(() => parseArgs(["foo"])).toThrow("Unknown argument: foo");
  });
});
