// New tests for §5's exact quota counting (QuotaLedger). Uses a plain
// Map-backed fake storage — no miniflare, no real Durable Object — so this
// exercises the same logic the SQLite-backed production class
// (src/durable/quota-object.ts) delegates to.

import { describe, expect, it } from "vitest";
import { QuotaLedger, type QuotaStorage } from "../../src/lib/quota.js";

function fakeStorage(): QuotaStorage {
  const map = new Map<string, unknown>();
  return {
    async get<T>(key: string) {
      return map.get(key) as T | undefined;
    },
    async put(key: string, value: unknown) {
      map.set(key, value);
    },
  };
}

const HOUR = 3_600_000;
const DAY = 86_400_000;

describe("QuotaLedger.consume", () => {
  it("allows the first 5 requests per IP within an hour, then caps at 429 ip", async () => {
    const ledger = new QuotaLedger(fakeStorage(), () => 0);
    for (let i = 0; i < 5; i++) {
      expect((await ledger.consume("1.2.3.4")).allowed).toBe(true);
    }
    expect(await ledger.consume("1.2.3.4")).toEqual({ allowed: false, limitedBy: "ip" });
  });

  it("resets the per-IP window after it expires", async () => {
    let now = 0;
    const ledger = new QuotaLedger(fakeStorage(), () => now);
    for (let i = 0; i < 5; i++) await ledger.consume("1.2.3.4");
    expect((await ledger.consume("1.2.3.4")).allowed).toBe(false);
    now += HOUR + 1;
    expect((await ledger.consume("1.2.3.4")).allowed).toBe(true);
  });

  it("different IPs have independent buckets", async () => {
    const ledger = new QuotaLedger(fakeStorage(), () => 0);
    for (let i = 0; i < 5; i++) await ledger.consume("1.1.1.1");
    expect((await ledger.consume("1.1.1.1")).allowed).toBe(false);
    expect((await ledger.consume("2.2.2.2")).allowed).toBe(true);
  });

  it("caps at the global daily limit across many distinct IPs", async () => {
    const ledger = new QuotaLedger(fakeStorage(), () => 0);
    for (let i = 0; i < 100; i++) {
      const result = await ledger.consume(`10.0.0.${i}`);
      expect(result.allowed).toBe(true);
    }
    expect(await ledger.consume("10.0.0.200")).toEqual({ allowed: false, limitedBy: "global" });
  });

  it("the global cap resets on UTC date rollover", async () => {
    let now = 0;
    const ledger = new QuotaLedger(fakeStorage(), () => now);
    for (let i = 0; i < 100; i++) await ledger.consume(`10.0.1.${i}`);
    expect((await ledger.consume("10.0.1.200")).allowed).toBe(false);
    now += DAY;
    expect((await ledger.consume("10.0.1.200")).allowed).toBe(true);
  });

  it("keeps the IP charge when the global cap subsequently rejects (preserves legacy KV semantics)", async () => {
    const storage = fakeStorage();
    const ledger = new QuotaLedger(storage, () => 0);
    for (let i = 0; i < 100; i++) await ledger.consume(`10.0.2.${i}`);
    const before = await storage.get<{ count: number }>("ip:1.2.3.4");
    expect(before).toBeUndefined();
    const result = await ledger.consume("1.2.3.4");
    expect(result).toEqual({ allowed: false, limitedBy: "global" });
    const after = await storage.get<{ count: number }>("ip:1.2.3.4");
    expect(after?.count).toBe(1); // charged even though the request was ultimately rejected
  });
});

describe("QuotaLedger.refund", () => {
  it("decrements both counters by one", async () => {
    const storage = fakeStorage();
    const ledger = new QuotaLedger(storage, () => 0);
    await ledger.consume("1.2.3.4");
    await ledger.consume("1.2.3.4");
    await ledger.refund("1.2.3.4");
    expect((await storage.get<{ count: number }>("ip:1.2.3.4"))?.count).toBe(1);
    expect((await storage.get<{ count: number }>("global"))?.count).toBe(1);
  });

  it("never goes below zero", async () => {
    const storage = fakeStorage();
    const ledger = new QuotaLedger(storage, () => 0);
    await ledger.refund("1.2.3.4"); // nothing consumed yet
    expect(await storage.get("ip:1.2.3.4")).toBeUndefined();
  });

  it("does not resurrect an expired IP window", async () => {
    let now = 0;
    const storage = fakeStorage();
    const ledger = new QuotaLedger(storage, () => now);
    await ledger.consume("1.2.3.4");
    now += HOUR + 1;
    await ledger.refund("1.2.3.4");
    const bucket = await storage.get<{ count: number; expiresAt: number }>("ip:1.2.3.4");
    expect(bucket?.count).toBe(1); // unchanged — the window had already rolled over
  });
});
