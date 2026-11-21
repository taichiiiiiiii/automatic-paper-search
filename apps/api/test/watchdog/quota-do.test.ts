// #546: the watchdog probes the quota Durable Object (QUOTA) with the
// read-only `/inflight/peek` route. New theme requests fail closed (503,
// no dispatch) when the DO is unreachable, so the watchdog must notice.
// The DO namespace is a fake injected through Env — no Cloudflare call.

import { describe, expect, it } from "vitest";
import type { Env } from "../../src/types.js";
import {
  checkQuotaDurableObject,
  QUOTA_DO_PROBE_SLUG,
  QUOTA_DO_PROBLEM_KEY,
} from "../../src/watchdog/checks.js";
import { runScheduled, type WatchdogKv } from "../../src/watchdog/scheduled.js";

const PAT = "github_pat_SECRET123";

type StubFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

function fakeNamespace(stubFetch: StubFetch) {
  const names: string[] = [];
  const urls: string[] = [];
  const ns = {
    idFromName(name: string) {
      names.push(name);
      return { name } as unknown as DurableObjectId;
    },
    get(_id: DurableObjectId) {
      return {
        fetch: (input: RequestInfo | URL, init?: RequestInit) => {
          urls.push(String(input));
          return stubFetch(input, init);
        },
      } as unknown as DurableObjectStub;
    },
  } as unknown as DurableObjectNamespace;
  return { ns, names, urls };
}

function envWith(overrides: Partial<Env>): Env {
  return {
    GH_OWNER: "o",
    GH_REPO: "r",
    GH_WORKFLOW_FILE: "theme-on-demand.yml",
    GH_REF: "develop",
    DISPATCH_MODE: "live",
    GH_DISPATCH_PAT: PAT,
    CONFIG_KV: { get: async (k: string) => (k === "accepting" ? "true" : null) },
    ...overrides,
  };
}

const healthy: StubFetch = async () => Response.json({ request_id: null });

describe("checkQuotaDurableObject", () => {
  it("(a) is quiet when the DO answers 200 with JSON", async () => {
    const { ns, names, urls } = fakeNamespace(healthy);
    expect(await checkQuotaDurableObject(envWith({ QUOTA: ns }))).toEqual([]);
    // Same named instance the request path uses, read-only route only.
    expect(names).toEqual(["quota"]);
    expect(urls).toHaveLength(1);
    const url = new URL(urls[0]!);
    expect(url.pathname).toBe("/inflight/peek");
    expect(url.searchParams.get("slug")).toBe(QUOTA_DO_PROBE_SLUG);
  });

  it("(b) reports one problem with a fixed key when the DO call throws", async () => {
    const { ns } = fakeNamespace(async () => {
      throw new Error("Durable Object storage is unavailable");
    });
    const problems = await checkQuotaDurableObject(envWith({ QUOTA: ns }));
    expect(problems).toHaveLength(1);
    expect(problems[0]!.key).toBe(QUOTA_DO_PROBLEM_KEY);
    expect(problems[0]!.message).toContain("Durable Object storage is unavailable");
    expect(problems[0]!.message).not.toContain(PAT);
  });

  it("(b2) reports a problem when idFromName/get itself throws", async () => {
    const ns = {
      idFromName() {
        throw new Error("binding broken");
      },
    } as unknown as DurableObjectNamespace;
    const problems = await checkQuotaDurableObject(envWith({ QUOTA: ns }));
    expect(problems.map((p) => p.key)).toEqual([QUOTA_DO_PROBLEM_KEY]);
    expect(problems[0]!.message).toContain("binding broken");
  });

  it("(c) reports one problem for a non-200 answer", async () => {
    const { ns } = fakeNamespace(async () => new Response("overloaded", { status: 500 }));
    const problems = await checkQuotaDurableObject(envWith({ QUOTA: ns }));
    expect(problems.map((p) => p.key)).toEqual([QUOTA_DO_PROBLEM_KEY]);
    expect(problems[0]!.message).toContain("500");
  });

  it("(c2) reports one problem for a 200 whose body is not JSON", async () => {
    const { ns } = fakeNamespace(async () => new Response("<html>error</html>", { status: 200 }));
    const problems = await checkQuotaDurableObject(envWith({ QUOTA: ns }));
    expect(problems.map((p) => p.key)).toEqual([QUOTA_DO_PROBLEM_KEY]);
  });

  it("(c3) reports one problem for JSON of the wrong shape", async () => {
    const { ns } = fakeNamespace(async () => Response.json({ hello: "world" }));
    const problems = await checkQuotaDurableObject(envWith({ QUOTA: ns }));
    expect(problems.map((p) => p.key)).toEqual([QUOTA_DO_PROBLEM_KEY]);
  });

  it("(c4) reports a timeout when the DO never answers", async () => {
    const { ns } = fakeNamespace(() => new Promise<Response>(() => undefined));
    const problems = await checkQuotaDurableObject(envWith({ QUOTA: ns }), { timeoutMs: 20 });
    expect(problems.map((p) => p.key)).toEqual([QUOTA_DO_PROBLEM_KEY]);
    expect(problems[0]!.message).toContain("20 ms");
  });

  it("(d) without the QUOTA binding: a problem when live, skipped otherwise", async () => {
    const live = await checkQuotaDurableObject(envWith({ QUOTA: undefined }));
    expect(live).toHaveLength(1);
    expect(live[0]!.key).toBe("quota-do:binding");
    expect(
      await checkQuotaDurableObject(envWith({ QUOTA: undefined, DISPATCH_MODE: "dry-run" })),
    ).toEqual([]);
  });
});

describe("runScheduled includes the quota DO probe", () => {
  function kv(): WatchdogKv {
    const store: Record<string, string> = {};
    return {
      async get(k) {
        return store[k] ?? null;
      },
      async put(k, v) {
        store[k] = v;
      },
    };
  }
  const okFetch = async (input: RequestInfo | URL): Promise<Response> => {
    const url = String(input);
    if (url.endsWith("/dispatches")) return new Response(null, { status: 204 });
    if (url.startsWith("https://api.github.com/"))
      return Response.json({
        workflow_runs: [{ id: 1, status: "completed", conclusion: "success" }],
      });
    if (url.startsWith("https://raw.githubusercontent.com/"))
      return new Response("404", { status: 404 });
    if (url.endsWith("/lineage-quality-v1.json"))
      return Response.json({
        collections: [{ kind: "theme", availability: "ready", publication_tier: "unaudited" }],
      });
    return new Response("ok", { status: 200 });
  };

  it("alerts on an unreachable DO and stays quiet on a healthy one", async () => {
    const at = Date.parse("2026-10-13T00:30:00Z"); // Tuesday: no weekly dispatches
    const down = fakeNamespace(async () => {
      throw new Error("DO down");
    });
    const bad = await runScheduled(envWith({ QUOTA: down.ns }), at, {
      fetch: okFetch,
      kv: kv(),
      siteOrigin: "https://site.test",
      now: () => new Date(at),
      log: () => undefined,
    });
    expect(bad.problems.map((p) => p.key)).toEqual([QUOTA_DO_PROBLEM_KEY]);
    expect(bad.decision).toEqual({ action: "problem", reason: "new" });
    expect(bad.alertDispatched).toBe(true);

    const up = fakeNamespace(healthy);
    const good = await runScheduled(envWith({ QUOTA: up.ns }), at, {
      fetch: okFetch,
      kv: kv(),
      siteOrigin: "https://site.test",
      now: () => new Date(at),
      log: () => undefined,
    });
    expect(good.problems).toEqual([]);
    expect(up.urls).toHaveLength(1);
  });
});
