import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import {
  AccountPool,
  initAccountPool,
  getNextAccountConfigDir,
  reportRequestStart,
  reportRequestEnd,
  reportRateLimit,
} from "./account-pool.js";

describe("AccountPool", () => {
  it("should return undefined if no config dirs provided", () => {
    const pool = new AccountPool([]);
    expect(pool.getNextConfigDir()).toBeUndefined();
    expect(pool.getConfigDirsCount()).toBe(0);
  });

  it("should return the only config dir if one is provided", () => {
    const pool = new AccountPool(["/dir1"]);
    expect(pool.getNextConfigDir()).toBe("/dir1");
    expect(pool.getNextConfigDir()).toBe("/dir1");
    expect(pool.getConfigDirsCount()).toBe(1);
  });

  it("should round-robin through multiple config dirs", () => {
    const pool = new AccountPool(["/dir1", "/dir2", "/dir3"]);
    expect(pool.getNextConfigDir()).toBe("/dir1");
    expect(pool.getNextConfigDir()).toBe("/dir2");
    expect(pool.getNextConfigDir()).toBe("/dir3");
    expect(pool.getNextConfigDir()).toBe("/dir1");
    expect(pool.getConfigDirsCount()).toBe(3);
  });
});

describe("AccountPool Active Requests & Rate Limits", () => {
  describe("Global AccountPool", () => {
    it("should select the least busy account", () => {
      const pool = new AccountPool(["/dir1", "/dir2", "/dir3"]);

      // Simulate requests starting on dir1 and dir2
      pool.reportRequestStart("/dir1");
      pool.reportRequestStart("/dir2");

      // dir3 should be selected since it has 0 active requests
      expect(pool.getNextConfigDir()).toBe("/dir3");

      // Now dir3 also has a request
      pool.reportRequestStart("/dir3");

      // End request on dir1
      pool.reportRequestEnd("/dir1");

      // Now dir1 should be selected because it has 0 requests again
      expect(pool.getNextConfigDir()).toBe("/dir1");
    });

    it("should skip rate-limited accounts", () => {
      const pool = new AccountPool(["/dir1", "/dir2"]);

      // Rate limit dir1 for 60 seconds
      pool.reportRateLimit("/dir1", 60000);

      // It should select dir2
      expect(pool.getNextConfigDir()).toBe("/dir2");
      expect(pool.getNextConfigDir()).toBe("/dir2");
    });

    it("should fallback to sorting by recovery time if all accounts are rate-limited", () => {
      const pool = new AccountPool(["/dir1", "/dir2"]);

      // Rate limit both, but dir2 recovers sooner
      pool.reportRateLimit("/dir1", 60000);
      pool.reportRateLimit("/dir2", 30000);

      // Should select dir2 because its penalty is shorter
      expect(pool.getNextConfigDir()).toBe("/dir2");
    });
  });

  describe("Global AccountPool", () => {
    beforeEach(() => {
      initAccountPool([]);
    });

    it("should initialize and use global pool", () => {
      initAccountPool(["/global1", "/global2"]);
      expect(getNextAccountConfigDir()).toBe("/global1");
      expect(getNextAccountConfigDir()).toBe("/global2");
      expect(getNextAccountConfigDir()).toBe("/global1");
    });

    it("should handle empty global pool", () => {
      initAccountPool([]);
      expect(getNextAccountConfigDir()).toBeUndefined();
    });
  });
});

describe("AccountPool edge cases", () => {
  it("reportRequestEnd does not allow activeRequests to go below zero", () => {
    const pool = new AccountPool(["/dir1"]);
    // No request started — end should be a no-op
    pool.reportRequestEnd("/dir1");
    pool.reportRequestEnd("/dir1");
    // Still returns the dir (doesn't crash or corrupt state)
    expect(pool.getNextConfigDir()).toBe("/dir1");
  });

  it("activeRequests increments and decrements correctly", () => {
    const pool = new AccountPool(["/dir1", "/dir2"]);
    pool.reportRequestStart("/dir1");
    pool.reportRequestStart("/dir1");
    // dir2 has 0 requests, dir1 has 2 — should pick dir2
    expect(pool.getNextConfigDir()).toBe("/dir2");
    pool.reportRequestEnd("/dir1");
    pool.reportRequestEnd("/dir1");
    // Now both have 0 active — round-robin picks dir1 (lastUsed oldest)
    expect(pool.getNextConfigDir()).toBe("/dir1");
  });

  it("ignores reportRequestStart for unknown configDir", () => {
    const pool = new AccountPool(["/dir1"]);
    // Should not throw or corrupt pool
    pool.reportRequestStart("/nonexistent");
    expect(pool.getNextConfigDir()).toBe("/dir1");
  });

  it("ignores reportRequestEnd for unknown configDir", () => {
    const pool = new AccountPool(["/dir1"]);
    pool.reportRequestEnd("/nonexistent");
    expect(pool.getNextConfigDir()).toBe("/dir1");
  });

  it("ignores reportRateLimit for unknown configDir", () => {
    const pool = new AccountPool(["/dir1"]);
    pool.reportRateLimit("/nonexistent", 60000);
    expect(pool.getNextConfigDir()).toBe("/dir1");
  });

  it("rate limit expires and account becomes available again", async () => {
    const pool = new AccountPool(["/dir1", "/dir2"]);
    // Rate limit dir1 for 50ms
    pool.reportRateLimit("/dir1", 50);
    // Immediately — dir2 should be selected
    expect(pool.getNextConfigDir()).toBe("/dir2");
    // Wait for expiry
    await new Promise((r) => setTimeout(r, 100));
    // Now dir1 should be available again (has lower lastUsed, same activeRequests)
    expect(pool.getNextConfigDir()).toBe("/dir1");
  });

  it("selects by lastUsed when activeRequests are equal (round-robin effect)", () => {
    const pool = new AccountPool(["/a", "/b", "/c"]);
    const r1 = pool.getNextConfigDir(); // /a gets lastUsed = now
    const r2 = pool.getNextConfigDir(); // /b gets lastUsed = now
    const r3 = pool.getNextConfigDir(); // /c gets lastUsed = now
    const r4 = pool.getNextConfigDir(); // back to /a (oldest lastUsed)
    expect(r1).toBe("/a");
    expect(r2).toBe("/b");
    expect(r3).toBe("/c");
    expect(r4).toBe("/a");
  });

  it("getConfigDirsCount returns correct count", () => {
    expect(new AccountPool([]).getConfigDirsCount()).toBe(0);
    expect(new AccountPool(["/x"]).getConfigDirsCount()).toBe(1);
    expect(new AccountPool(["/x", "/y", "/z"]).getConfigDirsCount()).toBe(3);
  });

  it("getStats reflects success, error, and latency totals", () => {
    const pool = new AccountPool(["/dir1"]);
    pool.reportRequestStart("/dir1");
    pool.reportRequestSuccess("/dir1", 100);
    pool.reportRequestEnd("/dir1");
    pool.reportRequestStart("/dir1");
    pool.reportRequestError("/dir1", 50);
    pool.reportRequestEnd("/dir1");
    const stats = pool.getStats();
    expect(stats[0].totalSuccess).toBe(1);
    expect(stats[0].totalErrors).toBe(1);
    expect(stats[0].totalLatencyMs).toBe(150);
  });
});

describe("Global account pool functions", () => {
  afterEach(() => {
    initAccountPool([]);
  });

  it("global reportRequestStart/End are no-ops before initAccountPool", () => {
    // Functions should not throw even when global pool is uninitialized
    // (calling them before initAccountPool means globalPool is null after reset)
    expect(() => reportRequestStart("/dir1")).not.toThrow();
    expect(() => reportRequestEnd("/dir1")).not.toThrow();
    expect(() => reportRateLimit("/dir1", 1000)).not.toThrow();
  });

  it("global pool functions work after init", () => {
    initAccountPool(["/g1", "/g2"]);
    reportRequestStart("/g1");
    // g2 should be preferred since g1 has an active request
    expect(getNextAccountConfigDir()).toBe("/g2");
    reportRequestEnd("/g1");
    // Now g1 is free again and has older lastUsed
    expect(getNextAccountConfigDir()).toBe("/g1");
  });

  it("reinitializing pool resets all state", () => {
    initAccountPool(["/old1", "/old2"]);
    expect(getNextAccountConfigDir()).toBe("/old1");
    // Re-init with new dirs
    initAccountPool(["/new1"]);
    expect(getNextAccountConfigDir()).toBe("/new1");
    expect(getNextAccountConfigDir()).toBe("/new1");
  });
});
