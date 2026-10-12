// In-flight dedup (src/lib/inflight.ts) — the ledger itself and its
// wiring in POST /api/themes: a second request for a slug whose run is
// still in flight returns the first request id (status "queued",
// deduplicated) with no dispatch and no quota charge; a failed dispatch
// releases the claim; a broken in-flight backend degrades to "no dedup".

import { describe, expect, it } from "vitest";
import { INFLIGHT_TTL_MS, type InflightBackend, InflightLedger } from "../../src/lib/inflight.js";
import { type QuotaBackend, QuotaLedger } from "../../src/lib/quota.js";
import { createThemesPostHandler } from "../../src/routes/themes.js";
import type { Env } from "../../src/types.js";

const ORIGIN = "https://paperpilot.pages.dev";

function mapStorage() {
  const map = new Map<string, unknown>();
  return {
    map,
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
      return new Map([...map].filter(([k]) => k.startsWith(prefix))) as Map<string, T>;
    },
  };
}

describe("InflightLedger", () => {
  it("claims once, returns the first id to later claims, and expires after the TTL", async () => {
    let now = 1_000;
    const ledger = new InflightLedger(mapStorage(), () => now);
    expect(await ledger.peek("vit")).toBeNull();
    expect(await ledger.claim("vit", "theme-a")).toEqual({ claimed: true });
    expect(await ledger.claim("vit", "theme-b")).toEqual({ claimed: false, requestId: "theme-a" });
    expect(await ledger.peek("vit")).toBe("theme-a");
    expect(await ledger.peek("gnn")).toBeNull();
    now += INFLIGHT_TTL_MS;
    expect(await ledger.peek("vit")).toBeNull();
    expect(await ledger.claim("vit", "theme-c")).toEqual({ claimed: true });
  });

  it("release only drops the claim it owns", async () => {
    const ledger = new InflightLedger(mapStorage(), () => 0);
    await ledger.claim("vit", "theme-a");
    await ledger.release("vit", "theme-other");
    expect(await ledger.peek("vit")).toBe("theme-a");
    await ledger.release("vit", "theme-a");
    expect(await ledger.peek("vit")).toBeNull();
  });

  it("expired claims are removed by the quota sweep with the inflight: prefix", async () => {
    const storage = mapStorage();
    const ledger = new InflightLedger(storage, () => 0);
    await ledger.claim("vit", "theme-a");
    expect(await QuotaLedger.sweepExpired(storage, 1, "inflight:")).toBe(INFLIGHT_TTL_MS);
    expect(await QuotaLedger.sweepExpired(storage, INFLIGHT_TTL_MS + 1, "inflight:")).toBeNull();
    expect(storage.map.size).toBe(0);
  });
});

// ---- route wiring ----

const UUIDS = [
  "11111111-1111-4111-8111-111111111111",
  "22222222-2222-4222-8222-222222222222",
  "33333333-3333-4333-8333-333333333333",
];

function setup(
  opts: { dispatchStatus?: number; inflight?: InflightBackend | "throws" | "none" } = {},
) {
  const dispatches: unknown[] = [];
  let dispatchStatus = opts.dispatchStatus ?? 204;
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    if (url.startsWith("https://raw.githubusercontent.com")) return new Response("[]");
    dispatches.push(JSON.parse(String(init?.body)));
    return new Response(null, { status: dispatchStatus });
  }) as unknown as typeof fetch;
  const quotaCalls: string[] = [];
  const quota: QuotaBackend = {
    async consume(ip) {
      quotaCalls.push(ip);
      return { allowed: true };
    },
    async refund() {},
  };
  const ledger = new InflightLedger(mapStorage(), () => 0);
  let n = 0;
  const handler = createThemesPostHandler({
    fetch: fetchImpl,
    quota: () => quota,
    inflight:
      opts.inflight === "none"
        ? undefined
        : opts.inflight === "throws"
          ? () => {
              throw new Error("DO down");
            }
          : () => (opts.inflight as InflightBackend | undefined) ?? ledger,
    randomUUID: () => UUIDS[n++ % UUIDS.length]!,
    log: () => {},
  });
  const env: Env = {
    GH_OWNER: "o",
    GH_REPO: "r",
    GH_WORKFLOW_FILE: "theme-on-demand.yml",
    GH_REF: "develop",
    GH_DISPATCH_PAT: "pat",
    DISPATCH_MODE: "live",
    CONFIG_KV: {
      async get(key: string) {
        if (key === "origin_allowlist") return JSON.stringify([ORIGIN]);
        if (key === "accepting") return "true";
        return null;
      },
    },
  };
  const post = async (theme: string) => {
    const resp = await handler(
      new Request("https://w.test/api/themes", {
        method: "POST",
        headers: {
          origin: ORIGIN,
          "content-type": "application/json",
          "cf-connecting-ip": "1.2.3.4",
        },
        body: JSON.stringify({ theme }),
      }),
      env,
    );
    return { status: resp.status, body: (await resp.json()) as Record<string, unknown> };
  };
  return {
    post,
    dispatches,
    quotaCalls,
    setDispatchStatus: (s: number) => {
      dispatchStatus = s;
    },
  };
}

describe("POST /api/themes in-flight dedup", () => {
  it("a second request for the same new slug follows the first run: no dispatch, no charge", async () => {
    const t = setup();
    const first = await t.post("Vision Transformer");
    expect(first.body).toMatchObject({ ok: true, status: "queued", slug: "vision-transformer" });
    expect(first.body.deduplicated).toBeUndefined();
    // Different spelling, same slug.
    const second = await t.post("vision  transformer ");
    expect(second.status).toBe(200);
    expect(second.body).toEqual({
      ok: true,
      status: "queued",
      slug: "vision-transformer",
      request_id: first.body.request_id,
      deduplicated: true,
    });
    expect(t.dispatches).toHaveLength(1);
    expect(t.quotaCalls).toHaveLength(1);
    // Another slug is independent.
    await t.post("Graph Neural Network");
    expect(t.dispatches).toHaveLength(2);
  });

  it("a failed dispatch releases the claim so a retry dispatches again", async () => {
    const t = setup({ dispatchStatus: 500 });
    expect((await t.post("Vision Transformer")).status).toBe(502);
    t.setDispatchStatus(204);
    const retry = await t.post("Vision Transformer");
    expect(retry.body).toMatchObject({ status: "queued" });
    expect(retry.body.deduplicated).toBeUndefined();
    expect(t.dispatches).toHaveLength(2);
  });

  it("a concurrent claim lost to another request returns that request's id", async () => {
    const racing: InflightBackend = {
      async peek() {
        return null;
      },
      async claim() {
        return { claimed: false, requestId: "theme-99999999-9999-4999-8999-999999999999" };
      },
      async release() {},
    };
    const t = setup({ inflight: racing });
    const r = await t.post("Vision Transformer");
    expect(r.body).toMatchObject({
      status: "queued",
      request_id: "theme-99999999-9999-4999-8999-999999999999",
      deduplicated: true,
    });
    expect(t.dispatches).toHaveLength(0);
  });

  it("an unavailable in-flight backend degrades to no dedup (quota still applies)", async () => {
    const t = setup({ inflight: "throws" });
    expect((await t.post("Vision Transformer")).body).toMatchObject({ status: "queued" });
    expect((await t.post("Vision Transformer")).body).toMatchObject({ status: "queued" });
    expect(t.dispatches).toHaveLength(2);
    expect(t.quotaCalls).toHaveLength(2);
  });

  it("without an in-flight backend every request dispatches (unit-test default)", async () => {
    const t = setup({ inflight: "none" });
    await t.post("Vision Transformer");
    await t.post("Vision Transformer");
    expect(t.dispatches).toHaveLength(2);
  });
});
