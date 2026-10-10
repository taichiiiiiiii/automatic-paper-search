/**
 * Pure helpers that turn one lineage edge's `rationale` + `provenance`
 * into what the evidence panel and the relation list show (R2 UX
 * review P0-2, design doc 41 D6): the rationale without the quoted
 * sentence, the quoted citation sentence itself (shown as a blockquote,
 * limited to one sentence of ~300 chars per the Semantic Scholar
 * attribution rules in research note 44 §5), the Japanese label of the
 * classification method, and outbound links.
 *
 * DOM-free so it is unit-tested directly (test/themes/evidence.test.ts).
 */

/** Japanese label per `provenance.classification.method`. Unknown
 * methods fall back to a neutral label instead of leaking the raw key. */
export const METHOD_LABEL_JA: Record<string, string> = {
  s2_context_rule: "Semantic Scholar の引用文",
  intent_map: "Semantic Scholar の引用の意図",
  context_pattern: "引用文のパターン",
  llm: "LLM",
  title_version: "題名の版",
  foundational_allowlist: "基礎文献リスト",
  citation_heuristic: "引用と年からの推測",
  year_cite: "引用と年からの推測",
};

export const METHOD_LABEL_FALLBACK = "自動判定";

export function methodLabelJa(method: string | null | undefined): string {
  if (typeof method !== "string") return METHOD_LABEL_FALLBACK;
  return METHOD_LABEL_JA[method] ?? METHOD_LABEL_FALLBACK;
}

/** Max characters of a quoted citation sentence shown on the site. */
export const MAX_QUOTE_CHARS = 300;

/** Source label shown next to every quoted sentence. */
export const QUOTE_SOURCE_LABEL = "Semantic Scholar";

// The pipeline writes the quote as `引用文: "…"` (ASCII or curly quotes)
// at the end of the rationale (apps/pipeline lineage/theme s2Relations).
const QUOTE_RE = /\s*引用文\s*[:：]\s*["“「]([\s\S]+?)["”」]\s*[。.]?\s*$/;

export interface EdgeEvidence {
  /** Rationale with the quoted part removed (never empty if the
   * rationale itself was non-empty). */
  summary: string;
  /** The quoted citation sentence, clipped to MAX_QUOTE_CHARS, or null. */
  quote: string | null;
}

export function clipQuote(text: string, max: number = MAX_QUOTE_CHARS): string {
  const t = text.replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  return `${t.slice(0, max - 1).trimEnd()}…`;
}

export function parseEdgeEvidence(rationale: string | null | undefined): EdgeEvidence {
  const text = typeof rationale === "string" ? rationale.trim() : "";
  const m = QUOTE_RE.exec(text);
  if (!m || m.index === undefined) return { summary: text, quote: null };
  const quote = clipQuote(m[1] ?? "");
  const summary = text.slice(0, m.index).trim();
  return { summary: summary || text, quote: quote || null };
}

const ARXIV_RE = /^\d{4}\.\d{4,5}(v\d+)?$/;
const DOI_RE = /^10\.\d{4,9}\/[A-Za-z0-9._;()/:-]+$/;

export interface PaperRef {
  id: string;
  title?: string;
  arxiv_id?: string;
  doi?: string;
  [key: string]: unknown;
}

/** Primary link for a paper: arXiv > DOI > Semantic Scholar search. */
export function paperLink(node: PaperRef): { url: string; label: string } {
  if (typeof node.arxiv_id === "string" && ARXIV_RE.test(node.arxiv_id)) {
    return { url: `https://arxiv.org/abs/${encodeURIComponent(node.arxiv_id)}`, label: "arXiv" };
  }
  if (typeof node.doi === "string" && DOI_RE.test(node.doi)) {
    return { url: `https://doi.org/${encodeURIComponent(node.doi)}`, label: "DOI" };
  }
  return { url: semanticScholarUrl(node), label: "Semantic Scholar" };
}

/** Semantic Scholar page for a paper: the arXiv-id resolver when the
 * paper has one, otherwise a title search (node ids are OpenAlex /
 * internal ids, not S2 corpus ids, so `paper/<id>` would 404). */
export function semanticScholarUrl(node: PaperRef): string {
  if (typeof node.arxiv_id === "string" && ARXIV_RE.test(node.arxiv_id)) {
    return `https://www.semanticscholar.org/arxiv/${encodeURIComponent(node.arxiv_id.replace(/v\d+$/, ""))}`;
  }
  const q = typeof node.title === "string" && node.title ? node.title : node.id;
  return `https://www.semanticscholar.org/search?q=${encodeURIComponent(q)}`;
}
