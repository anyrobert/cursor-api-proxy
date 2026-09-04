import { afterEach, describe, expect, it, vi } from "vitest";

import { killProcessTree } from "./process-tree-kill.js";

type FakeChild = {
  pid?: number | undefined;
  kill: (signal?: NodeJS.Signals) => boolean;
};

function fakeChild(pid: number | undefined): FakeChild {
  return { pid, kill: vi.fn(() => true) };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("killProcessTree", () => {
  it("signals the whole process group so grandchildren die with the agent", () => {
    const groupKill = vi.spyOn(process, "kill").mockReturnValue(true);
    const child = fakeChild(4321);

    killProcessTree(child as never, "SIGTERM", { detached: true });

    expect(groupKill).toHaveBeenCalledWith(-4321, "SIGTERM");
    expect(child.kill).not.toHaveBeenCalled();
  });

  it("falls back to the direct child when the group is already gone", () => {
    vi.spyOn(process, "kill").mockImplementation(() => {
      throw Object.assign(new Error("no such process"), { code: "ESRCH" });
    });
    const child = fakeChild(4321);

    killProcessTree(child as never, "SIGKILL", { detached: true });

    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
  });

  it("signals only the child when the process was not detached", () => {
    const groupKill = vi.spyOn(process, "kill").mockReturnValue(true);
    const child = fakeChild(4321);

    killProcessTree(child as never, "SIGTERM", { detached: false });

    expect(groupKill).not.toHaveBeenCalled();
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("signals only the child when no pid is available", () => {
    const groupKill = vi.spyOn(process, "kill").mockReturnValue(true);
    const child = fakeChild(undefined);

    killProcessTree(child as never, "SIGTERM", { detached: true });

    expect(groupKill).not.toHaveBeenCalled();
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("never throws when the child has already exited", () => {
    vi.spyOn(process, "kill").mockImplementation(() => {
      throw new Error("boom");
    });
    const child = fakeChild(4321);
    child.kill = vi.fn(() => {
      throw new Error("already exited");
    });

    expect(() =>
      killProcessTree(child as never, "SIGTERM", { detached: true }),
    ).not.toThrow();
  });
});
