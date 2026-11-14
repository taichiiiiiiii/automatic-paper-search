// Exact quota counting (§5 "依頼数の上限を Durable Objects で正確に数える").
// `QuotaLedger` is the pure logic over a minimal storage interface so it
// can run against either the real DurableObjectStorage (SQLite-backed, see
// src/durable/quota-object.ts) or an in-memory fake in tests — no miniflare
// / no network either way.
//
// Behaviour preserved from worker/response.js's KV version (isRateLimited /
// isGloballyRateLimited): the per-IP bucket is checked-and-charged first;
// only if it passes is the global bucket checked-and-charged. This means a
// request that passes the per-IP check but then trips the global daily cap
// still leaves the per-IP counter incremented — that was already true of
// the KV version (two independent read-then-write calls) and is kept
// intentionally rather than "fixed" as part of this port, since the design
// doc does not ask for that semantic change; only the *exactness* of each
// counter (no lost updates under concurrency) is new, courtesy of the
// Durable Object's single-threaded execution model.

import {
  RATE_LIMIT_GLOBAL_PER_DAY,
  RATE_LIMIT_GLOBAL_PER_HOUR,
  RATE_LIMIT_PER_HOUR,
} from "../config.js";

export interface QuotaStorage {
  get<T = unknown>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
}

// R2-27 (privacy): the per-IP bucket stores the raw client IP in its key,
// and `expiresAt` alone only ends the rate-limit window — the entry itself
// would stay in Durable Object storage forever. Storage that can also list
// and delete lets `sweepExpired` remove expired buckets, so the site's
// privacy note ("IP addresses are kept for at most about one hour") holds.
export interface SweepableQuotaStorage extends QuotaStorage {
  delete(key: string): Promise<unknown>;
  list<T = unknown>(options: { prefix: string }): Promise<Map<string, T>>;
}

/** Key prefix of the per-IP buckets (the only entries holding an IP). */
export const IP_KEY_PREFIX = "ip:";

interface IpBucket {
  count: number;
  expiresAt: number;
}

interface GlobalBucket {
  count: number;
  date: string;
}

interface GlobalHourBucket {
  count: number;
  hour: string;
}

/**
 * #522: the per-IP bucket key. One IPv6 subscriber usually holds a whole
 * /64, so rotating the low 64 bits would otherwise give a fresh 5/hour
 * bucket per address; IPv6 is counted per /64 (the first four hextets of
 * the expanded address). IPv4 and anything unparseable stay as given.
 */
export function quotaClientKey(ip: string): string {
  const raw = ip.trim().toLowerCase();
  if (!raw.includes(":")) return raw;
  const addr = raw.split("%")[0] ?? raw;
  if (addr.includes(".")) return raw; // IPv4-mapped / embedded IPv4: keep as is
  const halves = addr.split("::");
  if (halves.length > 2) return raw;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - head.length - tail.length;
  // "::" stands for at least one zero group; without it all 8 must be given.
  if (halves.length === 2 ? missing < 1 : missing !== 0) return raw;
  const groups = [...head, ...Array(halves.length === 2 ? missing : 0).fill("0"), ...tail];
  if (groups.length !== 8 || !groups.every((g) => /^[0-9a-f]{1,4}$/.test(g))) return raw;
  return `${groups
    .slice(0, 4)
    .map((g) => g.replace(/^0+(?=.)/, ""))
    .join(":")}::/64`;
}

export type ConsumeResult =
  | { allowed: true }
  | { allowed: false; limitedBy: "ip" | "global" | "global-hour" };

function utcHour(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 13);
}

function utcDate(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}

export class QuotaLedger {
  constructor(
    private readonly storage: QuotaStorage,
    private readonly now: () => number = () => Date.now(),
  ) {}

  async consume(ip: string): Promise<ConsumeResult> {
    const nowMs = this.now();
    // #522: the site-wide caps are checked first (without charging), so a
    // request refused by them does not also use up the visitor's 5/hour.
    const globalFull = await this.globalFull(nowMs);
    if (globalFull) return { allowed: false, limitedBy: globalFull };
    const ipCharge = await this.chargeIp(quotaClientKey(ip), nowMs);
    if (!ipCharge) return { allowed: false, limitedBy: "ip" };
    await this.chargeGlobal(nowMs);
    return { allowed: true };
  }

  // §5 "枠の返却" (dispatch-failure refund), gated behind
  // REFUND_ON_DISPATCH_FAILURE at the call site. Decrements both counters,
  // floored at 0; never re-extends an expired/rolled-over window.
  async refund(ip: string): Promise<void> {
    const nowMs = this.now();
    const ipKey = `${IP_KEY_PREFIX}${quotaClientKey(ip)}`;
    const ipBucket = await this.storage.get<IpBucket>(ipKey);
    if (ipBucket && ipBucket.expiresAt > nowMs && ipBucket.count > 0) {
      await this.storage.put(ipKey, { ...ipBucket, count: ipBucket.count - 1 });
    }
    const today = utcDate(nowMs);
    const globalBucket = await this.storage.get<GlobalBucket>("global");
    if (globalBucket && globalBucket.date === today && globalBucket.count > 0) {
      await this.storage.put("global", { ...globalBucket, count: globalBucket.count - 1 });
    }
    const hourBucket = await this.storage.get<GlobalHourBucket>("global-hour");
    if (hourBucket && hourBucket.hour === utcHour(nowMs) && hourBucket.count > 0) {
      await this.storage.put("global-hour", { ...hourBucket, count: hourBucket.count - 1 });
    }
  }

  private async chargeIp(ip: string, nowMs: number): Promise<boolean> {
    const key = `${IP_KEY_PREFIX}${ip}`;
    const bucket = await this.storage.get<IpBucket>(key);
    const live = bucket && bucket.expiresAt > nowMs ? bucket : null;
    const count = live ? live.count : 0;
    if (count >= RATE_LIMIT_PER_HOUR) return false;
    const expiresAt = live ? live.expiresAt : nowMs + 3_600_000;
    await this.storage.put(key, { count: count + 1, expiresAt });
    return true;
  }

  /**
   * Deletes every per-IP bucket whose window has ended (R2-27). Returns the
   * earliest `expiresAt` among the buckets still live, or null when none
   * remain — the Durable Object schedules its next alarm from that value.
   * Malformed entries (no numeric `expiresAt`) are deleted as well.
   * `prefix` also lets the alarm sweep the in-flight dedup claims
   * (`inflight:<slug>`, src/lib/inflight.ts), which carry the same field.
   */
  static async sweepExpired(
    storage: SweepableQuotaStorage,
    nowMs: number,
    prefix: string = IP_KEY_PREFIX,
  ): Promise<number | null> {
    const entries = await storage.list<IpBucket>({ prefix });
    let nextExpiry: number | null = null;
    for (const [key, bucket] of entries) {
      const expiresAt = bucket && typeof bucket.expiresAt === "number" ? bucket.expiresAt : null;
      if (expiresAt === null || expiresAt <= nowMs) {
        await storage.delete(key);
      } else if (nextExpiry === null || expiresAt < nextExpiry) {
        nextExpiry = expiresAt;
      }
    }
    return nextExpiry;
  }

  private async globalCounts(nowMs: number): Promise<{ day: number; hour: number }> {
    const bucket = await this.storage.get<GlobalBucket>("global");
    const hourBucket = await this.storage.get<GlobalHourBucket>("global-hour");
    return {
      day: bucket && bucket.date === utcDate(nowMs) ? bucket.count : 0,
      hour: hourBucket && hourBucket.hour === utcHour(nowMs) ? hourBucket.count : 0,
    };
  }

  private async globalFull(nowMs: number): Promise<"global" | "global-hour" | null> {
    const c = await this.globalCounts(nowMs);
    if (c.day >= RATE_LIMIT_GLOBAL_PER_DAY) return "global";
    if (c.hour >= RATE_LIMIT_GLOBAL_PER_HOUR) return "global-hour";
    return null;
  }

  /** Charges both site-wide buckets (the caller checked {@link globalFull}
   * first; the Durable Object runs one request at a time). */
  private async chargeGlobal(nowMs: number): Promise<void> {
    const c = await this.globalCounts(nowMs);
    await this.storage.put("global", { count: c.day + 1, date: utcDate(nowMs) });
    await this.storage.put("global-hour", { count: c.hour + 1, hour: utcHour(nowMs) });
  }
}

// What the route handler depends on — satisfied in production by
// src/durable/quota-object.ts's stub wiring, and by a plain in-memory fake
// in tests (see test/lib/quota.test.ts and test/routes/themes.test.ts).
export interface QuotaBackend {
  consume(ip: string): Promise<ConsumeResult>;
  refund(ip: string): Promise<void>;
}
