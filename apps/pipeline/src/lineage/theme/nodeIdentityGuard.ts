/**
 * R2-22: mis-merged bibliographic records (design 41 D5 node metadata).
 *
 * OpenAlex sometimes merges a paper's citations into an unrelated record.
 * The GNN lineage carried "Advances In Deep Learning On Graphs (GSP'18
 * Workshop)" (W2964321699, a Figshare/Zenodo slide-deck record) with
 * ChebNet's 4,973 citations: it looked like a canonical ancestor, touched
 * 14 edges, and Semantic Scholar does not know it at all. Such a node is
 * not a paper of the lineage and its edges are not citations of a paper.
 *
 * The guard is deliberately conservative. A non-focus node is DROPPED only
 * when two independent signals agree:
 *  - its record is an event/repository record, not a paper: the title
 *    names a workshop / tutorial / lecture / keynote / slides / talk
 *    (e.g. "(GSP'18 Workshop)"), or the work lives on a generic repository
 *    (Zenodo / Figshare DOI or venue); AND
 *  - its citation count is implausible for such a record (>= 500), or,
 *    when a Semantic Scholar count for the same work is known, wildly
 *    above it (> 5x and > +300).
 * A node whose OpenAlex count is wildly above the known S2 count for the
 * same work is also dropped on that signal alone (two sources disagree on
 * the identity of the record). A paper with an implausible citation rate
 * for its age (>= 1,000 citations per year within two years of
 * publication) is only FLAGGED (`meta.suspect_records`): real blockbuster
 * papers do that too ("Identifying Resilient Communities in Road Networks",
 * 2025, 1,570 citations, is flagged, not dropped).
 * Focus (seed) nodes are never dropped, only flagged.
 */

export interface SuspectRecord {
  id: string;
  title: string;
  /** Machine-readable reasons, e.g. `event_title`, `repository_record`, `citations>=500`. */
  reasons: string[];
  action: "dropped" | "flagged";
}

type NodeLike = Record<string, unknown> & { id: string };

/** Event / non-paper record words in a title ("(GSP'18 Workshop)", "Tutorial on …", "Lecture slides"). */
const EVENT_TITLE =
  /\b(workshop|tutorial|lecture|lectures|keynote|slides|slide\s+deck|talk|webinar|summer\s+school|invited\s+talk)\b/i;
/** Generic repositories that host slides, posters, datasets and code. */
const REPOSITORY_DOI = /^10\.(5281\/zenodo|6084\/m9\.figshare)\./i;
const REPOSITORY_VENUE = /^(zenodo|figshare)\b/i;

/** Citation count from which an event/repository record is implausible. */
export const RECORD_CITATION_FLOOR = 500;
/** Citations per year (within {@link YOUNG_YEARS} years) that get a flag. */
export const YOUNG_RATE_FLAG = 1000;
const YOUNG_YEARS = 2;

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function doisOf(node: NodeLike): string[] {
  const out: string[] = [];
  const aliases = node.aliases;
  if (Array.isArray(aliases)) {
    for (const a of aliases) {
      if (Array.isArray(a) && a[0] === "doi" && typeof a[1] === "string") out.push(a[1]);
    }
  }
  const doi = str(node.doi);
  if (doi) out.push(doi.replace(/^https?:\/\/(dx\.)?doi\.org\//i, ""));
  return out;
}

function citationsOf(node: NodeLike): number | null {
  for (const k of ["citation_count", "citationCount", "cited_by_count"]) {
    const v = node[k];
    if (typeof v === "number" && Number.isFinite(v)) return v;
  }
  return null;
}

/** The record is an event/repository record rather than a paper. */
export function recordKindReasons(node: NodeLike): string[] {
  const reasons: string[] = [];
  if (EVENT_TITLE.test(str(node.title))) reasons.push("event_title");
  if (doisOf(node).some((d) => REPOSITORY_DOI.test(d)) || REPOSITORY_VENUE.test(str(node.venue))) {
    reasons.push("repository_record");
  }
  return reasons;
}

export interface SuspectOptions {
  /** Ids that must never be dropped (theme seeds / focus nodes). */
  focusIds?: ReadonlySet<string>;
  /** Semantic Scholar citation counts for the same works, when known. */
  s2CitationCounts?: ReadonlyMap<string, number>;
  /** Current year for the age-rate flag (default: this year). */
  currentYear?: number;
}

/** Check every node; returns only the suspect ones (sorted by id). */
export function suspectMergedRecords(
  nodes: Iterable<NodeLike>,
  opts: SuspectOptions = {},
): SuspectRecord[] {
  const year = opts.currentYear ?? new Date().getUTCFullYear();
  const out: SuspectRecord[] = [];
  for (const node of nodes) {
    const cites = citationsOf(node);
    const kind = recordKindReasons(node);
    const reasons = [...kind];
    const s2 = opts.s2CitationCounts?.get(node.id);
    const s2Mismatch =
      cites !== null && typeof s2 === "number" && cites > 5 * s2 && cites - s2 > 300;
    if (s2Mismatch) reasons.push(`openalex_vs_s2:${cites}/${s2}`);
    const highForRecord = cites !== null && cites >= RECORD_CITATION_FLOOR;
    let drop = false;
    if (kind.length > 0 && (highForRecord || s2Mismatch)) {
      if (highForRecord) reasons.push(`citations>=${RECORD_CITATION_FLOOR}`);
      drop = true;
    } else if (s2Mismatch) {
      drop = true;
    }
    let flag = false;
    const y = typeof node.year === "number" ? node.year : null;
    if (!drop && cites !== null && y !== null && y <= year && year - y < YOUNG_YEARS) {
      const rate = cites / Math.max(1, year - y);
      if (rate >= YOUNG_RATE_FLAG) {
        reasons.push(`young_high_citations:${cites}@${y}`);
        flag = true;
      }
    }
    if (!drop && !flag) continue;
    const focus = opts.focusIds?.has(node.id) === true;
    out.push({
      id: node.id,
      title: str(node.title),
      reasons,
      action: drop && !focus ? "dropped" : "flagged",
    });
  }
  return out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
