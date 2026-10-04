/**
 * OpenAlex-primary seed discovery + BFS traversal — TS port of the
 * OpenAlex-only network layer in `paperpilot/scripts/build_theme_lineage.py`
 * (`discover_seeds_via_openalex`, `_openalex_outcome`,
 * `_fetch_openalex_works_by_ids`, `_split_by_foundational_priority`,
 * `fetch_related_via_openalex`, `_attach_empty_intent_fields`, plus the
 * unarXive citation-context enrichment stubs).
 *
 * Safety contracts: LIN-20 (transient OpenAlex failures must never be
 * cached — this module never caches anything itself; it is the caller's
 * job, same as Python), LIN-28 (seed search is scoped to the Computer
 * Science field via `primary_topic.field.id:fields/17`).
 *
 * unarXive scope note: `enrichParentWithUnarxive`/`enrichChildWithUnarxive`
 * require a local DuckDB build of the unarXive 2022 corpus (see CLAUDE.md
 * "unarXive DuckDB アーティファクト"), which needs the `duckdb` native
 * dependency and is not part of this port. Both are ported as faithful
 * no-ops (always `_contexts: []`, i.e. "not built" per
 * `paperpilot.utils.unarxive.is_available()` returning `False`) — the
 * documented degrade path ("fetch_contexts() returns [] -> year/cite +
 * LLM fallback... build pipeline is not broken, Phase J is just inactive").
 */

import type { FetchLike } from "../../collect/http/requestWithRetry.js";
import { requestWithRetry } from "../../collect/http/requestWithRetry.js";
import type { ClassifyPaperLike } from "../../collect/llm/provider.js";
import { firstUnusable } from "../../collect/signals/payload.js";
import { isFoundationalAncestor } from "../classify/classify.js";
import { IncompleteFetchError } from "../fetch-state/completeness.js";
import {
  arxivIdFromWork,
  OPENALEX_PAPER_ID_PREFIX,
  openalexShortId,
  type ThemePaper,
  workToPaperDict,
} from "./openalexWork.js";
import { openalexWorkShape } from "./payloadShape.js";

export const OPENALEX_WORKS_URL = "https://api.openalex.org/works";
export const OPENALEX_PER_PAGE_MAX = 200;

/** Thrown instead of returning data when an OpenAlex result MUST NOT be
 * cached (mirrors `build_lineage.py::OpenAlexTransientError`). `partial`
 * carries whatever was successfully fetched before the failure — usable
 * for the current run, never persisted. */
export class OpenAlexTransientError extends IncompleteFetchError {
  readonly partial: ThemePaper[];
  constructor(message: string, partial: ThemePaper[] = []) {
    super(message);
    this.partial = partial;
  }
}

export interface OpenAlexDeps {
  fetchImpl: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  logger?: { warn: (msg: string) => void };
  email?: string | null;
}

interface HttpResponseLike {
  status: number;
  json(): Promise<unknown>;
}

function get(
  url: string,
  params: Record<string, string | number | boolean | undefined>,
  deps: OpenAlexDeps,
) {
  return requestWithRetry(
    {
      method: "GET",
      url,
      params,
      headers: { "User-Agent": "PaperPilot/0.1" },
      timeoutMs: 20_000,
    },
    deps,
  );
}

function withEmail(
  params: Record<string, string | number | boolean | undefined>,
  deps: OpenAlexDeps,
): Record<string, string | number | boolean | undefined> {
  return deps.email ? { ...params, mailto: deps.email } : params;
}

export interface BuildCompletenessLike {
  subjectFailed(reason: string): void;
}

/** Search OpenAlex `/works` for the theme; return raw Work dicts.
 *
 * Returns `[]` on any error so callers degrade gracefully. That empty
 * list is ambiguous by design (also what a genuinely unmatched query
 * returns) — when `completeness` is supplied the failure is recorded
 * there so the caller can tell the two apart (LIN-15). */
export async function discoverSeedsViaOpenalex(
  options: {
    query: string;
    topN: number;
    sinceYear: number | null;
    completeness?: BuildCompletenessLike | null;
  },
  deps: OpenAlexDeps,
): Promise<Record<string, unknown>[]> {
  const { query, topN, sinceYear, completeness } = options;
  if (!query || !query.trim()) return [];
  const pageSize = Math.min(Math.max(topN * 3, 25), OPENALEX_PER_PAGE_MAX);

  const conceptFilter = "primary_topic.field.id:fields/17";
  const params = withEmail(
    {
      search: query,
      "per-page": pageSize,
      filter:
        sinceYear !== null
          ? `from_publication_date:${sinceYear}-01-01,${conceptFilter}`
          : conceptFilter,
    },
    deps,
  );

  const resp = (await get(OPENALEX_WORKS_URL, params, deps)) as HttpResponseLike | null;
  if (resp === null || resp.status !== 200) {
    const status = resp ? resp.status : null;
    deps.logger?.warn(`openalex search failed (status=${status}) — fallback contributes 0 seeds`);
    completeness?.subjectFailed(
      `openalex seed search for ${JSON.stringify(query)} failed (status=${status})`,
    );
    return [];
  }
  let payload: unknown;
  try {
    payload = await resp.json();
  } catch (exc) {
    deps.logger?.warn(`openalex JSON parse failed: ${String(exc)}`);
    completeness?.subjectFailed(
      `openalex seed search for ${JSON.stringify(query)} returned a malformed body`,
    );
    return [];
  }
  const results =
    payload !== null && typeof payload === "object" && !Array.isArray(payload)
      ? (payload as Record<string, unknown>).results
      : undefined;
  if (!Array.isArray(results)) {
    completeness?.subjectFailed(
      `openalex seed search for ${JSON.stringify(query)} returned no results array`,
    );
    return [];
  }
  const bad = firstUnusable(results, (w) => openalexWorkShape(w) !== null);
  if (bad !== null) {
    const [index, item] = bad;
    completeness?.subjectFailed(
      `openalex seed search for ${JSON.stringify(query)} returned a result with no usable OpenAlex id at index ${index} (type=${typeOf(item)})`,
    );
    return [];
  }
  return results as Record<string, unknown>[];
}

function typeOf(value: unknown): string {
  if (value === null) return "NoneType";
  if (Array.isArray(value)) return "list";
  return typeof value;
}

/** The only status that is a permanent statement about the data: 410
 * Gone (deliberately removed Work). 404 is excluded on purpose (see
 * Python docstring — promises nothing about permanence). */
const OPENALEX_ABSENT_STATUSES: ReadonlySet<number> = new Set([410]);

export function openalexOutcome(resp: HttpResponseLike | null): "ok" | "absent" | "uncacheable" {
  if (resp === null) return "uncacheable";
  if (resp.status === 200) return "ok";
  if (OPENALEX_ABSENT_STATUSES.has(resp.status)) return "absent";
  return "uncacheable";
}

/** Batch-fetch OpenAlex Works by short ID via `filter=openalex:W1|W2`.
 * Returns S2-shape paper dicts. Failed pages are dropped (graceful
 * degrade) unless ANY chunk fails, in which case this throws
 * `OpenAlexTransientError` carrying whatever did resolve as `.partial`
 * (LIN-20: a partial answer must never be cached as complete). */
export async function fetchOpenAlexWorksByIds(
  shortIds: readonly string[],
  deps: OpenAlexDeps,
): Promise<ThemePaper[]> {
  const cleaned = shortIds
    .map((sid) => openalexShortId(sid))
    .filter((s): s is string => Boolean(s));
  if (cleaned.length === 0) return [];
  const results: ThemePaper[] = [];
  const chunkSize = 50;
  let chunks = 0;
  let failedChunks = 0;
  for (let i = 0; i < cleaned.length; i += chunkSize) {
    chunks += 1;
    const chunk = cleaned.slice(i, i + chunkSize);
    const params = withEmail(
      { filter: `openalex:${chunk.join("|")}`, "per-page": chunk.length },
      deps,
    );
    const resp = (await get(OPENALEX_WORKS_URL, params, deps)) as HttpResponseLike | null;
    const outcome = openalexOutcome(resp);
    if (outcome !== "ok") {
      deps.logger?.warn(
        `openalex batch fetch ${outcome} (status=${resp ? resp.status : null}, chunk=${chunk.length} ids)`,
      );
      if (outcome === "uncacheable") failedChunks += 1;
      continue;
    }
    let payload: unknown;
    try {
      payload = await (resp as HttpResponseLike).json();
    } catch {
      failedChunks += 1;
      continue;
    }
    const works =
      payload !== null && typeof payload === "object" && !Array.isArray(payload)
        ? (payload as Record<string, unknown>).results
        : undefined;
    if (!Array.isArray(works)) {
      failedChunks += 1;
      continue;
    }
    if (firstUnusable(works, (w) => openalexWorkShape(w) !== null) !== null) {
      failedChunks += 1;
      continue;
    }
    for (const work of works) {
      const paper = workToPaperDict(work as Record<string, unknown>);
      if (paper !== null) results.push(paper);
    }
  }
  if (failedChunks > 0) {
    throw new OpenAlexTransientError(
      `openalex batch fetch lost ${failedChunks}/${chunks} chunk(s) (${cleaned.length} id(s) requested, ${results.length} resolved)`,
      results,
    );
  }
  return results;
}

/** Faithful no-op: unarXive requires a local DuckDB build this port
 * does not include. Mirrors `is_available() === False` -> always empty
 * contexts (downstream falls through to year/cite + LLM). See module
 * doc comment. */
export function enrichParentWithUnarxive(
  parent: ThemePaper,
  _options: { citingArxivId: string },
): ThemePaper {
  if (parent._contexts === undefined) parent._contexts = [];
  return parent;
}

/** Faithful no-op counterpart for the `citations` BFS direction. See
 * `enrichParentWithUnarxive`. */
export function enrichChildWithUnarxive(
  child: ThemePaper,
  _options: { citedOpenalexId: string },
): ThemePaper {
  if (child._contexts === undefined) child._contexts = [];
  return child;
}

/** Return at most `budget` papers, always keeping foundational-allowlist
 * matches first (#277 — OpenAlex's `referenced_works` ordering buries
 * famous ancestors below the width cut otherwise). */
export function splitByFoundationalPriority(
  papers: readonly ThemePaper[],
  budget: number,
): ThemePaper[] {
  const foundational: ThemePaper[] = [];
  const rest: ThemePaper[] = [];
  for (const p of papers) {
    if (isFoundationalAncestor(p as ClassifyPaperLike)) foundational.push(p);
    else rest.push(p);
  }
  const fill = Math.max(0, budget - foundational.length);
  return [...foundational, ...rest.slice(0, fill)];
}

/** Add the entry-level fields BFS callers rely on (`_intents`,
 * `_is_influential`, `_contexts`) when a data source (always OpenAlex,
 * here) doesn't provide them. */
export function attachEmptyIntentFields(paper: ThemePaper): ThemePaper {
  if (paper._intents === undefined) paper._intents = null;
  // Was `undefined as unknown as boolean` (a type-cast lie, not a real
  // value) — matched the sibling `_intents` line's INTENT (mirror
  // Python's `_is_influential=None`) but not its actual null assignment.
  // `undefined` serialized as JSON `null` under the old, permissive
  // `pyJsonDumps`, so this was silent; the stricter port (throws on a
  // bare `undefined`, since Python has no such value) now surfaces it
  // wherever a cached/serialized paper dict carries this field unset.
  if (paper._is_influential === undefined) paper._is_influential = null;
  if (paper._contexts === undefined) paper._contexts = [];
  return paper;
}

/** OpenAlex BFS — return parent/child papers for a given Work. Mirrors
 * the contract of `build_lineage.fetch_related` so callers can dispatch
 * by paperId prefix. `kind` is `"references"` (parents) or `"citations"`
 * (children, sorted by cited_by_count desc). */
export async function fetchRelatedViaOpenalex(
  openalexShortIdInput: string,
  kind: string,
  limit: number,
  deps: OpenAlexDeps,
): Promise<ThemePaper[]> {
  const normalized = openalexShortId(openalexShortIdInput);
  if (normalized === null) return [];
  const pageSize = Math.min(Math.max(1, limit), OPENALEX_PER_PAGE_MAX);

  if (kind === "references") {
    const params = withEmail(
      { select: "id,referenced_works,ids,primary_location,locations,doi" },
      deps,
    );
    const resp = (await get(
      `${OPENALEX_WORKS_URL}/${normalized}`,
      params,
      deps,
    )) as HttpResponseLike | null;
    const outcome = openalexOutcome(resp);
    if (outcome === "uncacheable") {
      throw new OpenAlexTransientError(
        `openalex work fetch failed (id=${normalized}, status=${resp ? resp.status : null})`,
      );
    }
    if (outcome === "absent") {
      deps.logger?.warn(
        `openalex work is absent (id=${normalized}, status=${resp ? resp.status : null}); treating as empty`,
      );
      return [];
    }
    let payload: unknown;
    try {
      payload = await (resp as HttpResponseLike).json();
    } catch {
      throw new OpenAlexTransientError(
        `openalex work fetch returned a malformed body (id=${normalized})`,
      );
    }
    if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
      throw new OpenAlexTransientError(
        `openalex work fetch returned a non-object body (id=${normalized})`,
      );
    }
    const payloadObj = payload as Record<string, unknown>;
    if (!("referenced_works" in payloadObj)) {
      throw new OpenAlexTransientError(
        `openalex work response omitted referenced_works (id=${normalized}, keys=${Object.keys(payloadObj).sort().slice(0, 5)})`,
      );
    }
    let refUrls = payloadObj.referenced_works;
    if (refUrls === null || refUrls === undefined) {
      refUrls = [];
    } else if (!Array.isArray(refUrls)) {
      throw new OpenAlexTransientError(
        `openalex referenced_works is not a list (id=${normalized})`,
      );
    }
    const badRef = firstUnusable(refUrls as unknown[], (u) => Boolean(openalexShortId(u)));
    if (badRef !== null) {
      const [index, item] = badRef;
      throw new OpenAlexTransientError(
        `openalex referenced_works has a malformed entry at index ${index} (id=${normalized}, type=${typeOf(item)})`,
      );
    }
    const refIds = (refUrls as unknown[])
      .map((u) => openalexShortId(u))
      .filter((s): s is string => Boolean(s));
    const focalArxiv = arxivIdFromWork(payloadObj);
    const wideCap = Math.min(refIds.length, OPENALEX_PER_PAGE_MAX);
    let incomplete: OpenAlexTransientError | null = null;
    let wideParents: ThemePaper[];
    try {
      wideParents = await fetchOpenAlexWorksByIds(refIds.slice(0, wideCap), deps);
    } catch (exc) {
      if (exc instanceof OpenAlexTransientError) {
        incomplete = exc;
        wideParents = exc.partial;
      } else {
        throw exc;
      }
    }
    const parents = splitByFoundationalPriority(wideParents, pageSize);
    const enriched = parents.map((p) => attachEmptyIntentFields(p));
    if (focalArxiv) {
      for (const p of enriched) enrichParentWithUnarxive(p, { citingArxivId: focalArxiv });
    }
    if (incomplete !== null) {
      throw new OpenAlexTransientError(incomplete.message, enriched);
    }
    return enriched;
  }

  if (kind !== "citations") {
    // Defensive: mirrors Python's fallthrough `return []` for an
    // unrecognised `kind` reaching this point at runtime (e.g. via an
    // un-narrowed caller) despite the TS literal-union type.
    return [];
  }
  const params = withEmail(
    { filter: `cites:${normalized}`, "per-page": pageSize, sort: "cited_by_count:desc" },
    deps,
  );
  const resp = (await get(OPENALEX_WORKS_URL, params, deps)) as HttpResponseLike | null;
  const outcome = openalexOutcome(resp);
  if (outcome === "uncacheable") {
    throw new OpenAlexTransientError(
      `openalex cites query failed (id=${normalized}, status=${resp ? resp.status : null})`,
    );
  }
  if (outcome === "absent") {
    deps.logger?.warn(
      `openalex work is absent (id=${normalized}, status=${resp ? resp.status : null}); treating as empty`,
    );
    return [];
  }
  let payload: unknown;
  try {
    payload = await (resp as HttpResponseLike).json();
  } catch {
    throw new OpenAlexTransientError(
      `openalex cites query returned a malformed body (id=${normalized})`,
    );
  }
  const results =
    payload !== null && typeof payload === "object" && !Array.isArray(payload)
      ? (payload as Record<string, unknown>).results
      : undefined;
  if (!Array.isArray(results)) {
    throw new OpenAlexTransientError(
      `openalex cites query returned no results array (id=${normalized})`,
    );
  }
  const badChild = firstUnusable(results, (w) => openalexWorkShape(w) !== null);
  if (badChild !== null) {
    const [index, item] = badChild;
    throw new OpenAlexTransientError(
      `openalex cites query returned a malformed Work at index ${index} (id=${normalized}, type=${typeOf(item)})`,
    );
  }
  const children: ThemePaper[] = [];
  const focalPaperId = `${OPENALEX_PAPER_ID_PREFIX}${normalized}`;
  for (const work of results) {
    const paper = workToPaperDict(work as Record<string, unknown>);
    if (paper === null) continue;
    attachEmptyIntentFields(paper);
    enrichChildWithUnarxive(paper, { citedOpenalexId: focalPaperId });
    children.push(paper);
  }
  return children;
}
