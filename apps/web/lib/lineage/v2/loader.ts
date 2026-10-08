/**
 * Bounded, same-origin, non-redirected fetch of the five documents a
 * pilot release needs (the index, artifact, fixture, quality, and the
 * conference catalog used to validate `seed_paper_id`) -- ported 1:1
 * from docs/assets/lineage-focus.js `readBounded`/`fetchBytes`/
 * `loadOwner`/`loadVerifiedRelease` (safety-contracts.md SCR-44).
 *
 * Unlike the JS source, this module never reads `window`/`location`
 * directly -- callers (ultimately `app/lineage/page.tsx`) inject
 * `origin` and `rootUrl` explicitly, which is what keeps this testable
 * under plain Node (no DOM) and is exactly the injectable-`fetch`
 * pattern `lib/lineage/core.ts` already uses for the same reason
 * (CLAUDE.md "外部 API を叩くテストを書かない").
 */
import { validateCatalog } from "../../catalog-core";
import { parsePilotIndex, resolvePilotEntry } from "./pilot-index";
import { verifyPilotRelease } from "./release";
import type { Release } from "./types";

export const PILOT_RELEASE_MAX_BYTES = Object.freeze({
  index: 256 * 1024,
  artifact: 8 * 1024 * 1024,
  fixture: 8 * 1024 * 1024,
  quality: 256 * 1024,
  catalog: 8 * 1024 * 1024,
});

export const LOAD_TIMEOUT_MS = 30_000;
const PAPER_ID_RE = /^[0-9a-f]{40}$/;

export interface LoadOwner {
  controller: AbortController;
  isActive: () => boolean;
  finish: () => void;
  abandon: () => void;
}

export interface TimerLike {
  setTimeout: typeof setTimeout;
  clearTimeout: typeof clearTimeout;
}

/**
 * One in-flight load's lifecycle: a deadline that aborts the fetch
 * exactly once if not `finish()`ed first, and `abandon()` for a caller
 * that is replacing this load with a new one (e.g. a `popstate`
 * navigation) before it settles.
 */
export function loadOwner(
  timer: TimerLike = globalThis,
  timeoutMs: number = LOAD_TIMEOUT_MS,
): LoadOwner {
  const controller = new AbortController();
  let active = true;
  const timerId = timer.setTimeout(() => {
    if (!active) return;
    active = false;
    controller.abort(new DOMException("lineage load timed out", "TimeoutError"));
  }, timeoutMs);
  return Object.freeze({
    controller,
    isActive: () => active,
    finish() {
      if (!active) return;
      active = false;
      timer.clearTimeout(timerId);
    },
    abandon() {
      if (!active) return;
      active = false;
      timer.clearTimeout(timerId);
      controller.abort(new DOMException("lineage load abandoned", "AbortError"));
    },
  });
}

/** A fetch-like `Response` shape minimal enough for both the real
 * `fetch` and the fixture mock `loader.test.ts`/the ported mjs test
 * use. */
export interface FetchResponseLike {
  ok: boolean;
  redirected?: boolean;
  url?: string;
  headers?: { get?: (name: string) => string | null | undefined };
  body?: { getReader?: () => ReadableStreamDefaultReader<Uint8Array> } | null;
  arrayBuffer: () => Promise<ArrayBuffer>;
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<FetchResponseLike>;

/** Enforces `maxBytes` against BOTH the declared `content-length` (so
 * an oversized body is never even requested from the network stack)
 * and the actual byte stream (so a dishonest or absent
 * `content-length` cannot smuggle a bigger body through) -- never
 * materializes more than `maxBytes` of a non-conforming response. */
export async function readBounded(
  response: FetchResponseLike,
  maxBytes: number,
): Promise<Uint8Array> {
  if (!response?.ok || response.redirected === true) throw new Error("response refused");
  const length = response.headers?.get?.("content-length");
  if (length !== null && length !== undefined) {
    if (!/^[0-9]+$/.test(length) || Number(length) > maxBytes)
      throw new Error("response too large");
  }
  if (!response.body?.getReader) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > maxBytes) throw new Error("response too large");
    return bytes;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) throw new Error("response too large");
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/** Fetches `url` (resolved against `origin`), refusing anything that
 * is not exactly same-origin, refusing any response whose final `url`
 * differs from the requested one (so a same-origin redirect chain that
 * still ends up elsewhere on the same origin is also refused, not just
 * a cross-origin one), and bounding the body via `readBounded`. */
export async function fetchBytes(
  url: string | URL,
  maxBytes: number,
  signal: AbortSignal,
  origin: string,
  fetchImpl: FetchLike,
): Promise<Uint8Array> {
  const expected = new URL(url, origin);
  if (expected.origin !== origin) throw new Error("cross-origin path refused");
  const response = await fetchImpl(expected.href, {
    cache: "no-cache",
    credentials: "same-origin",
    redirect: "error",
    referrerPolicy: "same-origin",
    signal,
    headers: { accept: "application/json" },
  });
  if (response.url && new URL(response.url).href !== expected.href)
    throw new Error("redirected response refused");
  return readBounded(response, maxBytes);
}

function parseJsonBytes(bytes: Uint8Array): unknown {
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}

export interface LoadVerifiedReleaseDeps {
  /** Same-origin check target, e.g. `window.location.origin`. */
  origin: string;
  /** Absolute URL every relative pilot/catalog path resolves against,
   * e.g. `new URL(`${BASE_PATH}/`, window.location.origin).href` --
   * the equivalent of the JS source's `new URL("../", location.href)`. */
  rootUrl: string;
  fetchImpl: FetchLike;
}

/**
 * Loads and fully verifies the pilot release for `paperId`: fetches
 * the pilot index (bounded, same-origin), resolves the one matching
 * entry, then fetches the artifact/fixture/quality/catalog documents
 * (also bounded, same-origin, in parallel) and runs
 * `verifyPilotRelease` against their raw bytes. Returns `null` if the
 * index has no matching entry; throws (does not catch) on any fetch,
 * parse, or catalog-validation failure -- the caller (the page's load
 * effect) is responsible for turning that into the fail-closed
 * "監査情報の一致を確認できなかった" message, exactly as
 * `docs/assets/lineage-focus.js` `start()`'s surrounding `try/catch`
 * does. Makes exactly five bounded fetches on a successful resolution
 * (index, artifact, fixture, quality, catalog) -- never more.
 */
export async function loadVerifiedRelease(
  paperId: string,
  owner: LoadOwner,
  deps: LoadVerifiedReleaseDeps,
): Promise<Release | null> {
  if (!PAPER_ID_RE.test(paperId)) return null;
  const { origin, rootUrl, fetchImpl } = deps;
  const indexBytes = await fetchBytes(
    new URL("lineage-pilot-index-v1.json", rootUrl),
    PILOT_RELEASE_MAX_BYTES.index,
    owner.controller.signal,
    origin,
    fetchImpl,
  );
  const index = parsePilotIndex(parseJsonBytes(indexBytes));
  const entry = index && resolvePilotEntry(index, paperId);
  if (!entry) return null;
  const urls = {
    artifact: new URL(entry.artifact.path, rootUrl),
    fixture: new URL(entry.fixture.path, rootUrl),
    quality: new URL(entry.quality.path, rootUrl),
    catalog: new URL(`${entry.conference}/papers.json`, rootUrl),
  };
  const [artifactBytes, fixtureBytes, qualityBytes, catalogBytes] = await Promise.all([
    fetchBytes(
      urls.artifact,
      PILOT_RELEASE_MAX_BYTES.artifact,
      owner.controller.signal,
      origin,
      fetchImpl,
    ),
    fetchBytes(
      urls.fixture,
      PILOT_RELEASE_MAX_BYTES.fixture,
      owner.controller.signal,
      origin,
      fetchImpl,
    ),
    fetchBytes(
      urls.quality,
      PILOT_RELEASE_MAX_BYTES.quality,
      owner.controller.signal,
      origin,
      fetchImpl,
    ),
    fetchBytes(
      urls.catalog,
      PILOT_RELEASE_MAX_BYTES.catalog,
      owner.controller.signal,
      origin,
      fetchImpl,
    ),
  ]);
  const catalog = validateCatalog(parseJsonBytes(catalogBytes));
  const catalogPaperIds = [...catalog.keys()];
  return verifyPilotRelease({ entry, artifactBytes, fixtureBytes, qualityBytes, catalogPaperIds });
}
