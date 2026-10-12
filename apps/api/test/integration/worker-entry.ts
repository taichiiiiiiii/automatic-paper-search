// Test-only Worker entry for the request-flow integration test
// (apps/web/e2e-integration, `pnpm --filter @paperpilot/web e2e:request-flow`).
// NEVER deployed: it is only referenced by test/integration/wrangler.integration.jsonc,
// which `wrangler dev --local` runs on a developer machine / CI runner.
//
// It wires the REAL app (createApp + the real SQLite Durable Object quota and
// in-flight dedup +
// the real local KV binding) exactly like src/index.ts, with two test seams:
//
//  1. Outbound fetch: GitHub hosts are rewritten to the mock GitHub server
//     (MOCK_GITHUB_ORIGIN, a plain Node server started by Playwright) —
//     `https://api.github.com/<p>` -> `<mock>/api.github.com/<p>` and
//     `https://raw.githubusercontent.com/<p>` -> `<mock>/raw/<p>`. Any other
//     host throws, so a test can never reach a real endpoint.
//  2. Client IP: workerd's local dev does not set `cf-connecting-ip` the way
//     the edge does, so this entry sets it from the `test_client_ip` KV key
//     (default 203.0.113.10). Tests change it to get a fresh per-IP bucket.
//
// `/__test/kv` (PUT `{key, value}` / DELETE `{key}`) lets the test seed the
// origin allowlist / accept switch in the same local KV namespace the app
// reads. These routes exist only in this file.

import { createApp } from "../../src/app.js";
import {
  productionInflightBackend,
  productionQuotaBackend,
} from "../../src/durable/quota-object.js";
import type { Env } from "../../src/types.js";

export { QuotaCounter } from "../../src/durable/quota-object.js";

interface IntegrationEnv extends Env {
  MOCK_GITHUB_ORIGIN: string;
}

type WritableKv = Env["CONFIG_KV"] & {
  put(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
};

const DEFAULT_CLIENT_IP = "203.0.113.10";

function mockFetch(mockOrigin: string): typeof fetch {
  return (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = input instanceof Request ? input.url : String(input);
    const url = new URL(raw);
    let target: string;
    if (url.hostname === "api.github.com") {
      target = `${mockOrigin}/api.github.com${url.pathname}${url.search}`;
    } else if (url.hostname === "raw.githubusercontent.com") {
      target = `${mockOrigin}/raw${url.pathname}${url.search}`;
    } else {
      return Promise.reject(new Error(`integration worker: unexpected outbound host ${url.host}`));
    }
    return fetch(target, init);
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export default {
  async fetch(request: Request, env: IntegrationEnv): Promise<Response> {
    const url = new URL(request.url);
    const kv = env.CONFIG_KV as WritableKv;

    if (url.pathname === "/__test/kv") {
      const body = (await request.json()) as { key: string; value?: string };
      if (request.method === "PUT" && typeof body.value === "string") {
        await kv.put(body.key, body.value);
        return json({ ok: true });
      }
      if (request.method === "DELETE") {
        await kv.delete(body.key);
        return json({ ok: true });
      }
      return json({ ok: false }, 400);
    }

    const ip = (await kv.get("test_client_ip")) ?? DEFAULT_CLIENT_IP;
    const headers = new Headers(request.headers);
    headers.set("cf-connecting-ip", ip);
    const forwarded = new Request(request, { headers });

    const app = createApp({
      fetch: mockFetch(env.MOCK_GITHUB_ORIGIN),
      quota: (e: Env) => {
        if (!e.QUOTA) throw new TypeError("QUOTA binding missing");
        return productionQuotaBackend(e.QUOTA);
      },
      inflight: (e: Env) => {
        if (!e.QUOTA) throw new TypeError("QUOTA binding missing");
        return productionInflightBackend(e.QUOTA);
      },
    });
    return app.fetch(forwarded, env);
  },
} satisfies ExportedHandler<IntegrationEnv>;
