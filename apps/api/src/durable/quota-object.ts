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

import { type QuotaBackend, QuotaLedger, type QuotaStorage } from "../lib/quota.js";

// Adapts workers-types' DurableObjectStorage (SQLite-backed under
// `new_sqlite_classes`, see wrangler.jsonc) to the minimal QuotaStorage
// interface QuotaLedger depends on.
function storageAdapter(storage: DurableObjectStorage): QuotaStorage {
  return {
    get: <T>(key: string) => storage.get<T>(key) as Promise<T | undefined>,
    put: (key: string, value: unknown) => storage.put(key, value),
  };
}

export class QuotaCounter {
  private readonly ledger: QuotaLedger;

  constructor(state: DurableObjectState, _env: unknown) {
    this.ledger = new QuotaLedger(storageAdapter(state.storage));
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const ip = url.searchParams.get("ip") ?? "";
    if (url.pathname === "/consume") {
      const result = await this.ledger.consume(ip);
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
