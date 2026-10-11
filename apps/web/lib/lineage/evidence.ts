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

import { authorCredit } from "@paperpilot/core/licensing";

/** Japanese label per `provenance.classification.method`. Unknown
 * methods fall back to a neutral label instead of leaking the raw key. */
export const METHOD_LABEL_JA: Record<string, string> = {
  s2_context_rule: "Semantic Scholar の引用文",
  intent_map: "Semantic Scholar の引用の意図",
  context_pattern: "引用文のパターン",
  llm: "LLM",
  title_version: "題名の版",
  foundational_allowlist: "基礎文献リスト",
  // R2-24: the citation itself, read from an API reference list.
  api_citation: "参考文献リスト（引用の事実のみ）",
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

/** R2-23: source label of a sentence quoted from the citing paper's own
 * abstract (`要旨: "…"`) rather than a Semantic Scholar citation context. */
export const ABSTRACT_SOURCE_LABEL = "新しい論文の要旨";

/** R2-28: source label of a sentence quoted from the citing paper's arXiv
 * HTML rendering (pairs Semantic Scholar has no citation sentence for). */
export const ARXIV_HTML_SOURCE_LABEL = "arXiv HTML";

/** R2-28: method label of a rule edge whose sentence came from arXiv HTML. */
export const ARXIV_HTML_METHOD_LABEL = "arXiv HTML の引用文";

// The pipeline notes the source as `（arXiv HTML（arXiv:2101.03961v3）の本文…`.
const ARXIV_HTML_NOTE_RE = /arXiv HTML（arXiv:([0-9a-z./-]+?)(v\d+)?）/i;

/** The arXiv id (and version) the quote of an arXiv-HTML rule edge comes
 * from, or null for any other rationale. */
export function arxivHtmlSourceOf(
  rationale: string | null | undefined,
): { id: string; version: string | null } | null {
  const m = typeof rationale === "string" ? ARXIV_HTML_NOTE_RE.exec(rationale) : null;
  return m ? { id: m[1] as string, version: m[2] ?? null } : null;
}

/** Method label for an edge: arXiv-HTML rule edges are not labelled as
 * Semantic Scholar sentences. */
export function edgeMethodLabelJa(
  method: string | null | undefined,
  rationale?: string | null,
): string {
  if (method === "s2_context_rule" && arxivHtmlSourceOf(rationale) !== null) {
    return ARXIV_HTML_METHOD_LABEL;
  }
  return methodLabelJa(method);
}

// The pipeline writes the quote as `引用文: "…"` (ASCII or curly quotes)
// at the end of the rationale (apps/pipeline lineage/theme s2Relations),
// or `要旨: "…"` when the sentence is from the citing paper's abstract.
const QUOTE_RE = /\s*(引用文|要旨)\s*[:：]\s*["“「]([\s\S]+?)["”」]\s*[。.]?\s*$/;

export interface EdgeEvidence {
  /** Rationale with the quoted part removed (never empty if the
   * rationale itself was non-empty). */
  summary: string;
  /** The quoted citation sentence, clipped to MAX_QUOTE_CHARS, or null. */
  quote: string | null;
  /** Where the quote comes from: a citation context or the citing
   * paper's abstract (absent when there is no quote). */
  quoteSource?: "citation-context" | "abstract" | "arxiv-html";
}

const ELLIPSIS = "…";

/**
 * True when an excerpt evidently starts inside a sentence (or a word):
 * its first letter is lower-case, or it opens with punctuation that
 * continues a sentence (",", ";", ")"…). S2 citation contexts are cut by
 * character windows, e.g. "istance and angular distance …".
 */
export function startsMidSentence(text: string): boolean {
  const t = text.trimStart();
  if (!t || t.startsWith(ELLIPSIS) || t.startsWith("...")) return false;
  if (/^[,;:.)\]}]/u.test(t)) return true;
  const first = /\p{L}/u.exec(t.slice(0, 1));
  return (
    first !== null && first[0] === first[0].toLowerCase() && first[0] !== first[0].toUpperCase()
  );
}

/** True when an excerpt does not end at a sentence end (. ! ? or a closing quote/bracket after one). */
export function endsMidSentence(text: string): boolean {
  const t = text.trimEnd();
  if (!t || t.endsWith(ELLIPSIS) || t.endsWith("...")) return false;
  return !/[.!?。](?:["'”’)\]]*|\s*\[[^\]]*\])$/u.test(t);
}

/**
 * Normalise whitespace, clip to `max` characters, and mark every cut
 * with "…" — at the end when clipped or when the excerpt stops
 * mid-sentence, at the start when it begins mid-sentence / mid-word
 * (design 51 §3.3, Japanese copyright act art. 32: an abridged quotation
 * must show the omission).
 */
export function clipQuote(text: string, max: number = MAX_QUOTE_CHARS): string {
  let t = text.replace(/\s+/g, " ").trim();
  if (!t) return t;
  const lead = startsMidSentence(t);
  const budget = max - (lead ? 2 : 0);
  let clipped = false;
  if (t.length > budget) {
    t = t.slice(0, budget - 1).trimEnd();
    clipped = true;
  }
  const tail = clipped || endsMidSentence(t);
  return `${lead ? `${ELLIPSIS} ` : ""}${t}${tail && !t.endsWith(ELLIPSIS) ? ELLIPSIS : ""}`;
}

export function parseEdgeEvidence(rationale: string | null | undefined): EdgeEvidence {
  const text = typeof rationale === "string" ? rationale.trim() : "";
  const m = QUOTE_RE.exec(text);
  if (!m || m.index === undefined) return { summary: text, quote: null };
  const quote = clipQuote(m[2] ?? "");
  const summary = text.slice(0, m.index).trim();
  if (!quote) return { summary: summary || text, quote: null };
  return {
    summary: summary || text,
    quote,
    quoteSource:
      m[1] === "要旨"
        ? "abstract"
        : arxivHtmlSourceOf(text) !== null
          ? "arxiv-html"
          : "citation-context",
  };
}

const ARXIV_RE = /^\d{4}\.\d{4,5}(v\d+)?$/;
const DOI_RE = /^10\.\d{4,9}\/[A-Za-z0-9._;()/:-]+$/;

export interface PaperRef {
  id: string;
  title?: string;
  authors?: unknown;
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

/**
 * Short author credit of a lineage node for a quotation's source line
 * ("Beltagy et al."), or "" when the node lists no authors — design 51
 * §3.3 / Japanese copyright act art. 48(2): name the author of a quoted
 * work when the work names one.
 */
export function quoteAuthorCredit(node: PaperRef | undefined): string {
  const authors = Array.isArray(node?.authors)
    ? (node.authors as unknown[]).filter((a): a is string => typeof a === "string")
    : [];
  return authorCredit(authors);
}

/**
 * Where a theme node's abstract excerpt was read from, for its label: the
 * generator decodes OpenAlex's abstract for `openalex:` nodes (falling
 * back to Semantic Scholar's when OpenAlex has none) and uses Semantic
 * Scholar's for the others.
 */
export function abstractExcerptSourceLabel(nodeId: string): string {
  return nodeId.startsWith("openalex:") ? "OpenAlex / Semantic Scholar " : "Semantic Scholar ";
}
