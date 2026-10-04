/**
 * Theme/seed off-topic filters — TS port of the five off-topic-exclusion
 * layers in `paperpilot/scripts/build_theme_lineage.py` documented in
 * CLAUDE.md under "品質改善ノイズ防止" (issues #127/#186/#188/#189) and
 * safety-contracts LIN-29..32 (LIN-27/28, the S2/OpenAlex API-level field
 * gates, live in `discoverSeeds.ts` next to the requests that set them).
 *
 * Reads real data straight from `paperpilot/data/*.json` (per the
 * migration rule that new code may read `docs/`/`paperpilot/data/`/
 * `paperpilot/output/`, never write there) — same files
 * `build_theme_lineage.py` itself reads, so a denylist/alias/blacklist
 * edit takes effect on both sides without a second copy to keep in sync.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getRepoRoot } from "@paperpilot/core";
import { themeSlug } from "./slug.js";

export interface ThemeSeedLike {
  paperId?: string | null;
  id?: string | null;
  title?: string | null;
  abstract?: string | null;
  citationCount?: number | null;
  _intents?: readonly string[] | null;
  [key: string]: unknown;
}

// ---- #127 topic-relevance gate (LIN-30) ----

const TOPIC_RELEVANCE_MIN_WORD_LEN = 3;
const TOPIC_RELEVANCE_THRESHOLD_RATIO = 0.5;
/** Maximum token-position distance between the two theme words in the
 * title-only fallback for 2-word themes (2026-06-05 audit; K=3). */
const TWO_WORD_FALLBACK_MAX_DISTANCE = 3;

/** Lower-case, replace hyphens with spaces, collapse whitespace — so
 * "self-supervised learning" and "self supervised learning" match
 * interchangeably. */
export function normalizeRelevanceText(text: string): string {
  return text.replaceAll("-", " ").toLowerCase().replace(/\s+/g, " ").trim();
}

/** Smallest token-index distance between any occurrence of `wordA` and
 * any occurrence of `wordB` in `text` (both already lowercased +
 * hyphen-normalised). Match is substring-within-token. `null` when
 * either word fails to match anywhere. */
export function minTokenDistance(text: string, wordA: string, wordB: string): number | null {
  const tokens = text.split(" ").filter((t) => t.length > 0);
  const positionsA: number[] = [];
  const positionsB: number[] = [];
  tokens.forEach((t, i) => {
    if (t.includes(wordA)) positionsA.push(i);
    if (t.includes(wordB)) positionsB.push(i);
  });
  if (positionsA.length === 0 || positionsB.length === 0) return null;
  let min = Number.POSITIVE_INFINITY;
  for (const a of positionsA) {
    for (const b of positionsB) {
      const d = Math.abs(a - b);
      if (d < min) min = d;
    }
  }
  return min;
}

/** Single-paper topic-relevance predicate (#127/#298). See the Python
 * docstring on `_is_topic_relevant` for the full rule table; mirrored
 * exactly here (and must stay identical to `minTokenDistance`'s
 * tokenisation — the BFS-node gate and the seed gate share this one
 * function so the two can never drift). */
export function isTopicRelevant(paper: ThemeSeedLike, theme: string): boolean {
  const words = theme
    .split(/\s+/)
    .filter((w) => w.length >= TOPIC_RELEVANCE_MIN_WORD_LEN)
    .map((w) => w.toLowerCase());
  if (words.length < 2) {
    // Short / single-word theme — gate disabled (escape hatch).
    return true;
  }
  const phrase = normalizeRelevanceText(theme);
  const normalisedWords = words.map((w) => normalizeRelevanceText(w));
  const titleOnly = normalizeRelevanceText(paper.title ?? "");
  const haystack = normalizeRelevanceText(`${paper.title ?? ""} ${paper.abstract ?? ""}`);
  if (phrase && haystack.includes(phrase)) return true;
  if (words.length === 2) {
    const [wa, wb] = normalisedWords;
    if (!(wa && titleOnly.includes(wa)) || !(wb && titleOnly.includes(wb))) return false;
    const distance = minTokenDistance(titleOnly, wa as string, wb as string);
    return distance !== null && distance <= TWO_WORD_FALLBACK_MAX_DISTANCE;
  }
  const threshold = Math.max(2, Math.ceil(words.length * TOPIC_RELEVANCE_THRESHOLD_RATIO));
  const hits = normalisedWords.filter((w) => w && haystack.includes(w)).length;
  return hits >= threshold;
}

/** Drop seeds whose title+abstract don't carry enough of the theme. */
export function filterTopicRelevantSeeds<T extends ThemeSeedLike>(seeds: T[], theme: string): T[] {
  if (seeds.length === 0) return [];
  return seeds.filter((p) => isTopicRelevant(p, theme));
}

// ---- #209 implementation-foundation denylist (LIN-29) ----

interface DenylistData {
  paperIds: ReadonlySet<string>;
  patterns: readonly RegExp[];
}

let cachedDenylist: { path: string; data: DenylistData } | undefined;

function defaultDenylistPath(): string {
  return join(getRepoRoot(), "paperpilot", "data", "lineage_denylist.json");
}

/** `(paperId set, compiled title-regexes)` from
 * `paperpilot/data/lineage_denylist.json`. Cached per path (mirrors the
 * Python `@lru_cache` — the file is parsed once per process in steady
 * state, and tests that need a fresh read can pass a distinct `path`). */
export function loadDenylist(path: string = defaultDenylistPath()): DenylistData {
  if (cachedDenylist?.path === path) return cachedDenylist.data;
  let data: DenylistData;
  try {
    const raw = JSON.parse(readFileSync(path, "utf-8")) as {
      paper_ids?: unknown;
      title_patterns?: unknown;
    };
    const paperIds = new Set(
      Array.isArray(raw.paper_ids)
        ? raw.paper_ids.filter((x): x is string => typeof x === "string")
        : [],
    );
    const patterns = (
      Array.isArray(raw.title_patterns)
        ? raw.title_patterns.filter((x): x is string => typeof x === "string")
        : []
    ).map((p) => new RegExp(p, "i"));
    data = { paperIds, patterns };
  } catch {
    // Missing or malformed file — proceed with an empty denylist
    // (graceful degrade, matching the Python warning-and-continue path).
    data = { paperIds: new Set(), patterns: [] };
  }
  cachedDenylist = { path, data };
  return data;
}

/** True iff `paper` is on the implementation-foundation denylist (a
 * match on either paperId or title regex is enough). */
export function isImplementationFoundation(paper: ThemeSeedLike, denylistPath?: string): boolean {
  const { paperIds, patterns } = loadDenylist(denylistPath);
  const pid = paper.paperId ?? paper.id;
  if (typeof pid === "string" && paperIds.has(pid)) return true;
  const title = paper.title;
  if (typeof title !== "string") return false;
  return patterns.some((pat) => pat.test(title));
}

/** Drop seed candidates that match the implementation-foundation
 * denylist (same helper `filterOffTopicRefs` uses for BFS candidates,
 * so the two can't drift). */
export function filterDenylistedSeeds<T extends ThemeSeedLike>(
  seeds: T[],
  denylistPath?: string,
): T[] {
  return seeds.filter((p) => !isImplementationFoundation(p, denylistPath));
}

// ---- #209 off-topic foundational-ref filter (LIN-32) ----

/** Anything cited more than `OFF_TOPIC_CITE_MULTIPLIER × max(seed cites)`
 * is treated as a foundational paper likely tangential to the theme,
 * unless it carries a "methodology" S2 intent. */
const OFF_TOPIC_CITE_MULTIPLIER = 2.0;

/** Drop BFS reference candidates (parents or children) whose
 * citationCount is wildly above the theme's max-cited seed AND that
 * lack a methodology intent. The denylist check is unconditional. */
export function filterOffTopicRefs<T extends ThemeSeedLike>(
  refs: readonly T[],
  options: { maxSeedCite: number; denylistPath?: string },
): T[] {
  const { maxSeedCite, denylistPath } = options;
  const ceiling = maxSeedCite > 0 ? maxSeedCite * OFF_TOPIC_CITE_MULTIPLIER : null;
  const kept: T[] = [];
  for (const p of refs) {
    if (isImplementationFoundation(p, denylistPath)) continue;
    const cites = Number(p.citationCount) || 0;
    if (ceiling === null || cites <= ceiling) {
      kept.push(p);
      continue;
    }
    const intents = new Set(
      (p._intents ?? [])
        .filter((i): i is string => typeof i === "string")
        .map((i) => i.toLowerCase()),
    );
    if (intents.has("methodology")) kept.push(p);
  }
  return kept;
}

// ---- #274 theme alias fallback (LIN-26) ----

type ThemeAliasMap = Record<string, string[]>;

let cachedAliases: { path: string; data: ThemeAliasMap } | undefined;

function defaultThemeAliasesPath(): string {
  return join(getRepoRoot(), "paperpilot", "data", "theme_aliases.json");
}

/** The alias map from `theme_aliases.json`: lower-cased theme string ->
 * list of alternate keywords to UNION into the seed search. Missing or
 * malformed file degrades to "no aliases". */
export function loadThemeAliases(path: string = defaultThemeAliasesPath()): ThemeAliasMap {
  if (cachedAliases?.path === path) return cachedAliases.data;
  let out: ThemeAliasMap = {};
  try {
    const raw: unknown = JSON.parse(readFileSync(path, "utf-8"));
    if (raw !== null && typeof raw === "object" && !Array.isArray(raw)) {
      for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
        if (k.startsWith("_") || !Array.isArray(v)) continue;
        const clean = v.filter((s): s is string => typeof s === "string" && s.trim() !== "");
        if (clean.length > 0) out[k.toLowerCase()] = clean;
      }
    }
  } catch {
    out = {};
  }
  cachedAliases = { path, data: out };
  return out;
}

/** Alternate keywords for `theme` (lower-cased, whitespace-trimmed to
 * match the loader's key shape). */
export function aliasesFor(theme: string, path?: string): string[] {
  return loadThemeAliases(path)[theme.trim().toLowerCase()] ?? [];
}

// ---- #209 Tier 1 per-theme keyword blacklist (LIN-31) ----

type ThemeBlacklistMap = Record<string, readonly string[]>;

let cachedBlacklist: { path: string; data: ThemeBlacklistMap } | undefined;

function defaultThemeBlacklistPath(): string {
  return join(getRepoRoot(), "paperpilot", "data", "theme_blacklist.json");
}

/** Per-theme keyword blacklist from `theme_blacklist.json`. Keys are
 * theme SLUGS (output of `themeSlug`); values are lower-cased
 * substrings. The top-level shape may be `{"themes": {<slug>: [...]}}`
 * or a flat `{<slug>: [...]}` (Python falls back to the raw object when
 * `themes` is absent). Missing/malformed file -> empty map. */
export function loadThemeBlacklist(path: string = defaultThemeBlacklistPath()): ThemeBlacklistMap {
  if (cachedBlacklist?.path === path) return cachedBlacklist.data;
  let out: ThemeBlacklistMap = {};
  try {
    const raw: unknown = JSON.parse(readFileSync(path, "utf-8"));
    if (raw !== null && typeof raw === "object" && !Array.isArray(raw)) {
      const rawObj = raw as Record<string, unknown>;
      const themes =
        rawObj.themes !== null && typeof rawObj.themes === "object" && !Array.isArray(rawObj.themes)
          ? (rawObj.themes as Record<string, unknown>)
          : rawObj;
      for (const [slug, kws] of Object.entries(themes)) {
        if (slug.startsWith("_") || !Array.isArray(kws)) continue;
        const cleaned = kws
          .filter((kw): kw is string => typeof kw === "string" && kw.trim() !== "")
          .map((kw) => kw.trim().toLowerCase());
        if (cleaned.length > 0) out[slug] = cleaned;
      }
    }
  } catch {
    out = {};
  }
  cachedBlacklist = { path, data: out };
  return out;
}

/** Drop seeds whose title or abstract contains any of the theme's
 * blacklisted substrings. Resolves `theme` to its slug via `themeSlug`
 * so keys match regardless of capitalisation/hyphenation of the input. */
export function filterThemeBlacklist<T extends ThemeSeedLike>(
  seeds: T[],
  theme: string,
  path?: string,
): T[] {
  const slug = themeSlug(theme);
  const blacklist = loadThemeBlacklist(path)[slug];
  if (!blacklist || blacklist.length === 0) return seeds;
  return seeds.filter((p) => {
    const haystack = `${p.title ?? ""} ${p.abstract ?? ""}`.toLowerCase();
    return !blacklist.some((kw) => haystack.includes(kw));
  });
}

/** Test-only cache reset (the Python `@lru_cache`d loaders are also
 * only ever reset via test monkeypatching of the module path constant;
 * this is the equivalent escape hatch for tests that load a fixture
 * path after already having cached the production one, or vice versa). */
export function _resetSeedFilterCachesForTests(): void {
  cachedDenylist = undefined;
  cachedAliases = undefined;
  cachedBlacklist = undefined;
}
