/**
 * References/citations BFS dispatcher — TS port of
 * `paperpilot/scripts/build_lineage.py`'s `S2TransientError`, `_s2_get`,
 * `fetch_related` (the S2 half; the `openalex:`-prefixed half dispatches
 * to `../theme/openalexFetch.ts`'s `fetchRelatedViaOpenalex`).
 *
 * Consolidated per docs/migration/p4-followups.md #23: this used to be a
 * local, scoped copy inside `apps/pipeline/src/lineage/theme/
 * fetchRelated.ts` (`build_theme_lineage.py`'s BFS calls it directly and
 * dispatches by paperId prefix), because the P4d task that ported
 * `build_lineage.py`'s conference/ICLR builder and the one that ported
 * the theme builder had non-overlapping edit scopes. The conference and
 * deep builders already called this same function via
 * `../theme/fetchRelated.js` — that reverse dependency is what this move
 * fixes; the OpenAlex half it dispatches to (`openalexFetch.ts`), plus
 * `payloadShape.ts`/`versionedCache.ts`, stay in `../theme/` (they are
 * not duplicated anywhere, so moving them is out of this follow-up's
 * scope).
 *
 * Safety contracts: LIN-02 (this is the "expansion" side of the
 * completeness ledger — a loss here is counted, not raised), LIN-20 (a
 * transient S2/OpenAlex failure must never be written to the
 * never-expiring relation cache).
 */

import type { FetchLike } from "../../collect/http/requestWithRetry.js";
import { requestWithRetry } from "../../collect/http/requestWithRetry.js";
import { firstUnusable } from "../../collect/signals/payload.js";
import { IncompleteFetchError } from "../fetch-state/completeness.js";
import {
  fetchRelatedViaOpenalex,
  type OpenAlexDeps,
  OpenAlexTransientError,
} from "../theme/openalexFetch.js";
import type { ThemePaper } from "../theme/openalexWork.js";
import { s2CachedNeighbourOk, s2RelationEntryOk } from "../theme/payloadShape.js";
import { readVersionedCache, writeVersionedCache } from "../theme/versionedCache.js";

export const RELATION_CACHE_VERSION = "lineage-relation-cache-v1";
/** Unauthenticated S2 quota is harsh; stay well under it. */
export const S2_RATE_DELAY_MS = 3500;

const S2_FIELDS_REL =
  "paperId,title,year,venue,citationCount,authors,abstract,externalIds,isInfluential,intents";

/** Raised when an S2 request failed at the transport level (network
 * error / timeout / 5xx with all of `requestWithRetry`'s retries
 * exhausted). Distinct from a definitive 404/4xx or malformed body,
 * both of which legitimately mean "no such data" and are safe to cache
 * as empty. */
export class S2TransientError extends IncompleteFetchError {}

export interface FetchRelatedDeps extends OpenAlexDeps {
  fetchImpl: FetchLike;
  cacheDir: string;
  sleep: (ms: number) => Promise<void>;
}

interface HttpResponseLike {
  status: number;
  json(): Promise<unknown>;
}

/** GET an S2 JSON endpoint, returning the parsed body or `null`.
 * @throws {S2TransientError} the outcome is a transient failure (never
 * cache it as a legitimate empty result). */
export async function s2Get(
  url: string,
  deps: FetchRelatedDeps,
): Promise<Record<string, unknown> | null> {
  const resp = (await requestWithRetry(
    { method: "GET", url, headers: { "User-Agent": "PaperPilot/0.1" }, timeoutMs: 20_000 },
    deps,
  )) as HttpResponseLike | null;
  if (resp === null) {
    throw new S2TransientError(`S2 request failed after retries: ${url}`);
  }
  if (resp.status === 429 || (resp.status >= 500 && resp.status < 600)) {
    throw new S2TransientError(`S2 request exhausted retries with status=${resp.status}: ${url}`);
  }
  if (resp.status === 200) {
    let payload: unknown;
    try {
      payload = await resp.json();
    } catch {
      throw new S2TransientError(`S2 returned a malformed body: ${url}`);
    }
    if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
      throw new S2TransientError(`S2 returned a non-object body: ${url}`);
    }
    return payload as Record<string, unknown>;
  }
  if (resp.status === 404) {
    // The one status that is a fact about the DATA: S2 has no paper
    // under this id.
    return null;
  }
  throw new S2TransientError(
    `S2 answered ${resp.status}, which says nothing about the data: ${url}`,
  );
}

export interface BuildCompletenessForExpansion {
  expansionAttempted(): void;
  expansionFailed(reason?: string | null): void;
}

/** `kind` is `"references"` or `"citations"`. Dispatches by paperId
 * prefix (#209 S2-free Phase 1): `openalex:` -> OpenAlex BFS (no S2
 * call); anything else -> the S2 `/paper/{id}/{kind}` path. This is the
 * one place every builder's graph EXPANSION passes through, so it is
 * where expansion attempts/losses are tallied (LIN-02). */
export async function fetchRelated(
  s2Id: string,
  kind: string,
  limit: number,
  deps: FetchRelatedDeps,
  completeness?: BuildCompletenessForExpansion | null,
): Promise<ThemePaper[]> {
  const cachePath = `${deps.cacheDir}/${kind}_${s2Id}.json`;
  const cached = readVersionedCache(cachePath, RELATION_CACHE_VERSION);
  if (Array.isArray(cached) && firstUnusable(cached, (p) => s2CachedNeighbourOk(p)) === null) {
    return cached as ThemePaper[];
  }

  completeness?.expansionAttempted();

  if (s2Id.startsWith("openalex:")) {
    const shortId = s2Id.slice("openalex:".length);
    try {
      const items = await fetchRelatedViaOpenalex(shortId, kind, limit, deps);
      writeVersionedCache(cachePath, RELATION_CACHE_VERSION, items);
      return items;
    } catch (exc) {
      if (exc instanceof OpenAlexTransientError) {
        deps.logger?.warn(
          `openalex ${kind} for ${shortId} incomplete (${exc.partial.length} usable); not caching: ${exc.message}`,
        );
        completeness?.expansionFailed();
        return exc.partial;
      }
      throw exc;
    }
  }

  const url =
    `https://api.semanticscholar.org/graph/v1/paper/${s2Id}/${kind}` +
    `?fields=${S2_FIELDS_REL}&limit=${Math.min(limit * 4, 100)}`;
  let data: Record<string, unknown> | null;
  try {
    data = await s2Get(url, deps);
  } catch (exc) {
    if (exc instanceof S2TransientError) {
      deps.logger?.warn(`s2: ${exc.message}`);
      completeness?.expansionFailed();
      await deps.sleep(S2_RATE_DELAY_MS);
      return [];
    }
    throw exc;
  }
  const envelope: Record<string, unknown> = data ?? { data: [] };
  const innerKey = kind === "references" ? "citedPaper" : "citingPaper";
  let entries = envelope.data;
  if (entries === null || entries === undefined) {
    entries = [];
  } else if (!Array.isArray(entries)) {
    deps.logger?.warn(`s2: ${s2Id}/${kind} returned a non-array data field`);
    completeness?.expansionFailed();
    await deps.sleep(S2_RATE_DELAY_MS);
    return [];
  }
  if ((entries as unknown[]).length === 0 && !("data" in envelope)) {
    deps.logger?.warn(`s2: ${s2Id}/${kind} returned an envelope with no data field`);
    completeness?.expansionFailed();
    await deps.sleep(S2_RATE_DELAY_MS);
    return [];
  }
  const bad = firstUnusable(entries as unknown[], (e) => s2RelationEntryOk(e, innerKey));
  if (bad !== null) {
    const [index, item] = bad;
    deps.logger?.warn(
      `s2: ${s2Id}/${kind} returned a malformed entry at index ${index} (${typeOf(item)})`,
    );
    completeness?.expansionFailed();
    await deps.sleep(S2_RATE_DELAY_MS);
    return [];
  }
  const items: ThemePaper[] = [];
  for (const entry of entries as Record<string, unknown>[]) {
    const p = entry[innerKey] as Record<string, unknown> | undefined;
    if (p && p.paperId && p.title) {
      const enriched: Record<string, unknown> = { ...p };
      enriched._is_influential = "isInfluential" in entry ? Boolean(entry.isInfluential) : null;
      const rawIntents = entry.intents;
      enriched._intents = Array.isArray(rawIntents) ? rawIntents.map((i) => String(i)) : null;
      items.push(enriched as unknown as ThemePaper);
    }
  }
  writeVersionedCache(cachePath, RELATION_CACHE_VERSION, items);
  await deps.sleep(S2_RATE_DELAY_MS);
  return items;
}

function typeOf(value: unknown): string {
  if (value === null) return "NoneType";
  if (Array.isArray(value)) return "list";
  return typeof value;
}
