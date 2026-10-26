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
    // R2-39: field words ("Reinforcement Learning: A Survey" is not named by
    // "rule-based reinforcement learning"; "Flow Straight and Fast" not by
    // "Flow Matching").
    "reinforcement",
    "flow",
    "flows",
    "diffusion",
    "generative",
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
  // R2-39: a stem made of field words only names a field, not a paper.
  const fieldOnly =
    stem
      ?.toLowerCase()
      .split(/[\s-]+/)
      .every((w) => GENERIC_WORDS.has(w)) ?? false;
  const names = stem && !fieldOnly ? [stem] : [];
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
  // R2-39: a sentence without any citation ("Building upon this, we
  // introduce VRPO", "Based on the setup in Section 4.3, …") ties a cue to
  // the cited paper only through its name inside the cue's span (below).
  const byName = (span: string) =>
    id.aliases.some((a) => mentions(span, a)) || namesVersionFamily(span, id);
  const namedInWords = byName(sentence);
  const multi = citationTargetCount(sentence) > 1;
  for (const p of cues) {
    const re = new RegExp(p.source, p.flags.includes("g") ? p.flags : `${p.flags}g`);
    for (const m of sentence.matchAll(re)) {
      // R2-39: what the cue governs — the first citation (or self
      // reference) in its object, the owner named by "proposed by / introduced
      // in", a third-party subject — decides when it can be read.
      const gov = cueGovernor(sentence, m.index ?? 0, m[0], id);
      if (gov === "cited") return true;
      if (gov !== "none") continue;
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
 * R2-39: what a cue governs, read from its own words:
 *  - `cited`: the first citation of the cue's object (from the cue to the
 *    clause end, outside brackets: "," / ";" / ":" / "." or a relative
 *    "which / who / while …") is the cited paper's (name, marker, author-year
 *    group) — or the owner a "proposed by / introduced in / released by"
 *    phrase names is ("the semi-autoregressive denoising strategy
 *    introduced in LLaDA [22]");
 *  - `other`: another work comes first ("We adopt the zero residual-block
 *    initialization [13], which adaLN-zero [35] also follows"), owns the
 *    object ("enhancements of GRPO [16] proposed by DAPO [4]", "models
 *    released by SimpleRLZoo (Zeng et al., 2025)"), is the subject of an
 *    active build verb ("Flow Matching methods [28, 1, 30] extend this
 *    framework"), or the cited paper is only the destination of an
 *    extension ("can readily extend to other policy gradient methods such
 *    as PPO [37]");
 *  - `self`: the object is the citing paper itself — a section / figure /
 *    table / equation / appendix / algorithm reference ("building on the
 *    observations … discussed in Section 3"), or an anaphor without any
 *    citation ("Building upon this", "this line of research");
 *  - `distant`: the object is a long phrase (12 words or more) without any
 *    citation — whatever the clause cites later is not what the cue is
 *    about ("On-Policy RL with Extended Generation Budget Our prior … a
 *    vanilla implementation of GRPO …");
 *  - `none`: the object is short and carries none of these; the caller
 *    falls back to the clause-level test ("builds on the common
 *    hierarchical VLA paradigm, as in Shi et al. (2025)").
 */
export type CueGovernor = "cited" | "other" | "self" | "distant" | "none";

/** Periods of abbreviations ("et al.", "e.g.", "Sec.") blanked so they do
 * not end a clause; same length, so offsets stay valid. */
function maskAbbrev(s: string): string {
  return s.replace(
    /\b(?:et\s+al|e\.g|i\.e|cf|vs|Sec|Secs|Fig|Figs|Tab|Eq|Eqs|Eqn|Alg|Thm|App|resp|approx|No)\./gi,
    (m) => `${m.slice(0, -1)} `,
  );
}

/** The object span of a cue ending at `from`: up to the clause end outside
 * brackets, or a relative / contrastive connective. */
function objectSpanEnd(masked: string, from: number): { end: number; capped: boolean } {
  const max = Math.min(masked.length, from + 220);
  let depth = 0;
  let words = 0;
  for (let i = from; i < max; i++) {
    const ch = masked[i] as string;
    if (ch === "(" || ch === "[") depth += 1;
    else if ((ch === ")" || ch === "]") && depth > 0) depth -= 1;
    else if (depth === 0) {
      if (ch === ";" || ch === ":" || ch === ",") return { end: i, capped: false };
      if (ch === "." && /^(?:\s|$)/.test(masked.slice(i + 1, i + 2))) {
        return { end: i, capped: false };
      }
      // A noun phrase, not the rest of the sentence: at most 12 words
      // outside brackets ("… with Extended Generation Budget Our prior …
      // indicated that a vanilla implementation of GRPO …" is not about GRPO).
      if (/\s/.test(ch) && i > from && /\S/.test(masked[i - 1] as string)) {
        words += 1;
        if (words >= 12) return { end: i, capped: true };
      }
      if (
        /\s/.test(ch) &&
        /^\s(?:which|who|whose|where|while|whereas|because|since|but|although|though)\b/i.test(
          masked.slice(i, i + 12),
        )
      )
        return { end: i, capped: false };
    }
  }
  return { end: max, capped: max < masked.length };
}

const SELF_REF_RE =
  /(?:\b(?:[Ss]ections?|[Ss]ecs?|[Ff]ig(?:ure)?s?|[Tt]ab(?:le)?s?|[Ee]q(?:uation)?s?|[Ee]qn|[Aa]ppendi(?:x|ces)|[Aa]pp|[Aa]lg(?:orithm)?s?|[Tt]heorems?|[Tt]hm|[Ll]emmas?|[Pp]ropositions?|[Dd]efinitions?)\b|§)\s*[(~]?\s*(?:\d|[A-Z](?:\.\d|\b))/;
const ANAPHOR_RE = /^\s*(?:the\s+former|the\s+latter|this|these|those|that)\b/i;
const OWNER_RE =
  /\b(?:proposed|introduced|developed|presented|released|described|suggested|designed|devised|open-?sourced|provided|trained)\s+(?:by|in|from)\s/gi;
const DESTINATION_CUE_RE = /\b(?:extend\w*|extension|generali[sz]\w*)\b/i;
const ACTIVE_BUILD_RE =
  /\b(?:extend|extends|extended|build|builds|built|generali[sz]e|generali[sz]es|generali[sz]ed|modif(?:y|ies|ied)|improves?|improved|adapts?|adapted|subsumes?|subsumed)\b/i;
const FIRST_PERSON_RE = /(?<![\w-])(?:we|our|ours|us)(?![\w-])/i;
/** R2-40: noun cues (“a variant of X”) and the apposition right before
 * them: “<work> (<citation>), a [few words] ” (group 1 = the citation). */
const VARIANT_NOUN_RE =
  /^(?:variant|version|adaptation|modification|instantiation|extension)\s+of\b/i;
const APPOSITION_HEAD_RE = /([[(][^\][()]{1,160}[\])])\s*,\s*(?:a|an)\s+(?:[\w-]+\s+){0,3}$/;
const YEAR_RE = /\b(?:1[89]|20)\d{2}[a-z]?\b/;
const ENUMERATION_RE =
  /\b(?:such\s+as|e\.?g\b|including|like|for\s+(?:example|instance)|namely)\b/i;

interface GovEvent {
  at: number;
  kind: CueGovernor;
  /** The "to" of "extend … to X": what follows is a destination. */
  destination?: boolean;
}

interface CiteUnit {
  at: number;
  cited: boolean | null;
}

/** Citation units of `text` (positions relative to it): numeric bracket
 * groups, author-year groups, "Name et al." mentions, and the cited
 * paper's names. `cited` = whether the unit is the cited paper's (`null` =
 * cannot tell). */
function citationUnits(
  text: string,
  sentence: string,
  id: CitedIdentity,
  withNames = true,
): CiteUnit[] {
  const out: CiteUnit[] = [];
  const surnameRe =
    id.surname && id.surname.length >= 2
      ? new RegExp(`(?<![\\p{L}])${escapeRe(id.surname)}(?![\\p{L}])`, "iu")
      : null;
  const single = citationTargetCount(sentence) === 1;
  for (const m of text.matchAll(/[[(]([^\][()]{1,160})[\])]/g)) {
    const inner = m[1] as string;
    const nums = numericMarkers(`[${inner}]`);
    if (nums.length > 0) {
      out.push({
        at: m.index ?? 0,
        cited: id.marker !== null ? nums.includes(id.marker) : single ? true : null,
      });
    } else if (YEAR_RE.test(inner) && /\p{Lu}[\p{L}'’-]+/u.test(inner)) {
      out.push({
        at: m.index ?? 0,
        cited: surnameRe !== null ? surnameRe.test(inner) : single ? true : null,
      });
    }
  }
  for (const m of text.matchAll(/(?<![\p{L}])(\p{Lu}[\p{L}'’-]+)\s+et\s+al\b/gu)) {
    out.push({
      at: m.index ?? 0,
      cited: surnameRe !== null ? surnameRe.test(m[1] as string) : null,
    });
  }
  for (const a of withNames ? id.aliases : []) {
    if (/ et al$/.test(a)) continue;
    const re = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(foldText(a))}(?![\\p{L}])`, "iu");
    const m = re.exec(text);
    if (m) out.push({ at: m.index, cited: true });
  }
  return out.sort((x, y) => x.at - y.at);
}

export function cueGovernor(
  sentence: string,
  cueAt: number,
  cueText: string,
  id: CitedIdentity,
): CueGovernor {
  const folded = foldText(sentence);
  // Offsets come from `sentence`; fold only when that keeps them valid.
  const text = folded.length === sentence.length ? folded : sentence;
  const masked = maskAbbrev(text);
  const at = Math.min(cueAt, text.length);
  const from = at + cueText.length;
  // A cue that carries the cited paper itself ("Following [39], we …",
  // "Following ImageReward [32], we …") governs it.
  if (citationUnits(text.slice(at, from), sentence, id).some((u) => u.cited === true)) {
    return "cited";
  }
  // Third-party subject of an active build verb: the clause before the cue
  // cites a work and has no first-person word.
  const verb = ACTIVE_BUILD_RE.exec(cueText);
  const head = masked.slice(0, at);
  const clauseStart = Math.max(
    head.lastIndexOf(". "),
    head.lastIndexOf(";"),
    head.lastIndexOf(":"),
  );
  if (verb !== null && !/^(?:building|extending|built|extended)\b/i.test(cueText.trim())) {
    const subject = head.slice(clauseStart + 1);
    if (
      !FIRST_PERSON_RE.test(subject) &&
      !FIRST_PERSON_RE.test(cueText) &&
      citationUnits(subject, sentence, id, false).length > 0
    ) {
      return "other";
    }
    // R2-40: a relative clause about other works (“Point3R [95] and
    // StreamVGGT [106], which extend CUT3R and VGGT [87]”): the antecedent
    // after the last first-person word cites only other works.
    if (/\b(?:which|who|that)\s+(?:also\s+|further\s+)?$/i.test(head)) {
      const fps = [...head.matchAll(new RegExp(FIRST_PERSON_RE.source, "gi"))];
      const last = fps.length > 0 ? (fps[fps.length - 1]?.index ?? 0) : clauseStart + 1;
      const units = citationUnits(head.slice(Math.max(last, clauseStart + 1)), sentence, id, false);
      if (units.length > 0 && units.every((u) => u.cited === false)) return "other";
    }
  }
  // R2-40: a passive participle that describes another work (“GenEx [33],
  // a panoramic video generation model built upon stable video diffusion
  // [5]”): the clause before it cites only other works, no first person.
  if (/^(?:built|extended|derived|adapted)\b/i.test(cueText.trim())) {
    const before = head.slice(clauseStart + 1);
    const units = citationUnits(before, sentence, id, false);
    if (
      !FIRST_PERSON_RE.test(before) &&
      units.length > 0 &&
      units.every((u) => u.cited === false)
    ) {
      return "other";
    }
  }
  // R2-40: a variant named in an apposition belongs to the work before it
  // (“We use LightningDiT (Yao et al., 2025), a variant of DiT (Peebles &
  // Xie, 2023), as our model backbone” is about LightningDiT).
  if (VARIANT_NOUN_RE.test(cueText)) {
    const app = APPOSITION_HEAD_RE.exec(text.slice(0, at));
    if (app !== null) {
      const own = citationUnits(app[1] as string, sentence, id);
      if (own.length > 0 && own.every((u) => u.cited === false)) return "other";
    }
  }
  const { end, capped } = objectSpanEnd(masked, from);
  const object = text.slice(from, end);
  const units = citationUnits(object, sentence, id);
  // The owner a "proposed by / introduced in" phrase names owns the object.
  for (const m of masked.slice(from, end).matchAll(OWNER_RE)) {
    const after = (m.index ?? 0) + m[0].length;
    const owner = units.find((u) => u.at >= after - 1 && u.at <= after + 60);
    if (owner && owner.cited !== null) return owner.cited ? "cited" : "other";
  }
  const events: GovEvent[] = units
    .filter((u) => u.cited !== null)
    .map((u) => ({ at: u.at, kind: u.cited ? "cited" : "other" }));
  const self = SELF_REF_RE.exec(masked.slice(from, end));
  if (self) events.push({ at: self.index, kind: "self" });
  if (units.length === 0 && ANAPHOR_RE.test(object)) events.push({ at: 0, kind: "self" });
  if (DESTINATION_CUE_RE.test(cueText)) {
    const to = /\bto\s/i.exec(object);
    if (to) events.push({ at: to.index, kind: "other", destination: true });
    // R2-40: “We extend the patch-level pathway with MM-DiT blocks [9]” —
    // what follows “with / using / via” is the instrument; the extended
    // thing is the citing paper's own, unless the cited paper came first
    // (“We extend visual instruction tuning (Liu et al., 2023) with …”).
    const by = /\b(?:with|using|via)\s/i.exec(object);
    if (by) events.push({ at: by.index, kind: "other", destination: true });
  }
  if (events.length === 0) return capped ? "distant" : "none";
  events.sort((x, y) => x.at - y.at);
  const first = events[0] as GovEvent;
  // An enumeration ("unlike … mechanisms such as Sinkhorn [20], Reformer [18]
  // and Routing Transformer [19]") puts every listed work under the cue:
  // the clause-level test decides.
  const list = ENUMERATION_RE.exec(object);
  if (list !== null && list.index <= first.at && first.kind === "other" && !first.destination) {
    return "none";
  }
  return first.kind;
}

/**
 * R2-38: whether `span` (a part of `sentence`, e.g. the few words after a
 * cue) refers to the cited paper: by name, by its inferred reference
 * marker, or — in a sentence citing one work only — by any citation.
 */
export function spanMentionsCited(span: string, sentence: string, id: CitedIdentity): boolean {
  if (id.aliases.some((a) => mentions(span, a)) || namesVersionFamily(span, id)) return true;
  if (id.marker !== null) return numericMarkers(span).includes(id.marker);
  return citationTargetCount(sentence) === 1 && citationTargetCount(span) >= 1;
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
