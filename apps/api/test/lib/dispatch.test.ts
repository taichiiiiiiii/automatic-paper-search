// Ported from worker/themes-post.test.mjs's dispatch-related tests
// (API-15/16/17, L-7), isolated to the extracted dispatch module, plus new
// tests for the §4.5 dry-run dispatcher and the inventory-weakness-#7
// truncate-and-redact logging.

import { describe, expect, it } from "vitest";
import { dispatchWorkflow } from "../../src/lib/dispatch.js";

const PAT = "ghp_super-secret-dispatch-token";
const ENV = {
  GH_OWNER: "taichiiiiiiii",
  GH_REPO: "automatic-paper-search",
  GH_WORKFLOW_FILE: "theme-on-demand.yml",
  GH_REF: "develop",
  GH_DISPATCH_PAT: PAT,
};
const REQUEST_ID = "theme-123e4567-e89b-42d3-a456-426614174000";

function makeFetch(respond: () => Response | Promise<Response>) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const impl = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return respond();
  }) as unknown as typeof fetch;
  (impl as unknown as { calls: typeof calls }).calls = calls;
  return impl as typeof fetch & { calls: typeof calls };
}

describe("dispatchWorkflow live mode", () => {
  it("resolves ok on a 204", async () => {
    const fetchImpl = makeFetch(() => new Response(null, { status: 204 }));
    const result = await dispatchWorkflow("Vision Transformer", REQUEST_ID, ENV, fetchImpl, "live");
    expect(result).toEqual({ ok: true, dryRun: false });
    expect(fetchImpl.calls[0]?.init?.redirect).toBe("manual");
  });

  it("non-ok response -> ok:false with status/body", async () => {
    const fetchImpl = makeFetch(() => new Response("nope", { status: 500 }));
    const result = await dispatchWorkflow("Vision Transformer", REQUEST_ID, ENV, fetchImpl, "live");
    expect(result.ok).toBe(false);
  });

  it("3xx under redirect: manual -> ok:false", async () => {
    const fetchImpl = makeFetch(
      () => new Response(null, { status: 307, headers: { location: "https://attacker.test/" } }),
    );
    expect((await dispatchWorkflow("x", REQUEST_ID, ENV, fetchImpl, "live")).ok).toBe(false);
  });

  it("throw propagates for the caller to map to 502", async () => {
    const fetchImpl = (async () => {
      throw new Error("fetch failed");
    }) as typeof fetch;
    await expect(dispatchWorkflow("x", REQUEST_ID, ENV, fetchImpl, "live")).rejects.toThrow(
      "fetch failed",
    );
  });

  it("never logs the PAT, even on failure, and truncates to 500 chars", async () => {
    const longBody = `before${PAT}after-${"x".repeat(600)}`;
    const fetchImpl = makeFetch(() => new Response(longBody, { status: 500 }));
    const logged: string[] = [];
    await dispatchWorkflow("x", REQUEST_ID, ENV, fetchImpl, "live", (m) => logged.push(m));
    expect(logged.length).toBe(1);
    expect(logged[0]).not.toContain(PAT);
    expect(logged[0]?.length).toBeLessThanOrEqual(600); // prefix text + 500-char truncated body + ellipsis
  });
});

describe("dispatchWorkflow dry-run mode", () => {
  it("never calls fetch and reports dryRun:true", async () => {
    const fetchImpl = makeFetch(() => new Response(null, { status: 204 }));
    const result = await dispatchWorkflow(
      "Vision Transformer",
      REQUEST_ID,
      ENV,
      fetchImpl,
      "dry-run",
    );
    expect(result).toEqual({ ok: true, dryRun: true });
    expect(fetchImpl.calls.length).toBe(0);
  });

  it("records the would-be dispatch via the injected log sink", async () => {
    const fetchImpl = makeFetch(() => new Response(null, { status: 204 }));
    const logged: string[] = [];
    await dispatchWorkflow("Vision Transformer", REQUEST_ID, ENV, fetchImpl, "dry-run", (m) =>
      logged.push(m),
    );
    expect(logged.length).toBe(1);
    expect(logged[0]).toContain("Vision Transformer");
    expect(logged[0]).toContain(REQUEST_ID);
  });
});
