/**
 * Build a lightweight, human-friendly summary CSV from PaperPilot output —
 * TS port of `paperpilot/scripts/build_summary_csv.py` (CAT-25..27 of
 * docs/migration/safety-contracts.md).
 *
 * Input : <conferenceDir>/papers_YYYY-MM-DD.csv (pipeline output)
 * Output: <conferenceDir>/summary.csv            (14 columns, sortable)
 *
 * See the Python module's own doc comment for the full column/semantics
 * rationale; this port keeps the exact same behaviour (auto-discovery of
 * the latest dated CSV, the `summary.meta.json` sidecar, the formula-guard
 * round trip) so its output is byte-identical for the same input.
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { IdentityError, identityFromUrl, normalizeAlias } from "@paperpilot/core/identity";
import {
  codepointCompare,
  pyJsonDumps,
  pyLower,
  pySplit,
  pyStrip,
} from "@paperpilot/core/pycompat";
import { neutralizeRow, unneutralize } from "../collect/exporters/csvSafety.js";
import { atomicWriteText } from "../collect/state/atomic.js";
import { dictReader, stripBom, writeDictCsv } from "./csv.js";
import { TOPIC_RULES_COMPILED } from "./topicRules.js";

/**
 * Names the papers_*.csv this run read, so the published catalog's
 * "generated" date describes THAT collection instead of the newest dated
 * CSV lying around. Exported because `buildPages.ts` imports it rather
 * than re-declaring the name.
 */
export const SUMMARY_META_FILENAME = "summary.meta.json";

const PAPERS_NAME_RE = /^papers_\d{4}-\d{2}-\d{2}\.csv$/;

const SUMMARY_FIELDNAMES = [
  "title",
  "type",
  "tags",
  "venue",
  "authors",
  "arxiv_url",
  "pdf_url",
  "abstract",
  "arxiv_id",
  "citation_count",
  "venue_tier",
  "github_stars",
  "source",
  "source_id",
] as const;

export interface BuildSummaryResult {
  rowsWritten: number;
  oralCount: number;
  sourceCsv: string;
  summaryCsv: string;
  tagCounts: Map<string, number>;
}

/** Pick the most recent `papers_YYYY-MM-DD.csv` under the given dir (filename-dated, not mtime). */
export function findLatestCsv(conferenceDir: string): string {
  let entries: string[];
  try {
    entries = readdirSync(conferenceDir);
  } catch {
    entries = [];
  }
  const candidates = entries
    .filter((name) => PAPERS_NAME_RE.test(name) && statSync(join(conferenceDir, name)).isFile())
    .sort(); // YYYY-MM-DD filenames sort lexicographically by date (ASCII digits only).
  if (candidates.length === 0) {
    throw new Error(`No papers_YYYY-MM-DD.csv found under ${conferenceDir}`);
  }
  return join(conferenceDir, candidates[candidates.length - 1] as string);
}

const ORAL_TITLE_RE = /^## \d+\.\s+(.+)$/gm;

/** Extract paper titles from `oral_summaries_ja.md` (`## 1. Title` headers). Empty set if absent. */
export function loadOralTitles(oralMdPath: string): Set<string> {
  if (!existsSync(oralMdPath)) return new Set();
  const text = readFileSync(oralMdPath, "utf-8");
  const titles = new Set<string>();
  for (const match of text.matchAll(ORAL_TITLE_RE)) {
    titles.add(normalizeTitle(match[1] as string));
  }
  return titles;
}

// Invisible zero-width characters (ZWSP/ZWNJ/ZWJ/BOM) leak in from arXiv
// metadata and otherwise survive verbatim into papers.json (#371).
const ZERO_WIDTH_RE = /​|‌|‍|﻿/g;

export function stripZeroWidth(s: string): string {
  return s.replace(ZERO_WIDTH_RE, "");
}

/** Collapse whitespace runs and lowercase, for oral-title matching only. */
export function normalizeTitle(s: string): string {
  return pyLower(pySplit(s).join(" "));
}

export function classifyTags(title: string, abstract: string): string[] {
  const text = pyLower(`${title} ${abstract}`);
  const tags: string[] = [];
  for (const [tag, patterns] of TOPIC_RULES_COMPILED) {
    if (patterns.some((re) => re.test(text))) {
      tags.push(tag);
    }
  }
  return tags;
}

interface SummaryRow {
  title: string;
  type: "Oral" | "Poster";
  tags: string;
  venue: string;
  authors: string;
  arxiv_url: string;
  pdf_url: string;
  abstract: string;
  arxiv_id: string;
  citation_count: string;
  venue_tier: string;
  github_stars: string;
  source: string;
  source_id: string;
}

export interface BuildSummaryOptions {
  conferenceDir: string;
  inputCsv?: string | null;
}

/** Generate summary.csv for the given conference directory. */
export function buildSummary(options: BuildSummaryOptions): BuildSummaryResult {
  const conferenceDir = options.conferenceDir;
  const srcCsv = options.inputCsv ?? findLatestCsv(conferenceDir);
  const oralMd = join(conferenceDir, "oral_summaries_ja.md");
  const dstCsv = join(conferenceDir, "summary.csv");

  const oralTitles = loadOralTitles(oralMd);
  const rowsOut: SummaryRow[] = [];

  const rawText = stripBom(readFileSync(srcCsv, "utf-8"));
  const { rows } = dictReader(rawText);
  for (const rawRow of rows) {
    const row: Record<string, string | null> = {};
    for (const [k, v] of Object.entries(rawRow)) {
      row[k] = typeof v === "string" ? unneutralize(v) : v;
    }
    const title = pyStrip(stripZeroWidth(row.title ?? ""));
    if (!title) continue;
    const abstract = stripZeroWidth(row.abstract ?? "");
    const identity = identityFromUrl(row.url ?? "");
    const declaredSource = pyStrip(row.source ?? "");
    const declaredSourceId = pyStrip(row.source_id ?? "");
    if (Boolean(declaredSource) !== Boolean(declaredSourceId)) {
      throw new IdentityError("source and source_id must be present together");
    }
    if (declaredSource) {
      const [normSource, normId] = normalizeAlias(declaredSource, declaredSourceId);
      if (normSource !== identity.source || normId !== identity.sourceId) {
        throw new IdentityError("declared source/source_id does not match the native source URL");
      }
    }
    const paperType: "Oral" | "Poster" = oralTitles.has(normalizeTitle(title)) ? "Oral" : "Poster";
    const tags = classifyTags(title, abstract);
    rowsOut.push({
      title,
      type: paperType,
      tags: tags.length > 0 ? tags.join(" ") : "Other",
      venue: row.venue ?? "",
      authors: row.authors ?? "",
      arxiv_url: row.url ?? "",
      pdf_url: row.pdf_url ?? "",
      abstract: pyStrip(abstract.replace(/\n/g, " ")),
      arxiv_id: row.arxiv_id ?? "",
      citation_count: row.citation_count ?? "",
      venue_tier: row.venue_tier ?? "",
      github_stars: row.github_stars ?? "",
      source: identity.source,
      source_id: identity.sourceId,
    });
  }

  rowsOut.sort((a, b) => {
    const ra = a.type === "Oral" ? 0 : 1;
    const rb = b.type === "Oral" ? 0 : 1;
    if (ra !== rb) return ra - rb;
    return codepointCompare(pyLower(a.title), pyLower(b.title));
  });

  mkdirSync(dirname(dstCsv), { recursive: true });
  const rowsNeutralized = rowsOut.map((row) =>
    neutralizeRow(row as unknown as Record<string, string>),
  );
  const csvText = writeDictCsv(SUMMARY_FIELDNAMES, rowsNeutralized);
  atomicWriteText(dstCsv, csvText);

  const sidecar = join(conferenceDir, SUMMARY_META_FILENAME);
  // realpathSync (not path.resolve, which is purely lexical) so a
  // conference directory reached via a symlink is correctly recognized as
  // "the same directory" as the source CSV's real location — matching
  // Python's `Path.resolve()`, which follows symlinks.
  const srcAbsDir = realpathSync(dirname(srcCsv));
  const confAbsDir = realpathSync(conferenceDir);
  if (srcAbsDir === confAbsDir) {
    atomicWriteText(
      sidecar,
      `${pyJsonDumps({ source: basename(srcCsv) }, { ensureAscii: false })}\n`,
    );
  } else {
    try {
      unlinkSync(sidecar);
    } catch {
      // missing_ok
    }
  }

  const tagCounts = new Map<string, number>();
  for (const r of rowsOut) {
    for (const t of pySplit(r.tags)) {
      tagCounts.set(t, (tagCounts.get(t) ?? 0) + 1);
    }
  }
  const oralCount = rowsOut.filter((r) => r.type === "Oral").length;

  return {
    rowsWritten: rowsOut.length,
    oralCount,
    sourceCsv: srcCsv,
    summaryCsv: dstCsv,
    tagCounts,
  };
}
