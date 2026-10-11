/**
 * R3-5: link catalog rows that have no shared identifier (the
 * `conference_site` namespace, e.g. ICLR 2025 from proceedings.iclr.cc) to
 * their DBLP record and, through it, their OpenReview forum id — so later
 * identity / lineage work can use a stable id instead of the proceedings
 * hash.
 *
 * Why DBLP: OpenReview `/notes` answers 403 to automated clients and
 * `/groups` only carries the venue configuration (no per-paper forum ids);
 * Semantic Scholar `externalIds` has no OpenReview field. DBLP (metadata
 * CC0 1.0) lists every ICLR paper on its table-of-contents page with the
 * OpenReview forum as `primaryDocumentPage`, and its SPARQL endpoint is
 * reachable (the search API sits behind a bot wall). One query per 2,000
 * records.
 *
 * Usage (repo root, Node 22):
 *   pnpm exec tsx apps/pipeline/src/catalog/linkExternalIdsCli.ts \
 *     --conference iclr-2025 [--dblp-toc db/conf/iclr/iclr2025]
 * Writes `<inputs>/<conf>/external_ids.json` (input-side only; not
 * published). A row is linked only with an (near-)identical title AND
 * >= 50 % author overlap, and a DBLP record claimed by two rows links
 * neither (fail closed).
 */

import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { layoutFor } from "@paperpilot/core/layout";
import { validateConferenceSlug } from "@paperpilot/core/slug";
import { atomicWriteText } from "../collect/state/atomic.js";
import { parseArgs } from "../shared/cli/argparse.js";
import { isMain } from "../shared/cli/isMain.js";
import {
  authorOverlap,
  judgeArxivMatch,
  type MatchCandidate,
  normalizeTitle,
  titleScore,
} from "./abstractReplacements.js";
import { loadSummaryWithDetails } from "./buildPages.js";
import { PacedClient } from "./resolveAbstractReplacementsCli.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPO_ROOT = resolve(HERE, "..", "..", "..", "..");

export const EXTERNAL_IDS_SCHEMA = "conference-external-ids-v1";
export const EXTERNAL_IDS_FILENAME = "external_ids.json";
export const DBLP_SPARQL = "https://sparql.dblp.org/sparql";
const DBLP_PAGE = 2000;

/** Default DBLP table-of-contents page per conference prefix. */
const DBLP_TOC_BY_PREFIX: Record<string, (year: number) => string> = {
  iclr: (y) => `db/conf/iclr/iclr${y}`,
  neurips: (y) => `db/conf/nips/neurips${y}`,
};

export interface DblpRecord extends MatchCandidate {
  /** e.g. `conf/iclr/ChenC25`. */
  dblp_key: string;
  /** OpenReview forum id from `primaryDocumentPage`, or null. */
  openreview_id: string | null;
}

export interface ExternalIdLink {
  paper_id: string;
  title: string;
  dblp_key: string;
  openreview_id?: string;
  /**
   * `title`: (near-)identical title + >= 50 % authors. `authors`: a retitled
   * paper — the only record of the edition with exactly the same (>= 2)
   * authors and some title overlap.
   */
  match: { via: "title" | "authors"; title_score: number; author_overlap: number };
}

/** Title overlap still required for an `authors` link (token Jaccard). */
export const AUTHORS_LINK_TITLE_MIN = 0.25;

export interface ExternalIdsFile {
  schema_version: typeof EXTERNAL_IDS_SCHEMA;
  conference: string;
  generated_at: string;
  source: { dblp_toc: string; endpoint: string; license: "CC0-1.0" };
  counts: { rows: number; dblp_records: number; linked: number; openreview: number };
  papers: ExternalIdLink[];
}

/** SPARQL for one page of a DBLP table-of-contents listing. */
export function dblpTocQuery(toc: string, limit: number, offset: number): string {
  if (!/^db\/[a-z0-9/_-]+$/i.test(toc)) throw new Error(`invalid DBLP toc: ${toc}`);
  return `PREFIX dblp: <https://dblp.org/rdf/schema#>
SELECT ?p ?title ?ee (GROUP_CONCAT(?an; separator="|") AS ?authors) WHERE {
  ?p dblp:listedOnTocPage <https://dblp.org/${toc}> ; dblp:title ?title .
  OPTIONAL { ?p dblp:primaryDocumentPage ?ee }
  OPTIONAL { ?p dblp:hasSignature ?s . ?s dblp:signatureDblpName ?an }
} GROUP BY ?p ?title ?ee ORDER BY ?p LIMIT ${limit} OFFSET ${offset}`;
}

const OPENREVIEW_FORUM_RE = /^https?:\/\/openreview\.net\/forum\?id=([A-Za-z0-9_-]+)$/;

/** Parse SPARQL JSON results into DBLP records; null for an unusable body. */
export function parseDblpSparql(body: string): DblpRecord[] | null {
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch {
    return null;
  }
  const bindings = (raw as { results?: { bindings?: unknown } })?.results?.bindings;
  if (!Array.isArray(bindings)) return null;
  const byKey = new Map<string, DblpRecord>();
  for (const b of bindings as Array<Record<string, { value?: string } | undefined>>) {
    const iri = b.p?.value ?? "";
    const key = /^https:\/\/dblp\.org\/rec\/(.+)$/.exec(iri)?.[1];
    const title = (b.title?.value ?? "").replace(/\.$/, "").trim();
    if (!key || !title) continue;
    const ee = b.ee?.value ?? "";
    const orId = OPENREVIEW_FORUM_RE.exec(ee)?.[1] ?? null;
    const authors = (b.authors?.value ?? "")
      .split("|")
      // DBLP disambiguates homonyms with a numeric suffix ("Zaid Khan 0001").
      .map((a) => a.replace(/\s+\d{4}$/, "").trim())
      .filter(Boolean);
    const prev = byKey.get(key);
    // A record with two document pages appears twice: prefer the OpenReview one.
    if (prev && (prev.openreview_id || !orId)) continue;
    byKey.set(key, { dblp_key: key, title, authors, openreview_id: orId });
  }
  return [...byKey.values()];
}

/**
 * Link catalog rows to DBLP records: exact normalised title first, then
 * the best near-identical title (>= 0.9, LaTeX-insensitive); always >= 50 %
 * authors. Rows still unlinked may link by authors alone when exactly one
 * record of the edition has the same author set (>= 2 authors) and the
 * titles share >= 25 % of their tokens (retitled camera-ready). A record
 * claimed by more than one row links none of them.
 */
export function linkRowsToDblp(
  rows: ReadonlyArray<MatchCandidate & { paper_id: string }>,
  records: readonly DblpRecord[],
): ExternalIdLink[] {
  const byTitle = new Map<string, DblpRecord[]>();
  for (const r of records) {
    const k = normalizeTitle(r.title);
    byTitle.set(k, [...(byTitle.get(k) ?? []), r]);
  }
  const claims = new Map<string, ExternalIdLink[]>();
  for (const row of rows) {
    let best: { rec: DblpRecord; ts: number; ao: number } | null = null;
    const exact = byTitle.get(normalizeTitle(row.title)) ?? [];
    const pool = exact.length > 0 ? exact : records;
    for (const rec of pool) {
      const j = judgeArxivMatch(row, rec, "arxiv_title_search");
      if (!j.ok) continue;
      if (
        !best ||
        j.title_score > best.ts ||
        (j.title_score === best.ts && j.author_overlap > best.ao)
      ) {
        best = { rec, ts: j.title_score, ao: j.author_overlap };
      }
    }
    if (!best) continue;
    const link: ExternalIdLink = {
      paper_id: row.paper_id,
      title: row.title,
      dblp_key: best.rec.dblp_key,
      ...(best.rec.openreview_id ? { openreview_id: best.rec.openreview_id } : {}),
      match: { via: "title", title_score: best.ts, author_overlap: best.ao },
    };
    claims.set(best.rec.dblp_key, [...(claims.get(best.rec.dblp_key) ?? []), link]);
  }
  const linkedRows = new Set([...claims.values()].flat().map((l) => l.paper_id));
  for (const row of rows) {
    if (linkedRows.has(row.paper_id) || row.authors.length < 2) continue;
    const same = records.filter(
      (r) => r.authors.length === row.authors.length && authorOverlap(row.authors, r.authors) === 1,
    );
    if (same.length !== 1) continue;
    const rec = same[0] as DblpRecord;
    const ts = titleScore(row.title, rec.title);
    if (ts < AUTHORS_LINK_TITLE_MIN || claims.has(rec.dblp_key)) continue;
    claims.set(rec.dblp_key, [
      {
        paper_id: row.paper_id,
        title: row.title,
        dblp_key: rec.dblp_key,
        ...(rec.openreview_id ? { openreview_id: rec.openreview_id } : {}),
        match: { via: "authors", title_score: Math.round(ts * 1000) / 1000, author_overlap: 1 },
      },
    ]);
  }
  const out: ExternalIdLink[] = [];
  for (const links of claims.values()) if (links.length === 1) out.push(links[0] as ExternalIdLink);
  return out.sort((a, b) => (a.paper_id < b.paper_id ? -1 : 1));
}

/** Parse an `external_ids.json` into paper_id -> link (throws when malformed). */
export function parseExternalIds(raw: unknown): Map<string, ExternalIdLink> {
  const file = raw as Partial<ExternalIdsFile> | null;
  if (!file || file.schema_version !== EXTERNAL_IDS_SCHEMA || !Array.isArray(file.papers)) {
    throw new Error(`external ids: schema_version must be ${EXTERNAL_IDS_SCHEMA}`);
  }
  const out = new Map<string, ExternalIdLink>();
  for (const p of file.papers) {
    if (!/^[0-9a-f]{40}$/.test(p?.paper_id ?? "") || typeof p.dblp_key !== "string") {
      throw new Error("external ids: invalid row");
    }
    out.set(p.paper_id, p);
  }
  return out;
}

export interface LinkOptions {
  conference: string;
  inputsRoot: string;
  dblpToc: string;
  client: PacedClient;
  log: (msg: string) => void;
  now: () => Date;
}

export async function linkExternalIds(
  opts: LinkOptions,
): Promise<{ counts: ExternalIdsFile["counts"]; path: string } | null> {
  const conf = validateConferenceSlug(opts.conference);
  const confDir = join(opts.inputsRoot, conf);
  const { papers } = loadSummaryWithDetails(join(confDir, "summary.csv"), {
    replacements: new Map(),
  });
  const rows = papers.map((p) => ({ paper_id: p.paper_id, title: p.title, authors: p.authors }));
  const records: DblpRecord[] = [];
  for (let offset = 0; ; offset += DBLP_PAGE) {
    const url = `${DBLP_SPARQL}?${new URLSearchParams({
      query: dblpTocQuery(opts.dblpToc, DBLP_PAGE, offset),
    })}`;
    const resp = await opts.client.request("dblp", url, {
      headers: { Accept: "application/sparql-results+json" },
    });
    const page = resp.status === 200 ? parseDblpSparql(resp.body) : null;
    if (page === null) {
      opts.log(`  DBLP SPARQL: HTTP ${resp.status} / unusable page; nothing written`);
      return null;
    }
    records.push(...page);
    if (page.length < DBLP_PAGE) break;
  }
  if (records.length === 0) {
    opts.log(`  DBLP ${opts.dblpToc}: no records; nothing written`);
    return null;
  }
  const links = linkRowsToDblp(rows, records);
  const counts = {
    rows: rows.length,
    dblp_records: records.length,
    linked: links.length,
    openreview: links.filter((l) => l.openreview_id).length,
  };
  const file: ExternalIdsFile = {
    schema_version: EXTERNAL_IDS_SCHEMA,
    conference: conf,
    generated_at: opts.now().toISOString(),
    source: { dblp_toc: opts.dblpToc, endpoint: DBLP_SPARQL, license: "CC0-1.0" },
    counts,
    papers: links,
  };
  const path = join(confDir, EXTERNAL_IDS_FILENAME);
  atomicWriteText(path, `${JSON.stringify(file, null, 1)}\n`);
  opts.log(`${conf}: ${JSON.stringify(counts)} -> ${path}`);
  return { counts, path };
}

export async function main(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv, {
    conference: { type: "string", required: true },
    root: { type: "string" },
    "dblp-toc": { type: "string" },
  });
  const conference = args.conference as string;
  const prefix = conference.split("-", 1)[0] ?? "";
  const year = Number(/-(\d{4})$/.exec(conference)?.[1] ?? Number.NaN);
  const toc =
    (args["dblp-toc"] as string | undefined) ??
    (Number.isFinite(year) ? DBLP_TOC_BY_PREFIX[prefix]?.(year) : undefined);
  if (!toc) {
    console.error(`no DBLP toc known for ${conference}; pass --dblp-toc db/conf/<x>/<x><year>`);
    return 2;
  }
  const layout = layoutFor((args.root as string | undefined) ?? DEFAULT_REPO_ROOT);
  const res = await linkExternalIds({
    conference,
    inputsRoot: layout.inputs,
    dblpToc: toc,
    client: new PacedClient(),
    log: (m) => console.log(m),
    now: () => new Date(),
  });
  return res === null ? 1 : 0;
}

if (isMain(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      console.error(err);
      process.exit(1);
    },
  );
}
