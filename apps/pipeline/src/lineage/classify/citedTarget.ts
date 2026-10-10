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
  /** R2-21: the cited paper's first-author surname (folded, lower-cased), when known. */
  surname?: string | null;
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

/**
 * R2-21: fold diacritics, including the spacing accents PDF extraction
 * leaves behind ("Veliˇckovi´c" -> "Velickovic"), and compatibility forms
 * ("ﬁ" -> "fi"), so names in S2 contexts match the cited paper's metadata.
 */
export function foldText(s: string): string {
  // Spacing accents first: NFKD turns "´" into a space plus a combining mark.
  return s
    .replace(/[\u00a8\u00b4\u02c6-\u02df]/gu, "")
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .normalize("NFC");
}

/** Surname of one author entry ("Thomas N. Kipf" -> "Kipf", "Wagner, Christopher" -> "Wagner"). */
function surnameOf(entry: unknown): string | null {
  const name =
    typeof entry === "string"
      ? entry
      : entry && typeof entry === "object"
        ? str((entry as { name?: unknown }).name)
        : "";
  const comma = name.indexOf(",");
  const parts = (comma > 0 ? name.slice(0, comma) : name).trim().split(/\s+/).filter(Boolean);
  const last = comma > 0 ? parts.join(" ") : parts[parts.length - 1];
  return last ? foldText(last) : null;
}

/** Surnames of the cited paper's authors, in order (empty when unknown). */
function authorSurnames(paper: ClassifyPaperLike): string[] {
  const raw = (paper as Record<string, unknown>).authors;
  if (!Array.isArray(raw)) return [];
  return raw.map(surnameOf).filter((s): s is string => s !== null && s.length > 0);
}

function firstAuthorSurname(paper: ClassifyPaperLike): string | null {
  const last = authorSurnames(paper)[0];
  return last && last.length >= 3 ? last : null;
}

/**
 * R2-21: how a citing paper writes the cited paper's author list in an
 * author-year citation: "Kipf and Welling", "Kipf & Welling" (two
 * authors), "Hamilton, Ying, and Leskovec" (three). "<first> et al" is
 * added by {@link citedAliases} for any author count.
 */
function authorListAliases(paper: ClassifyPaperLike): string[] {
  const s = authorSurnames(paper);
  if (s.length === 2) return [`${s[0]} and ${s[1]}`, `${s[0]} & ${s[1]}`];
  if (s.length === 3) {
    return [
      `${s[0]}, ${s[1]}, and ${s[2]}`,
      `${s[0]}, ${s[1]} and ${s[2]}`,
      `${s[0]}, ${s[1]}, & ${s[2]}`,
    ];
  }
  return [];
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
  if (surname) for (const a of authorListAliases(cited)) out.add(a.toLowerCase());
  return [...out].filter((a) => a.length >= 3);
}

/** The year written right after an author mention: "et al. (2017b)",
 * "Welling, 2016", "Leskovec 2017)". */
const YEAR_AFTER = /^\.?\s*,?\s*\(?\s*((?:1[89]|20)\d{2})([a-z]?)\b/;

function mentions(sentence: string, alias: string): boolean {
  // Word-bounded, case-insensitive; "Swin" matches "Swin-B" but not "CSWin".
  const re = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(foldText(alias))}(?![\\p{L}])`, "giu");
  const text = foldText(sentence);
  const years = new Set<string>();
  let hit = false;
  for (const m of text.matchAll(re)) {
    hit = true;
    const y = YEAR_AFTER.exec(text.slice((m.index ?? 0) + m[0].length));
    if (y === null) continue;
    // R2-21: an author citation is ambiguous when the same author list is
    // cited with a lettered year ("Hamilton et al. (2017b)" — the same
    // authors have several papers that year) or with two different years
    // in one sentence ("Kipf & Welling, 2017 … Kipf & Welling, 2016").
    if (y[2]) return false;
    years.add(y[1] as string);
  }
  return hit && years.size <= 1;
}

/** Family / generic acronyms that never name one paper on their own. */
const GENERIC_NAMES: ReadonlySet<string> = new Set(
  [
    "AI",
    "ML",
    "NLP",
    "CV",
    "NN",
    "NNS",
    "DNN",
    "CNN",
    "RNN",
    "GNN",
    "MLP",
    "LSTM",
    "GRU",
    "GPU",
    "TPU",
    "CPU",
    "SOTA",
    "LLM",
    "MOE",
    "API",
    "PCA",
    "SVM",
    "WL",
    "ROI",
    "IEEE",
    "ACM",
  ].map((w) => w.toLowerCase()),
);

/** A token shaped like a method name: two or more capitals ("GCN",
 * "GraphSAGE", "MoNet", "PATCHY-SAN"), letters/digits/hyphens only. */
const METHOD_NAME = /^(?=(?:[^\p{Lu}]*\p{Lu}){2})\p{L}[\p{L}\p{N}-]{1,24}$/u;

function normaliseName(raw: string): string | null {
  // "GCNs" / "DCNNs" -> "GCN" / "DCNN" (plural of an all-caps acronym).
  const name = /^\p{Lu}[\p{Lu}\p{N}-]+s$/u.test(raw) ? raw.slice(0, -1) : raw;
  if (!METHOD_NAME.test(name)) return null;
  const low = name.toLowerCase();
  if (GENERIC_NAMES.has(low) || GENERIC_WORDS.has(low) || low.length < 3) return null;
  return low;
}

/**
 * R2-21: method names the citing paper itself gives the cited paper,
 * read from the pair's contexts: a name-shaped token written right before
 * the cited paper's own citation — "GCN (Kipf and Welling 2017)",
 * "GraphSAGE (Hamilton, Ying, and Leskovec 2017)", "GRAPHSAGE [16]" when
 * 16 is the cited paper's inferred marker, "network (GCN) [4]". Many
 * method papers carry their name only in the abstract or not at all
 * ("Semi-Supervised Classification with Graph Convolutional Networks"),
 * so the title stem cannot supply it. The name only counts for this
 * pair's sentences (it comes from them).
 */
export function contextMethodNames(
  contexts: readonly string[],
  cited: ClassifyPaperLike,
  marker: number | null,
): string[] {
  const surname = firstAuthorSurname(cited)?.toLowerCase() ?? null;
  const out = new Set<string>();
  const NAME_BEFORE = /(?<![\p{L}\p{N}_-])\(?([\p{L}][\p{L}\p{N}-]{1,24})\)?\s*([[(])/gu;
  for (const raw of contexts) {
    if (typeof raw !== "string") continue;
    const c = foldText(raw);
    for (const m of c.matchAll(NAME_BEFORE)) {
      const name = normaliseName(m[1] as string);
      if (name === null) continue;
      const at = (m.index ?? 0) + m[0].length;
      const rest = c.slice(at, at + 120);
      let cites = false;
      if (m[2] === "[") {
        const close = rest.indexOf("]");
        if (marker !== null && close > 0)
          cites = numericMarkers(`[${rest.slice(0, close + 1)}`).includes(marker);
      } else if (surname !== null) {
        // "(Kipf and Welling 2017)", "(Hamilton et al., 2017)", "(Kipf & Welling, 2017; …)".
        const head = rest.toLowerCase();
        cites =
          head.startsWith(surname) &&
          /^[\s,&]|^\s*et\s+al|^\s+and\b/.test(head.slice(surname.length));
        // Not "(Hamilton et al., 2017b)": a lettered year may be another paper.
        const close = head.indexOf(")");
        if (cites && /\b(?:1[89]|20)\d{2}[a-z]\b/.test(head.slice(0, close > 0 ? close : 60)))
          cites = false;
      }
      if (cites) out.add(name);
    }
  }
  return [...out];
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
    const low = foldText(c).toLowerCase();
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
    const folded = foldText(c);
    for (const alias of aliases) {
      const re = new RegExp(
        `(?<![\\p{L}\\p{N}])${escapeRe(foldText(alias))}(?:[-\\s]?[\\p{L}\\p{N}]{1,6})?\\s*\\[(\\d{1,4})\\]`,
        "giu",
      );
      for (const m of folded.matchAll(re)) vote(Number(m[1]), 3);
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
  return best ?? commonMarker(contexts);
}

/**
 * R2-23: the one numeric marker every marker-carrying context shares.
 * S2 attaches a context to the pair because it carries the cited paper's
 * marker, so when no sentence cites it alone or by name, the marker common
 * to all of them is the cited one (V-MoE: "[54] … [39]", "[54, 39, 22]",
 * "inspired by [54] who … [26]" -> 54). Needs two or more such contexts
 * and exactly one shared marker; author-year contexts give nothing.
 */
export function commonMarker(contexts: readonly string[]): number | null {
  let common: number[] | null = null;
  let seen = 0;
  for (const c of contexts) {
    if (typeof c !== "string" || isBibliographyLine(c)) continue;
    const ms = numericMarkers(c);
    if (ms.length === 0) continue;
    seen += 1;
    common = common === null ? [...new Set(ms)] : common.filter((n: number) => ms.includes(n));
  }
  if (common === null || seen < 2 || common.length !== 1) return null;
  return common[0] ?? null;
}

/**
 * R2-23: attribution of a cue to the cited paper. A sentence often names
 * several works, and a cue word is about the work it governs: the cited
 * paper must appear in the cue's own span — from the cue to the end of
 * its clause (next "." / ";") — by name, version-family name or reference
 * marker:
 *   - "Our approach is inspired by [54] who proposed …, with … [26]" and
 *     "As our architecture is adapted from Swin Transformer [28]" are
 *     about the cited paper;
 *   - "in ChebNet and MoNet we used three convolutional layers, …
 *     pooling layers based on the Graclus method [16]" is not about
 *     ChebNet; "prior works [8, 15] that …, we study the frameworks that
 *     are based on Siamese networks, including MoCo [19]" is not about
 *     [15].
 * When the sentence names the cited paper only by its marker and cites
 * several works, the FIRST marker group of the span must carry it.
 * `exempt` patterns put the cited paper before the cue by construction
 * ("GCN [26] … as particular instances of our approach") and always pass;
 * so does a sentence without any recognisable citation (S2 stripped the
 * markers, nothing to attribute).
 */
export function cueTargetsCited(
  sentence: string,
  id: CitedIdentity,
  cues: readonly RegExp[],
  exempt: readonly RegExp[] = [],
  /** "clause" (default): up to the next "." / ";"; "phrase": up to the next
   * "," too — for abstract sentences, where nothing but the name ties the
   * cue to the cited paper ("Unlike the recently-proposed Vision
   * Transformer (ViT) …, we introduce the Pyramid Vision Transformer
   * (PVT)" is about ViT, not about a "PVT …" paper). */
  scope: "clause" | "phrase" = "clause",
): boolean {
  if (exempt.some((p) => p.test(sentence))) return true;
  if (sentenceTarget(sentence, id) === "unmarked") return true;
  const byName = (span: string) =>
    id.aliases.some((a) => mentions(span, a)) || namesVersionFamily(span, id);
  const namedInWords = byName(sentence);
  const multi = citationTargetCount(sentence) > 1;
  for (const p of cues) {
    const re = new RegExp(p.source, p.flags.includes("g") ? p.flags : `${p.flags}g`);
    for (const m of sentence.matchAll(re)) {
      const tail = sentence.slice(m.index ?? 0);
      const stop = tail.search(scope === "phrase" ? /[.;,](?:\s|$)/ : /[.;](?:\s|$)/);
      const span = (stop >= 0 ? tail.slice(0, stop) : tail).slice(0, 300);
      if (byName(span)) return true;
      if (id.marker !== null) {
        if (namedInWords || !multi) {
          if (numericMarkers(span).includes(id.marker)) return true;
        } else {
          const group = /\[[^\]]{1,80}\]/.exec(span);
          if (group && numericMarkers(group[0]).includes(id.marker)) return true;
        }
      } else if (!namedInWords && !multi && citationTargetCount(span) >= 1) {
        // The only work the sentence cites, cited inside the cue's span.
        return true;
      }
    }
  }
  return false;
}

/**
 * R2-23: names under which the CITING paper refers to itself — its title
 * stem ("Swin Transformer", "ViViT", "SwinIR"). A sentence whose subject is
 * the citing method's own name is first-person in effect ("These merits
 * make Swin Transformer suitable …, in contrast to previous Transformer
 * based architectures [19]"). Stems that are also a name of the cited
 * paper, or generic words, are dropped.
 */
export function citingSelfNames(
  citingTitle: string | null | undefined,
  cited: CitedIdentity,
): string[] {
  const stem = titleStem(str(citingTitle));
  if (stem === null) return [];
  const low = stem.toLowerCase();
  if (low.length < 3 || GENERIC_WORDS.has(low) || GENERIC_NAMES.has(low)) return [];
  if (cited.aliases.includes(low)) return [];
  return [low];
}

/** Whether `sentence` mentions one of `names` (word-bounded, case-insensitive). */
export function mentionsAny(sentence: string, names: readonly string[]): boolean {
  return names.some((n) => mentions(sentence, n));
}

/**
 * R2-23: the citing paper calls its model a modified / extended version of
 * the cited one by name: "ViT-BN is our modified ViT that has BatchNorm"
 * (MoCo v3 <- ViT). The cited paper's name must follow directly.
 */
export function ownVariantOf(sentence: string, id: CitedIdentity): boolean {
  const text = foldText(sentence);
  return id.aliases.some((a) =>
    new RegExp(
      `\\bour\\s+(?:own\\s+)?(?:modified|extended|adapted|customi[sz]ed)\\s+(?:version\\s+of\\s+(?:the\\s+)?)?${escapeRe(foldText(a))}(?![\\p{L}])`,
      "iu",
    ).test(text),
  );
}

/** Identity of the cited paper for one pair's contexts. */
export function citedIdentity(
  cited: ClassifyPaperLike | null | undefined,
  contexts: readonly string[],
): CitedIdentity {
  if (!cited) return { aliases: [], marker: null };
  const aliases = citedAliases(cited);
  const marker = inferCitedMarker(contexts, cited, aliases);
  const names = contextMethodNames(contexts, cited, marker).filter((n) => !aliases.includes(n));
  const surname = firstAuthorSurname(cited)?.toLowerCase() ?? null;
  return { aliases: [...aliases, ...names], marker, surname };
}

/** Surnames of the author-year citations of a sentence ("Bronstein et al.
 * (2017)", "(Kipf and Welling, 2017)", "Atwood & Towsley 2016"). */
function authorYearSurnames(sentence: string): string[] {
  const re =
    /(?<![\p{L}])(\p{Lu}[\p{L}'’-]+)(?:\s+et\s+al\.?|\s*(?:,|and|&)\s*\p{Lu}[\p{L}'’-]+(?:,?\s*(?:and|&)\s*\p{Lu}[\p{L}'’-]+)?)?,?\s*\(?(?:1[89]|20)\d{2}[a-z]?\b/gu;
  return [...foldText(sentence).matchAll(re)].map((m) => (m[1] as string).toLowerCase());
}

/** How `sentence` refers to the cited paper (see {@link SentenceTarget}). */
export function sentenceTarget(sentence: string, id: CitedIdentity): SentenceTarget {
  if (id.aliases.some((a) => mentions(sentence, a))) return "named";
  const markers = numericMarkers(sentence);
  if (id.marker !== null && markers.includes(id.marker)) return "named";
  const count = citationTargetCount(sentence);
  if (id.marker !== null && markers.length > 0 && count === markers.length) return "other";
  // R2-21: the only citation is an author-year one of somebody else
  // ("We refer the reader to … Bronstein et al. (2017); Hamilton et al."
  // attached by S2 to Bianchi et al.'s ARMA paper).
  if (count === 1 && id.surname && markers.length === 0) {
    const cites = authorYearSurnames(sentence);
    if (cites.length > 0 && !cites.includes(id.surname)) return "other";
  }
  if (count === 1) return "single";
  if (count === 0) return "unmarked";
  if (count === 2) return "pair";
  return "multi";
}

/** R2-22: the sentence names the cited paper in words (title stem, acronym,
 * author, method name), not only through a reference marker. */
export function namesCitedPaper(sentence: string | null, id: CitedIdentity): boolean {
  return sentence !== null && id.aliases.some((a) => mentions(sentence, a));
}

/** The version family's name ("We follow the FlashAttention algorithms …
 * [2, 3, 4]" for FlashAttention-2 = [2]) singles the family out. */
function namesVersionFamily(sentence: string, id: CitedIdentity): boolean {
  const family = id.aliases
    .map((a) => a.replace(/[-\s]?(v\d+|\d+|\+\+)$/i, ""))
    .filter((f, i) => f.length >= 4 && f !== id.aliases[i]);
  return family.some((f) => mentions(sentence, f));
}

/**
 * R2-22: the sentence identifies the cited paper ONLY through its reference
 * marker, and every marker group carrying it cites other works too ("prior
 * works [8, 15] that …, we study frameworks based on Siamese networks").
 * Such a sentence lumps the cited paper with others, so a build cue in it
 * cannot be attributed to the cited paper alone.
 */
export function namedOnlyInMarkerGroup(sentence: string, id: CitedIdentity): boolean {
  if (id.marker === null) return false;
  if (id.aliases.some((a) => mentions(sentence, a))) return false;
  if (namesVersionFamily(sentence, id)) return false;
  let carrying = 0;
  for (const m of sentence.matchAll(/\[([^\]]{1,80})\]/g)) {
    const ms = numericMarkers(m[0]);
    if (!ms.includes(id.marker)) continue;
    carrying += 1;
    if (ms.length === 1) return false;
  }
  return carrying > 0;
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
  // "論文 A", or a bare A/B not glued to another Latin letter/digit/hyphen.
  // R2-22: Japanese text may touch the letter ("Bは", "のAを"): kana/kanji
  // are letters (\p{L}) but do not make A/B part of a word, so only Latin
  // letters, digits, "_" and "-" count as glue.
  const glue = "[\\p{Script=Latin}\\p{N}_-]";
  const letter = `(?:論文\\s*([AB])|(?<!${glue})([AB]))`;
  // Not followed by another Latin letter/digit, nor by a space and an
  // English word ("A ConvNet for the 2020s" is a title, not paper A).
  const tail = `(?!${glue})(?!\\s+[A-Za-z])`;
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
