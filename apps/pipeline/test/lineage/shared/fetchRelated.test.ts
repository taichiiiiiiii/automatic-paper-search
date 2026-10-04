/**
 * Vitest port of the S2-dispatch tests in
 * `paperpilot/tests/test_build_lineage.py` (`_s2_get`, `fetch_related`'s
 * S2 branch) — safety contract LIN-20/LIN-02. The `openalex:`-prefixed
 * branch is exercised in `openalexFetch.test.ts`; this file covers the
 * S2 half plus the dispatcher's shared cache behaviour.
 */
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { FetchInit, HttpResponseLike } from "../../../src/collect/http/requestWithRetry.js";
import {
  type FetchRelatedDeps,
  fetchRelated,
  S2TransientError,
  s2Get,
} from "../../../src/lineage/shared/fetchRelated.js";

function jsonResp(status: number, body: unknown): HttpResponseLike {
  return { status, json: async () => body };
}

let cacheDir: string;
beforeEach(() => {
  cacheDir = mkdtempSync(join(tmpdir(), "s2-related-cache-"));
});

function depsFor(
  fetchImpl: (url: string, init: FetchInit) => Promise<HttpResponseLike>,
): FetchRelatedDeps {
  return { fetchImpl, cacheDir, sleep: async () => {}, logger: { warn: () => {} } };
}

function writeRelationCache(path: string, data: unknown): void {
  writeFileSync(path, JSON.stringify({ schema_version: "lineage-relation-cache-v1", data }));
}

describe("s2Get", () => {
  it("raises on a malformed or non-object 200 body", async () => {
    const malformed = depsFor(async () => ({
      status: 200,
      json: async () => {
        throw new Error("not json");
      },
    }));
    await expect(s2Get("https://example.invalid/x", malformed)).rejects.toBeInstanceOf(
      S2TransientError,
    );

    const nonObject = depsFor(async () => jsonResp(200, ["not", "an", "object"]));
    await expect(s2Get("https://example.invalid/x", nonObject)).rejects.toBeInstanceOf(
      S2TransientError,
    );
  });

  it("returns null (not an error) for a definitive 404", async () => {
    const deps = depsFor(async () => jsonResp(404, {}));
    expect(await s2Get("https://example.invalid/x", deps)).toBeNull();
  });

  it("raises on an exhausted 429/5xx", async () => {
    const deps429 = depsFor(async () => jsonResp(429, {}));
    await expect(s2Get("https://example.invalid/x", deps429)).rejects.toBeInstanceOf(
      S2TransientError,
    );
    const deps503 = depsFor(async () => jsonResp(503, {}));
    await expect(s2Get("https://example.invalid/x", deps503)).rejects.toBeInstanceOf(
      S2TransientError,
    );
  });
});

describe("fetchRelated (S2 branch)", () => {
  it("tallies expansion attempts and losses", async () => {
    let calls = 0;
    const deps = depsFor(async () => {
      calls += 1;
      if (calls === 1) throw new Error("boom"); // -> S2TransientError via requestWithRetry -> null -> S2TransientError
      return jsonResp(200, { data: [] });
    });
    let attempted = 0;
    let failed = 0;
    const completeness = {
      expansionAttempted: () => (attempted += 1),
      expansionFailed: () => (failed += 1),
    };
    expect(await fetchRelated("pX", "references", 5, deps, completeness)).toEqual([]);
    expect(attempted).toBe(1);
    expect(failed).toBe(1);

    expect(await fetchRelated("pY", "references", 5, deps, completeness)).toEqual([]);
    expect(attempted).toBe(2);
    expect(failed).toBe(1);
  });

  it("does not count a cache hit as an attempt", async () => {
    writeRelationCache(join(cacheDir, "references_pZ.json"), []);
    let attempted = 0;
    const completeness = { expansionAttempted: () => (attempted += 1), expansionFailed: () => {} };
    const deps = depsFor(async () => {
      throw new Error("must not be called");
    });
    await fetchRelated("pZ", "references", 5, deps, completeness);
    expect(attempted).toBe(0);
  });

  it("treats a 200 error-envelope ({error: ...}) as a failure, not a cacheable []", async () => {
    const deps = depsFor(async () => jsonResp(200, { error: "maintenance" }));
    let failed = 0;
    const completeness = { expansionAttempted: () => {}, expansionFailed: () => (failed += 1) };
    expect(await fetchRelated("pE", "references", 5, deps, completeness)).toEqual([]);
    expect(failed).toBe(1);
    expect(() => readFileSync(join(cacheDir, "references_pE.json"))).toThrow();
  });

  it("keeps {data: null} as a genuine, cacheable empty", async () => {
    const deps = depsFor(async () => jsonResp(200, { data: null }));
    let failed = 0;
    const completeness = { expansionAttempted: () => {}, expansionFailed: () => (failed += 1) };
    expect(await fetchRelated("pN", "references", 5, deps, completeness)).toEqual([]);
    expect(failed).toBe(0);
  });

  it("keeps a definitive 404 as a cacheable empty", async () => {
    const deps = depsFor(async () => jsonResp(404, {}));
    let failed = 0;
    const completeness = { expansionAttempted: () => {}, expansionFailed: () => (failed += 1) };
    expect(await fetchRelated("p404", "references", 5, deps, completeness)).toEqual([]);
    expect(failed).toBe(0);
    expect(() => readFileSync(join(cacheDir, "references_p404.json"))).not.toThrow();
  });

  it.each([
    ["string", ["malformed"]],
    ["empty-dict", [{}]],
    ["null", [null]],
    ["null-inner", [{ citedPaper: null }]],
    ["inner-without-id", [{ citedPaper: { title: "no id" } }]],
  ])("rejects a malformed relation entry (%s)", async (_label, entries) => {
    const deps = depsFor(async () => jsonResp(200, { data: entries }));
    let failed = 0;
    const completeness = { expansionAttempted: () => {}, expansionFailed: () => (failed += 1) };
    expect(await fetchRelated("pB", "references", 5, deps, completeness)).toEqual([]);
    expect(failed).toBe(1);
    expect(() => readFileSync(join(cacheDir, "references_pB.json"))).toThrow();
  });

  it("still filters a neighbour without a title (real data, not a broken page)", async () => {
    const payload = {
      data: [
        { citedPaper: { paperId: "good", title: "Kept" } },
        { citedPaper: { paperId: "untitled" } },
      ],
    };
    const deps = depsFor(async () => jsonResp(200, payload));
    let failed = 0;
    const completeness = { expansionAttempted: () => {}, expansionFailed: () => (failed += 1) };
    const items = await fetchRelated("pT", "references", 5, deps, completeness);
    expect(items.map((p) => p.paperId)).toEqual(["good"]);
    expect(failed).toBe(0);
    expect(() => readFileSync(join(cacheDir, "references_pT.json"))).not.toThrow();
  });

  it("ignores a relation cache written before validation ([{}])", async () => {
    writeRelationCache(join(cacheDir, "references_pC.json"), [{}]);
    let calls = 0;
    const deps = depsFor(async () => {
      calls += 1;
      return jsonResp(200, { data: [{ citedPaper: { paperId: "fresh", title: "Fresh" } }] });
    });
    const items = await fetchRelated("pC", "references", 5, deps);
    expect(items.map((p) => p.paperId)).toEqual(["fresh"]);
    expect(calls).toBe(1);
  });

  it("still uses a valid relation cache without any network call", async () => {
    const cached = [{ paperId: "cached", title: "Cached" }];
    writeRelationCache(join(cacheDir, "references_pE2.json"), cached);
    const deps = depsFor(async () => {
      throw new Error("must not be called");
    });
    expect(await fetchRelated("pE2", "references", 5, deps)).toEqual(cached);
  });
});
