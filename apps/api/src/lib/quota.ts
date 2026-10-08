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

import { RATE_LIMIT_GLOBAL_PER_DAY, RATE_LIMIT_PER_HOUR } from "../config.js";

export interface QuotaStorage {
  get<T = unknown>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
}

interface IpBucket {
  count: number;
  expiresAt: number;
}

interface GlobalBucket {
  count: number;
  date: string;
}

export type ConsumeResult = { allowed: true } | { allowed: false; limitedBy: "ip" | "global" };

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
    const ipCharge = await this.chargeIp(ip, nowMs);
    if (!ipCharge) return { allowed: false, limitedBy: "ip" };
    const globalCharge = await this.chargeGlobal(nowMs);
    if (!globalCharge) return { allowed: false, limitedBy: "global" };
    return { allowed: true };
  }

  // §5 "枠の返却" (dispatch-failure refund), gated behind
  // REFUND_ON_DISPATCH_FAILURE at the call site. Decrements both counters,
  // floored at 0; never re-extends an expired/rolled-over window.
  async refund(ip: string): Promise<void> {
    const nowMs = this.now();
    const ipKey = `ip:${ip}`;
    const ipBucket = await this.storage.get<IpBucket>(ipKey);
    if (ipBucket && ipBucket.expiresAt > nowMs && ipBucket.count > 0) {
      await this.storage.put(ipKey, { ...ipBucket, count: ipBucket.count - 1 });
    }
    const today = utcDate(nowMs);
    const globalBucket = await this.storage.get<GlobalBucket>("global");
    if (globalBucket && globalBucket.date === today && globalBucket.count > 0) {
      await this.storage.put("global", { ...globalBucket, count: globalBucket.count - 1 });
    }
  }

  private async chargeIp(ip: string, nowMs: number): Promise<boolean> {
    const key = `ip:${ip}`;
    const bucket = await this.storage.get<IpBucket>(key);
    const live = bucket && bucket.expiresAt > nowMs ? bucket : null;
    const count = live ? live.count : 0;
    if (count >= RATE_LIMIT_PER_HOUR) return false;
    const expiresAt = live ? live.expiresAt : nowMs + 3_600_000;
    await this.storage.put(key, { count: count + 1, expiresAt });
    return true;
  }

  private async chargeGlobal(nowMs: number): Promise<boolean> {
    const today = utcDate(nowMs);
    const bucket = await this.storage.get<GlobalBucket>("global");
    const count = bucket && bucket.date === today ? bucket.count : 0;
    if (count >= RATE_LIMIT_GLOBAL_PER_DAY) return false;
    await this.storage.put("global", { count: count + 1, date: today });
    return true;
  }
}

// What the route handler depends on — satisfied in production by
// src/durable/quota-object.ts's stub wiring, and by a plain in-memory fake
// in tests (see test/lib/quota.test.ts and test/routes/themes.test.ts).
export interface QuotaBackend {
  consume(ip: string): Promise<ConsumeResult>;
  refund(ip: string): Promise<void>;
}
