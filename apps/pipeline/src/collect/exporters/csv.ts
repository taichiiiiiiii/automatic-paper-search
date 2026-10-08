/**
 * CSV exporter — one row per paper, dated filename. TS port of
 * `paperpilot/exporters/csv_exporter.py` (OUT-03, OUT-05..08 of
 * docs/migration/safety-contracts.md).
 *
 * Byte-parity notes (docs/design/39-typescript-cloudflare-migration.md
 * §7.2): this file's output is compared byte-for-byte against the Python
 * original by the e2e fixture, so the CSV dialect (comma delimiter,
 * `QUOTE_MINIMAL`, doubled-quote escaping, `\r\n` line terminator), the
 * `utf-8-sig` BOM, and Python's own float `repr()` (via `pyFloatRepr` +
 * `pyRound`, not `toFixed`/`Math.round`) are all reproduced exactly rather
 * than left to a generic CSV library default.
 */

import { mkdirSync } from "node:fs";
import { pyFloatRepr, pyRound } from "@paperpilot/core/pycompat";
import type { Paper } from "../model/paper.js";
import { paperUid } from "../model/paper.js";
import { atomicWriteText } from "../state/atomic.js";
import * as csvSafety from "./csvSafety.js";
import type { Exporter } from "./exporter.js";
import { resolveExportPath } from "./exportPath.js";

/** Column order — a stable prefix shared with Python's `COLUMNS`; `uid`/`doi` are additive, appended last. */
const COLUMNS = [
  "rank",
  "total_score",
  "llm_relevance",
  "llm_summary_ja",
  "llm_reason",
  "llm_tags",
  "follow_score",
  "follow_reason",
  "title",
  "authors",
  "affiliations",
  "venue",
  "venue_tier",
  "venue_score",
  "citation_count",
  "influential_citations",
  "citation_velocity",
  "citation_score",
  "author_h_index",
  "author_score",
  "embedding_similarity",
  "github_stars",
  "github_score",
  "has_code",
  "is_official_repo",
  "keyword_match_count",
  "keyword_score",
  "matched_keywords",
  "categories",
  "published_date",
  "url",
  "pdf_url",
  "github_url",
  "arxiv_id",
  "source",
  "abstract",
  "uid",
  "doi",
] as const;

/**
 * Columns whose Python value is a genuine `str` (so `neutralize_row`
 * actually inspects it). Every other column holds an `int`/`float`/`bool`
 * (or, for `llm_relevance`, either an `int` or the literal `""`), which
 * `neutralize_row`'s `isinstance(v, str)` guard skips — a negative float
 * like `-0.5` must NOT get the formula guard, since spreadsheets read a
 * bare negative number fine.
 */
const TEXT_COLUMNS = new Set<string>([
  "llm_summary_ja",
  "llm_reason",
  "llm_tags",
  "follow_reason",
  "title",
  "authors",
  "affiliations",
  "venue",
  "matched_keywords",
  "categories",
  "published_date",
  "url",
  "pdf_url",
  "github_url",
  "arxiv_id",
  "source",
  "abstract",
  "uid",
  "doi",
]);

function f(x: number, ndigits: number): string {
  return pyFloatRepr(pyRound(x, ndigits));
}

function buildRow(p: Paper, rank: number): Record<string, string> {
  const row: Record<string, string> = {
    rank: String(rank),
    total_score: f(p.totalScore, 2),
    llm_relevance: p.llmRelevance !== null ? String(p.llmRelevance) : "",
    llm_summary_ja: p.llmSummaryJa ?? "",
    llm_reason: p.llmReason ?? "",
    llm_tags: p.llmTags.join("; "),
    follow_score: f(p.followScore, 2),
    follow_reason: p.followReason ?? "",
    title: p.title,
    authors: p.authors.join("; "),
    affiliations: p.affiliations.join("; "),
    venue: p.venue ?? "",
    venue_tier: String(p.venueTier),
    venue_score: f(p.venueScore, 2),
    citation_count: String(p.citationCount),
    influential_citations: String(p.influentialCitations),
    citation_velocity: f(p.citationVelocity, 3),
    citation_score: f(p.citationScore, 2),
    author_h_index: String(p.authorHIndex),
    author_score: f(p.authorScore, 2),
    embedding_similarity: p.embeddingSimilarity !== null ? f(p.embeddingSimilarity, 2) : "",
    github_stars: String(p.githubStars),
    github_score: f(p.githubScore, 2),
    has_code: p.hasCode ? "True" : "False",
    is_official_repo: p.isOfficialRepo ? "True" : "False",
    keyword_match_count: String(p.keywordMatchCount),
    keyword_score: f(p.keywordScore, 2),
    matched_keywords: p.matchedKeywords.join("; "),
    categories: p.categories.join("; "),
    published_date: p.publishedDate,
    url: p.url,
    pdf_url: p.pdfUrl ?? "",
    github_url: p.githubUrl ?? "",
    arxiv_id: p.arxivId ?? "",
    source: p.source,
    abstract: p.abstract,
    uid: paperUid(p),
    doi: p.doi ?? "",
  };
  for (const col of TEXT_COLUMNS) {
    row[col] = csvSafety.neutralize(row[col] as string);
  }
  return row;
}

function csvField(value: string): string {
  if (/[",\r\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function csvLine(values: readonly string[]): string {
  return `${values.map(csvField).join(",")}\r\n`;
}

export interface CsvExporterConfig {
  enabled?: boolean;
  dir?: string;
  encoding?: "utf-8" | "utf-8-sig";
}

export class CSVExporter implements Exporter {
  readonly name = "csv";
  enabled: boolean;
  lastDelivered: number | null = null;
  private readonly dir: string;
  private readonly encoding: "utf-8" | "utf-8-sig";
  private readonly now: () => Date;

  constructor(config: CsvExporterConfig = {}, deps: { now?: () => Date } = {}) {
    this.enabled = config.enabled ?? true;
    this.dir = config.dir ?? "./output";
    this.encoding = config.encoding ?? "utf-8-sig";
    this.now = deps.now ?? (() => new Date());
  }

  async export(papers: readonly Paper[]): Promise<string | null> {
    if (papers.length === 0) return null;

    mkdirSync(this.dir, { recursive: true });
    const path = resolveExportPath(this.dir, "csv", this.now());

    // Built in memory first, then replaced atomically: writing straight to
    // the destination would truncate the published CSV before the first
    // row, so a failure mid-build leaves the previous complete file alone.
    let buffer = csvLine(COLUMNS);
    papers.forEach((p, i) => {
      const row = buildRow(p, i + 1);
      buffer += csvLine(COLUMNS.map((c) => row[c] as string));
    });
    atomicWriteText(path, buffer, { encoding: this.encoding });
    return path;
  }
}
