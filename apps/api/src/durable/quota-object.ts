// SQLite-backed Durable Object class implementing the exact quota counters
// (§5). Classic fetch-style DO (constructor(state, env) + async fetch) —
// deliberately NOT built on the `cloudflare:workers` RPC-style
// `DurableObject` base class, so this module has no import that Vitest
// under plain Node would need to resolve; `@cloudflare/workers-types`
// alone covers the types used here. This file is wired into
// wrangler.jsonc's `durable_objects` binding but is not imported by any
// test — src/lib/quota.ts's QuotaLedger carries the tested logic, and
// production_quota_backend() below carries the stub-fetch wiring, tested
// only via its request/response shape where feasible.

import { type QuotaBackend, QuotaLedger, type SweepableQuotaStorage } from "../lib/quota.js";

// Grace added after a bucket's expiry before the sweep alarm fires, so the
// alarm never runs a hair before the window it is meant to clear.
const SWEEP_GRACE_MS = 1_000;

// Adapts workers-types' DurableObjectStorage (SQLite-backed under
// `new_sqlite_classes`, see wrangler.jsonc) to the minimal QuotaStorage
// interface QuotaLedger depends on.
function storageAdapter(storage: DurableObjectStorage): SweepableQuotaStorage {
  return {
    get: <T>(key: string) => storage.get<T>(key) as Promise<T | undefined>,
    put: (key: string, value: unknown) => storage.put(key, value),
    delete: (key: string) => storage.delete(key),
    list: <T>(options: { prefix: string }) => storage.list<T>(options),
  };
}

export class QuotaCounter {
  private readonly ledger: QuotaLedger;
  private readonly storage: DurableObjectStorage;
  private readonly sweepable: SweepableQuotaStorage;

  constructor(state: DurableObjectState, _env: unknown) {
    this.storage = state.storage;
    this.sweepable = storageAdapter(state.storage);
    this.ledger = new QuotaLedger(this.sweepable);
  }

  // R2-27: every consume() may write a new `ip:<addr>` bucket that expires
  // one hour later; make sure an alarm is pending to delete it. A new
  // bucket never expires earlier than one already stored (windows are all
  // one hour long), so an existing alarm is always early enough.
  private async ensureSweepAlarm(): Promise<void> {
    if ((await this.storage.getAlarm()) === null) {
      await this.storage.setAlarm(Date.now() + 3_600_000 + SWEEP_GRACE_MS);
    }
  }

  async alarm(): Promise<void> {
    const next = await QuotaLedger.sweepExpired(this.sweepable, Date.now());
    if (next !== null) await this.storage.setAlarm(next + SWEEP_GRACE_MS);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const ip = url.searchParams.get("ip") ?? "";
    if (url.pathname === "/consume") {
      const result = await this.ledger.consume(ip);
      await this.ensureSweepAlarm();
      return new Response(JSON.stringify(result), {
        headers: { "content-type": "application/json" },
      });
    }
    if (url.pathname === "/refund") {
      await this.ledger.refund(ip);
      return new Response(JSON.stringify({ ok: true }), {
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("Not Found", { status: 404 });
  }
}

// Single named instance — a per-IP+global quota needs exactly one ledger,
// not one per caller, so every request routes to the same Durable Object
// via idFromName rather than idFromRequest/newUniqueId.
const INSTANCE_NAME = "quota";

export function productionQuotaBackend(namespace: DurableObjectNamespace): QuotaBackend {
  const stub = namespace.get(namespace.idFromName(INSTANCE_NAME));
  return {
    async consume(ip: string) {
      const resp = await stub.fetch(`https://quota.internal/consume?ip=${encodeURIComponent(ip)}`);
      return (await resp.json()) as Awaited<ReturnType<QuotaBackend["consume"]>>;
    },
    async refund(ip: string) {
      await stub.fetch(`https://quota.internal/refund?ip=${encodeURIComponent(ip)}`);
    },
  };
}
