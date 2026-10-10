/**
 * Which citation-context sentences are about the CITED paper (R2-16).
 *
 * Semantic Scholar returns, for one citing->cited pair, every sentence of
 * the citing paper that carries the cited reference's marker. Many of
 * those sentences cite several works at once ("[3, 7, 12]"), some are
 * extraction noise (a bare marker list "[19, 41].", a bibliography line
 * "[17] Tri Dao, …", a flattened table row), and a cue word in a sentence
 * (build on / unlike / outperform) may be about another work in it. The
 * second review found extends edges driven by such sentences and quotes
 * that never mention the cited paper (ERROR_PATTERNS 3, 4).
 *
 * This module answers, per sentence:
 *   - is it usable as evidence at all ({@link isUsableContext});
 *   - does it point at the cited paper ({@link sentenceTarget}): by name
 *     (the short title, its acronym, the first author's surname), by the
 *     cited paper's reference marker when we can infer it, or because it
 *     cites exactly one work;
 * and picks the quote to show ({@link pickQuote}).
 *
 * Pure functions only.
 */

import type { ClassifyPaperLike } from "../../collect/llm/provider.js";
import { citationTargetCount } from "./citationCount.js";

/** What we know about the cited paper for target matching. */
export interface CitedIdentity {
  /** Names the citing paper may use for the cited paper (lower-cased). */
  aliases: string[];
  /** The cited paper's numeric reference marker in the citing paper,
   * when it could be inferred from the contexts (`null` otherwise). */
  marker: number | null;
}

/** How a sentence refers to the cited paper. */
export type SentenceTarget =
  /** names the cited paper (alias) or carries its inferred marker */
  | "named"
  /** cites exactly one work — S2 attached it to this pair, so it is the cited one */
  | "single"
  /** no citation marker recognised (S2 sometimes strips them) */
  | "unmarked"
  /** cites two works, neither named */
  | "pair"
  /** cites three or more works and does not single out the cited one */
  | "multi"
  /** carries numeric markers, none of which is the cited paper's inferred marker */
  | "other";

const MIN_CONTEXT_CHARS = 40;
const MIN_CONTEXT_LETTERS = 25;

/** Words too generic to identify a paper on their own. */
const GENERIC_WORDS: ReadonlySet<string> = new Set(
  [
    "a",
    "an",
    "the",
    "on",
    "of",
    "for",
    "and",
    "in",
    "with",
    "to",
    "via",
    "towards",
    "toward",
    "is",
    "are",
    "all",
    "you",
    "need",
    "deep",
    "neural",
    "network",
    "networks",
    "learning",
    "model",
    "models",
    "graph",
    "graphs",
    "vision",
    "visual",
    "video",
    "image",
    "images",
    "language",
    "transformer",
    "transformers",
    "attention",
    "efficient",
    "fast",
    "faster",
    "scalable",
    "large",
    "scale",
    "new",
    "general",
    "improved",
    "improving",
    "training",
    "self",
    "supervised",
    "towards",
    "beyond",
    "simple",
    "survey",
    "review",
    "mixture",
    "experts",
    "expert",
    "sparse",
    "dense",
    "prediction",
    "segmentation",
    "detection",
    "classification",
    "recognition",
  ].map((w) => w.toLowerCase()),
);

/** Bibliography line extracted as a "context": "[17] Tri Dao, Daniel Y. Fu…",
 * "17. Dao, T., Fu, D. Y., …", or a line that reads like a reference entry. */
const BIB_LEAD = /^\s*(?:\[\d{1,4}\]|\d{1,4}\.)\s+\p{Lu}[\p{L}'’-]*(?:\s+\p{Lu}\.?)*[\s,.]/u;
const BIB_VENUE =
  /\b(?:arXiv\s+preprint|In\s+Proceedings|Proc\.|Advances\s+in\s+Neural|pp\.\s*\d|vol\.\s*\d|Conference\s+on)\b/i;
const MARKER_GROUP = /\[[\d,;\s–—-]{1,80}\]/g;

function stripMarkers(s: string): string {
  return s
    .replace(MARKER_GROUP, " ")
    .replace(/\((?:[^()]*\b(?:1[89]|20)\d{2}[a-z]?\b[^()]*)\)/g, " ");
}

/** A bibliography entry mis-extracted as a citation context. */
export function isBibliographyLine(sentence: string): boolean {
  const s = sentence.trim();
  if (BIB_LEAD.test(s) && (BIB_VENUE.test(s) || /\b(?:1[89]|20)\d{2}\b/.test(s))) return true;
  // "[17] Tri Dao, Daniel Y. Fu, Stefano Ermon, …": a marker then a name list.
  return /^\s*\[\d{1,4}\]\s+(?:\p{Lu}[\p{L}'’.-]*\s+){1,3}\p{Lu}[\p{L}'’-]+,/u.test(s);
}

/** Whether a context sentence can serve as evidence / be quoted: not a
 * bibliography line, not just citation markers, at least
 * {@link MIN_CONTEXT_CHARS} characters with {@link MIN_CONTEXT_LETTERS}
 * letters left once the markers are removed. */
export function isUsableContext(sentence: string): boolean {
  if (typeof sentence !== "string") return false;
  const s = sentence.replace(/\s+/g, " ").trim();
  if (Array.from(s).length < MIN_CONTEXT_CHARS) return false;
  if (isBibliographyLine(s)) return false;
  const letters = stripMarkers(s).match(/\p{L}/gu)?.length ?? 0;
  return letters >= MIN_CONTEXT_LETTERS;
}

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function firstAuthorSurname(paper: ClassifyPaperLike): string | null {
  const raw = (paper as Record<string, unknown>).authors;
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const first = raw[0];
  const name =
    typeof first === "string"
      ? first
      : first && typeof first === "object"
        ? str((first as { name?: unknown }).name)
        : "";
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const last = parts[parts.length - 1];
  return last && last.length >= 3 ? last : null;
}

/** The part of a title before its first colon (the method name for
 * "Swin Transformer: Hierarchical …"), or `null` when that part is long. */
export function titleStem(title: string): string | null {
  const idx = title.indexOf(":");
  if (idx <= 0) return null;
  const stem = title.slice(0, idx).trim();
  return stem.split(/\s+/).length <= 5 ? stem : null;
}

/** Acronym of a multi-word name ("Pyramid Vision Transformer" -> "pvt"). */
function acronym(name: string): string | null {
  const words = name.split(/[\s-]+/).filter((w) => /^\p{Lu}/u.test(w));
  if (words.length < 3) return null;
  return words.map((w) => w[0]).join("");
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Lower-cased names by which the citing paper may refer to the cited one. */
export function citedAliases(cited: ClassifyPaperLike): string[] {
  const title = str((cited as Record<string, unknown>).title);
  const out = new Set<string>();
  const stem = titleStem(title);
  const names = stem ? [stem] : [];
  for (const name of names) {
    out.add(name.toLowerCase());
    // "PVT v2" is also written "PVTv2"; "FlashAttention-2" as "FlashAttention 2".
    out.add(name.toLowerCase().replace(/\s+(v?\d)\b/g, "$1"));
    const acr = acronym(name);
    if (acr) out.add(acr.toLowerCase());
    // The first distinctive word of a multi-word stem ("Swin" of "Swin
    // Transformer", "Tokens-to-Token" of "Tokens-to-Token ViT").
    const words = name.split(/\s+/);
    if (words.length > 1) {
      const w = (words[0] as string).replace(/[^\p{L}\p{N}-]/gu, "");
      if (w.length >= 3 && !GENERIC_WORDS.has(w.toLowerCase())) out.add(w.toLowerCase());
    }
  }
  const surname = firstAuthorSurname(cited);
  if (surname) out.add(`${surname.toLowerCase()} et al`);
  return [...out].filter((a) => a.length >= 3);
}

function mentions(sentence: string, alias: string): boolean {
  // Word-bounded, case-insensitive; "Swin" matches "Swin-B" but not "CSWin".
  const re = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(alias)}(?![\\p{L}])`, "iu");
  return re.test(sentence);
}

/** Every numeric marker of a sentence ("[3, 7-9]" -> 3, 7, 8, 9). */
export function numericMarkers(sentence: string): number[] {
  const out: number[] = [];
  for (const m of sentence.matchAll(/\[([^\]]{1,80})\]/g)) {
    const items = (m[1] as string).split(/[,;]/);
    if (!items.every((it) => /^\s*\d{1,4}\s*(?:[-–—]\s*\d{1,4}\s*)?$/.test(it))) continue;
    for (const it of items) {
      const r = /^\s*(\d{1,4})\s*[-–—]\s*(\d{1,4})\s*$/.exec(it);
      if (r) {
        const a = Number(r[1]);
        const b = Number(r[2]);
        for (let n = a; n <= b && n - a < 50; n++) out.push(n);
      } else out.push(Number(it.trim()));
    }
  }
  return out;
}

/**
 * Infer the cited paper's reference marker from the contexts:
 *   1. a bibliography line "[n] …" that carries the first author's surname
 *      or most of the title words;
 *   2. otherwise the marker written right after one of the aliases
 *      ("Swin Transformer [28]", "Swin-B [30]");
 *   3. otherwise the majority marker of the single-citation sentences.
 */
export function inferCitedMarker(
  contexts: readonly string[],
  cited: ClassifyPaperLike,
  aliases: readonly string[] = citedAliases(cited),
): number | null {
  const surname = firstAuthorSurname(cited)?.toLowerCase() ?? null;
  const titleWords = str((cited as Record<string, unknown>).title)
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length >= 4 && !GENERIC_WORDS.has(w));
  for (const c of contexts) {
    if (!isBibliographyLine(c)) continue;
    const m = /^\s*\[(\d{1,4})\]/.exec(c);
    if (!m) continue;
    const low = c.toLowerCase();
    const hits = titleWords.filter((w) => low.includes(w)).length;
    if (
      (surname && low.includes(surname)) ||
      (titleWords.length > 0 && hits * 2 >= titleWords.length)
    ) {
      return Number(m[1]);
    }
  }
  const votes = new Map<number, number>();
  const vote = (n: number, w: number) => votes.set(n, (votes.get(n) ?? 0) + w);
  for (const c of contexts) {
    for (const alias of aliases) {
      const re = new RegExp(
        `(?<![\\p{L}\\p{N}])${escapeRe(alias)}(?:[-\\s]?[\\p{L}\\p{N}]{1,6})?\\s*\\[(\\d{1,4})\\]`,
        "giu",
      );
      for (const m of c.matchAll(re)) vote(Number(m[1]), 3);
    }
    const ms = numericMarkers(c);
    if (ms.length === 1 && citationTargetCount(c) === 1) vote(ms[0] as number, 1);
  }
  let best: number | null = null;
  let bestVotes = 0;
  for (const [n, v] of votes) {
    if (v > bestVotes) {
      best = n;
      bestVotes = v;
    }
  }
  return best;
}

/** Identity of the cited paper for one pair's contexts. */
export function citedIdentity(
  cited: ClassifyPaperLike | null | undefined,
  contexts: readonly string[],
): CitedIdentity {
  if (!cited) return { aliases: [], marker: null };
  const aliases = citedAliases(cited);
  return { aliases, marker: inferCitedMarker(contexts, cited, aliases) };
}

/** How `sentence` refers to the cited paper (see {@link SentenceTarget}). */
export function sentenceTarget(sentence: string, id: CitedIdentity): SentenceTarget {
  if (id.aliases.some((a) => mentions(sentence, a))) return "named";
  const markers = numericMarkers(sentence);
  if (id.marker !== null && markers.includes(id.marker)) return "named";
  const count = citationTargetCount(sentence);
  if (id.marker !== null && markers.length > 0 && count === markers.length) return "other";
  if (count === 1) return "single";
  if (count === 0) return "unmarked";
  if (count === 2) return "pair";
  return "multi";
}

/** The sentence points at the cited paper unambiguously. */
export function isStrongTarget(t: SentenceTarget): boolean {
  return t === "named" || t === "single";
}

/** A cue in the sentence may be attributed to the cited paper: strong
 * targets, sentences whose markers S2 stripped, and two-work sentences.
 * Sentences citing three or more works without naming the cited one, or
 * citing only other works, are background at most. */
export function isCueTarget(t: SentenceTarget): boolean {
  return t === "named" || t === "single" || t === "unmarked" || t === "pair";
}

/** Rank of a sentence as a quote: named by name > single citation >
 * named only by its marker in a multi-citation list > unmarked; others are
 * never quoted (they do not identify the cited paper). Among sentences
 * that name it, a sentence whose subject is the cited paper and fewer
 * cited works rank higher ("Swin Transformer layer (STL) [56] is based on
 * …" over "A concurrent work [82] proposed … based on the Swin
 * Transformer [56]"). */
function quoteRank(sentence: string, id: CitedIdentity): number {
  const t = sentenceTarget(sentence, id);
  const count = citationTargetCount(sentence);
  switch (t) {
    case "named": {
      const byName = id.aliases.some((a) => mentions(sentence, a));
      if (!byName) return count <= 1 ? 3 : 1.5;
      // The cited paper as the sentence's subject (named near the start)
      // beats a mention after another work ("A concurrent work [82] …").
      const head = sentence.slice(0, 30);
      const subject = id.aliases.some((a) => mentions(head, a)) ? 0.5 : 0;
      return 4 + subject + 1 / (1 + count);
    }
    case "single":
      return 3;
    case "unmarked":
      return 1;
    default:
      return 0;
  }
}

/** The best quotable sentence about the cited paper, or `null` when no
 * usable context identifies it. */
export function pickQuote(contexts: readonly string[], id: CitedIdentity): string | null {
  let best: string | null = null;
  let bestRank = 0;
  for (const c of contexts) {
    if (!isUsableContext(c)) continue;
    const rank = quoteRank(c, id);
    if (rank > bestRank) {
      best = c.replace(/\s+/g, " ").trim();
      bestRank = rank;
    }
  }
  return best;
}

/** Whether `sentence` may be shown as the quote for the cited paper. */
export function isQuotable(sentence: string | null, id: CitedIdentity): boolean {
  return sentence !== null && isUsableContext(sentence) && quoteRank(sentence, id) > 0;
}

// ---------------------------------------------------------------- short names

const SHORT_NAME_MAX = 32;

/** Short display name of a paper for Japanese rationales: the title stem
 * before the colon ("Swin Transformer"), else the title cut to
 * {@link SHORT_NAME_MAX} characters. Corner brackets are stripped. */
export function shortPaperName(paper: ClassifyPaperLike | null | undefined): string {
  const title = str(paper ? (paper as Record<string, unknown>).title : "")
    .replaceAll("「", "")
    .replaceAll("」", "");
  if (!title) return "引用元の論文";
  const stem = titleStem(title);
  const base = stem && Array.from(stem).length <= 40 ? stem : title;
  const cps = Array.from(base);
  return cps.length > SHORT_NAME_MAX ? `${cps.slice(0, SHORT_NAME_MAX - 1).join("")}…` : base;
}

/**
 * Replace the bare paper letters an LLM rationale uses ("B は A を置き換える",
 * "論文 A", "B (FlashAttention-2)") with the papers' short names, so a
 * reader sees which two papers are meant (UX P1-4). `a` = cited/older,
 * `b` = citing/newer.
 */
export function titleizeRationale(
  rationale: string,
  a: ClassifyPaperLike | null | undefined,
  b: ClassifyPaperLike | null | undefined,
): string {
  const names: Record<string, string> = { A: shortPaperName(a), B: shortPaperName(b) };
  // "論文 A", or a bare A/B not glued to another letter/digit/hyphen.
  const letter = "(?:論文\\s*([AB])|(?<![\\p{L}\\p{N}_-])([AB]))";
  // Not followed by another letter/digit, nor by a space and an English
  // word ("A ConvNet for the 2020s" is a title, not paper A).
  const tail = "(?![\\p{L}\\p{N}_-])(?!\\s+[A-Za-z])";
  let out = rationale.replace(
    new RegExp(`${letter}\\s*[(（]([^)）]{1,40})[)）]`, "gu"),
    (_m, _l1: string, _l2: string, inner: string) => `「${inner.trim()}」`,
  );
  out = out.replace(
    new RegExp(`${letter}${tail}`, "gu"),
    (_m, l1: string | undefined, l2: string | undefined) => `「${names[(l1 ?? l2) as string]}」`,
  );
  return out;
}
