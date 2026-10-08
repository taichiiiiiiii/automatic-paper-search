/**
 * Strong-alias identity resolution for theme focus candidates — TS port
 * of the identity-gate section of `paperpilot/scripts/build_theme_lineage.py`
 * (`_load_identity_aliases`, `_declared_alias_values`, `_resolve_seed_paper_id`,
 * `_candidate_rank`, `_resolve_and_dedup_seeds`).
 *
 * Safety contract LIN-25: ambiguous/unreadable identity-aliases sidecar,
 * a conflicting canonical seed ID, or a mismatched declared
 * `seed_paper_id` must fail closed (throw) before any write — never
 * silently fall back to title/year matching or a graph-provider ID.
 */

import { readFileSync } from "node:fs";
import { codepointCompare } from "@paperpilot/core";
import { IdentityError, makePaperId, normalizeAlias } from "@paperpilot/core/identity";
import { isPaperId } from "../contract/v1.js";

export const CANONICAL_ALIAS_NAMESPACES: ReadonlySet<string> = new Set([
  "arxiv",
  "openreview",
  "acl_anthology",
  "cvf",
]);

export type AliasKey = readonly [string, string];

/** Multi-map of exact alias -> set of canonical paper ids, loaded from
 * `docs/identity-aliases-v1.json` (an array of `[namespace, id, paper_id]`
 * rows). An alias claimed by more than one `paper_id` is ambiguous and
 * must fail closed wherever it is looked up, rather than picking one. */
export type IdentityAliasIndex = ReadonlyMap<string, ReadonlySet<string>>;

function aliasMapKey(namespace: string, value: string): string {
  return `${namespace}\u0000${value}`;
}

/** Load exact aliases as a multi-map so ambiguous sidecars fail closed.
 *
 * `raw` is the already-parsed JSON (an array of 3-string rows); callers
 * (tests, and eventually the real builder) read the file themselves —
 * this function's job is only the validation + indexing, matching how
 * `_load_identity_aliases` is unit-tested against in-memory rows in the
 * Python suite as often as against a real path. */
export function loadIdentityAliasesFromRows(rows: unknown): IdentityAliasIndex {
  if (!Array.isArray(rows)) {
    throw new RangeError("identity-aliases-v1.json must be an array");
  }
  const aliases = new Map<string, Set<string>>();
  rows.forEach((row, index) => {
    if (!(Array.isArray(row) && row.length === 3 && row.every((v) => typeof v === "string"))) {
      throw new RangeError(`identity alias row ${index} must be [namespace,id,paper_id]`);
    }
    const [namespace, sourceId, paperId] = row as [string, string, string];
    let key: AliasKey;
    try {
      key = normalizeAlias(namespace, sourceId);
    } catch (exc) {
      if (exc instanceof IdentityError) {
        throw new RangeError(`identity alias row ${index} is invalid`);
      }
      throw exc;
    }
    if (!isPaperId(paperId)) {
      throw new RangeError(`identity alias row ${index} has invalid paper_id`);
    }
    const mapKey = aliasMapKey(key[0], key[1]);
    const set = aliases.get(mapKey) ?? new Set<string>();
    set.add(paperId);
    aliases.set(mapKey, set);
  });
  return aliases;
}

/** Load `docs/identity-aliases-v1.json` (`_load_identity_aliases`).
 * A MISSING file degrades to `{}` (no aliases); a PRESENT but malformed
 * file throws (fails closed — see `loadIdentityAliasesFromRows`). */
export function loadIdentityAliases(path: string): IdentityAliasIndex {
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch (exc) {
    const err = exc as NodeJS.ErrnoException;
    if (err.code === "ENOENT") return new Map();
    throw new RangeError(`identity aliases are unreadable: ${path}`);
  }
  let rows: unknown;
  try {
    rows = JSON.parse(raw);
  } catch {
    throw new RangeError(`identity aliases are unreadable: ${path}`);
  }
  return loadIdentityAliasesFromRows(rows);
}

export function lookupAlias(
  index: IdentityAliasIndex,
  namespace: string,
  value: string,
): ReadonlySet<string> {
  return index.get(aliasMapKey(namespace, value)) ?? new Set();
}

export interface AliasablePaper {
  externalIds?: Record<string, unknown> | null;
  arxiv_id?: unknown;
  openreview_id?: unknown;
  acl_anthology_id?: unknown;
  cvf_id?: unknown;
  doi?: unknown;
  aliases?: unknown;
  source?: unknown;
  source_id?: unknown;
  seed_paper_id?: unknown;
  paperId?: unknown;
  [key: string]: unknown;
}

const EXTERNAL_KEYS: ReadonlyMap<string, string> = new Map([
  ["ArXiv", "arxiv"],
  ["arxiv", "arxiv"],
  ["OpenReview", "openreview"],
  ["openreview", "openreview"],
  ["ACL", "acl_anthology"],
  ["ACLAnthology", "acl_anthology"],
  ["acl_anthology", "acl_anthology"],
  ["CVF", "cvf"],
  ["cvf", "cvf"],
  ["DOI", "doi"],
  ["doi", "doi"],
]);

const DIRECT_KEYS: ReadonlyMap<string, string> = new Map([
  ["arxiv_id", "arxiv"],
  ["openreview_id", "openreview"],
  ["acl_anthology_id", "acl_anthology"],
  ["cvf_id", "cvf"],
  ["doi", "doi"],
]);

/** Return every exact normalized identity alias declared by a source
 * row. Semantic Scholar and OpenAlex graph IDs are deliberately ignored.
 * A malformed value in a recognized alias field is an identity error
 * (throws) rather than permission to fall back to title/year. */
export function declaredAliasValues(paper: AliasablePaper): AliasKey[] {
  const raw: [string, unknown][] = [];
  const external = paper.externalIds;
  if (external !== undefined && external !== null && typeof external !== "object") {
    throw new RangeError("externalIds must be an object when present");
  }
  const externalObj = (external ?? {}) as Record<string, unknown>;
  for (const [key, namespace] of EXTERNAL_KEYS) {
    if (
      key in externalObj &&
      externalObj[key] !== null &&
      externalObj[key] !== "" &&
      externalObj[key] !== undefined
    ) {
      raw.push([namespace, externalObj[key]]);
    }
  }
  for (const [key, namespace] of DIRECT_KEYS) {
    if (key in paper && paper[key] !== null && paper[key] !== "" && paper[key] !== undefined) {
      raw.push([namespace, paper[key]]);
    }
  }
  const declaredAliases = paper.aliases;
  if (declaredAliases !== undefined && declaredAliases !== null) {
    if (!Array.isArray(declaredAliases)) {
      throw new RangeError("aliases must be an array when present");
    }
    for (const alias of declaredAliases) {
      if (
        !(Array.isArray(alias) && alias.length === 2 && alias.every((v) => typeof v === "string"))
      ) {
        throw new RangeError("each alias must be [namespace, source_id]");
      }
      const [namespace, sourceId] = alias as [string, string];
      if (
        CANONICAL_ALIAS_NAMESPACES.has(namespace.trim().toLowerCase()) ||
        namespace.trim().toLowerCase() === "doi"
      ) {
        raw.push([namespace, sourceId]);
      }
    }
  }
  if (
    (paper.source !== undefined && paper.source !== null) ||
    (paper.source_id !== undefined && paper.source_id !== null)
  ) {
    const source = paper.source;
    const sourceId = paper.source_id;
    if (typeof source !== "string" || typeof sourceId !== "string") {
      throw new RangeError("source/source_id must both be strings");
    }
    if (CANONICAL_ALIAS_NAMESPACES.has(source.trim().toLowerCase())) {
      raw.push([source, sourceId]);
    }
  }

  const normalized = new Map<string, AliasKey>();
  for (const [namespace, value] of raw) {
    if (typeof value !== "string") {
      throw new RangeError(`${namespace} alias must be a string`);
    }
    let key: AliasKey;
    try {
      key = normalizeAlias(namespace, value);
    } catch (exc) {
      if (exc instanceof IdentityError) {
        throw new RangeError(`invalid ${namespace} alias: ${JSON.stringify(value)}`);
      }
      throw exc;
    }
    normalized.set(aliasMapKey(key[0], key[1]), key);
  }
  return [...normalized.values()].sort(
    (a, b) => codepointCompare(a[0], b[0]) || codepointCompare(a[1], b[1]),
  );
}

/** Resolve one focus candidate without using title/year or graph IDs.
 *
 * @throws {RangeError} an alias is ambiguous in `aliasIndex`, or two
 * canonical aliases on the same candidate disagree, or a declared
 * `seed_paper_id` does not match what the aliases resolve to.
 */
export function resolveSeedPaperId(
  paper: AliasablePaper,
  aliasIndex: IdentityAliasIndex,
): [string | null, AliasKey[]] {
  const aliases = declaredAliasValues(paper);
  const canonicalAliases = aliases.filter((a) => CANONICAL_ALIAS_NAMESPACES.has(a[0]));
  const resolved = new Set<string>();
  for (const alias of aliases) {
    const matches = lookupAlias(aliasIndex, alias[0], alias[1]);
    if (matches.size > 1) {
      throw new RangeError(`ambiguous identity alias ${alias[0]}:${alias[1]}`);
    }
    if (matches.size > 0) {
      for (const m of matches) resolved.add(m);
    } else if (CANONICAL_ALIAS_NAMESPACES.has(alias[0])) {
      resolved.add(makePaperId(alias[0], alias[1]));
    }
    // DOI may join through the sidecar, but never creates a new ID.
  }
  if (resolved.size > 1) {
    const pid = paper.paperId;
    throw new RangeError(`conflicting canonical seed IDs for ${JSON.stringify(pid)}`);
  }
  const seedPaperId = resolved.size > 0 ? [...resolved][0]! : null;
  const declaredSeed = paper.seed_paper_id;
  if (
    declaredSeed !== undefined &&
    declaredSeed !== null &&
    (!isPaperId(declaredSeed) || declaredSeed !== seedPaperId)
  ) {
    throw new RangeError("declared seed_paper_id does not match exact aliases");
  }
  if (canonicalAliases.length === 0 && seedPaperId === null) {
    return [null, aliases];
  }
  return [seedPaperId, aliases];
}

/** `(-citationCount, graphId)` ranking key: highest-cited first, then
 * lexicographic graph id ascending. */
export function candidateRank(
  paper: AliasablePaper & { citationCount?: unknown; citation_count?: unknown },
): [number, string] {
  const graphId = (paper.paperId as string | undefined) ?? (paper.id as string | undefined) ?? "";
  let citations: unknown = paper.citationCount;
  if (citations === null || citations === undefined) citations = paper.citation_count;
  const n = Number(citations);
  const count = Number.isFinite(n) ? Math.trunc(n) : 0;
  return [count === 0 ? 0 : -count, String(graphId)];
}

function compareCandidateRank(a: [number, string], b: [number, string]): number {
  if (a[0] !== b[0]) return a[0] - b[0];
  return codepointCompare(a[1], b[1]);
}

/** Keep resolvable focus candidates and dedup only exact identities. */
export function resolveAndDedupSeeds<T extends AliasablePaper & { paperId?: unknown }>(
  seeds: readonly T[],
  aliasIndex: IdentityAliasIndex,
): [T[], Map<string, string>] {
  const resolvedRows: [T, string, AliasKey[]][] = [];
  for (const paper of seeds) {
    const graphId = paper.paperId;
    if (typeof graphId !== "string" || !graphId) continue;
    const [seedPaperId, aliases] = resolveSeedPaperId(paper, aliasIndex);
    if (seedPaperId !== null) {
      resolvedRows.push([paper, seedPaperId, aliases]);
    }
  }

  const survivors: T[] = [];
  const seedByGraphId = new Map<string, string>();
  const occupied = new Map<string, [string, string]>();

  const sorted = resolvedRows
    .slice()
    .sort((a, b) => compareCandidateRank(candidateRank(a[0]), candidateRank(b[0])));

  for (const [paper, seedPaperId, aliases] of sorted) {
    const graphId = String(paper.paperId);
    const keys = new Set<string>([
      aliasMapKey("graph", graphId),
      aliasMapKey("seed", seedPaperId),
      ...aliases.map(([ns, v]) => aliasMapKey(ns, v)),
    ]);
    const collisions: [string, string][] = [];
    for (const key of keys) {
      const hit = occupied.get(key);
      if (hit) collisions.push(hit);
    }
    if (collisions.length > 0) {
      const survivorIds = new Set(collisions.map((c) => c[0]));
      const survivorSeeds = new Set(collisions.map((c) => c[1]));
      if (survivorIds.size !== 1 || !(survivorSeeds.size === 1 && survivorSeeds.has(seedPaperId))) {
        throw new RangeError(`conflicting seed identity for ${JSON.stringify(graphId)}`);
      }
      continue;
    }
    survivors.push(paper);
    seedByGraphId.set(graphId, seedPaperId);
    for (const key of keys) occupied.set(key, [graphId, seedPaperId]);
  }
  return [survivors, seedByGraphId];
}
