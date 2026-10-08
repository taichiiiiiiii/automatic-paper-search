// New tests for the OPTIONS /api/* preflight, adapted from
// worker/entrypoint.test.mjs's "generic API preflight keeps the theme CORS
// contract" — CHANGED per §4.2-6: a mismatched/unreadable-allowlist Origin
// now 403s instead of always echoing a single fixed origin.

import { describe, expect, it } from "vitest";
import { KV_KEY_ORIGIN_ALLOWLIST } from "../../src/config.js";
import { themePreflight } from "../../src/lib/preflight.js";

function fakeKv(store: Record<string, string> = {}) {
  return {
    async get(key: string) {
      return key in store ? store[key]! : null;
    },
  };
}

describe("themePreflight", () => {
  it("matched origin -> 204 with echoed ACAO, Vary, and the fixed CORS headers", async () => {
    const kv = fakeKv({ [KV_KEY_ORIGIN_ALLOWLIST]: JSON.stringify(["https://a.test"]) });
    const request = new Request("https://worker.test/api/themes", {
      method: "OPTIONS",
      headers: { origin: "https://a.test" },
    });
    const response = await themePreflight(request, kv);
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe("https://a.test");
    expect(response.headers.get("vary")).toBe("Origin");
    expect(response.headers.get("access-control-allow-methods")).toBe("GET, POST, OPTIONS");
    expect(response.headers.get("access-control-allow-headers")).toBe("content-type");
    expect(response.headers.get("access-control-max-age")).toBe("86400");
  });

  it("mismatched origin -> 403, no ACAO", async () => {
    const kv = fakeKv({ [KV_KEY_ORIGIN_ALLOWLIST]: JSON.stringify(["https://a.test"]) });
    const request = new Request("https://worker.test/api/themes", {
      method: "OPTIONS",
      headers: { origin: "https://evil.test" },
    });
    const response = await themePreflight(request, kv);
    expect(response.status).toBe(403);
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("unreadable allowlist -> 403", async () => {
    const kv = {
      async get(): Promise<string | null> {
        throw new Error("down");
      },
    };
    const request = new Request("https://worker.test/api/themes", {
      method: "OPTIONS",
      headers: { origin: "https://a.test" },
    });
    expect((await themePreflight(request, kv)).status).toBe(403);
  });
});
