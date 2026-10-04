// Entrypoint-level tests, scoped to the theme routes per the task (the
// paper-slide adapter-projection machinery in worker/entrypoint.js is out
// of scope — see src/app.ts's header comment). Ported from the
// theme-relevant subset of worker/entrypoint.test.mjs: exact route table,
// 404 body/headers, and the preflight CORS contract (now KV-backed, see
// test/lib/preflight.test.ts for the allowlist-matching cases in detail).

import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import type { QuotaBackend } from "../src/lib/quota.js";
import type { Env } from "../src/types.js";

const ALLOWED_ORIGIN = "https://taichiiiiiiii.github.io";

function fakeKv(store: Record<string, string> = {}) {
  return {
    async get(key: string) {
      return key in store ? store[key]! : null;
    },
  };
}

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    GH_OWNER: "o",
    GH_REPO: "r",
    GH_WORKFLOW_FILE: "wf.yml",
    GH_REF: "feat/ts-migration",
    GH_DISPATCH_PAT: "pat",
    DISPATCH_MODE: "live",
    CONFIG_KV: fakeKv({ origin_allowlist: JSON.stringify([ALLOWED_ORIGIN]), accepting: "true" }),
    ...overrides,
  };
}

function noopQuota(): QuotaBackend {
  return {
    async consume() {
      return { allowed: true };
    },
    async refund() {},
  };
}

function makeApp() {
  return createApp({
    fetch: (async () => new Response("[]", { status: 200 })) as unknown as typeof fetch,
    quota: () => noopQuota(),
  });
}

describe("app routing", () => {
  it("POST /api/themes reaches the theme handler", async () => {
    const app = makeApp();
    const response = await app.fetch(
      new Request("https://worker.test/api/themes", {
        method: "POST",
        headers: {
          origin: ALLOWED_ORIGIN,
          "content-type": "application/json",
          "cf-connecting-ip": "203.0.113.5",
        },
        body: JSON.stringify({ theme: "Vision Transformer" }),
      }),
      makeEnv(),
    );
    expect(response.status).toBe(200);
  });

  it("GET /api/themes/status stays dormant (503)", async () => {
    const app = makeApp();
    const response = await app.fetch(
      new Request("https://worker.test/api/themes/status"),
      makeEnv(),
    );
    expect(response.status).toBe(503);
  });

  it("GET /api/health responds 200 with the closed field set", async () => {
    const app = makeApp();
    const response = await app.fetch(new Request("https://worker.test/api/health"), makeEnv());
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(
      ["accepting", "dispatch_mode", "kv_namespace_tag", "pat_configured"].sort(),
    );
  });

  it("OPTIONS /api/* preflights with the theme CORS contract when origin matches", async () => {
    const app = makeApp();
    const response = await app.fetch(
      new Request("https://worker.test/api/themes", {
        method: "OPTIONS",
        headers: { origin: ALLOWED_ORIGIN },
      }),
      makeEnv(),
    );
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe(ALLOWED_ORIGIN);
    expect(response.headers.get("access-control-allow-methods")).toBe("GET, POST, OPTIONS");
  });

  it("OPTIONS /api/* returns 403 with no ACAO when origin does not match", async () => {
    const app = makeApp();
    const response = await app.fetch(
      new Request("https://worker.test/api/themes", {
        method: "OPTIONS",
        headers: { origin: "https://example.test" },
      }),
      makeEnv(),
    );
    expect(response.status).toBe(403);
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("unknown API path -> 404 with the exact plain-text body, no CORS headers", async () => {
    const app = makeApp();
    const response = await app.fetch(new Request("https://worker.test/api/unknown"), makeEnv());
    expect(response.status).toBe(404);
    expect(await response.text()).toBe("Not Found");
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("GET /api/themes (wrong method) -> 404, not 405", async () => {
    const app = makeApp();
    const response = await app.fetch(new Request("https://worker.test/api/themes"), makeEnv());
    expect(response.status).toBe(404);
  });

  it("non-API requests remain not found", async () => {
    const app = makeApp();
    const response = await app.fetch(new Request("https://worker.test/themes/"), makeEnv());
    expect(response.status).toBe(404);
    expect(await response.text()).toBe("Not Found");
  });

  it("/api/paper-slides* is 404 — no adapter is wired in this phase (out of scope)", async () => {
    const app = makeApp();
    const response = await app.fetch(
      new Request("https://worker.test/api/paper-slides", { method: "POST" }),
      makeEnv(),
    );
    expect(response.status).toBe(404);
  });

  // Ported from worker/entrypoint.test.mjs's "Paper Slide namespace
  // near-misses never inherit generic theme CORS": OPTIONS on any
  // /api/paper-slides* path must stay a plain 404, never the theme
  // preflight's 204 + echoed ACAO, even when the Origin matches the
  // allowlist.
  it("OPTIONS on /api/paper-slides* near-misses never inherit the theme CORS preflight", async () => {
    const app = makeApp();
    for (const path of [
      "/api/paper-slides",
      "/api/paper-slides/",
      "/api/paper-slides/status",
      "/api/paper-slides/internal/claim",
      "/api/paper-slides-status",
    ]) {
      const response = await app.fetch(
        new Request(`https://worker.test${path}`, {
          method: "OPTIONS",
          headers: { origin: ALLOWED_ORIGIN },
        }),
        makeEnv(),
      );
      expect(response.status, path).toBe(404);
      expect(response.headers.get("access-control-allow-origin"), path).toBeNull();
    }
  });
});
