// Tests for GET /api/health (new per §4.2-7). Confirms the closed field
// set, that the PAT never appears in the body, and that accepting/
// dispatch_mode reflect the env/KV inputs.

import { describe, expect, it } from "vitest";
import type { HealthBody } from "../../src/routes/health.js";
import { createHealthHandler } from "../../src/routes/health.js";
import type { Env } from "../../src/types.js";

async function readHealth(response: Response): Promise<HealthBody> {
  return (await response.json()) as HealthBody;
}

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
    GH_REF: "develop",
    CONFIG_KV: fakeKv(),
    ...overrides,
  };
}

describe("GET /api/health", () => {
  it("reports accepting:true only when the KV flag is exactly 'true'", async () => {
    const handler = createHealthHandler();
    const env = makeEnv({ CONFIG_KV: fakeKv({ accepting: "true" }) });
    const body = await handler(new Request("https://worker.test/api/health"), env).then(readHealth);
    expect(body.accepting).toBe(true);
  });

  it("reports accepting:false when the flag is missing", async () => {
    const handler = createHealthHandler();
    const body = await handler(new Request("https://worker.test/api/health"), makeEnv()).then(
      readHealth,
    );
    expect(body.accepting).toBe(false);
  });

  it("reports the configured dispatch mode, or 'unconfigured'", async () => {
    const handler = createHealthHandler();
    const live = await handler(
      new Request("https://worker.test/api/health"),
      makeEnv({ DISPATCH_MODE: "live" }),
    ).then(readHealth);
    expect(live.dispatch_mode).toBe("live");
    const unset = await handler(new Request("https://worker.test/api/health"), makeEnv()).then(
      readHealth,
    );
    expect(unset.dispatch_mode).toBe("unconfigured");
  });

  it("reports pat_configured as a boolean, never the PAT value", async () => {
    const handler = createHealthHandler();
    const body = await handler(
      new Request("https://worker.test/api/health"),
      makeEnv({ GH_DISPATCH_PAT: "ghp_super-secret" }),
    ).then((r) => r.text());
    expect(body).not.toContain("ghp_super-secret");
    expect(JSON.parse(body).pat_configured).toBe(true);
  });

  it("returns exactly the four documented fields", async () => {
    const handler = createHealthHandler();
    const body = await handler(
      new Request("https://worker.test/api/health"),
      makeEnv({ CONFIG_KV: fakeKv({ namespace_tag: "preview" }) }),
    ).then(readHealth);
    expect(Object.keys(body).sort()).toEqual(
      ["accepting", "dispatch_mode", "kv_namespace_tag", "pat_configured"].sort(),
    );
    expect(body.kv_namespace_tag).toBe("preview");
  });

  it("kv_namespace_tag is read from the KV binding, not a deploy-time var (§4.2-7)", async () => {
    const handler = createHealthHandler();
    const missing = await handler(new Request("https://worker.test/api/health"), makeEnv()).then(
      readHealth,
    );
    expect(missing.kv_namespace_tag).toBeNull();
    const throwing = await handler(
      new Request("https://worker.test/api/health"),
      makeEnv({
        CONFIG_KV: {
          async get(): Promise<string | null> {
            throw new Error("down");
          },
        },
      }),
    ).then(readHealth);
    expect(throwing.kv_namespace_tag).toBeNull();
  });

  it("is non-cacheable JSON", async () => {
    const handler = createHealthHandler();
    const response = await handler(new Request("https://worker.test/api/health"), makeEnv());
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
  });

  it("adds Access-Control-Allow-Origin only for an allowlisted Origin", async () => {
    const handler = createHealthHandler();
    const env = makeEnv({
      CONFIG_KV: fakeKv({
        accepting: "true",
        origin_allowlist: JSON.stringify(["https://site.test"]),
      }),
    });
    const allowed = await handler(
      new Request("https://worker.test/api/health", { headers: { origin: "https://site.test" } }),
      env,
    );
    expect(allowed.headers.get("access-control-allow-origin")).toBe("https://site.test");
    expect(allowed.headers.get("vary")).toBe("Origin");
    const other = await handler(
      new Request("https://worker.test/api/health", { headers: { origin: "https://evil.test" } }),
      env,
    );
    expect(other.headers.get("access-control-allow-origin")).toBeNull();
    const none = await handler(new Request("https://worker.test/api/health"), env);
    expect(none.headers.get("access-control-allow-origin")).toBeNull();
    expect((await readHealth(none)).accepting).toBe(true);
  });
});
