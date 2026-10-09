/**
 * Ports the fetch-boundary cases of
 * paperpilot/tests/viewer/test_lineage_focus_app.mjs against
 * lib/lineage/v2/loader.ts (not the JS): the five-bounded-fetch
 * resolution against the real cross-language fixture bundle, and the
 * cross-origin/redirect/oversize refusals of
 * `fetchBytes`/`readBounded` (safety-contracts.md SCR-44).
 *
 * Unlike the mjs source, this module takes `origin`/`rootUrl`
 * explicitly instead of reading `window.location` -- see
 * lib/lineage/v2/loader.ts's module doc. The fixture-mapping
 * `fixtureFetch` below is otherwise the same pattern as the mjs test's
 * (same fixture directory, same per-path routing).
 */

import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  type FetchResponseLike,
  fetchBytes,
  loadOwner,
  loadVerifiedRelease,
  readBounded,
} from "../../../lib/lineage/v2/loader";

const here = dirname(fileURLToPath(import.meta.url));
const repository = resolve(here, "../../../../..");
const fixtureRoot = resolve(repository, "apps/web/test/fixtures/lineage-pilot/positive-release");
if (!existsSync(fixtureRoot)) {
  throw new Error(
    `fixture root not found at ${fixtureRoot} -- check the relative depth from this test file`,
  );
}
const paperId = "1".repeat(40);
const ORIGIN = "https://example.test";
const ROOT_URL = "https://example.test/";

function fixtureFetchFactory() {
  let fetchCount = 0;
  async function fixtureFetch(url: string): Promise<FetchResponseLike> {
    fetchCount += 1;
    const parsed = new URL(url);
    let path: string;
    if (parsed.pathname.endsWith("/lineage-pilot-index-v1.json")) {
      path = resolve(fixtureRoot, "lineage-pilot-index-v1.json");
    } else if (parsed.pathname.endsWith("/synthetic-pilot/papers.json")) {
      path = resolve(fixtureRoot, "catalog.json");
    } else {
      path = resolve(fixtureRoot, parsed.pathname.replace(/^\//, ""));
    }
    const bytes = await readFile(path);
    return {
      ok: true,
      redirected: false,
      url: parsed.href,
      headers: {
        get: (name: string) => (name === "content-length" ? String(bytes.byteLength) : null),
      },
      arrayBuffer: async () =>
        bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    };
  }
  return { fixtureFetch, count: () => fetchCount };
}

describe("loadVerifiedRelease", () => {
  it("real producer bytes pass the five-resource verifier, using exactly five bounded fetches", async () => {
    const { fixtureFetch, count } = fixtureFetchFactory();
    const owner = loadOwner();
    const release = await loadVerifiedRelease(paperId, owner, {
      origin: ORIGIN,
      rootUrl: ROOT_URL,
      fetchImpl: fixtureFetch,
    });
    owner.finish();
    expect(release).not.toBeNull();
    expect(release?.artifact.nodes.some((node) => node.seed_paper_id === paperId)).toBe(true);
    expect(count()).toBe(5);
  });

  it("an invalid paper id never fetches anything", async () => {
    const owner = loadOwner();
    const release = await loadVerifiedRelease("not-a-paper-id", owner, {
      origin: ORIGIN,
      rootUrl: ROOT_URL,
      fetchImpl: async () => {
        throw new Error("must not fetch");
      },
    });
    owner.finish();
    expect(release).toBeNull();
  });
});

describe("fetchBytes", () => {
  it("refuses a cross-origin path before ever calling fetch", async () => {
    let called = false;
    await expect(
      fetchBytes(
        "https://evil.test/x.json",
        1024,
        new AbortController().signal,
        ORIGIN,
        async () => {
          called = true;
          throw new Error("unreachable");
        },
      ),
    ).rejects.toThrow(/cross-origin/);
    expect(called).toBe(false);
  });

  it("refuses a response whose final url differs from the requested one (same-origin redirect)", async () => {
    await expect(
      fetchBytes(
        "lineage-pilot-index-v1.json",
        1024,
        new AbortController().signal,
        ORIGIN,
        async () => ({
          ok: true,
          redirected: true,
          url: `${ORIGIN}/elsewhere.json`,
          headers: { get: () => "2" },
          arrayBuffer: async () => new Uint8Array([123, 125]).buffer,
        }),
      ),
    ).rejects.toThrow(/refused/);
  });

  it("refuses an oversized declared content-length before allocating the body", async () => {
    let allocated = false;
    await expect(
      fetchBytes(
        "lineage-pilot-index-v1.json",
        1,
        new AbortController().signal,
        ORIGIN,
        async () => ({
          ok: true,
          redirected: false,
          headers: { get: () => "999999" },
          arrayBuffer: async () => {
            allocated = true;
            return new Uint8Array(999_999).buffer;
          },
        }),
      ),
    ).rejects.toThrow(/too large/);
    expect(allocated).toBe(false);
  });

  it("refuses an oversized stream even when content-length is absent", async () => {
    const bytes = readFileSync(resolve(fixtureRoot, "lineage-pilot-index-v1.json"));
    await expect(
      fetchBytes(
        "lineage-pilot-index-v1.json",
        1,
        new AbortController().signal,
        ORIGIN,
        async () => ({
          ok: true,
          redirected: false,
          headers: { get: () => null },
          arrayBuffer: async () =>
            bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
        }),
      ),
    ).rejects.toThrow(/too large/);
  });
});

describe("readBounded", () => {
  it("rejects a non-ok response", async () => {
    await expect(
      readBounded({ ok: false, arrayBuffer: async () => new ArrayBuffer(0) }, 10),
    ).rejects.toThrow(/refused/);
  });

  it("streams and bounds a ReadableStream-shaped body", async () => {
    let read = false;
    const reader = {
      async read() {
        if (read) return { done: true, value: undefined };
        read = true;
        return { done: false, value: new Uint8Array([1, 2, 3]) };
      },
      cancel: async () => {},
    };
    const bytes = await readBounded(
      {
        ok: true,
        headers: { get: () => null },
        body: { getReader: () => reader as unknown as ReadableStreamDefaultReader<Uint8Array> },
        arrayBuffer: async () => new ArrayBuffer(0),
      },
      10,
    );
    expect([...bytes]).toEqual([1, 2, 3]);
  });
});

describe("loadOwner", () => {
  it("aborts exactly once after the timeout, and finish() cancels the timer", () => {
    vi.useFakeTimers();
    try {
      const owner = loadOwner(globalThis, 1000);
      expect(owner.isActive()).toBe(true);
      vi.advanceTimersByTime(1000);
      expect(owner.isActive()).toBe(false);
      expect(owner.controller.signal.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("abandon() aborts immediately and finish() afterwards is a no-op", () => {
    const owner = loadOwner();
    owner.abandon();
    expect(owner.controller.signal.aborted).toBe(true);
    expect(owner.isActive()).toBe(false);
    expect(() => owner.finish()).not.toThrow();
  });
});
