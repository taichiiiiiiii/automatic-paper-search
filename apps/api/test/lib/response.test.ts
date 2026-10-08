// Adapted from worker/response.test.mjs's json()/themeStatusUnavailable()
// tests. CHANGED: json() no longer hardcodes a single PAGES_ORIGIN — the
// caller passes the already-resolved origin (or none), so these tests
// exercise that parameter instead of a module-level constant. The
// isRateLimited/isGloballyRateLimited KV tests are NOT ported here — that
// logic moved to src/lib/quota.ts (Durable-Object-backed, see
// test/lib/quota.test.ts) per §5.

import { describe, expect, it } from "vitest";
import { json, themeStatusUnavailable } from "../../src/lib/response.js";

const ORIGIN = "https://taichiiiiiiii.github.io";

describe("json()", () => {
  it("sets content-type application/json; charset=utf-8", () => {
    const r = json({ ok: true, status: "queued", slug: "x" });
    expect(r.headers.get("content-type")).toBe("application/json; charset=utf-8");
  });

  it("sets cache-control no-store", () => {
    const r = json({ ok: true, status: "queued" });
    expect(r.headers.get("cache-control")).toBe("no-store");
  });

  it("sets access-control-allow-origin to the resolved origin when given", () => {
    const r = json({ ok: true, status: "queued" }, { origin: ORIGIN });
    expect(r.headers.get("access-control-allow-origin")).toBe(ORIGIN);
  });

  it("omits access-control-allow-origin when no origin resolved", () => {
    const r = json({ ok: true, status: "queued" });
    expect(r.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("always sets vary: Origin", () => {
    expect(json({ ok: true, status: "queued" }).headers.get("vary")).toBe("Origin");
    expect(json({ ok: true, status: "queued" }, { origin: ORIGIN }).headers.get("vary")).toBe(
      "Origin",
    );
  });

  it("serializes the body", async () => {
    const r = json({ ok: false, status: "error", message: "boom" });
    const parsed = (await r.json()) as { ok: boolean; status: string; message?: string };
    expect(parsed.ok).toBe(false);
    expect(parsed.status).toBe("error");
    expect(parsed.message).toBe("boom");
  });

  it("propagates init.status code", () => {
    expect(json({ ok: false, status: "rate_limited" }, { status: 429 }).status).toBe(429);
  });

  it("defaults to 200 when init omits status", () => {
    expect(json({ ok: true, status: "queued" }).status).toBe(200);
  });
});

describe("themeStatusUnavailable()", () => {
  it("returns 503", () => {
    expect(themeStatusUnavailable().status).toBe(503);
  });

  it("uses the closed JSON envelope", async () => {
    const r = themeStatusUnavailable();
    expect(await r.text()).toBe(
      JSON.stringify({
        ok: false,
        status: "error",
        message:
          "workflow status is temporarily unavailable; completion continues through the public manifest",
      }),
    );
  });

  it("is non-cacheable JSON", () => {
    const r = themeStatusUnavailable();
    expect(r.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(r.headers.get("cache-control")).toBe("no-store");
  });

  it("echoes an origin only when one is given", () => {
    expect(themeStatusUnavailable().headers.get("access-control-allow-origin")).toBeNull();
    expect(themeStatusUnavailable(ORIGIN).headers.get("access-control-allow-origin")).toBe(ORIGIN);
  });

  it("performs zero upstream fetches", async () => {
    let calls = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      calls++;
      throw new Error("upstream fetch must stay unreachable");
    }) as typeof fetch;
    try {
      expect(themeStatusUnavailable().status).toBe(503);
      expect(calls).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
