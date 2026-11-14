// New tests for §5's exact quota counting (QuotaLedger). Uses a plain
// Map-backed fake storage — no miniflare, no real Durable Object — so this
// exercises the same logic the SQLite-backed production class
// (src/durable/quota-object.ts) delegates to.

import { describe, expect, it } from "vitest";
import { RATE_LIMIT_GLOBAL_PER_DAY, RATE_LIMIT_GLOBAL_PER_HOUR } from "../../src/config.js";
import {
  QuotaLedger,
  type QuotaStorage,
  quotaClientKey,
  type SweepableQuotaStorage,
} from "../../src/lib/quota.js";

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
    let now = 0;
    const ledger = new QuotaLedger(fakeStorage(), () => now);
    for (let i = 0; i < RATE_LIMIT_GLOBAL_PER_DAY; i++) {
      // spread over the day so the hourly cap never binds
      now = Math.floor(i / RATE_LIMIT_GLOBAL_PER_HOUR) * HOUR;
      const result = await ledger.consume(`10.0.0.${i}`);
      expect(result.allowed).toBe(true);
    }
    expect(await ledger.consume("10.0.0.200")).toEqual({ allowed: false, limitedBy: "global" });
  });

  it("#522: caps the whole site per UTC hour, then allows again next hour", async () => {
    let now = 0;
    const ledger = new QuotaLedger(fakeStorage(), () => now);
    for (let i = 0; i < RATE_LIMIT_GLOBAL_PER_HOUR; i++) {
      expect((await ledger.consume(`10.0.3.${i}`)).allowed).toBe(true);
    }
    expect(await ledger.consume("10.0.3.99")).toEqual({ allowed: false, limitedBy: "global-hour" });
    now = HOUR;
    expect((await ledger.consume("10.0.3.99")).allowed).toBe(true);
  });

  it("#522: counts IPv6 per /64, so rotating the interface id does not reset the bucket", async () => {
    const ledger = new QuotaLedger(fakeStorage(), () => 0);
    for (let i = 1; i <= 5; i++) {
      expect((await ledger.consume(`2001:db8:1:2::${i}`)).allowed).toBe(true);
    }
    expect(await ledger.consume("2001:db8:1:2:ffff:1:2:3")).toEqual({
      allowed: false,
      limitedBy: "ip",
    });
    expect((await ledger.consume("2001:db8:1:3::1")).allowed).toBe(true);
  });

  it("the global cap resets on UTC date rollover", async () => {
    let now = 0;
    const ledger = new QuotaLedger(fakeStorage(), () => now);
    for (let i = 0; i < RATE_LIMIT_GLOBAL_PER_DAY; i++) {
      now = Math.floor(i / RATE_LIMIT_GLOBAL_PER_HOUR) * HOUR;
      await ledger.consume(`10.0.1.${i}`);
    }
    expect((await ledger.consume("10.0.1.200")).allowed).toBe(false);
    now = DAY;
    expect((await ledger.consume("10.0.1.200")).allowed).toBe(true);
  });

  it("#522: a request refused by a site-wide cap does not use up the IP's 5/hour", async () => {
    const storage = fakeStorage();
    const ledger = new QuotaLedger(storage, () => 0);
    for (let i = 0; i < RATE_LIMIT_GLOBAL_PER_HOUR; i++) await ledger.consume(`10.0.2.${i}`);
    const result = await ledger.consume("1.2.3.4");
    expect(result).toEqual({ allowed: false, limitedBy: "global-hour" });
    expect(await storage.get("ip:1.2.3.4")).toBeUndefined();
  });

  it("#522: reports the daily cap as 'global' and the hourly cap as 'global-hour'", async () => {
    let now = 0;
    const ledger = new QuotaLedger(fakeStorage(), () => now);
    for (let i = 0; i < RATE_LIMIT_GLOBAL_PER_DAY; i++) {
      now = Math.floor(i / RATE_LIMIT_GLOBAL_PER_HOUR) * HOUR;
      await ledger.consume(`10.0.4.${i}`);
    }
    expect(await ledger.consume("10.0.4.250")).toEqual({ allowed: false, limitedBy: "global" });
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

function sweepableStorage(): SweepableQuotaStorage & { keys(): string[] } {
  const map = new Map<string, unknown>();
  return {
    async get<T>(key: string) {
      return map.get(key) as T | undefined;
    },
    async put(key: string, value: unknown) {
      map.set(key, value);
    },
    async delete(key: string) {
      return map.delete(key);
    },
    async list<T>({ prefix }: { prefix: string }) {
      return new Map([...map].filter(([key]) => key.startsWith(prefix)) as Array<[string, T]>);
    },
    keys: () => [...map.keys()].sort(),
  };
}

describe("QuotaLedger.sweepExpired (R2-27: IP kept at most ~1 hour)", () => {
  it("deletes expired per-IP buckets, keeps live ones and the global counter", async () => {
    let now = 0;
    const storage = sweepableStorage();
    const ledger = new QuotaLedger(storage, () => now);
    await ledger.consume("1.1.1.1");
    now = 30 * 60_000;
    await ledger.consume("2.2.2.2");
    now = HOUR + 1;
    const next = await QuotaLedger.sweepExpired(storage, now);
    expect(storage.keys()).toEqual(["global", "global-hour", "ip:2.2.2.2"]);
    expect(next).toBe(30 * 60_000 + HOUR);
    expect(await QuotaLedger.sweepExpired(storage, next ?? 0)).toBeNull();
    expect(storage.keys()).toEqual(["global", "global-hour"]);
  });

  it("deletes malformed buckets and returns null on an empty store", async () => {
    const storage = sweepableStorage();
    await storage.put("ip:9.9.9.9", { count: 1 });
    expect(await QuotaLedger.sweepExpired(storage, 0)).toBeNull();
    expect(storage.keys()).toEqual([]);
  });
});

describe("quotaClientKey (#522)", () => {
  it("keeps IPv4 and maps IPv6 to its /64", () => {
    expect(quotaClientKey("203.0.113.7")).toBe("203.0.113.7");
    expect(quotaClientKey("2001:0db8:0001:0002:0000:0000:0000:0005")).toBe("2001:db8:1:2::/64");
    expect(quotaClientKey("2001:DB8:1:2::5")).toBe("2001:db8:1:2::/64");
    expect(quotaClientKey("2001:db8::1")).toBe("2001:db8:0:0::/64");
    expect(quotaClientKey("::1")).toBe("0:0:0:0::/64");
  });
  it("leaves unparseable or IPv4-mapped values as given", () => {
    expect(quotaClientKey("::ffff:192.0.2.1")).toBe("::ffff:192.0.2.1");
    expect(quotaClientKey("not-an-ip")).toBe("not-an-ip");
    expect(quotaClientKey("1:2:3")).toBe("1:2:3");
    expect(quotaClientKey("1:2:3:4:5:6:7:8::")).toBe("1:2:3:4:5:6:7:8::");
  });
});
