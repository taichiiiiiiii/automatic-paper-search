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

import { INFLIGHT_KEY_PREFIX, type InflightBackend, InflightLedger } from "../lib/inflight.js";
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
  private readonly inflight: InflightLedger;
  private readonly storage: DurableObjectStorage;
  private readonly sweepable: SweepableQuotaStorage;

  constructor(state: DurableObjectState, _env: unknown) {
    this.storage = state.storage;
    this.sweepable = storageAdapter(state.storage);
    this.ledger = new QuotaLedger(this.sweepable);
    this.inflight = new InflightLedger(this.sweepable);
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
    const now = Date.now();
    const nextIp = await QuotaLedger.sweepExpired(this.sweepable, now);
    const nextInflight = await QuotaLedger.sweepExpired(this.sweepable, now, INFLIGHT_KEY_PREFIX);
    const pending = [nextIp, nextInflight].filter((n): n is number => n !== null);
    if (pending.length > 0) await this.storage.setAlarm(Math.min(...pending) + SWEEP_GRACE_MS);
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
    const slug = url.searchParams.get("slug") ?? "";
    const requestId = url.searchParams.get("request_id") ?? "";
    if (url.pathname === "/inflight/peek") {
      return Response.json({ request_id: await this.inflight.peek(slug) });
    }
    if (url.pathname === "/inflight/claim") {
      const result = await this.inflight.claim(slug, requestId);
      await this.ensureSweepAlarm();
      return Response.json(result);
    }
    if (url.pathname === "/inflight/release") {
      await this.inflight.release(slug, requestId);
      return Response.json({ ok: true });
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

export function productionInflightBackend(namespace: DurableObjectNamespace): InflightBackend {
  const stub = namespace.get(namespace.idFromName(INSTANCE_NAME));
  const call = (op: string, slug: string, requestId = "") =>
    stub.fetch(
      `https://quota.internal/inflight/${op}?slug=${encodeURIComponent(slug)}&request_id=${encodeURIComponent(requestId)}`,
    );
  return {
    async peek(slug: string) {
      const body = (await (await call("peek", slug)).json()) as { request_id: string | null };
      return body.request_id;
    },
    async claim(slug: string, requestId: string) {
      return (await (await call("claim", slug, requestId)).json()) as Awaited<
        ReturnType<InflightBackend["claim"]>
      >;
    },
    async release(slug: string, requestId: string) {
      await call("release", slug, requestId);
    },
  };
}
