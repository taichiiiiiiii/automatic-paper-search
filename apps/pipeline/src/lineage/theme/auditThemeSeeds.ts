/**
 * Audit theme seed topic-relevance from the user's perspective — TS
 * port of `paperpilot/scripts/audit_theme_seeds.py` (LIN-34).
 *
 * Walks every `docs/themes/<slug>/lineage.json`, applies the same word/phrase
 * substring check `build_theme_lineage` uses at generation time, but
 * limited to the data the viewer actually has (`title` + `short_abstract`
 * or `tldr` — the full S2 abstract isn't persisted). Reports each focus
 * paper that fails the gate so a human can decide whether to
 * re-dispatch theme generation for that theme.
 *
 * Exit codes (via the returned number, mapped 1:1 to the Python exit
 * code): 0 = every theme passes; 1 = at least one theme has an
 * off-topic seed.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { codepointCompare } from "@paperpilot/core";

const MIN_WORD_LEN = 3;
const THRESHOLD_RATIO = 0.5;
const TWO_WORD_FALLBACK_MAX_DISTANCE = 3;

/** Smallest token-index distance between any occurrence of `wordA` and
 * any occurrence of `wordB` in `text` (both already lower-cased +
 * hyphen-normalised). Mirrors `build_theme_lineage`'s own helper. */
export function minTokenDistance(text: string, wordA: string, wordB: string): number | null {
  const tokens = text.split(/\s+/).filter((t) => t.length > 0);
  const positionsA: number[] = [];
  const positionsB: number[] = [];
  tokens.forEach((t, i) => {
    if (t.includes(wordA)) positionsA.push(i);
    if (t.includes(wordB)) positionsB.push(i);
  });
  if (positionsA.length === 0 || positionsB.length === 0) return null;
  let min = Number.POSITIVE_INFINITY;
  for (const a of positionsA) for (const b of positionsB) min = Math.min(min, Math.abs(a - b));
  return min;
}

/** Mirror of `build_theme_lineage`'s `_normalize_relevance_text`. */
export function normalize(text: string): string {
  return text.replaceAll("-", " ").toLowerCase().replace(/\s+/g, " ").trim();
}

function eligibleWords(theme: string): string[] {
  return theme
    .split(/\s+/)
    .filter((w) => w.length >= MIN_WORD_LEN)
    .map((w) => w.toLowerCase());
}

/** Word endings stripped when checking a theme word against a
 * haystack (audit-only — production uses full abstracts so it doesn't
 * need this). Order is intentional — see the Python docstring for the
 * "ation before tion before ion", "ying before ing" reasoning. */
const STEM_SUFFIXES: readonly string[] = [
  "ation",
  "tion",
  "ion",
  "ying",
  "ing",
  "ies",
  "ied",
  "ier",
  "est",
  "ed",
  "es",
  "er",
  "s",
];

/** Light suffix-stripping stemmer for audit-only fuzzy match. Strips
 * one matching suffix if the remainder is at least 4 chars; recurses
 * for multi-char suffixes, not for the single-char `"s"` (see Python
 * docstring for why). Idempotent. */
export function stem(word: string): string {
  if (typeof word !== "string" || word.length < 5) return word;
  for (const suffix of STEM_SUFFIXES) {
    if (word.endsWith(suffix) && word.length - suffix.length >= 4) {
      const chopped = word.slice(0, word.length - suffix.length);
      if (suffix.length > 1) return stem(chopped);
      return chopped;
    }
  }
  return word;
}

/** Stem-aware substring check: does any stem-prefix variant of
 * `needle` appear in `haystack`? */
export function stemContains(haystack: string, needle: string): boolean {
  if (haystack.includes(needle)) return true;
  const s = stem(needle);
  return Boolean(s && s !== needle && haystack.includes(s));
}

export interface AuditablePaper {
  title?: unknown;
  short_abstract?: unknown;
  tldr?: unknown;
  paperId?: unknown;
  [key: string]: unknown;
}

/** Mirror of `build_theme_lineage`'s `_filter_topic_relevant_seeds`
 * (#209), reading `short_abstract` (falling back to `tldr`) instead of
 * the full S2 abstract the production filter sees. */
export function isOnTopic(theme: string, paper: AuditablePaper): boolean {
  const words = eligibleWords(theme);
  if (words.length < 2) return true; // filter skipped at generation time
  const abstractExcerpt = (paper.short_abstract || paper.tldr || "") as string;
  const haystack = normalize(`${(paper.title as string) || ""} ${abstractExcerpt}`);
  const phrase = normalize(theme);
  if (phrase && haystack.includes(phrase)) return true;
  const normalisedWords = words.map((w) => normalize(w));
  if (words.length === 2) {
    const titleOnly = normalize((paper.title as string) || "");
    if (!normalisedWords.every((w) => w && stemContains(titleOnly, w))) return false;
    const distance = minTokenDistance(titleOnly, normalisedWords[0]!, normalisedWords[1]!);
    return distance !== null && distance <= TWO_WORD_FALLBACK_MAX_DISTANCE;
  }
  const threshold = Math.max(2, Math.ceil(words.length * THRESHOLD_RATIO));
  const hits = normalisedWords.filter((w) => w && stemContains(haystack, w)).length;
  return hits >= threshold;
}

export interface AuditProblem {
  slug: string;
  theme: string;
  titles: string[];
}

export interface AuditResult {
  exitCode: number;
  seenThemes: number;
  problems: AuditProblem[];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export interface AuditThemeSeedsLogger {
  warn: (msg: string) => void;
}

/** Walk every `themesDir/<slug>/lineage.json` and audit each theme's focus seeds
 * for topic relevance. Returns the exit code (0 clean, 1 >=1 problem)
 * plus the structured findings so a CLI can format them. */
export function auditThemeSeeds(themesDir: string, logger?: AuditThemeSeedsLogger): AuditResult {
  const problems: AuditProblem[] = [];
  let seenThemes = 0;

  // LOW (#review): Python's `audit()` has NO try/except around
  // `THEMES_DIR.iterdir()` — on a themes dir that doesn't exist at all,
  // Python's `iterdir()` raises `FileNotFoundError` and the script
  // crashes (a non-zero exit via the uncaught traceback), not a clean
  // "0 themes audited, all clean" exit 0. The previous TS version's
  // `catch { names = [] }` silently turned a genuinely missing/
  // unreadable themes dir into "nothing to report" — exactly the kind
  // of outage this audit exists to catch. Let it propagate; an empty
  // (but EXISTING) directory still legitimately yields `[]` with no
  // error, matching Python's `iterdir()` on an empty dir.
  const names = readdirSync(themesDir).sort(codepointCompare);

  for (const name of names) {
    const themeDir = join(themesDir, name);
    try {
      if (!statSync(themeDir).isDirectory()) continue;
    } catch {
      continue;
    }
    const lj = join(themeDir, "lineage.json");
    let raw: string;
    try {
      raw = readFileSync(lj, "utf-8");
    } catch {
      continue; // no lineage.json for this entry
    }
    let data: unknown;
    try {
      data = JSON.parse(raw);
    } catch {
      logger?.warn(`WARN  ${name}: lineage.json unreadable, skipping`);
      continue;
    }
    if (!isPlainObject(data)) continue;
    const meta = isPlainObject(data.meta) ? data.meta : {};
    const theme = typeof meta.theme === "string" ? meta.theme : "";
    const nodes = Array.isArray(data.nodes) ? data.nodes : [];
    const seeds = (nodes as AuditablePaper[]).filter((n) => isPlainObject(n) && n.is_focus);
    if (!theme || seeds.length === 0) continue;
    seenThemes += 1;
    // R2-17: canonical method seeds (from the theme surveys' references)
    // are on topic by provenance even when the title omits the theme words.
    const canonical = new Set(
      Array.isArray(meta.canonical_seeds)
        ? meta.canonical_seeds.filter((v): v is string => typeof v === "string")
        : [],
    );
    const off = seeds.filter((s) => !canonical.has(String(s.id ?? "")) && !isOnTopic(theme, s));
    if (off.length > 0) {
      problems.push({
        slug: name,
        theme,
        titles: off.map((s) => (s.title as string) || (s.paperId as string) || ""),
      });
    }
  }

  return { exitCode: problems.length > 0 ? 1 : 0, seenThemes, problems };
}
