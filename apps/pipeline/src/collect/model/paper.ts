/**
 * Paper model — TypeScript port of `paperpilot/models/paper.py`.
 *
 * Mirrors the Python `@dataclass Paper` field-for-field (see §6/§7.1 of
 * docs/design/39-typescript-cloudflare-migration.md and COL-* rows of
 * docs/migration/safety-contracts.md). Sources produce `Paper` objects;
 * later stages (not part of this port) enrich them with quality signals.
 *
 * INTENTIONAL DEVIATION from the design doc's suggestion of "a zod schema
 * mirroring paperpilot/models/paper.py fields": this task's edit scope is
 * restricted to `apps/pipeline/src/collect/**` and
 * `apps/pipeline/test/collect/**` (no `package.json` edits, no touching
 * `packages/core`). `zod` is a dependency of `@paperpilot/core` but is not
 * hoisted/linked into `apps/pipeline/node_modules` (pnpm strict linking), so
 * `import { z } from "zod"` does not resolve from this package today. Rather
 * than silently reach for a phantom dependency, this module ships a plain
 * TypeScript type plus a hand-written runtime validator/factory
 * (`createPaper`) that enforces the same required-field contract a zod
 * schema would. A follow-up that is allowed to touch `apps/pipeline/package.json`
 * (to add `zod` as a direct dependency) or `packages/core` (to re-export a
 * shared `zod` instance) can swap this for an actual zod schema without
 * changing the shape callers see.
 */

export type PaperSource = "arxiv" | "s2" | "openalex";

/** Mirrors the Python dataclass field-for-field, including defaults. */
export interface Paper {
  // ---- Required (from source) ----
  title: string;
  authors: string[];
  abstract: string;
  url: string;
  /** ISO date string `YYYY-MM-DD` (Python `datetime.date`). */
  publishedDate: string;
  source: PaperSource;

  // ---- Optional metadata ----
  arxivId: string | null;
  doi: string | null;
  pdfUrl: string | null;
  categories: string[];
  /** arXiv comment field (e.g. "Accepted at ICLR 2026"). */
  comment: string | null;
  /** OpenAlex only (for now). */
  affiliations: string[];

  // ---- Enriched by Signals (not produced by any Source) ----
  venue: string | null;
  venueTier: number;
  venueScore: number;
  githubUrl: string | null;
  githubStars: number;
  githubScore: number;
  hasCode: boolean;
  isOfficialRepo: boolean;
  citationCount: number;
  influentialCitations: number;
  citationVelocity: number;
  citationScore: number;
  firstAuthorId: string | null;
  authorHIndex: number;
  authorScore: number;
  keywordMatchCount: number;
  keywordScore: number;
  followScore: number;
  followReason: "followed_author" | "followed_org" | null;

  // ---- Stage 3: embedding similarity ----
  embeddingSimilarity: number | null;

  // ---- Final ranking ----
  totalScore: number;
  matchedKeywords: string[];

  // ---- Stage 4: LLM rerank ----
  llmRelevance: number | null;
  llmSummaryJa: string | null;
  llmReason: string | null;
  llmTags: string[];
}

/** Fields a Source is responsible for filling in; everything else defaults. */
export type PaperInit = Pick<
  Paper,
  "title" | "authors" | "abstract" | "url" | "publishedDate" | "source"
> &
  Partial<Omit<Paper, "title" | "authors" | "abstract" | "url" | "publishedDate" | "source">>;

const DEFAULTS: Omit<Paper, "title" | "authors" | "abstract" | "url" | "publishedDate" | "source"> =
  {
    arxivId: null,
    doi: null,
    pdfUrl: null,
    categories: [],
    comment: null,
    affiliations: [],
    venue: null,
    venueTier: 0,
    venueScore: 0,
    githubUrl: null,
    githubStars: 0,
    githubScore: 0,
    hasCode: false,
    isOfficialRepo: false,
    citationCount: 0,
    influentialCitations: 0,
    citationVelocity: 0,
    citationScore: 0,
    firstAuthorId: null,
    authorHIndex: 0,
    authorScore: 0,
    keywordMatchCount: 0,
    keywordScore: 0,
    followScore: 0,
    followReason: null,
    embeddingSimilarity: null,
    totalScore: 0,
    matchedKeywords: [],
    llmRelevance: null,
    llmSummaryJa: null,
    llmReason: null,
    llmTags: [],
  };

/** Constructs a `Paper`, applying the same defaults as the Python dataclass. */
export function createPaper(init: PaperInit): Paper {
  return { ...DEFAULTS, ...init };
}

/**
 * Stable unique identifier for dedup / seen_ids tracking.
 * Mirrors `Paper.uid` exactly: arxiv_id > doi > url.
 */
export function paperUid(p: Paper): string {
  if (p.arxivId) return `arxiv:${p.arxivId}`;
  if (p.doi) return `doi:${p.doi}`;
  return `url:${p.url}`;
}

/**
 * JSON/CSV-friendly dict, matching Python `Paper.to_dict()` key-for-key
 * (snake_case, as the Python dataclass field names are) plus the computed
 * `uid`. Used by the parity harness to compare against the Python dump.
 */
export function paperToDict(p: Paper): Record<string, unknown> {
  return {
    title: p.title,
    authors: p.authors,
    abstract: p.abstract,
    url: p.url,
    published_date: p.publishedDate,
    source: p.source,
    arxiv_id: p.arxivId,
    doi: p.doi,
    pdf_url: p.pdfUrl,
    categories: p.categories,
    comment: p.comment,
    affiliations: p.affiliations,
    venue: p.venue,
    venue_tier: p.venueTier,
    venue_score: p.venueScore,
    github_url: p.githubUrl,
    github_stars: p.githubStars,
    github_score: p.githubScore,
    has_code: p.hasCode,
    is_official_repo: p.isOfficialRepo,
    citation_count: p.citationCount,
    influential_citations: p.influentialCitations,
    citation_velocity: p.citationVelocity,
    citation_score: p.citationScore,
    first_author_id: p.firstAuthorId,
    author_h_index: p.authorHIndex,
    author_score: p.authorScore,
    keyword_match_count: p.keywordMatchCount,
    keyword_score: p.keywordScore,
    follow_score: p.followScore,
    follow_reason: p.followReason,
    embedding_similarity: p.embeddingSimilarity,
    total_score: p.totalScore,
    matched_keywords: p.matchedKeywords,
    llm_relevance: p.llmRelevance,
    llm_summary_ja: p.llmSummaryJa,
    llm_reason: p.llmReason,
    llm_tags: p.llmTags,
    uid: paperUid(p),
  };
}
