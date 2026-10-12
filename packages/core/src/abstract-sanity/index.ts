/**
 * Abstract / title sanity (design 41 R2-17 ERROR_PATTERNS 13, R2-26).
 *
 * Upstream metadata sometimes attaches another document's abstract to a
 * paper (OpenAlex W4281758439 FlashAttention carried a FlashAttention-2
 * note; OpenAlex W3015468748 Longformer carries a 2025 "Murmurative
 * Attention" abstract). Showing such a text as the paper's abstract is a
 * false attribution, and the lineage builder must not use it as evidence,
 * so both the pipeline (when a node is built) and the web viewer (for
 * nodes already published) drop an abstract this check flags. No abstract
 * beats a wrong one.
 */

const SANITY_STOPWORDS = new Set([
  "with",
  "from",
  "into",
  "over",
  "under",
  "using",
  "towards",
  "toward",
  "via",
  "their",
  "this",
  "that",
  "these",
  "those",
  "based",
  "approach",
  "method",
  "methods",
  "model",
  "models",
  "learning",
  "deep",
  "neural",
  "network",
  "networks",
  "paper",
  "study",
  "analysis",
  "efficient",
  "fast",
  "large",
  "scale",
  "novel",
  "improved",
  "beyond",
  "without",
  "through",
]);

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * True when `abstract` evidently belongs to another document than
 * `title` (OpenAlex W4281758439, the FlashAttention paper, carries a note
 * on FlashAttention-2's rounding error as its abstract). Two cheap tests:
 *  - anachronism: the abstract names a LATER version of the paper's own
 *    name (title "FlashAttention: …", abstract "FlashAttention-2 …",
 *    "FlashAttention-3"); a paper cannot discuss its successors;
 *  - no overlap: a title with >= 5 distinctive words (>= 4 letters, not
 *    generic ML words) shares none of them (5-letter prefix) with a
 *    full-length (>= 200 chars) abstract;
 *  - foreign name (R2-26): the title is "<Name>: <subtitle>" with a
 *    one-word coined name (e.g. "Longformer") that the full-length
 *    abstract never mentions, the abstract introduces a different named
 *    method ("We introduce Murmurative Attention"), and fewer than half of
 *    the subtitle's distinctive words occur in it. Over the 28,310
 *    catalog abstracts (2026-10-11) this flags 1 row, and over the four
 *    published theme lineages exactly the Longformer node.
 */
export function abstractContradictsTitle(title: string, abstract: string): boolean {
  if (!title || !abstract) return false;
  const text = abstract.normalize("NFKC");
  const short = (title.split(":", 1)[0] ?? "").normalize("NFKC").trim();
  const vm = /^(.*?)(?:[\s-]*v?(\d{1,2}))?$/i.exec(short);
  const base = (vm?.[1] ?? short).trim();
  const own = vm?.[2] !== undefined ? Number(vm[2]) : 1;
  if (base.length >= 4 && base.split(/\s+/).length <= 4) {
    const body = base.split(/\s+/).map(escapeRe).join("[\\s-]+");
    const re = new RegExp(
      `(?<![\\p{L}\\p{N}])${body}(?:[\\s-]?v?|[\\s-])(\\d{1,2})(?![\\p{L}\\p{N}.])`,
      "giu",
    );
    for (const m of text.matchAll(re)) {
      const n = Number(m[1]);
      if (n > own && n <= 20) return true;
    }
  }
  const words = [
    ...new Set(
      title
        .normalize("NFKC")
        .toLowerCase()
        .split(/[^\p{L}\p{N}]+/u)
        .filter((w) => w.length >= 4 && !SANITY_STOPWORDS.has(w) && /\p{L}/u.test(w)),
    ),
  ];
  if (introducesForeignName(title, text)) return true;
  if (words.length < 5 || text.length < 200) return false;
  const lower = text.toLowerCase();
  return !words.some((w) => lower.includes(w.slice(0, 5)));
}

/**
 * True when `titleA` and `titleB` plainly describe DIFFERENT subjects
 * — low Jaccard overlap of their significant words (>= 4 letters, not
 * a generic ML stopword) — even though they may share one keyword
 * (R2-34: OpenAlex's own identity-merge bug on `openalex:W3168867926`
 * gave the real LoRA paper (arXiv 2106.09685) the title "LoRA
 * Fine-Tuning of a 3B Code LLM for Algorithmic Efficiency", which
 * still shares the word "LoRA" with the real title "LoRA: Low-Rank
 * Adaptation of Large Language Models" — {@link abstractContradictsTitle}
 * alone does not catch this: the abstract legitimately mentions "LoRA",
 * so word-overlap-with-abstract finds no contradiction. Comparing the
 * two CANDIDATE titles directly does: only 1 of their 11 combined
 * significant words is shared).
 *
 * Used to decide whether an independently-identified title (arXiv
 * metadata, or Semantic Scholar keyed by the same arXiv/DOI id) should
 * override a Work's own title field — the two titles are for the
 * same identity (same arXiv id), so a strong disagreement here means
 * one of the title FIELDS is wrong, not that the papers differ.
 */
export function titlesDisagreeStrongly(titleA: string, titleB: string): boolean {
  const wordsOf = (t: string): Set<string> =>
    new Set(
      t
        .normalize("NFKC")
        .toLowerCase()
        .split(/[^\p{L}\p{N}]+/u)
        .filter((w) => w.length >= 4 && !SANITY_STOPWORDS.has(w) && /\p{L}/u.test(w)),
    );
  const a = wordsOf(titleA);
  const b = wordsOf(titleB);
  if (a.size < 2 || b.size < 2) return false;
  let intersection = 0;
  for (const w of a) if (b.has(w)) intersection += 1;
  const union = a.size + b.size - intersection;
  return intersection / union < 0.3;
}

const INTRO_RE =
  /\b(?:[Ww]e|[Tt]his (?:paper|work))\s+(?:introduce|propose|present)s?\s+(?:[a-z]+\s+){0,4}?[A-Z]/u;

function alnumKey(s: string): string {
  return s
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

function distinctiveWords(s: string): string[] {
  return [
    ...new Set(
      s
        .normalize("NFKC")
        .toLowerCase()
        .split(/[^\p{L}\p{N}]+/u)
        .filter((w) => w.length >= 4 && !SANITY_STOPWORDS.has(w) && /\p{L}/u.test(w)),
    ),
  ];
}

function introducesForeignName(title: string, text: string): boolean {
  const colon = title.indexOf(":");
  if (colon < 0 || text.length < 200) return false;
  const name = title.slice(0, colon).normalize("NFKC").trim();
  if (name.length < 4 || /\s/u.test(name) || !/\p{L}/u.test(name)) return false;
  const nameKey = alnumKey(name);
  if (!nameKey || alnumKey(text).includes(nameKey)) return false;
  if (!INTRO_RE.test(text)) return false;
  const rest = distinctiveWords(title.slice(colon + 1));
  if (rest.length < 2) return false;
  const lower = text.toLowerCase();
  const hits = rest.filter((w) => lower.includes(w.slice(0, 5))).length;
  return hits / rest.length < 0.5;
}
