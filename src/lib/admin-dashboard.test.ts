import * as fs from "node:fs";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { handleAdminDashboard, safeJoin } from "./admin-dashboard.js";
import type { BridgeConfig } from "./config.js";

describe("dashboard /static/ route", () => {
  let server: http.Server;

  beforeAll(async () => {
    // Static assets read neither the config nor the version.
    server = http.createServer((req, res) =>
      handleAdminDashboard(req, res, {
        version: "test",
        config: {} as BridgeConfig,
      }),
    );
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
  });

  afterAll(async () => {
    await new Promise((resolve) => {
      server.close(resolve);
      server.closeAllConnections();
    });
  });

  /** GETs `rawPath` exactly as written; fetch would collapse the `..`. */
  function get(rawPath: string): Promise<number> {
    const { port } = server.address() as AddressInfo;
    return new Promise((resolve, reject) => {
      http
        .get({ host: "127.0.0.1", port, path: rawPath }, (res) => {
          res.resume();
          res.on("end", () => resolve(res.statusCode ?? 0));
        })
        .on("error", reject);
    });
  }

  it("serves an asset from public/", async () => {
    expect(await get("/static/styles.css")).toBe(200);
  });

  it.each(["/static/../package.json", "/static/../src/lib/admin-dashboard.ts"])(
    "answers 404 for %s, which leaves public/",
    async (rawPath) => {
      expect(await get(rawPath)).toBe(404);
    },
  );
});

describe("safeJoin (#92)", () => {
  let base: string;
  let root: string;

  beforeAll(() => {
    base = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), "safe-join-")));
    root = path.join(base, "public");
    fs.mkdirSync(path.join(root, "vendor"), { recursive: true });
    fs.writeFileSync(path.join(root, "app.js"), "app");
    fs.mkdirSync(path.join(base, "public-old"));
    fs.writeFileSync(path.join(base, "public-old", "secret.txt"), "secret");
  });

  afterAll(() => {
    fs.rmSync(base, { recursive: true, force: true });
  });

  it("refuses a sibling directory whose name starts with the root's", () => {
    const sibling = path.join(base, "public-old", "secret.txt");
    // The file is there and its path starts with the root's path, which is
    // all the old prefix check looked at.
    expect(fs.existsSync(sibling)).toBe(true);
    expect(sibling.startsWith(root)).toBe(true);
    expect(safeJoin(root, "../public-old/secret.txt")).toBeNull();
    expect(safeJoin(root, "../public-old")).toBeNull();
    expect(safeJoin(root, "vendor/../../public-old/secret.txt")).toBeNull();
  });

  it.each(["..", "../", "../..", "../../etc/passwd", "vendor/../.."])(
    "refuses %s, which leaves the root",
    (rel) => {
      expect(safeJoin(root, rel)).toBeNull();
    },
  );

  it.each([
    ["app.js", "app.js"],
    ["vendor/lib.js", "vendor/lib.js"],
    ["vendor/../app.js", "app.js"],
    ["../public/app.js", "app.js"],
    ["/app.js", "app.js"],
    ["..app.js", "..app.js"],
  ])("resolves %s inside the root", (rel, inside) => {
    expect(safeJoin(root, rel)).toBe(path.join(root, inside));
  });

  it.each(["", ".", "vendor/.."])(
    "returns the root itself for %j, which the caller answers as a directory",
    (rel) => {
      expect(safeJoin(root, rel)).toBe(root);
    },
  );

  it("treats a backslash as part of a file name on POSIX", () => {
    expect(safeJoin("/pkg/public", "..\\public-old\\secret.txt", path.posix)).toBe(
      "/pkg/public/..\\public-old\\secret.txt",
    );
  });

  it("allows anything under the filesystem root", () => {
    expect(safeJoin("/", "../etc/hosts", path.posix)).toBe("/etc/hosts");
  });

  describe("with Windows paths", () => {
    const winRoot = "C:\\pkg\\public";

    it.each([
      "..\\public-old\\secret.txt",
      "../public-old/secret.txt",
      "..\\..\\Windows\\win.ini",
      "vendor\\..\\..",
      "D:\\secret.txt",
    ])("refuses %s", (rel) => {
      expect(safeJoin(winRoot, rel, path.win32)).toBeNull();
    });

    it.each([
      ["app.js", "C:\\pkg\\public\\app.js"],
      ["vendor/lib.js", "C:\\pkg\\public\\vendor\\lib.js"],
      ["vendor\\lib.js", "C:\\pkg\\public\\vendor\\lib.js"],
      ["", winRoot],
    ])("resolves %j inside the root", (rel, inside) => {
      expect(safeJoin(winRoot, rel, path.win32)).toBe(inside);
    });

    it("compares directory names without case, as Windows does", () => {
      expect(safeJoin(winRoot, "..\\PUBLIC\\app.js", path.win32)).toBe(
        "C:\\pkg\\PUBLIC\\app.js",
      );
      expect(safeJoin(winRoot, "..\\PUBLIC-old\\x", path.win32)).toBeNull();
    });
  });
});
