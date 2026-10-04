/**
 * Build a citation-graph lineage for a conference's Oral papers —
 * OpenAlex only. TS port of `paperpilot/scripts/build_conference_lineage.py`
 * (LIN-08, LIN-09, LIN-10, LIN-11, LIN-23 of docs/migration/safety-contracts.md).
 *
 * A free-tier, S2-free, LLM-free path to a conference family tree.
 * `buildLineage.ts` (the S2+LLM "build_lineage.py" port) resolves papers via
 * arXiv -> Semantic Scholar, which needs an arxiv_id OpenReview/CVF/ACL
 * papers don't carry and is hard rate-limited without a key. This builder
 * instead resolves each Oral paper through an exact strong external alias
 * exposed by OpenAlex, then takes its top references (ancestors) and top
 * citing works (descendants) to form a structural family tree.
 *
 * Edges are heuristic — a citation is rendered as a `successor`
 * relationship (newer builds on older). This is NOT the LLM-classified
 * relation graph `buildLineage.ts` produces; it is a structural
 * demo/fallback. The output schema matches the shared lineage viewer:
 * `{root, nodes, edges, clusters}`.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { IdentityError, identityFromUrl, normalizeAlias } from "../../catalog/identity.js";
import { validateConferenceSlug } from "../../catalog/slug.js";
import type { FetchLike } from "../../collect/http/requestWithRetry.js";
import { requestWithRetry } from "../../collect/http/requestWithRetry.js";
import { firstUnusable } from "../../collect/signals/payload.js";
import {
  canonicalJsonSha256,
  LINEAGE_ARTIFACT_VERSION,
  makeProvenance,
  requirePaperId,
  requireValidLineageArtifact,
} from "../contract/v1.js";
import { BuildCompleteness, IncompleteFetchError } from "../fetch-state/completeness.js";
import { openalexShortId } from "../theme/openalexWork.js";
import { openalexWorkShape } from "../theme/payloadShape.js";

const OPENALEX_WORKS_URL = "https://api.openalex.org/works";
const PRODUCER_NAME = "paperpilot.scripts.build_conference_lineage";
const PRODUCER_VERSION = "1";
const CLASSIFICATION_SCHEMA_VERSION = "citation-successor-v1";
const NATIVE_ALIAS_SOURCES = new Set(["arxiv", "openreview", "acl_anthology", "cvf"]);
const RESOLVE_PAGE_SIZE = 25;

const TAG_RULES: Readonly<Record<string, RegExp[]>> = {
  Vision: [/\bimage/i, /\bvideo/i, /\b3d\b/i, /detection/i, /segmentation/i, /\bvisual/i],
  Diffusion: [/diffusion/i, /generat/i],
  VLM: [/vision[- ]language/i, /multimodal/i, /\bvlm\b/i],
  LLM: [/\bllm\b/i, /language model/i],
  Transformer: [/transformer/i, /attention/i],
  "3D": [/\b3d\b/i, /nerf/i, /gaussian/i, /point cloud/i, /mesh/i],
  Detection: [/detection/i, /segmentation/i],
};

function isMapping(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Python `str(value)` for values that can appear unrepr'd in an f-string (only `None` matters here). */
function pyStr(value: unknown): string {
  return value === null || value === undefined ? "None" : String(value);
}

/** Approximate Python `repr(str)` for plain-text strings (single-quoted, backslash/quote-escaped).
 * Not a full port (no `\xHH`/non-BMP handling) — these values are always short human-readable
 * titles/filters/filenames in this module, never attacker-controlled binary data. */
function pyRepr(value: string): string {
  const useDouble = value.includes("'") && !value.includes('"');
  const quote = useDouble ? '"' : "'";
  const escaped = value
    .replace(/\\/g, "\\\\")
    .replace(new RegExp(quote, "g"), `\\${quote}`)
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t");
  return `${quote}${escaped}${quote}`;
}

function shortId(workIdUrl: unknown): string {
  return openalexShortId(workIdUrl) ?? "";
}

function normalizeOpenalexId(value: string): string {
  const candidate = openalexShortId(value);
  if (candidate === null) throw new Error(`invalid OpenAlex work ID: ${pyRepr(value)}`);
  return candidate;
}

/** NFKC-normalize + casefold + collapse whitespace (representation differences only, no fuzzy match). */
function normalizeTitle(title: string): string {
  return title.normalize("NFKC").toLowerCase().trim().split(/\s+/).join(" ");
}

type AliasKey = string; // `${namespace}\u0000${value}`
function aliasKey(namespace: string, value: string): AliasKey {
  return `${namespace}\u0000${value}`;
}
function aliasParts(key: AliasKey): [string, string] {
  const i = key.indexOf("\u0000");
  return [key.slice(0, i), key.slice(i + 1)];
}

/** Validated strong aliases present on one catalog row. */
function catalogAliases(oral: Record<string, unknown>): Set<AliasKey> {
  const aliases = new Set<AliasKey>();

  const source = oral.source;
  const sourceId = oral.source_id;
  if (typeof source === "string" && NATIVE_ALIAS_SOURCES.has(source.trim().toLowerCase())) {
    if (typeof sourceId !== "string" || !sourceId.trim()) {
      throw new Error(`catalog source ${pyRepr(source)} requires a non-empty source_id`);
    }
    try {
      const [ns, val] = normalizeAlias(source, sourceId);
      aliases.add(aliasKey(ns, val));
    } catch (exc) {
      if (!(exc instanceof IdentityError)) throw exc;
      throw new Error(`invalid catalog source alias: ${exc.message}`);
    }
  }

  for (const [field, namespace] of [
    ["arxiv_id", "arxiv"],
    ["doi", "doi"],
  ] as const) {
    const value = oral[field];
    if (value === null || value === undefined || value === "") continue;
    if (typeof value !== "string") throw new Error(`oral.${field} must be a string`);
    try {
      const [ns, val] = normalizeAlias(namespace, value);
      aliases.add(aliasKey(ns, val));
    } catch (exc) {
      if (!(exc instanceof IdentityError)) throw exc;
      throw new Error(`invalid oral.${field}: ${exc.message}`);
    }
  }

  const openalexId = oral.openalex_id;
  if (openalexId !== null && openalexId !== undefined && openalexId !== "") {
    if (typeof openalexId !== "string") throw new Error("oral.openalex_id must be a string");
    aliases.add(aliasKey("openalex", normalizeOpenalexId(openalexId)));
  }

  return aliases;
}

function usableWork(work: unknown): boolean {
  return openalexWorkShape(work) !== null;
}

/** Extract exact external aliases exposed by one OpenAlex Work response. */
function workAliases(work: Record<string, unknown>): Set<AliasKey> {
  const aliases = new Set<AliasKey>();
  const ids = isMapping(work.ids) ? work.ids : {};
  for (const value of [work.id, ids.openalex]) {
    if (typeof value === "string") {
      try {
        aliases.add(aliasKey("openalex", normalizeOpenalexId(value)));
      } catch {
        // skip
      }
    }
  }

  for (const value of [work.doi, ids.doi]) {
    if (typeof value !== "string") continue;
    try {
      const [ns, val] = normalizeAlias("doi", value);
      aliases.add(aliasKey(ns, val));
      const arxivDoiPrefix = "10.48550/arxiv.";
      if (val.startsWith(arxivDoiPrefix)) {
        const [ans, aval] = normalizeAlias("arxiv", val.slice(arxivDoiPrefix.length));
        aliases.add(aliasKey(ans, aval));
      }
    } catch (exc) {
      if (!(exc instanceof IdentityError)) throw exc;
    }
  }
  for (const key of ["arxiv", "arxiv_id"]) {
    const value = ids[key];
    if (typeof value !== "string") continue;
    try {
      const [ns, val] = normalizeAlias("arxiv", value);
      aliases.add(aliasKey(ns, val));
    } catch (exc) {
      if (!(exc instanceof IdentityError)) throw exc;
    }
  }
  for (const key of ["openreview", "openreview_id"]) {
    const value = ids[key];
    if (typeof value !== "string") continue;
    try {
      const [ns, val] = normalizeAlias("openreview", value);
      aliases.add(aliasKey(ns, val));
    } catch (exc) {
      if (!(exc instanceof IdentityError)) throw exc;
    }
  }

  const locations: Record<string, unknown>[] = [];
  const primary = work.primary_location;
  if (isMapping(primary)) locations.push(primary);
  if (Array.isArray(work.locations)) {
    for (const item of work.locations) if (isMapping(item)) locations.push(item);
  }
  for (const location of locations) {
    for (const key of ["landing_page_url", "pdf_url"]) {
      const value = location[key];
      if (typeof value !== "string") continue;
      try {
        const identity = identityFromUrl(value);
        aliases.add(aliasKey(identity.source, identity.sourceId));
      } catch (exc) {
        if (!(exc instanceof IdentityError)) throw exc;
      }
    }
  }
  return aliases;
}

/** Select exactly one result by strong aliases; title is never identity. */
function selectOpenalexMatch(
  results: unknown[],
  aliases: ReadonlySet<AliasKey>,
): Record<string, unknown> | null {
  const candidates = new Map<string, Record<string, unknown>>();
  if (aliases.size === 0) return null;
  for (const result of results) {
    if (!isMapping(result)) continue;
    const workId = openalexShortId(result.id);
    if (workId === null) continue;
    const resultAliases = workAliases(result);
    const subset = Array.from(aliases).every((a) => resultAliases.has(a));
    if (subset) candidates.set(workId, result);
  }
  const values = Array.from(candidates.values());
  return values.length === 1 ? values[0]! : null;
}

function authors(work: Record<string, unknown>, limit = 4): string[] {
  const out: string[] = [];
  const authorships = Array.isArray(work.authorships) ? work.authorships : [];
  for (const a of authorships.slice(0, limit)) {
    if (!isMapping(a)) continue;
    const author = isMapping(a.author) ? a.author : {};
    const name = author.display_name;
    if (typeof name === "string" && name) out.push(name);
  }
  return out;
}

function kinds(title: string): string[] {
  const t = title.toLowerCase();
  return Object.entries(TAG_RULES)
    .filter(([, pats]) => pats.some((p) => p.test(t)))
    .map(([tag]) => tag);
}

function venueOf(work: Record<string, unknown>): string {
  const primary = isMapping(work.primary_location) ? work.primary_location : {};
  const src = isMapping(primary.source) ? primary.source : {};
  return typeof src.display_name === "string" ? src.display_name : "";
}

export interface OpenAlexDeps {
  fetchImpl: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  logger?: { warn: (msg: string) => void };
}

interface OpenAlexResponse {
  status: number;
  json(): Promise<unknown>;
}

/**
 * One OpenAlex query. Throws {@link IncompleteFetchError} instead of
 * collapsing a failure into `null`/empty — see the Python original's doc
 * comment for why (an outage must never be silently read as "no results").
 */
async function get(
  params: Record<string, string | number | boolean | undefined>,
  options: { email?: string | null },
  deps: OpenAlexDeps,
): Promise<Record<string, unknown>> {
  const withEmail = options.email ? { ...params, mailto: options.email } : params;
  const resp = (await requestWithRetry(
    { method: "GET", url: OPENALEX_WORKS_URL, params: withEmail, timeoutMs: 20_000 },
    deps,
  )) as OpenAlexResponse | null;
  if (resp === null || resp.status !== 200) {
    throw new IncompleteFetchError(
      `openalex query failed (status=${pyStr(resp ? resp.status : null)}, filter=${pyRepr(String(params.filter))})`,
    );
  }
  let data: unknown;
  try {
    data = await resp.json();
  } catch {
    throw new IncompleteFetchError(
      `openalex returned a malformed body (filter=${pyRepr(String(params.filter))})`,
    );
  }
  if (!isMapping(data)) {
    throw new IncompleteFetchError(
      `openalex returned a non-object body (filter=${pyRepr(String(params.filter))})`,
    );
  }
  const results = data.results;
  if (!Array.isArray(results)) {
    const keys = Object.keys(data).sort().slice(0, 5);
    throw new IncompleteFetchError(
      `openalex returned no results array (filter=${pyRepr(String(params.filter))}, keys=${JSON.stringify(keys)})`,
    );
  }
  const bad = firstUnusable(results, usableWork);
  if (bad !== null) {
    const [index, item] = bad;
    throw new IncompleteFetchError(
      `openalex returned a result with no usable OpenAlex id at index ${index} ` +
        `(filter=${pyRepr(String(params.filter))}, type=${typeof item})`,
    );
  }
  return data;
}

/** Resolve only a unique strong-alias match; title-only lookup is forbidden. */
export async function resolveOral(
  title: string,
  aliases: ReadonlySet<AliasKey>,
  options: { email?: string | null },
  deps: OpenAlexDeps,
): Promise<Record<string, unknown> | null> {
  if (aliases.size === 0) return null;
  const data = await get(
    {
      filter: `title.search:${title}`,
      "per-page": RESOLVE_PAGE_SIZE,
      select:
        "id,title,publication_year,authorships,primary_location,locations,ids,doi,referenced_works,cited_by_count",
    },
    options,
    deps,
  );
  const results = Array.isArray(data.results) ? data.results : [];
  return selectOpenalexMatch(results, aliases);
}

export interface BuildCompletenessLike {
  expansionAttempted(): void;
  expansionFailed(): void;
}

/** Batch-fetch title/year/authors for OpenAlex work ids (50 per request). Expansion, not subject resolution. */
export async function fetchMeta(
  ids: readonly string[],
  options: { email?: string | null; completeness?: BuildCompletenessLike | null },
  deps: OpenAlexDeps,
): Promise<Map<string, Record<string, unknown>>> {
  const out = new Map<string, Record<string, unknown>>();
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50);
    options.completeness?.expansionAttempted();
    let data: Record<string, unknown>;
    try {
      data = await get(
        {
          filter: `ids.openalex:${chunk.join("|")}`,
          "per-page": 50,
          select: "id,title,publication_year,authorships,primary_location",
        },
        options,
        deps,
      );
    } catch (exc) {
      if (!(exc instanceof IncompleteFetchError)) throw exc;
      deps.logger?.warn(`conference lineage: metadata page failed: ${exc.message}`);
      options.completeness?.expansionFailed();
      continue;
    }
    for (const w of Array.isArray(data.results) ? data.results : []) {
      if (isMapping(w)) out.set(shortId(w.id ?? ""), w);
    }
  }
  return out;
}

/** Top-k most-cited works that cite `workId` (the descendants). Expansion. */
export async function fetchCiters(
  workId: string,
  k: number,
  options: { email?: string | null; completeness?: BuildCompletenessLike | null },
  deps: OpenAlexDeps,
): Promise<Record<string, unknown>[]> {
  options.completeness?.expansionAttempted();
  let data: Record<string, unknown>;
  try {
    data = await get(
      {
        filter: `cites:${workId}`,
        sort: "cited_by_count:desc",
        "per-page": k,
        select: "id,title,publication_year,authorships,primary_location",
      },
      options,
      deps,
    );
  } catch (exc) {
    if (!(exc instanceof IncompleteFetchError)) throw exc;
    deps.logger?.warn(`conference lineage: citers for ${workId} failed: ${exc.message}`);
    options.completeness?.expansionFailed();
    return [];
  }
  return Array.isArray(data.results) ? (data.results as Record<string, unknown>[]) : [];
}

function node(
  work: Record<string, unknown>,
  options: { venue: string; tier: string; isFocus: boolean; seedPaperId?: string | null },
): Record<string, unknown> {
  const title = typeof work.title === "string" ? work.title : "";
  const out: Record<string, unknown> = {
    id: shortId(work.id ?? ""),
    title,
    year: work.publication_year ?? null,
    venue: options.venue || venueOf(work),
    venue_tier: options.tier,
    authors: authors(work),
    kinds: kinds(title),
    github_stars: 0,
    is_focus: options.isFocus,
  };
  if (options.isFocus) {
    out.seed_paper_id = requirePaperId(options.seedPaperId, "seed_paper_id");
  }
  return out;
}

function edge(
  src: string,
  dst: string,
  srcYear: unknown,
  dstYear: unknown,
): Record<string, unknown> {
  const evidenceSha256 = canonicalJsonSha256({
    cited_work_id: src,
    citing_work_id: dst,
    cited_year: srcYear ?? null,
    citing_year: dstYear ?? null,
    kind: "citation",
    source: "openalex",
  });
  return {
    src,
    dst,
    rel: "successor",
    relation: "successor",
    conf: 0.4,
    confidence: 0.4,
    rationale: "引用関係から導出（後継）。LLM 分類前のヒューリスティック。",
    provenance: makeProvenance({
      producerName: PRODUCER_NAME,
      producerVersion: PRODUCER_VERSION,
      evidenceSource: "openalex",
      evidenceKind: "citation",
      evidenceSha256,
      method: "citation_heuristic",
      provider: null,
      model: null,
      promptVersion: null,
      classificationSchemaVersion: CLASSIFICATION_SCHEMA_VERSION,
    }),
  };
}

function deterministicRoot(
  nodes: Map<string, Record<string, unknown>>,
  edges: readonly Record<string, unknown>[],
): string | null {
  const degree = new Map<string, number>();
  for (const e of edges) {
    const src = e.src as string;
    const dst = e.dst as string;
    degree.set(src, (degree.get(src) ?? 0) + 1);
    degree.set(dst, (degree.get(dst) ?? 0) + 1);
  }
  const focusIds = Array.from(nodes.entries())
    .filter(([, n]) => n.is_focus === true)
    .map(([id]) => id)
    .sort();
  if (focusIds.length === 0) return null;
  return focusIds.reduce((best, candidate) => {
    const bestDeg = -(degree.get(best) ?? 0);
    const candDeg = -(degree.get(candidate) ?? 0);
    if (candDeg < bestDeg) return candidate;
    if (candDeg > bestDeg) return best;
    return candidate < best ? candidate : best;
  }, focusIds[0]!);
}

function generatedAtNow(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** Group the focus (Oral) papers by topic kind for the viewer's Topics mode. */
function clusters(nodes: readonly Record<string, unknown>[]): Record<string, unknown>[] {
  const buckets = new Map<string, string[]>();
  const labels = new Map<string, string>();
  for (const n of nodes) {
    if (!n.is_focus) continue;
    const ks = Array.isArray(n.kinds) && n.kinds.length > 0 ? (n.kinds as string[]) : ["Other"];
    for (const k of ks) {
      if (!buckets.has(k)) buckets.set(k, []);
      buckets.get(k)!.push(n.id as string);
      labels.set(k, k);
    }
  }
  return Array.from(buckets.entries())
    .sort(
      ([ka, va], [kb, vb]) =>
        vb.length - va.length || ka.toLowerCase().localeCompare(kb.toLowerCase()),
    )
    .map(([k, ids]) => ({ id: k.toLowerCase(), label: labels.get(k)!, focus_ids: ids }));
}

export interface BuildGraphOptions {
  display: string;
  refsPer: number;
  citersPer: number;
  email?: string | null;
  generatedAt?: string | null;
  completeness?: BuildCompleteness | null;
}

/** Resolve orals -> works, attach top references + citers, emit the lineage graph. */
export async function buildGraph(
  orals: readonly Record<string, unknown>[],
  options: BuildGraphOptions,
  deps: OpenAlexDeps,
): Promise<Record<string, unknown>> {
  const {
    display,
    refsPer,
    citersPer,
    email = null,
    generatedAt = null,
    completeness = null,
  } = options;
  if (!Array.isArray(orals)) throw new Error("orals must be a list");
  if (typeof display !== "string" || !display.trim())
    throw new Error("display must be a non-empty string");
  for (const [field, value] of [
    ["refsPer", refsPer],
    ["citersPer", citersPer],
  ] as const) {
    if (!Number.isInteger(value) || value < 0)
      throw new Error(`${field} must be a non-negative integer`);
  }

  const prepared: {
    oral: Record<string, unknown>;
    seed: string;
    title: string;
    aliases: Set<AliasKey>;
  }[] = [];
  const seedIds = new Set<string>();
  const aliasOwners = new Map<AliasKey, string>();
  orals.forEach((oral, index) => {
    if (!isMapping(oral)) throw new Error(`orals[${index}] must be an object`);
    const seed = requirePaperId(oral.paper_id, `orals[${index}].paper_id`);
    if (seedIds.has(seed)) throw new Error(`duplicate catalog paper_id: ${seed}`);
    seedIds.add(seed);
    const title = oral.title;
    if (typeof title !== "string" || !normalizeTitle(title)) {
      throw new Error(`orals[${index}].title must be a non-empty string`);
    }
    const aliases = catalogAliases(oral);
    for (const alias of aliases) {
      const owner = aliasOwners.get(alias);
      if (owner === undefined) aliasOwners.set(alias, seed);
      else if (owner !== seed) {
        const [ns, val] = aliasParts(alias);
        throw new Error(
          `strong alias belongs to multiple catalog papers: (${pyRepr(ns)}, ${pyRepr(val)})`,
        );
      }
    }
    prepared.push({ oral, seed, title, aliases });
  });

  const seeds = prepared.map((p) => p.seed);
  const nodes = new Map<string, Record<string, unknown>>();
  const edges: Record<string, unknown>[] = [];
  const refIdsNeeded = new Set<string>();
  const oralRecords: { work: Record<string, unknown>; refs: string[]; seed: string }[] = [];

  for (const { title, seed, aliases } of prepared) {
    let work: Record<string, unknown> | null;
    try {
      work = await resolveOral(title, aliases, { email }, deps);
    } catch (exc) {
      if (!(exc instanceof IncompleteFetchError)) throw exc;
      deps.logger?.warn(`conference lineage: could not resolve ${pyRepr(title)}: ${exc.message}`);
      completeness?.subjectFailed(`oral ${pyRepr(title)}: ${exc.message}`);
      continue;
    }
    if (!work) continue;
    const oid = shortId(work.id ?? "");
    if (!oid) continue;
    if (nodes.has(oid)) {
      if (nodes.get(oid)!.seed_paper_id !== seed) {
        throw new Error(`distinct catalog papers resolve to the same OpenAlex work: ${oid}`);
      }
      continue;
    }
    nodes.set(oid, node(work, { venue: display, tier: "A", isFocus: true, seedPaperId: seed }));
    let rawRefs = work.referenced_works;
    if (!Array.isArray(rawRefs)) {
      deps.logger?.warn(
        `conference lineage: ${pyRepr(title)} resolved without a referenced_works array`,
      );
      completeness?.expansionAttempted();
      completeness?.expansionFailed();
      rawRefs = [];
    } else if (firstUnusable(rawRefs, (r) => Boolean(openalexShortId(r))) !== null) {
      deps.logger?.warn(
        `conference lineage: ${pyRepr(title)} has a malformed referenced_works entry`,
      );
      completeness?.expansionAttempted();
      completeness?.expansionFailed();
      rawRefs = [];
    }
    const refs = (rawRefs as unknown[]).map((r) => shortId(r)).slice(0, refsPer);
    oralRecords.push({ work, refs, seed });
    for (const r of refs) refIdsNeeded.add(r);
  }

  const refMeta =
    refIdsNeeded.size > 0
      ? await fetchMeta(Array.from(refIdsNeeded).sort(), { email, completeness }, deps)
      : new Map<string, Record<string, unknown>>();

  for (const { work, refs } of oralRecords) {
    const oid = shortId(work.id ?? "");
    const oyear = nodes.get(oid)!.year;
    for (const rid of refs) {
      const rw = refMeta.get(rid);
      if (!rw) continue;
      if (!nodes.has(rid))
        nodes.set(rid, node(rw, { venue: venueOf(rw), tier: "", isFocus: false }));
      edges.push(edge(rid, oid, nodes.get(rid)!.year, oyear));
    }
    for (const cw of await fetchCiters(
      shortId(work.id ?? ""),
      citersPer,
      { email, completeness },
      deps,
    )) {
      const cid = shortId(cw.id ?? "");
      if (!cid) continue;
      if (!nodes.has(cid))
        nodes.set(cid, node(cw, { venue: venueOf(cw), tier: "", isFocus: false }));
      edges.push(edge(oid, cid, oyear, nodes.get(cid)!.year));
    }
  }

  const seen = new Set<string>();
  const uniqEdges: Record<string, unknown>[] = [];
  for (const e of edges) {
    const key = `${e.src}\u0000${e.dst}`;
    if (e.src !== e.dst && !seen.has(key)) {
      seen.add(key);
      uniqEdges.push(e);
    }
  }

  const ordered = Array.from(nodes.values()).sort((a, b) =>
    (a.id as string) < (b.id as string) ? -1 : (a.id as string) > (b.id as string) ? 1 : 0,
  );
  const orderedEdges = uniqEdges.sort((a, b) => {
    const ak = `${a.src}\u0000${a.dst}\u0000${a.relation}`;
    const bk = `${b.src}\u0000${b.dst}\u0000${b.relation}`;
    return ak < bk ? -1 : ak > bk ? 1 : 0;
  });
  const graph: Record<string, unknown> = {
    schema_version: LINEAGE_ARTIFACT_VERSION,
    root: deterministicRoot(nodes, orderedEdges),
    nodes: ordered,
    edges: orderedEdges,
    clusters: clusters(ordered),
    meta: {
      kind: "conference",
      generator: PRODUCER_NAME,
      generated_at: generatedAt || generatedAtNow(),
      completeness: (completeness ?? new BuildCompleteness()).asMeta(),
    },
  };
  requireValidLineageArtifact(graph, { kind: "conference", catalogIds: new Set(seeds) });
  return graph;
}

export function loadOrals(
  docsRoot: string,
  conference: string,
  maxOrals: number,
): Record<string, unknown>[] {
  const papers = JSON.parse(
    readFileSync(join(docsRoot, conference, "papers.json"), "utf8"),
  ) as Record<string, unknown>[];
  const orals = papers.filter((p) => p.type === "Oral");
  return maxOrals ? orals.slice(0, maxOrals) : orals;
}

export { validateConferenceSlug };
