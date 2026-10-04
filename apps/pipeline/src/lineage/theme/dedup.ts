/**
 * Title/year + DOI duplicate collapse and strong-alias node dedup — TS
 * port of `paperpilot/scripts/build_theme_lineage.py`'s
 * `_normalize_dedup_title`, `_normalize_dedup_doi`, `_dedup_by_title_year`,
 * `_remap_edge_endpoints`, `_dedup_nodes_by_strong_alias`.
 */

import { codepointCompare, PY_WORD_CLASS_SOURCE } from "@paperpilot/core";
import { makePaperId } from "../../catalog/identity.js";
import {
  type AliasablePaper,
  CANONICAL_ALIAS_NAMESPACES,
  candidateRank,
  declaredAliasValues,
  type IdentityAliasIndex,
  lookupAlias,
} from "./identity.js";

// `[^\w\s]` with Python's Unicode `\w` semantics.
const TITLE_PUNCT_RE = new RegExp(`[^${PY_WORD_CLASS_SOURCE.slice(1, -1)}\\s]`, "gu");
const DOI_HOSTS: readonly string[] = ["doi.org", "www.doi.org", "dx.doi.org"];

/** Lowercase, strip punctuation, collapse whitespace — the primary
 * dedup key component. */
export function normalizeDedupTitle(title: string | null | undefined): string {
  if (!title) return "";
  const lowered = title.toLowerCase().replace(TITLE_PUNCT_RE, " ");
  return lowered.replace(/\s+/g, " ").trim();
}

export interface DedupDoiLike {
  externalIds?: Record<string, unknown> | null;
  doi?: unknown;
}

/** Secondary dedup key: the paper's DOI lowercased with the URL host
 * stripped (folds the `arxiv.`/`arXiv.` casing variance OpenAlex emits
 * and the doi.org URL-vs-bare-DOI variance). `null` when the paper
 * carries no DOI. */
export function normalizeDedupDoi(paper: DedupDoiLike): string | null {
  const external = paper.externalIds || {};
  const raw = external.DOI ?? external.doi ?? paper.doi;
  if (typeof raw !== "string" || !raw.trim()) return null;
  let doi = raw.trim().toLowerCase();
  for (const host of DOI_HOSTS) {
    const marker = `${host}/`;
    const idx = doi.indexOf(marker);
    if (idx !== -1) {
      doi = doi.slice(idx + marker.length);
      break;
    }
  }
  return doi || null;
}

/** Collapse same-title papers within this many years (preprint <->
 * published version). */
const DEDUP_YEAR_WINDOW = 2;

export interface DedupCiteLike {
  paperId?: unknown;
  id?: unknown;
  title?: unknown;
  year?: unknown;
  citationCount?: unknown;
  citation_count?: unknown;
  externalIds?: Record<string, unknown> | null;
  doi?: unknown;
}

/** Collapse true duplicates by `(normalised-title, year)` primary key, a
 * same-title-within-`DEDUP_YEAR_WINDOW` key, and normalised DOI, keeping
 * the higher-`citationCount` record on each collision (#298).
 *
 * Returns `[dedupedPapers, remap]` where `remap` maps every dropped
 * `paperId` onto the surviving `paperId`. Insertion order of survivors
 * is preserved. */
export function dedupByTitleYear<T extends DedupCiteLike>(
  papers: readonly T[],
): [T[], Map<string, string>] {
  if (papers.length === 0) return [[], new Map()];

  const keyToSurvivor = new Map<string, string>();
  const titleToSurvivor = new Map<string, string>();
  const survivors = new Map<string, T>();
  const order: string[] = [];
  const remap = new Map<string, string>();

  const cites = (p: T): number => {
    const n = Number(p.citationCount ?? p.citation_count ?? 0);
    return Number.isFinite(n) ? Math.trunc(n) : 0;
  };

  const register = (pid: string, normTitle: string, keys: string[]): void => {
    for (const k of keys) keyToSurvivor.set(k, pid);
    if (normTitle) titleToSurvivor.set(normTitle, pid);
  };

  for (const paper of papers) {
    const pid = (paper.paperId as string | undefined) ?? (paper.id as string | undefined);
    if (typeof pid !== "string" || !pid) continue;
    const normTitle = normalizeDedupTitle(paper.title as string | null | undefined);
    const year = paper.year;
    const yearKey = year !== null && year !== undefined ? String(year) : "";
    const doi = normalizeDedupDoi(paper);
    const keys: string[] = [];
    if (normTitle) keys.push(`ty\u0000${normTitle}|${yearKey}`);
    if (doi) keys.push(`doi\u0000${doi}`);
    if (keys.length === 0) {
      if (!survivors.has(pid)) {
        survivors.set(pid, paper);
        order.push(pid);
      }
      continue;
    }
    let existingPid: string | undefined;
    for (const k of keys) {
      const hit = keyToSurvivor.get(k);
      if (hit !== undefined) {
        existingPid = hit;
        break;
      }
    }
    if (
      existingPid === undefined &&
      normTitle &&
      typeof year === "number" &&
      Number.isInteger(year)
    ) {
      const cand = titleToSurvivor.get(normTitle);
      if (cand !== undefined && survivors.has(cand)) {
        const candYear = survivors.get(cand)?.year;
        if (
          typeof candYear === "number" &&
          Number.isInteger(candYear) &&
          Math.abs(year - candYear) <= DEDUP_YEAR_WINDOW
        ) {
          existingPid = cand;
        }
      }
    }
    if (existingPid === undefined) {
      survivors.set(pid, paper);
      order.push(pid);
      register(pid, normTitle, keys);
      continue;
    }
    const existing = survivors.get(existingPid)!;
    if (cites(paper) > cites(existing)) {
      order[order.indexOf(existingPid)] = pid;
      survivors.delete(existingPid);
      survivors.set(pid, paper);
      remap.set(existingPid, pid);
      for (const [dropped, target] of [...remap.entries()]) {
        if (target === existingPid) remap.set(dropped, pid);
      }
      for (const [k, v] of [...keyToSurvivor.entries()]) {
        if (v === existingPid) keyToSurvivor.set(k, pid);
      }
      for (const [t, v] of [...titleToSurvivor.entries()]) {
        if (v === existingPid) titleToSurvivor.set(t, pid);
      }
      register(pid, normTitle, keys);
    } else {
      remap.set(pid, existingPid);
      for (const k of keys) {
        if (!keyToSurvivor.has(k)) keyToSurvivor.set(k, existingPid);
      }
      if (normTitle && !titleToSurvivor.has(normTitle)) titleToSurvivor.set(normTitle, existingPid);
    }
  }
  const deduped = order.map((pid) => survivors.get(pid)!);
  return [deduped, remap];
}

export interface DedupEdgeLike {
  src: string;
  dst: string;
  [key: string]: unknown;
}

/** Reject endpoint rewrites whose endpoint-bound evidence cannot be
 * rebuilt. An identity collapse is still safe when the removed node is
 * isolated (no edge endpoint changes); otherwise this throws rather
 * than publish a false evidence binding. */
export function remapEdgeEndpoints<T extends DedupEdgeLike>(
  edges: readonly T[],
  remap: ReadonlyMap<string, string>,
): T[] {
  if (remap.size === 0) return edges as T[];
  for (const e of edges) {
    const src = remap.get(e.src) ?? e.src;
    const dst = remap.get(e.dst) ?? e.dst;
    if (src !== e.src || dst !== e.dst) {
      throw new RangeError("cannot remap endpoint-bound provenance after strong-alias dedup");
    }
  }
  return edges as T[];
}

/** Dedup graph nodes by exact normalized alias, never title/year.
 *
 * The deterministic survivor is citation-desc then graph-ID-asc. Focus
 * status and canonical seed identity are propagated to the survivor.
 * Every alias in every component is resolved, so conflicting canonical
 * identities fail the whole artifact (throw) even when only one member
 * was originally a focus. */
export function dedupNodesByStrongAlias<T extends AliasablePaper & Record<string, unknown>>(
  nodes: ReadonlyMap<string, T>,
  seedByGraphId: ReadonlyMap<string, string>,
  aliasIndex: IdentityAliasIndex = new Map(),
): [Map<string, T>, Map<string, string>, Map<string, string>] {
  const graphIds = [...nodes.keys()].sort(codepointCompare);
  const aliasesById = new Map<string, [string, string][]>();
  for (const graphId of graphIds) {
    aliasesById.set(graphId, declaredAliasValues(nodes.get(graphId)!) as [string, string][]);
  }

  const parent = new Map<string, string>(graphIds.map((id) => [id, id]));
  const find = (graphId: string): string => {
    let id = graphId;
    while (parent.get(id) !== id) {
      parent.set(id, parent.get(parent.get(id)!)!);
      id = parent.get(id)!;
    }
    return id;
  };
  const union = (left: string, right: string): void => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot !== rightRoot) {
      const cmp = codepointCompare(leftRoot, rightRoot);
      const hi = cmp > 0 ? leftRoot : rightRoot;
      const lo = cmp > 0 ? rightRoot : leftRoot;
      parent.set(hi, lo);
    }
  };

  const aliasOwner = new Map<string, string>();
  for (const graphId of graphIds) {
    for (const [ns, v] of aliasesById.get(graphId) ?? []) {
      const key = `${ns}\u0000${v}`;
      const owner = aliasOwner.get(key);
      if (owner === undefined) {
        aliasOwner.set(key, graphId);
        union(graphId, graphId);
      } else {
        union(graphId, owner);
      }
    }
  }

  const components = new Map<string, string[]>();
  for (const graphId of graphIds) {
    const root = find(graphId);
    const list = components.get(root) ?? [];
    list.push(graphId);
    components.set(root, list);
  }

  const survivors = new Map<string, T>();
  const remap = new Map<string, string>();
  const survivorSeed = new Map<string, string>();

  for (const members of components.values()) {
    let survivorId = members[0]!;
    let survivorKey = candidateRank(nodes.get(survivorId)!);
    for (const graphId of members.slice(1)) {
      const key = candidateRank(nodes.get(graphId)!);
      if (key[0] < survivorKey[0] || (key[0] === survivorKey[0] && key[1] < survivorKey[1])) {
        survivorId = graphId;
        survivorKey = key;
      }
    }
    const resolvedIds = new Set<string>();
    for (const graphId of members) {
      const seed = seedByGraphId.get(graphId);
      if (seed !== undefined) resolvedIds.add(seed);
    }
    for (const graphId of members) {
      for (const alias of aliasesById.get(graphId) ?? []) {
        const matches = lookupAlias(aliasIndex, alias[0], alias[1]);
        if (matches.size > 1) {
          throw new RangeError(`ambiguous identity alias ${alias[0]}:${alias[1]}`);
        }
        if (matches.size > 0) {
          for (const m of matches) resolvedIds.add(m);
        } else if (CANONICAL_ALIAS_NAMESPACES.has(alias[0])) {
          resolvedIds.add(makePaperId(alias[0], alias[1]));
        }
      }
    }
    if (resolvedIds.size > 1) {
      throw new RangeError(`conflicting seed IDs on exact alias for ${JSON.stringify(survivorId)}`);
    }
    const survivor = nodes.get(survivorId)!;
    const mergedAliasesSet = new Map<string, [string, string]>();
    for (const graphId of members) {
      for (const alias of aliasesById.get(graphId) ?? []) {
        mergedAliasesSet.set(`${alias[0]}\u0000${alias[1]}`, alias);
      }
    }
    const mergedAliases = [...mergedAliasesSet.values()].sort(
      (a, b) => codepointCompare(a[0], b[0]) || codepointCompare(a[1], b[1]),
    );
    if (mergedAliases.length > 0) {
      (survivor as Record<string, unknown>).aliases = mergedAliases.map(([ns, v]) => [ns, v]);
    }
    survivors.set(survivorId, survivor);
    const memberSeeds = new Set<string>();
    for (const graphId of members) {
      const seed = seedByGraphId.get(graphId);
      if (seed !== undefined) memberSeeds.add(seed);
    }
    if (memberSeeds.size > 0) {
      survivorSeed.set(survivorId, [...memberSeeds][0]!);
    }
    for (const graphId of members) {
      if (graphId !== survivorId) remap.set(graphId, survivorId);
    }
  }
  return [survivors, remap, survivorSeed];
}
