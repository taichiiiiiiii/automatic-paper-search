// Ported from worker/themes-post.test.mjs's H-1 manifest-failure tests
// (API-09/10), isolated to the extracted manifest module.

import { describe, expect, it } from "vitest";
import { alreadyGenerated } from "../../src/lib/manifest.js";

const ENV = { GH_OWNER: "taichiiiiiiii", GH_REPO: "automatic-paper-search", GH_REF: "develop" };

function makeFetch(respond: (url: string, init: RequestInit) => Promise<Response> | Response) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const impl = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init: init ?? {} });
    return respond(url, init ?? {});
  }) as unknown as typeof fetch;
  (impl as unknown as { calls: typeof calls }).calls = calls;
  return impl as typeof fetch & { calls: typeof calls };
}

describe("alreadyGenerated", () => {
  it("fetch throw -> ok:false", async () => {
    const fetchImpl = makeFetch(() => {
      throw new Error("network down");
    });
    expect((await alreadyGenerated("vision-transformer", ENV, fetchImpl)).ok).toBe(false);
  });

  it("non-ok response -> ok:false", async () => {
    const fetchImpl = makeFetch(() => new Response("gateway timeout", { status: 504 }));
    expect((await alreadyGenerated("x", ENV, fetchImpl)).ok).toBe(false);
  });

  it("JSON parse error -> ok:false", async () => {
    const fetchImpl = makeFetch(() => new Response("not json", { status: 200 }));
    expect((await alreadyGenerated("x", ENV, fetchImpl)).ok).toBe(false);
  });

  it("valid JSON that is not an array -> ok:false", async () => {
    const fetchImpl = makeFetch(() => new Response(JSON.stringify({ slug: "x" }), { status: 200 }));
    expect((await alreadyGenerated("x", ENV, fetchImpl)).ok).toBe(false);
  });

  it("array containing the slug -> exists:true", async () => {
    const fetchImpl = makeFetch(
      () => new Response(JSON.stringify([{ slug: "vision-transformer" }]), { status: 200 }),
    );
    const result = await alreadyGenerated("vision-transformer", ENV, fetchImpl);
    expect(result).toEqual({ ok: true, exists: true });
  });

  it("array without the slug -> exists:false", async () => {
    const fetchImpl = makeFetch(
      () => new Response(JSON.stringify([{ slug: "other" }]), { status: 200 }),
    );
    expect(await alreadyGenerated("vision-transformer", ENV, fetchImpl)).toEqual({
      ok: true,
      exists: false,
    });
  });

  it("passes redirect: manual", async () => {
    const fetchImpl = makeFetch(() => new Response("[]", { status: 200 }));
    await alreadyGenerated("x", ENV, fetchImpl);
    expect(fetchImpl.calls[0]?.init.redirect).toBe("manual");
  });

  it("3xx under redirect: manual -> ok:false (never follows to attacker-controlled host)", async () => {
    const fetchImpl = makeFetch(
      () => new Response(null, { status: 302, headers: { location: "https://attacker.test/" } }),
    );
    expect((await alreadyGenerated("x", ENV, fetchImpl)).ok).toBe(false);
  });
});
