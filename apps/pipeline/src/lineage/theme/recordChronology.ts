/**
 * R2-31 (design 41): publication-year and chronology guards for lineage
 * nodes whose OpenAlex record is wrong or mixed.
 *
 * 1. Proceedings year (`correctProceedingsYears`). OpenAlex sometimes
 *    dates a proceedings paper by its IEEE Xplore posting instead of the
 *    conference: Gori et al. "A new model for learning in graph domains"
 *    is shown as 2006, but its DOI (`10.1109/ijcnn.2005.1555942`, the
 *    Crossref record "Proceedings. 2005 IEEE International Joint
 *    Conference on Neural Networks") and DBLP (`conf/ijcnn/GoriMS05`) say
 *    2005. When an independent year disagrees with the node by EXACTLY one
 *    year, the node takes that year. Sources, first match wins:
 *     - the R2-28 DBLP venue cache entry of the node (`dblp_venues.json`),
 *       when it is a conference record (`conf/…` key) with a year;
 *     - the conference year an IEEE proceedings DOI encodes
 *       (`10.1109/<conf>.<yyyy>.<n>`; IEEE registers these at Crossref
 *       per conference edition), when the node's venue reads as a
 *       conference / proceedings.
 *    Never for a node whose arXiv id dates it to its own year: an arXiv-
 *    first paper keeps its preprint year (GCN: arXiv 2016, ICLR 2017).
 *    Only one-year disagreements are corrected; a larger gap is a
 *    different record or a different version, not a dating slip.
 *    Edge rationales that quote the old year next to the node's title are
 *    rewritten to the corrected year.
 *
 * 2. Chronology inversion (`chronologyInversions`). A mixed OpenAlex record
 *    (W4322614756: the title / DOI of a 2025 GIScience road-network paper,
 *    but 1,570 citations including 2019–2021 GNN papers) shows up in the
 *    graph as a node cited by works published years BEFORE it. For every
 *    node with in-graph citing works, count the citers whose year is more
 *    than one year before the node's earliest known year (its year, or
 *    its arXiv id's year if earlier — a journal version cited as a
 *    preprint is not an inversion). A non-focus node is DROPPED when at
 *    least half of its citers are inverted AND (two or more are inverted,
 *    or one is inverted by three or more years); otherwise any inversion
 *    is only FLAGGED. Focus nodes are only flagged. Results use the
 *    `SuspectRecord` shape of `nodeIdentityGuard.ts` and land in
 *    `meta.suspect_records` with reason `chronology_inversion:<k>/<n>@<gap>`.
 */

import type { SuspectRecord } from "./nodeIdentityGuard.js";

type NodeLike = Record<string, unknown> & { id: string };
type EdgeLike = { src: string; dst: string; rationale?: unknown };

export interface YearCorrection {
  id: string;
  title: string;
  from: number;
  to: number;
  /** `dblp` (R2-28 DBLP cache) or `ieee_doi` (conference year in the DOI). */
  source: "dblp" | "ieee_doi";
}

/** Minimal view of an R2-28 DBLP cache entry. */
export interface DblpYearEntry {
  year: number | null;
  key: string | null;
}

const IEEE_PROCEEDINGS_DOI = /^10\.1109\/[a-z][a-z0-9-]*\.((?:19|20)\d{2})\.\d+$/i;
const PROCEEDINGS_VENUE =
  /\b(conference|proceedings|symposium|workshop|congress|joint\s+conference)\b|\b(ijcnn|icassp|icip|icpr|iccv|cvpr|icdm|icde|infocom)\b/i;
const NEW_ARXIV = /^(\d{2})(\d{2})\.\d{4,5}(v\d+)?$/;
const OLD_ARXIV = /^[a-z-]+(\.[A-Z]{2})?\/(\d{2})(\d{2})\d{3}(v\d+)?$/i;

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function yearOf(node: NodeLike): number | null {
  return typeof node.year === "number" && Number.isInteger(node.year) ? node.year : null;
}

/** Year an arXiv identifier dates the paper to (`1901.01343` -> 2019). */
export function arxivIdYear(raw: unknown): number | null {
  const id = str(raw).trim();
  if (!id) return null;
  const m = NEW_ARXIV.exec(id);
  if (m) {
    const month = Number(m[2]);
    return month >= 1 && month <= 12 ? 2000 + Number(m[1]) : null;
  }
  const o = OLD_ARXIV.exec(id);
  if (o) {
    const yy = Number(o[2]);
    return yy >= 91 ? 1900 + yy : 2000 + yy;
  }
  return null;
}

function arxivOf(node: NodeLike): string | null {
  if (typeof node.arxiv_id === "string" && node.arxiv_id) return node.arxiv_id;
  const aliases = node.aliases;
  if (Array.isArray(aliases)) {
    for (const a of aliases) {
      if (Array.isArray(a) && a[0] === "arxiv" && typeof a[1] === "string") return a[1];
    }
  }
  return null;
}

function doisOf(node: NodeLike): string[] {
  const out: string[] = [];
  const doi = str(node.doi).replace(/^https?:\/\/(dx\.)?doi\.org\//i, "");
  if (doi) out.push(doi);
  const aliases = node.aliases;
  if (Array.isArray(aliases)) {
    for (const a of aliases) {
      if (Array.isArray(a) && a[0] === "doi" && typeof a[1] === "string") out.push(a[1]);
    }
  }
  return out;
}

/** The conference year an IEEE proceedings DOI encodes, if any. */
export function ieeeProceedingsDoiYear(doi: string): number | null {
  const m = IEEE_PROCEEDINGS_DOI.exec(doi.trim());
  return m ? Number(m[1]) : null;
}

/** Earliest year the node is known by: its year, or its arXiv id's year if earlier. */
export function earliestYear(node: NodeLike): number | null {
  const y = yearOf(node);
  const ax = arxivIdYear(arxivOf(node));
  if (y === null) return ax;
  return ax !== null && ax < y ? ax : y;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Correct one-year proceedings dating slips in place (nodes and the
 * rationales of their edges). Returns the corrections (sorted by id).
 */
export function correctProceedingsYears(
  nodes: Map<string, NodeLike> | NodeLike[],
  edges: EdgeLike[],
  opts: { dblp?: Readonly<Record<string, DblpYearEntry | undefined>> } = {},
): YearCorrection[] {
  const list = Array.isArray(nodes) ? nodes : [...nodes.values()];
  const out: YearCorrection[] = [];
  for (const node of list) {
    const y = yearOf(node);
    if (y === null) continue;
    // An arXiv-first paper is dated by its preprint on purpose.
    const ax = arxivIdYear(arxivOf(node));
    if (ax !== null && ax <= y) continue;
    let to: number | null = null;
    let source: YearCorrection["source"] | null = null;
    const d = opts.dblp?.[node.id];
    if (d && typeof d.year === "number" && str(d.key).startsWith("conf/")) {
      to = d.year;
      source = "dblp";
    } else if (PROCEEDINGS_VENUE.test(str(node.venue))) {
      for (const doi of doisOf(node)) {
        const dy = ieeeProceedingsDoiYear(doi);
        if (dy !== null) {
          to = dy;
          source = "ieee_doi";
          break;
        }
      }
    }
    if (to === null || source === null || Math.abs(to - y) !== 1) continue;
    node.year = to;
    out.push({ id: node.id, title: str(node.title), from: y, to, source });
  }
  if (out.length > 0) {
    const byId = new Map(out.map((c) => [c.id, c]));
    for (const e of edges) {
      if (typeof e.rationale !== "string") continue;
      for (const id of [e.src, e.dst]) {
        const c = byId.get(id);
        if (!c) continue;
        const head = escapeRe(c.title.slice(0, 12));
        if (!head) continue;
        e.rationale = (e.rationale as string).replace(
          new RegExp(`(「${head}[^」]*」\\s*)\\(${c.from}\\)`, "g"),
          `$1(${c.to})`,
        );
      }
    }
  }
  return out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** Share of in-graph citers from which an inversion drops a node. */
export const INVERSION_DROP_SHARE = 0.5;
/** Inverted citers that suffice (with the share) to drop a node. */
export const INVERSION_DROP_COUNT = 2;
/** Gap (years) at which a single inverted citer suffices. */
export const INVERSION_DROP_GAP = 3;

/**
 * Nodes cited by works that predate them by more than a year (edge
 * `src` = cited, `dst` = citing). Returns suspect records (sorted by id).
 */
export function chronologyInversions(
  nodes: Map<string, NodeLike> | NodeLike[],
  edges: readonly EdgeLike[],
  opts: { focusIds?: ReadonlySet<string> } = {},
): SuspectRecord[] {
  const byId = new Map<string, NodeLike>();
  for (const n of Array.isArray(nodes) ? nodes : nodes.values()) byId.set(n.id, n);
  const citers = new Map<string, Set<string>>();
  for (const e of edges) {
    if (e.src === e.dst || !byId.has(e.src) || !byId.has(e.dst)) continue;
    let s = citers.get(e.src);
    if (!s) {
      s = new Set();
      citers.set(e.src, s);
    }
    s.add(e.dst);
  }
  const out: SuspectRecord[] = [];
  for (const [id, set] of citers) {
    const node = byId.get(id) as NodeLike;
    const early = earliestYear(node);
    if (early === null) continue;
    const years = [...set].map((c) => yearOf(byId.get(c) as NodeLike)).filter((y) => y !== null);
    if (years.length === 0) continue;
    const gaps = years.map((y) => early - (y as number)).filter((g) => g > 1);
    if (gaps.length === 0) continue;
    const maxGap = Math.max(...gaps);
    const drop =
      gaps.length / years.length >= INVERSION_DROP_SHARE &&
      (gaps.length >= INVERSION_DROP_COUNT || maxGap >= INVERSION_DROP_GAP);
    const focus = opts.focusIds?.has(id) === true;
    out.push({
      id,
      title: str(node.title),
      reasons: [`chronology_inversion:${gaps.length}/${years.length}@${maxGap}`],
      action: drop && !focus ? "dropped" : "flagged",
    });
  }
  return out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** Merge chronology records into identity-guard records (same id -> one record). */
export function mergeSuspects(a: SuspectRecord[], b: SuspectRecord[]): SuspectRecord[] {
  const byId = new Map<string, SuspectRecord>();
  for (const s of [...a, ...b]) {
    const prev = byId.get(s.id);
    if (!prev) {
      byId.set(s.id, { ...s, reasons: [...s.reasons] });
      continue;
    }
    prev.reasons.push(...s.reasons);
    if (s.action === "dropped") prev.action = "dropped";
  }
  return [...byId.values()].sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
}
