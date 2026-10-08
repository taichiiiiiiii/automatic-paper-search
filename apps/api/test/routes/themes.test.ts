// Ported from worker/themes-post.test.mjs, plus new tests for the §4.2-6
// (origin allowlist), §4.2-7 (accept-stop), §4.5 (dispatch-mode), and §5
// (Durable-Object quota + refund-on-failure) gates that did not exist in
// the original Worker. Every assertion that had to change because of a new
// gate is marked `// CHANGED (§...)`.
//
// CHANGED overall: the fixed PAGES_ORIGIN constant is gone — origin is now
// resolved from a KV-backed allowlist (src/lib/kv-flags.ts). "must not
// touch KV" assertions from the original suite are re-expressed as "must
// not charge quota" (`quota.calls`), since the origin/accepting checks are
// now themselves KV reads that legitimately happen before body/manifest
// work — see test/lib/kv-flags.test.ts and test/lib/preflight.test.ts for
// the KV-read-ordering contract itself.
// CHANGED: request-id-generation-failure is exercised via the injected
// `randomUUID` dependency instead of monkey-patching `globalThis.crypto`.

import { describe, expect, it } from "vitest";
import type { ConsumeResult, QuotaBackend } from "../../src/lib/quota.js";
import {
  createThemeStatusHandler,
  createThemesPostHandler,
  MAX_BODY_BYTES,
} from "../../src/routes/themes.js";
import type { Env } from "../../src/types.js";

const ALLOWED_ORIGIN = "https://taichiiiiiiii.github.io";
const PREVIEW_ORIGIN = "https://preview.pages.dev";
const PAT = "ghp_super-secret-dispatch-token";

function fakeKv(store: Record<string, string> = {}) {
  return {
    async get(key: string) {
      return key in store ? store[key]! : null;
    },
  };
}

function defaultFlagsKv(overrides: Record<string, string> = {}) {
  return fakeKv({
    origin_allowlist: JSON.stringify([ALLOWED_ORIGIN, PREVIEW_ORIGIN]),
    accepting: "true",
    ...overrides,
  });
}

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    GH_OWNER: "taichiiiiiiii",
    GH_REPO: "automatic-paper-search",
    GH_WORKFLOW_FILE: "theme-on-demand.yml",
    GH_REF: "feat/ts-migration",
    GH_DISPATCH_PAT: PAT,
    DISPATCH_MODE: "live",
    CONFIG_KV: defaultFlagsKv(),
    ...overrides,
  };
}

function makeQuota(opts: { consumeResult?: ConsumeResult; throws?: Error } = {}) {
  const calls: string[] = [];
  const backend: QuotaBackend = {
    async consume(ip: string) {
      calls.push(`consume:${ip}`);
      if (opts.throws) throw opts.throws;
      return opts.consumeResult ?? { allowed: true };
    },
    async refund(ip: string) {
      calls.push(`refund:${ip}`);
    },
  };
  return Object.assign(backend, { calls });
}

// Programmable fetch stub keyed by URL prefix — same shape as
// worker/themes-post.test.mjs's makeFetch.
function makeFetch({
  manifest,
  dispatch,
}: {
  manifest?: {
    throws?: Error;
    response?: Response;
    fn?: (url: string, init: RequestInit) => Response | Promise<Response>;
  };
  dispatch?: {
    throws?: Error;
    response?: Response;
    fn?: (url: string, init: RequestInit) => Response | Promise<Response>;
  };
} = {}) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const impl = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init: init ?? {} });
    if (url.startsWith("https://raw.githubusercontent.com")) {
      if (manifest?.fn) return manifest.fn(url, init ?? {});
      if (manifest?.throws) throw manifest.throws;
      return manifest?.response ?? new Response("[]", { status: 200 });
    }
    if (url.startsWith("https://api.github.com")) {
      if (dispatch?.fn) return dispatch.fn(url, init ?? {});
      if (dispatch?.throws) throw dispatch.throws;
      return dispatch?.response ?? new Response(null, { status: 204 });
    }
    throw new Error(`unexpected fetch url: ${url}`);
  }) as unknown as typeof fetch;
  (impl as unknown as { calls: typeof calls }).calls = calls;
  return impl as typeof fetch & { calls: typeof calls };
}

function postRequest(
  body: unknown = { theme: "Vision Transformer" },
  headers: Record<string, string> = {},
) {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return new Request("https://worker.test/api/themes", {
    method: "POST",
    headers: {
      origin: ALLOWED_ORIGIN,
      "content-type": "application/json",
      "cf-connecting-ip": "203.0.113.5",
      ...headers,
    },
    body: text,
  });
}

async function readJson(response: Response) {
  return JSON.parse(await response.text());
}

function handlerWith(opts: {
  fetchImpl?: typeof fetch;
  quota?: QuotaBackend;
  randomUUID?: () => string;
  log?: (m: string) => void;
  refundOnDispatchFailure?: boolean;
}) {
  const fetchImpl = opts.fetchImpl ?? makeFetch();
  const quota = opts.quota ?? makeQuota();
  return createThemesPostHandler({
    fetch: fetchImpl,
    quota: () => quota,
    randomUUID: opts.randomUUID,
    log: opts.log,
    refundOnDispatchFailure: opts.refundOnDispatchFailure,
  });
}

// ---- construction ----

describe("createThemesPostHandler construction", () => {
  it("requires an injected fetch", () => {
    expect(() => createThemesPostHandler({ quota: () => makeQuota() } as never)).toThrow(TypeError);
  });
  it("requires an injected quota factory", () => {
    expect(() => createThemesPostHandler({ fetch: makeFetch() } as never)).toThrow(TypeError);
  });
});

// ---- §4.2-6: origin allowlist (supersedes M-1's fixed-origin gate) ----

describe("origin allowlist gate", () => {
  it("rejects a mismatched Origin, 403, before any fetch or quota charge", async () => {
    const fetchImpl = makeFetch();
    const quota = makeQuota();
    const handlePost = handlerWith({ fetchImpl, quota });
    const request = postRequest(
      { theme: "Vision Transformer" },
      { origin: "https://evil.example" },
    );
    const response = await handlePost(request, makeEnv());
    expect(response.status).toBe(403);
    expect((await readJson(response)).ok).toBe(false);
    expect(fetchImpl.calls.length).toBe(0);
    expect(quota.calls.length).toBe(0);
  });

  it("rejects a missing Origin header, 403", async () => {
    const fetchImpl = makeFetch();
    const handlePost = handlerWith({ fetchImpl });
    const request = new Request("https://worker.test/api/themes", {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.5" },
      body: JSON.stringify({ theme: "Vision Transformer" }),
    });
    const response = await handlePost(request, makeEnv());
    expect(response.status).toBe(403);
    expect(fetchImpl.calls.length).toBe(0);
  });

  // CHANGED (§4.2-6): no ACAO on a mismatch — there is nothing matched to
  // echo (the original always echoed the single fixed PAGES_ORIGIN).
  it("origin rejection carries Vary: Origin but no ACAO", async () => {
    const handlePost = handlerWith({});
    const request = postRequest({ theme: "x" }, { origin: "https://evil.example" });
    const response = await handlePost(request, makeEnv());
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
    expect(response.headers.get("vary")).toBe("Origin");
  });

  it("rejects when the allowlist is unreadable, 403, no charge", async () => {
    const throwingKv = {
      async get(): Promise<string | null> {
        throw new Error("down");
      },
    };
    const quota = makeQuota();
    const handlePost = handlerWith({ quota });
    const response = await handlePost(postRequest(), makeEnv({ CONFIG_KV: throwingKv }));
    expect(response.status).toBe(403);
    expect(quota.calls.length).toBe(0);
  });
});

// ---- §4.2-7: accept-stop switch ----

describe("accept-stop gate", () => {
  it("paused when the flag is missing -> 503, no charge, no fetch", async () => {
    const fetchImpl = makeFetch();
    const quota = makeQuota();
    const handlePost = handlerWith({ fetchImpl, quota });
    const response = await handlePost(
      postRequest(),
      makeEnv({ CONFIG_KV: fakeKv({ origin_allowlist: JSON.stringify([ALLOWED_ORIGIN]) }) }),
    );
    expect(response.status).toBe(503);
    expect((await readJson(response)).status).toBe("paused");
    expect(fetchImpl.calls.length).toBe(0);
    expect(quota.calls.length).toBe(0);
  });

  it("paused when the flag is anything other than the exact string 'true'", async () => {
    const handlePost = handlerWith({});
    const response = await handlePost(
      postRequest(),
      makeEnv({ CONFIG_KV: defaultFlagsKv({ accepting: "false" }) }),
    );
    expect(response.status).toBe(503);
    expect((await readJson(response)).status).toBe("paused");
  });

  it("paused response still echoes the resolved origin's CORS headers", async () => {
    const handlePost = handlerWith({});
    const response = await handlePost(
      postRequest(),
      makeEnv({ CONFIG_KV: defaultFlagsKv({ accepting: "false" }) }),
    );
    expect(response.headers.get("access-control-allow-origin")).toBe(ALLOWED_ORIGIN);
    expect(response.headers.get("vary")).toBe("Origin");
  });
});

// ---- M-1: content-type gate ----

describe("content-type gate", () => {
  it("rejects a non-JSON content-type, 415, before any fetch or quota charge", async () => {
    const fetchImpl = makeFetch();
    const quota = makeQuota();
    const handlePost = handlerWith({ fetchImpl, quota });
    const request = postRequest({ theme: "Vision Transformer" }, { "content-type": "text/plain" });
    const response = await handlePost(request, makeEnv());
    expect(response.status).toBe(415);
    expect(fetchImpl.calls.length).toBe(0);
    expect(quota.calls.length).toBe(0);
  });

  it("accepts application/json with a charset parameter", async () => {
    const handlePost = handlerWith({});
    const request = postRequest(
      { theme: "Vision Transformer" },
      { "content-type": "application/json; charset=utf-8" },
    );
    const response = await handlePost(request, makeEnv());
    expect(response.status).toBe(200);
  });

  it("rejects a missing content-type header, 415", async () => {
    const handlePost = handlerWith({});
    const request = new Request("https://worker.test/api/themes", {
      method: "POST",
      headers: { origin: ALLOWED_ORIGIN, "cf-connecting-ip": "203.0.113.5" },
      body: JSON.stringify({ theme: "Vision Transformer" }),
    });
    expect((await handlePost(request, makeEnv())).status).toBe(415);
  });

  it("rejects content-type application/json-seq, 415", async () => {
    const fetchImpl = makeFetch();
    const handlePost = handlerWith({ fetchImpl });
    const request = postRequest(
      { theme: "Vision Transformer" },
      { "content-type": "application/json-seq" },
    );
    expect((await handlePost(request, makeEnv())).status).toBe(415);
    expect(fetchImpl.calls.length).toBe(0);
  });

  it("rejects content-type application/jsonp, 415", async () => {
    const handlePost = handlerWith({});
    const request = postRequest(
      { theme: "Vision Transformer" },
      { "content-type": "application/jsonp" },
    );
    expect((await handlePost(request, makeEnv())).status).toBe(415);
  });
});

// ---- L-6: body size gate ----

describe("body size gate", () => {
  it("rejects a declared content-length over 1KB, 413, without reading the body", async () => {
    const fetchImpl = makeFetch();
    const quota = makeQuota();
    const handlePost = handlerWith({ fetchImpl, quota });
    let pulled = false;
    const stream = new ReadableStream(
      {
        pull(controller) {
          pulled = true;
          controller.enqueue(new TextEncoder().encode(JSON.stringify({ theme: "x".repeat(2000) })));
          controller.close();
        },
      },
      { highWaterMark: 0 },
    );
    const request = new Request("https://worker.test/api/themes", {
      method: "POST",
      headers: {
        origin: ALLOWED_ORIGIN,
        "content-type": "application/json",
        "cf-connecting-ip": "203.0.113.5",
        "content-length": String(MAX_BODY_BYTES + 1),
      },
      body: stream,
      duplex: "half",
    } as unknown as RequestInit);
    const response = await handlePost(request, makeEnv());
    expect(response.status).toBe(413);
    expect(fetchImpl.calls.length).toBe(0);
    expect(quota.calls.length).toBe(0);
    expect(pulled).toBe(false);
  });

  it("rejects a body that streams past 1KB even without content-length", async () => {
    const fetchImpl = makeFetch();
    const handlePost = handlerWith({ fetchImpl });
    const oversized = JSON.stringify({ theme: "x".repeat(2000) });
    const request = new Request("https://worker.test/api/themes", {
      method: "POST",
      headers: {
        origin: ALLOWED_ORIGIN,
        "content-type": "application/json",
        "cf-connecting-ip": "203.0.113.5",
      },
      body: oversized,
    });
    expect((await handlePost(request, makeEnv())).status).toBe(413);
    expect(fetchImpl.calls.length).toBe(0);
  });

  it("accepts a body exactly at the 1KB boundary", async () => {
    const base = JSON.stringify({ theme: "Vision Transformer", pad: "" });
    const padLen = MAX_BODY_BYTES - base.length;
    const body = JSON.stringify({ theme: "Vision Transformer", pad: "x".repeat(padLen) });
    expect(body.length).toBe(MAX_BODY_BYTES);
    const handlePost = handlerWith({});
    const request = postRequest(body, { "content-length": String(body.length) });
    expect((await handlePost(request, makeEnv())).status).toBe(200);
  });
});

// ---- parse / validation ----

describe("parse and validation", () => {
  it("invalid JSON body -> 400 invalid, before manifest/quota", async () => {
    const fetchImpl = makeFetch();
    const quota = makeQuota();
    const handlePost = handlerWith({ fetchImpl, quota });
    const response = await handlePost(postRequest("not json"), makeEnv());
    expect(response.status).toBe(400);
    expect((await readJson(response)).status).toBe("invalid");
    expect(fetchImpl.calls.length).toBe(0);
    expect(quota.calls.length).toBe(0);
  });

  it("invalid theme pattern -> 400 invalid, before manifest/quota", async () => {
    const fetchImpl = makeFetch();
    const quota = makeQuota();
    const handlePost = handlerWith({ fetchImpl, quota });
    const response = await handlePost(postRequest({ theme: "$(rm -rf ~)" }), makeEnv());
    expect(response.status).toBe(400);
    expect((await readJson(response)).status).toBe("invalid");
    expect(fetchImpl.calls.length).toBe(0);
    expect(quota.calls.length).toBe(0);
  });
});

// ---- §4.5: dispatch-mode sanity ----

describe("dispatch-mode gate", () => {
  // CHANGED (per-task review): the dispatch-mode check now runs AFTER the
  // manifest dedup (so an already-"exists" theme still gets a true answer
  // even when DISPATCH_MODE/PAT are misconfigured — see the order note at
  // the top of src/routes/themes.ts) — so these all see exactly one fetch
  // call (the manifest read), never two, and still zero quota charge.

  it("unconfigured DISPATCH_MODE -> 503, one manifest read, no quota charge", async () => {
    const fetchImpl = makeFetch();
    const quota = makeQuota();
    const handlePost = handlerWith({ fetchImpl, quota });
    const response = await handlePost(postRequest(), makeEnv({ DISPATCH_MODE: undefined }));
    expect(response.status).toBe(503);
    expect(fetchImpl.calls.length).toBe(1);
    expect(quota.calls.length).toBe(0);
  });

  it("live mode with a missing PAT -> 503, no charge", async () => {
    const fetchImpl = makeFetch();
    const quota = makeQuota();
    const handlePost = handlerWith({ fetchImpl, quota });
    const response = await handlePost(
      postRequest(),
      makeEnv({ DISPATCH_MODE: "live", GH_DISPATCH_PAT: undefined }),
    );
    expect(response.status).toBe(503);
    expect(fetchImpl.calls.length).toBe(1);
    expect(quota.calls.length).toBe(0);
  });

  it("dry-run mode refuses when GH_REF is develop, 503, no charge", async () => {
    const fetchImpl = makeFetch();
    const quota = makeQuota();
    const handlePost = handlerWith({ fetchImpl, quota });
    const response = await handlePost(
      postRequest(),
      makeEnv({ DISPATCH_MODE: "dry-run", GH_REF: "develop" }),
    );
    expect(response.status).toBe(503);
    expect(fetchImpl.calls.length).toBe(1);
    expect(quota.calls.length).toBe(0);
  });

  it("dry-run mode refuses for the production origin, 503, no charge", async () => {
    const fetchImpl = makeFetch();
    const quota = makeQuota();
    const handlePost = handlerWith({ fetchImpl, quota });
    const response = await handlePost(
      postRequest({ theme: "Vision Transformer" }, { origin: ALLOWED_ORIGIN }),
      makeEnv({ DISPATCH_MODE: "dry-run", GH_REF: "feat/ts-migration" }),
    );
    expect(response.status).toBe(503);
    expect(fetchImpl.calls.length).toBe(1);
    expect(quota.calls.length).toBe(0);
  });

  it("dispatch-mode misconfiguration does not block the exists short-circuit", async () => {
    const fetchImpl = makeFetch({
      manifest: {
        response: new Response(JSON.stringify([{ slug: "vision-transformer" }]), { status: 200 }),
      },
    });
    const quota = makeQuota();
    const handlePost = handlerWith({ fetchImpl, quota });
    const response = await handlePost(
      postRequest({ theme: "Vision Transformer" }),
      makeEnv({ DISPATCH_MODE: undefined }),
    );
    expect(response.status).toBe(200);
    const body = await readJson(response);
    expect(body.status).toBe("exists");
    expect(quota.calls.length).toBe(0);
  });

  it("dry-run mode off a preview origin/ref succeeds with status dry_run, never queued", async () => {
    const fetchImpl = makeFetch();
    const handlePost = handlerWith({ fetchImpl });
    const response = await handlePost(
      postRequest({ theme: "Vision Transformer" }, { origin: PREVIEW_ORIGIN }),
      makeEnv({
        DISPATCH_MODE: "dry-run",
        GH_REF: "feat/ts-migration",
        GH_DISPATCH_PAT: undefined,
      }),
    );
    expect(response.status).toBe(200);
    const body = await readJson(response);
    expect(body.status).toBe("dry_run");
    expect(body.status).not.toBe("queued");
    // Only the manifest fetch happens — dry-run never calls the GitHub dispatch endpoint.
    expect(fetchImpl.calls.length).toBe(1);
  });
});

// ---- H-1: manifest-failure fail-closed contract ----

describe("manifest dedup", () => {
  it("fetch throw -> 503 error (not exists), no quota charge, no dispatch", async () => {
    const fetchImpl = makeFetch({ manifest: { throws: new Error("network down") } });
    const quota = makeQuota();
    const handlePost = handlerWith({ fetchImpl, quota });
    const response = await handlePost(postRequest(), makeEnv());
    expect(response.status).toBe(503);
    const body = await readJson(response);
    expect(body.ok).toBe(false);
    expect(body.status).toBe("error");
    expect(quota.calls.length).toBe(0);
    expect(fetchImpl.calls.length).toBe(1);
  });

  it("non-ok response -> 503 error", async () => {
    const fetchImpl = makeFetch({
      manifest: { response: new Response("gateway timeout", { status: 504 }) },
    });
    const handlePost = handlerWith({ fetchImpl });
    const response = await handlePost(postRequest(), makeEnv());
    expect(response.status).toBe(503);
    expect((await readJson(response)).status).toBe("error");
  });

  it("JSON parse error -> 503 error", async () => {
    const fetchImpl = makeFetch({
      manifest: { response: new Response("not json", { status: 200 }) },
    });
    const handlePost = handlerWith({ fetchImpl });
    expect((await handlePost(postRequest(), makeEnv())).status).toBe(503);
  });

  it("valid JSON that is not an array -> 503 error", async () => {
    const fetchImpl = makeFetch({
      manifest: {
        response: new Response(JSON.stringify({ slug: "vision-transformer" }), { status: 200 }),
      },
    });
    const handlePost = handlerWith({ fetchImpl });
    expect((await handlePost(postRequest(), makeEnv())).status).toBe(503);
  });

  it("array containing the slug -> exists, no quota charge, no dispatch", async () => {
    const fetchImpl = makeFetch({
      manifest: {
        response: new Response(JSON.stringify([{ slug: "vision-transformer" }]), { status: 200 }),
      },
    });
    const quota = makeQuota();
    const handlePost = handlerWith({ fetchImpl, quota });
    const response = await handlePost(postRequest({ theme: "Vision Transformer" }), makeEnv());
    expect(response.status).toBe(200);
    const body = await readJson(response);
    expect(body.ok).toBe(true);
    expect(body.status).toBe("exists");
    expect(body.slug).toBe("vision-transformer");
    expect(quota.calls.length).toBe(0);
    expect(fetchImpl.calls.length).toBe(1);
  });

  it("array without the slug -> proceeds to dispatch (queued)", async () => {
    const fetchImpl = makeFetch({
      manifest: { response: new Response(JSON.stringify([{ slug: "other" }]), { status: 200 }) },
    });
    const handlePost = handlerWith({ fetchImpl });
    const response = await handlePost(postRequest({ theme: "Vision Transformer" }), makeEnv());
    expect(response.status).toBe(200);
    expect((await readJson(response)).status).toBe("queued");
    expect(fetchImpl.calls.length).toBe(2);
  });

  it("3xx under redirect: manual -> 503 error, no dispatch", async () => {
    const fetchImpl = makeFetch({
      manifest: {
        response: new Response(null, {
          status: 302,
          headers: { location: "https://attacker.test/" },
        }),
      },
    });
    const handlePost = handlerWith({ fetchImpl });
    const response = await handlePost(postRequest(), makeEnv());
    expect(response.status).toBe(503);
    expect(fetchImpl.calls.filter((c) => c.url.startsWith("https://api.github.com")).length).toBe(
      0,
    );
  });

  it("manifest fetch passes redirect: manual", async () => {
    const fetchImpl = makeFetch();
    const handlePost = handlerWith({ fetchImpl });
    await handlePost(postRequest(), makeEnv());
    const manifestCall = fetchImpl.calls.find((c) =>
      c.url.startsWith("https://raw.githubusercontent.com"),
    );
    expect(manifestCall?.init.redirect).toBe("manual");
  });
});

// ---- cf-connecting-ip + quota ----

describe("cf-connecting-ip and quota", () => {
  it("missing cf-connecting-ip -> 400, after manifest, before any quota call", async () => {
    const fetchImpl = makeFetch();
    const quota = makeQuota();
    const handlePost = handlerWith({ fetchImpl, quota });
    const request = postRequest({ theme: "Vision Transformer" }, { "cf-connecting-ip": "" });
    const response = await handlePost(request, makeEnv());
    expect(response.status).toBe(400);
    expect(fetchImpl.calls.length).toBe(1);
    expect(quota.calls.length).toBe(0);
  });

  it("per-IP cap reached -> 429, no dispatch", async () => {
    const fetchImpl = makeFetch();
    const quota = makeQuota({ consumeResult: { allowed: false, limitedBy: "ip" } });
    const handlePost = handlerWith({ fetchImpl, quota });
    const response = await handlePost(postRequest(), makeEnv());
    expect(response.status).toBe(429);
    expect(fetchImpl.calls.length).toBe(1);
  });

  it("global daily cap reached -> 429, no dispatch", async () => {
    const fetchImpl = makeFetch();
    const quota = makeQuota({ consumeResult: { allowed: false, limitedBy: "global" } });
    const handlePost = handlerWith({ fetchImpl, quota });
    const response = await handlePost(postRequest(), makeEnv());
    expect(response.status).toBe(429);
    expect(fetchImpl.calls.length).toBe(1);
  });

  it("quota backend throw -> 503 JSON error with CORS headers, no dispatch", async () => {
    const fetchImpl = makeFetch();
    const quota = makeQuota({ throws: new Error("DO unreachable") });
    const handlePost = handlerWith({ fetchImpl, quota });
    const response = await handlePost(postRequest(), makeEnv());
    expect(response.status).toBe(503);
    expect(response.headers.get("access-control-allow-origin")).toBe(ALLOWED_ORIGIN);
    expect(response.headers.get("vary")).toBe("Origin");
    expect((await readJson(response)).ok).toBe(false);
    expect(fetchImpl.calls.length).toBe(1);
  });
});

// ---- request-id generation failure ----

describe("request-id generation", () => {
  it("failure -> 500, no dispatch", async () => {
    const fetchImpl = makeFetch();
    const handlePost = handlerWith({
      fetchImpl,
      randomUUID: () => {
        throw new Error("entropy unavailable");
      },
    });
    const response = await handlePost(postRequest(), makeEnv());
    expect(response.status).toBe(500);
    expect(fetchImpl.calls.length).toBe(1);
  });
});

// ---- dispatch failure / refund ----

describe("dispatch failure and §5 refund-on-failure", () => {
  it("dispatchWorkflow throw -> 502 JSON error, not an uncaught exception, never leaks the PAT", async () => {
    const fetchImpl = makeFetch({ dispatch: { throws: new Error("fetch failed") } });
    const handlePost = handlerWith({ fetchImpl });
    const response = await handlePost(postRequest(), makeEnv());
    expect(response.status).toBe(502);
    const body = await readJson(response);
    expect(body.ok).toBe(false);
    expect(JSON.stringify(body)).not.toContain(PAT);
  });

  it("dispatchWorkflow non-ok response -> 502 JSON error", async () => {
    const fetchImpl = makeFetch({ dispatch: { response: new Response("nope", { status: 500 }) } });
    const handlePost = handlerWith({ fetchImpl });
    const response = await handlePost(postRequest(), makeEnv());
    expect(response.status).toBe(502);
    expect((await readJson(response)).ok).toBe(false);
  });

  it("neither dispatch throw nor failure logs the PAT", async () => {
    const logged: string[] = [];
    const fetchImpl1 = makeFetch({ dispatch: { throws: new Error("boom") } });
    await handlerWith({ fetchImpl: fetchImpl1, log: (m) => logged.push(m) })(
      postRequest(),
      makeEnv(),
    );
    const fetchImpl2 = makeFetch({
      dispatch: { response: new Response("server detail", { status: 502 }) },
    });
    await handlerWith({ fetchImpl: fetchImpl2, log: (m) => logged.push(m) })(
      postRequest({ theme: "Other Theme" }),
      makeEnv(),
    );
    for (const line of logged) expect(line).not.toContain(PAT);
  });

  it("dispatch 3xx under redirect: manual -> 502 error", async () => {
    const fetchImpl = makeFetch({
      dispatch: {
        response: new Response(null, {
          status: 307,
          headers: { location: "https://attacker.test/" },
        }),
      },
    });
    const handlePost = handlerWith({ fetchImpl });
    expect((await handlePost(postRequest(), makeEnv())).status).toBe(502);
  });

  it("dispatch fetch passes redirect: manual", async () => {
    const fetchImpl = makeFetch();
    const handlePost = handlerWith({ fetchImpl });
    await handlePost(postRequest(), makeEnv());
    const dispatchCall = fetchImpl.calls.find((c) => c.url.startsWith("https://api.github.com"));
    expect(dispatchCall?.init.redirect).toBe("manual");
  });

  // §5: behind REFUND_ON_DISPATCH_FAILURE, tested both ways per the task's
  // "decision pending" instruction.
  it("REFUND_ON_DISPATCH_FAILURE=false (default): no refund call on dispatch failure", async () => {
    const fetchImpl = makeFetch({ dispatch: { response: new Response("nope", { status: 500 }) } });
    const quota = makeQuota();
    const handlePost = handlerWith({ fetchImpl, quota, refundOnDispatchFailure: false });
    await handlePost(postRequest(), makeEnv());
    expect(quota.calls.filter((c) => c.startsWith("refund:")).length).toBe(0);
  });

  it("REFUND_ON_DISPATCH_FAILURE=true: refunds the IP's quota on dispatch failure", async () => {
    const fetchImpl = makeFetch({ dispatch: { response: new Response("nope", { status: 500 }) } });
    const quota = makeQuota();
    const handlePost = handlerWith({ fetchImpl, quota, refundOnDispatchFailure: true });
    await handlePost(postRequest(), makeEnv());
    expect(quota.calls).toContain("refund:203.0.113.5");
  });

  it("REFUND_ON_DISPATCH_FAILURE=true: also refunds on a dispatch throw", async () => {
    const fetchImpl = makeFetch({ dispatch: { throws: new Error("boom") } });
    const quota = makeQuota();
    const handlePost = handlerWith({ fetchImpl, quota, refundOnDispatchFailure: true });
    await handlePost(postRequest(), makeEnv());
    expect(quota.calls).toContain("refund:203.0.113.5");
  });

  it("a refund backend throw never escapes as an uncaught exception — stays 502 JSON with CORS", async () => {
    const fetchImpl = makeFetch({ dispatch: { response: new Response("nope", { status: 500 }) } });
    const throwingRefundQuota: QuotaBackend = {
      async consume() {
        return { allowed: true };
      },
      async refund() {
        throw new Error("DO refund hiccup");
      },
    };
    const logged: string[] = [];
    const handlePost = handlerWith({
      fetchImpl,
      quota: throwingRefundQuota,
      refundOnDispatchFailure: true,
      log: (m) => logged.push(m),
    });
    const response = await handlePost(postRequest(), makeEnv());
    expect(response.status).toBe(502);
    expect(response.headers.get("access-control-allow-origin")).toBe(ALLOWED_ORIGIN);
    expect((await readJson(response)).ok).toBe(false);
    expect(logged.some((l) => l.includes("DO refund hiccup"))).toBe(true);
  });

  it("never refunds on a successful dispatch", async () => {
    const quota = makeQuota();
    const handlePost = handlerWith({ quota, refundOnDispatchFailure: true });
    await handlePost(postRequest(), makeEnv());
    expect(quota.calls.filter((c) => c.startsWith("refund:")).length).toBe(0);
  });
});

// ---- happy path ----

describe("happy path", () => {
  it("queued response includes slug and server-generated request_id", async () => {
    const fetchImpl = makeFetch();
    const response = await handlerWith({ fetchImpl })(
      postRequest({ theme: "Vision Transformer" }),
      makeEnv(),
    );
    expect(response.status).toBe(200);
    const body = await readJson(response);
    expect(body.ok).toBe(true);
    expect(body.status).toBe("queued");
    expect(body.slug).toBe("vision-transformer");
    expect(/^theme-[0-9a-f-]{36}$/.test(body.request_id)).toBe(true);
    expect(fetchImpl.calls.length).toBe(2);
  });

  it("response carries the resolved-origin CORS headers", async () => {
    const response = await handlerWith({})(postRequest(), makeEnv());
    expect(response.headers.get("access-control-allow-origin")).toBe(ALLOWED_ORIGIN);
    expect(response.headers.get("vary")).toBe("Origin");
  });
});

// ---- GET /api/themes/status (dormant, API-19) ----

describe("GET /api/themes/status (dormant)", () => {
  it("always 503 regardless of origin resolution, performs zero fetches", async () => {
    const handler = createThemeStatusHandler();
    const response = await handler(
      new Request("https://worker.test/api/themes/status", { headers: { origin: ALLOWED_ORIGIN } }),
      makeEnv(),
    );
    expect(response.status).toBe(503);
    expect((await readJson(response)).message).toContain("public manifest");
  });

  it("echoes CORS only when the origin resolves, but never 403s", async () => {
    const handler = createThemeStatusHandler();
    const matched = await handler(
      new Request("https://worker.test/api/themes/status", { headers: { origin: ALLOWED_ORIGIN } }),
      makeEnv(),
    );
    expect(matched.headers.get("access-control-allow-origin")).toBe(ALLOWED_ORIGIN);
    const mismatched = await handler(
      new Request("https://worker.test/api/themes/status", {
        headers: { origin: "https://evil.test" },
      }),
      makeEnv(),
    );
    expect(mismatched.status).toBe(503);
    expect(mismatched.headers.get("access-control-allow-origin")).toBeNull();
  });
});
