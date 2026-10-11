/**
 * Resolve licence-safe replacements for catalog abstracts whose native
 * source grants no licence (CVF Open Access) — design doc 51 §4, user
 * decision D1=A, R2-26. See `abstractReplacements.ts` for the policy.
 *
 * Usage (from the repo root, Node 22):
 *   pnpm exec tsx apps/pipeline/src/catalog/resolveAbstractReplacementsCli.ts \
 *     --conference cvpr-2025 [--s2-venue "Computer Vision and Pattern Recognition" --year 2025]
 *     [--retry-none] [--s2-match] [--limit N]
 * then rebuild the catalog with buildPagesCli.ts.
 *
 * Steps, each cached into `data/inputs/<conf>/abstract_replacements.json`
 * after it finishes (re-running resumes; rows already resolved are kept):
 *  1. arXiv title search, batched: `ti:"<t1>" OR ti:"<t2>" …` (20 titles
 *     per request, 1 request / 3.1 s — arXiv's limit is 1 per 3 s across
 *     all machines). A hit needs a (near-)identical title AND >= 50 %
 *     author overlap.
 *  2. Semantic Scholar bulk search by venue + year (1,000 records per
 *     request): rows still unresolved whose title S2 knows get the S2
 *     record's `externalIds.ArXiv` (fetched from arXiv by `id_list`, 100
 *     per request, still title+author checked) or else its TLDR via
 *     `POST /paper/batch` (500 ids per request).
 *  3. Optional `--s2-match`: one `/paper/search/match` per still-unresolved
 *     title (~1 req/s keyless; slow — hours for thousands of rows).
 *  Rows still without a replacement are recorded as `none` (title /
 *  authors / link only); `--retry-none` re-tries them.
 *
 * R3-5: also used for `conference_site` rows (ICLR 2025 from
 * proceedings.iclr.cc, no abstracts) — any row whose native source grants
 * no licence is a target. Run `linkExternalIdsCli.ts` first: its
 * `external_ids.json` (DBLP key per row) lets step 2 pair rows whose S2
 * record kept a different title via `externalIds.DBLP`.
 *
 * Network budget (2026-10-11, the three CVF catalogs = 9,640 rows): step 1
 * ≈ 482 arXiv requests ≈ 25–30 min; step 2 ≈ 10 bulk + ≈ 20 batch S2
 * requests + a few arXiv id_list requests ≈ 1–2 min.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { layoutFor } from "@paperpilot/core/layout";
import { nativeAbstractSource } from "@paperpilot/core/licensing";
import { validateConferenceSlug } from "@paperpilot/core/slug";
import { parseArxivFeed } from "../collect/sources/arxiv/feed.js";
import { atomicWriteText } from "../collect/state/atomic.js";
import { parseArgs } from "../shared/cli/argparse.js";
import { isMain } from "../shared/cli/isMain.js";
import {
  ABSTRACT_REPLACEMENTS_FILENAME,
  type AbstractReplacement,
  judgeArxivMatch,
  type MatchCandidate,
  type MatchVia,
  normalizeTitle,
  parseAbstractReplacements,
  serializeAbstractReplacements,
  titleScore,
} from "./abstractReplacements.js";
import { loadSummaryWithDetails } from "./buildPages.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPO_ROOT = resolve(HERE, "..", "..", "..", "..");

const USER_AGENT =
  "PaperPilot-abstract-resolver/1.0 (+https://github.com/taichiiiiiiii/automatic-paper-search)";
const ARXIV_API = "https://export.arxiv.org/api/query";
const S2_API = "https://api.semanticscholar.org/graph/v1";
const ARXIV_DELAY_MS = 3100;
const S2_DELAY_MS = 1100;
/** DBLP asks crawlers to keep it slow; SPARQL pages are large. */
const DBLP_DELAY_MS = 2000;
const DELAY_MS = { arxiv: ARXIV_DELAY_MS, s2: S2_DELAY_MS, dblp: DBLP_DELAY_MS } as const;
const TITLES_PER_ARXIV_QUERY = 20;
/**
 * R3-5: consecutive arXiv batches that may fail (each already retried with
 * back-off for ~6 min) before the run stops calling arXiv and leaves the
 * rest for a re-run — a sustained 429 means arXiv wants us gone for a while.
 */
export const ARXIV_MAX_CONSECUTIVE_FAILURES = 2;

/** Default S2 venue strings per conference prefix (S2 `venue` filter). */
const S2_VENUE_BY_PREFIX: Record<string, string> = {
  cvpr: "Computer Vision and Pattern Recognition",
  iccv: "IEEE International Conference on Computer Vision",
  // R3-5: ICLR 2025 from proceedings.iclr.cc (S2 lists ~1,780 of 3,703).
  iclr: "International Conference on Learning Representations",
};

export interface CatalogRowForResolve extends MatchCandidate {
  paper_id: string;
}

export interface ArxivRecord extends MatchCandidate {
  arxiv_id: string;
  abstract: string;
}

// ---- HTTP with pacing ------------------------------------------------------

type Fetch = typeof fetch;

export class PacedClient {
  private last = new Map<string, number>();
  /** Per-host slow-down factor: doubled on 429 (max 5x), eased back on success. */
  private factor = new Map<string, number>();
  constructor(
    private readonly fetchFn: Fetch = fetch,
    private readonly sleep: (ms: number) => Promise<void> = (ms) =>
      new Promise((r) => setTimeout(r, ms)),
  ) {}

  private async pace(key: string, delayMs: number): Promise<void> {
    const prev = this.last.get(key) ?? 0;
    const wait = prev + delayMs - Date.now();
    if (wait > 0) await this.sleep(wait);
    this.last.set(key, Date.now());
  }

  /** GET/POST with pacing and up to 4 retries on 429/5xx/network errors. */
  async request(
    key: keyof typeof DELAY_MS,
    url: string,
    init: RequestInit = {},
  ): Promise<{ status: number; body: string }> {
    const base = DELAY_MS[key];
    let lastStatus = 0;
    for (let attempt = 0; attempt < 6; attempt++) {
      const factor = this.factor.get(key) ?? 1;
      await this.pace(key, base * factor);
      try {
        const resp = await this.fetchFn(url, {
          ...init,
          headers: { "User-Agent": USER_AGENT, ...(init.headers ?? {}) },
          signal: AbortSignal.timeout(60_000),
        });
        lastStatus = resp.status;
        if (resp.status === 429 || resp.status >= 500) {
          // Shared limits (arXiv: 1 request / 3 s across all machines): back
          // off and stay slower for the rest of the run.
          this.factor.set(key, Math.min(5, factor * 2));
          const retryAfter = Number(resp.headers.get("retry-after"));
          const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 0;
          await this.sleep(Math.min(120_000, Math.max(wait, 10_000 * 2 ** attempt)));
          continue;
        }
        this.factor.set(key, Math.max(1, factor * 0.95));
        return { status: resp.status, body: await resp.text() };
      } catch {
        lastStatus = 0;
        await this.sleep(Math.min(60_000, 5_000 * 2 ** attempt));
      }
    }
    return { status: lastStatus, body: "" };
  }
}

// ---- arXiv -----------------------------------------------------------------

function cleanArxivId(entryId: string): string | null {
  const m = /(\d{4}\.\d{4,5})(v\d+)?$/.exec(entryId);
  return m ? (m[1] as string) : null;
}

function collapse(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/** Parse an arXiv Atom page into records; `null` for an unusable page. */
export function arxivRecordsFromFeed(body: string): ArxivRecord[] | null {
  const page = parseArxivFeed(body);
  if (!page.ok) return null;
  const out: ArxivRecord[] = [];
  for (const e of page.entries) {
    const id = cleanArxivId(e.entryId);
    if (!id) continue;
    out.push({
      arxiv_id: id,
      title: collapse(e.title),
      authors: e.authors.map((a) => a.name),
      abstract: collapse(e.summary),
    });
  }
  return out;
}

/** arXiv `search_query` for a batch of titles (phrase search on `ti:`). */
export function arxivTitleQuery(titles: readonly string[]): string {
  return titles
    .map((t) => normalizeTitle(t))
    .filter((t) => t.length > 0)
    .map((t) => `ti:"${t}"`)
    .join(" OR ");
}

/** Best conservative match of `row` among `records`, or null. */
export function bestArxivMatch(
  row: MatchCandidate,
  records: readonly ArxivRecord[],
  via: MatchVia,
): { record: ArxivRecord; title_score: number; author_overlap: number } | null {
  let best: { record: ArxivRecord; title_score: number; author_overlap: number } | null = null;
  for (const record of records) {
    const j = judgeArxivMatch(row, record, via);
    if (!j.ok) continue;
    if (
      best === null ||
      j.title_score > best.title_score ||
      (j.title_score === best.title_score && j.author_overlap > best.author_overlap)
    ) {
      best = { record, title_score: j.title_score, author_overlap: j.author_overlap };
    }
  }
  return best;
}

function arxivReplacement(
  row: CatalogRowForResolve,
  m: { record: ArxivRecord; title_score: number; author_overlap: number },
  via: MatchVia,
  s2PaperId?: string,
): AbstractReplacement {
  return {
    paper_id: row.paper_id,
    title: row.title,
    kind: "arxiv",
    arxiv_id: m.record.arxiv_id,
    arxiv_title: m.record.title,
    text: m.record.abstract,
    ...(s2PaperId ? { s2_paper_id: s2PaperId } : {}),
    match: { via, title_score: m.title_score, author_overlap: m.author_overlap },
  };
}

// ---- Semantic Scholar ------------------------------------------------------

export interface S2Record {
  paperId: string;
  title: string;
  authors: string[];
  arxivId: string | null;
  /** `externalIds.DBLP`, e.g. `conf/iclr/ChenC25`. */
  dblpKey?: string | null;
}

function s2RecordFrom(raw: unknown): S2Record | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.paperId !== "string" || typeof r.title !== "string") return null;
  const ext = (r.externalIds && typeof r.externalIds === "object" ? r.externalIds : {}) as Record<
    string,
    unknown
  >;
  const authors = Array.isArray(r.authors)
    ? r.authors
        .map((a) => (a && typeof a === "object" ? (a as { name?: unknown }).name : null))
        .filter((n): n is string => typeof n === "string")
    : [];
  const arxivId = typeof ext.ArXiv === "string" && ext.ArXiv ? ext.ArXiv : null;
  const dblpKey = typeof ext.DBLP === "string" && ext.DBLP ? ext.DBLP : null;
  return { paperId: r.paperId, title: r.title, authors, arxivId, dblpKey };
}

/**
 * Pair catalog rows with S2 records: identical normalised title + >= 50 %
 * authors. R3-5: a row already linked to DBLP (`dblpKeys`, from
 * `external_ids.json`) also pairs with the S2 record carrying the same
 * `externalIds.DBLP`, if the titles share half their tokens and the
 * authors still overlap (S2 sometimes keeps a preprint's title).
 */
export function pairWithS2(
  rows: readonly CatalogRowForResolve[],
  records: readonly S2Record[],
  dblpKeys: ReadonlyMap<string, string> = new Map(),
): Map<string, S2Record> {
  const byTitle = new Map<string, S2Record[]>();
  const byDblp = new Map<string, S2Record>();
  for (const r of records) {
    const k = normalizeTitle(r.title);
    byTitle.set(k, [...(byTitle.get(k) ?? []), r]);
    if (r.dblpKey) byDblp.set(r.dblpKey, r);
  }
  const out = new Map<string, S2Record>();
  for (const row of rows) {
    const cands = byTitle.get(normalizeTitle(row.title)) ?? [];
    let hit = cands.find((c) => judgeArxivMatch(row, c, "arxiv_title_search").ok);
    const key = dblpKeys.get(row.paper_id);
    if (!hit && key) {
      const viaDblp = byDblp.get(key);
      if (viaDblp && judgeArxivMatch(row, viaDblp, "s2_external_id").ok) hit = viaDblp;
    }
    if (hit) out.set(row.paper_id, hit);
  }
  return out;
}

// ---- driver ----------------------------------------------------------------

/** paper_id -> DBLP key from `external_ids.json` (R3-5), empty when absent. */
function loadDblpKeys(confDir: string): Map<string, string> {
  const path = join(confDir, "external_ids.json");
  if (!existsSync(path)) return new Map();
  const raw = JSON.parse(readFileSync(path, "utf-8")) as {
    papers?: Array<{ paper_id?: unknown; dblp_key?: unknown }>;
  };
  const out = new Map<string, string>();
  for (const p of raw.papers ?? []) {
    if (typeof p.paper_id === "string" && typeof p.dblp_key === "string") {
      out.set(p.paper_id, p.dblp_key);
    }
  }
  return out;
}

export interface ResolveOptions {
  conference: string;
  inputsRoot: string;
  s2Venue: string | null;
  year: number | null;
  retryNone: boolean;
  s2Match: boolean;
  limit: number | null;
  client: PacedClient;
  log: (msg: string) => void;
  now: () => Date;
}

export async function resolveAbstractReplacements(opts: ResolveOptions): Promise<{
  counts: { arxiv: number; s2_tldr: number; none: number };
  path: string;
}> {
  const conf = validateConferenceSlug(opts.conference);
  const confDir = join(opts.inputsRoot, conf);
  const summary = join(confDir, "summary.csv");
  const outPath = join(confDir, ABSTRACT_REPLACEMENTS_FILENAME);
  const { papers } = loadSummaryWithDetails(summary, { replacements: new Map() });
  const targets: CatalogRowForResolve[] = papers
    .filter((p) => nativeAbstractSource(p.source) === null)
    .map((p) => ({ paper_id: p.paper_id, title: p.title, authors: p.authors }));

  const cache = existsSync(outPath)
    ? parseAbstractReplacements(JSON.parse(readFileSync(outPath, "utf-8")))
    : new Map<string, AbstractReplacement>();
  const targetIds = new Set(targets.map((t) => t.paper_id));
  for (const id of [...cache.keys()]) if (!targetIds.has(id)) cache.delete(id);

  if (opts.retryNone) {
    for (const [id, r] of [...cache]) if (r.kind === "none") cache.delete(id);
  }
  const save = () => {
    atomicWriteText(
      outPath,
      serializeAbstractReplacements(conf, opts.now().toISOString(), cache.values()),
    );
  };
  const markNone = (row: CatalogRowForResolve, step: string, s2PaperId?: string) => {
    const prev = cache.get(row.paper_id);
    const checked = [...new Set([...(prev?.kind === "none" ? (prev.checked ?? []) : []), step])];
    cache.set(row.paper_id, {
      paper_id: row.paper_id,
      title: row.title,
      kind: "none",
      ...((s2PaperId ?? prev?.s2_paper_id) ? { s2_paper_id: s2PaperId ?? prev?.s2_paper_id } : {}),
      checked,
    });
  };
  const noneWithout = (step: string) =>
    targets.filter((t) => {
      const c = cache.get(t.paper_id);
      return c?.kind === "none" && !(c.checked ?? []).includes(step);
    });

  // 1. arXiv batched title search for rows never searched (resumable: the
  // cache is saved after every batch; a batch that fails stays unsearched).
  let todo = targets.filter((t) => !cache.has(t.paper_id));
  if (opts.limit !== null) todo = todo.slice(0, opts.limit);
  opts.log(
    `${conf}: ${targets.length} rows need a licensed abstract; ${todo.length} to search on arXiv`,
  );
  let failedBatches = 0;
  let consecutiveFailures = 0;
  let arxivDown = false;
  for (let i = 0; i < todo.length; i += TITLES_PER_ARXIV_QUERY) {
    const batch = todo.slice(i, i + TITLES_PER_ARXIV_QUERY);
    const url = `${ARXIV_API}?${new URLSearchParams({
      search_query: arxivTitleQuery(batch.map((b) => b.title)),
      max_results: "100",
    })}`;
    const resp = await opts.client.request("arxiv", url);
    const records = resp.status === 200 ? arxivRecordsFromFeed(resp.body) : null;
    if (records === null) {
      failedBatches++;
      consecutiveFailures++;
      opts.log(
        `  arXiv batch ${i / TITLES_PER_ARXIV_QUERY + 1}: unusable (HTTP ${resp.status}); left for a re-run`,
      );
      if (consecutiveFailures >= ARXIV_MAX_CONSECUTIVE_FAILURES) {
        arxivDown = true;
        opts.log(
          `  arXiv: ${consecutiveFailures} batches failed in a row; stopping arXiv calls (re-run later to resume)`,
        );
        break;
      }
      continue;
    }
    consecutiveFailures = 0;
    for (const row of batch) {
      const m = bestArxivMatch(row, records, "arxiv_title_search");
      if (m) cache.set(row.paper_id, arxivReplacement(row, m, "arxiv_title_search"));
      else markNone(row, "arxiv_title");
    }
    save();
    if ((i / TITLES_PER_ARXIV_QUERY) % 10 === 9) {
      opts.log(`  arXiv title search: ${Math.min(i + batch.length, todo.length)}/${todo.length}`);
    }
  }

  // 2. Semantic Scholar venue listing for rows arXiv did not resolve. When
  // arXiv stopped answering, S2 waits too: its arXiv-linked rows would
  // otherwise settle for a TLDR instead of the arXiv abstract.
  const rest = arxivDown ? [] : noneWithout("s2");
  const s2Pairs = new Map<string, S2Record>();
  let s2Listed = false;
  if (rest.length > 0 && opts.s2Venue && opts.year) {
    const records: S2Record[] = [];
    let token: string | null = null;
    let ok = true;
    do {
      const params = new URLSearchParams({
        venue: opts.s2Venue,
        year: String(opts.year),
        fields: "title,externalIds,authors",
      });
      if (token) params.set("token", token);
      const resp = await opts.client.request("s2", `${S2_API}/paper/search/bulk?${params}`);
      if (resp.status !== 200) {
        opts.log(`  S2 bulk: HTTP ${resp.status}; S2 step left for a re-run`);
        ok = false;
        break;
      }
      const page = JSON.parse(resp.body) as { data?: unknown[]; token?: string | null };
      for (const raw of page.data ?? []) {
        const r = s2RecordFrom(raw);
        if (r) records.push(r);
      }
      token = page.token ?? null;
    } while (token);
    if (ok) {
      s2Listed = true;
      opts.log(`  S2 bulk (${opts.s2Venue} ${opts.year}): ${records.length} records`);
      for (const [k, v] of pairWithS2(rest, records, loadDblpKeys(confDir))) s2Pairs.set(k, v);
    }
  }

  // 2a/2b for a set of S2-paired rows: the arXiv version S2 linked
  // (retitled preprints; title+author checked again), else the TLDR.
  // Returns the rows whose TLDR lookup ran (false = left for a re-run).
  const resolvePaired = async (rows: readonly CatalogRowForResolve[]): Promise<Set<string>> => {
    const linked = arxivDown ? [] : rows.filter((r) => s2Pairs.get(r.paper_id)?.arxivId);
    for (let i = 0; i < linked.length; i += 100) {
      const batch = linked.slice(i, i + 100);
      const ids = batch.map((r) => s2Pairs.get(r.paper_id)?.arxivId as string);
      const url = `${ARXIV_API}?${new URLSearchParams({ id_list: ids.join(","), max_results: "100" })}`;
      const resp = await opts.client.request("arxiv", url);
      const records = resp.status === 200 ? arxivRecordsFromFeed(resp.body) : null;
      if (records === null) continue;
      const byId = new Map(records.map((r) => [r.arxiv_id, r]));
      for (const row of batch) {
        const s2 = s2Pairs.get(row.paper_id) as S2Record;
        const rec = byId.get((s2.arxivId as string).replace(/v\d+$/, ""));
        if (!rec) continue;
        const m = bestArxivMatch(row, [rec], "s2_external_id");
        if (m) cache.set(row.paper_id, arxivReplacement(row, m, "s2_external_id", s2.paperId));
      }
      save();
    }
    const tldrRows = rows.filter(
      (r) => cache.get(r.paper_id)?.kind === "none" && s2Pairs.has(r.paper_id),
    );
    const done = new Set<string>(
      rows.filter((r) => cache.get(r.paper_id)?.kind !== "none").map((r) => r.paper_id),
    );
    for (let i = 0; i < tldrRows.length; i += 500) {
      const batch = tldrRows.slice(i, i + 500);
      const ids = batch.map((r) => (s2Pairs.get(r.paper_id) as S2Record).paperId);
      const resp = await opts.client.request("s2", `${S2_API}/paper/batch?fields=tldr`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids }),
      });
      if (resp.status !== 200) {
        opts.log(`  S2 batch tldr: HTTP ${resp.status}; left for a re-run`);
        continue;
      }
      const data = JSON.parse(resp.body) as Array<{ tldr?: { text?: unknown } | null } | null>;
      batch.forEach((row, k) => {
        done.add(row.paper_id);
        const text = data[k]?.tldr?.text;
        const s2Id = (s2Pairs.get(row.paper_id) as S2Record).paperId;
        if (typeof text === "string" && text.trim()) {
          cache.set(row.paper_id, {
            paper_id: row.paper_id,
            title: row.title,
            kind: "s2_tldr",
            text: collapse(text),
            s2_paper_id: s2Id,
          });
        } else {
          markNone(row, "s2", s2Id);
        }
      });
      save();
    }
    return done;
  };

  await resolvePaired(rest.filter((r) => s2Pairs.has(r.paper_id)));

  // 3 (optional). Per-title S2 match for rows S2's venue listing missed, in
  // chunks: each chunk's hits are resolved (arXiv version / TLDR) before
  // its rows are marked `s2_match`, so an interrupted run resumes cleanly.
  if (opts.s2Match && !arxivDown) {
    const pending = noneWithout("s2_match").filter((r) => !s2Pairs.has(r.paper_id));
    opts.log(`  S2 match: ${pending.length} titles`);
    for (let i = 0; i < pending.length; i += 20) {
      const chunk = pending.slice(i, i + 20);
      const asked: CatalogRowForResolve[] = [];
      for (const row of chunk) {
        const params = new URLSearchParams({
          query: row.title,
          fields: "title,externalIds,authors",
        });
        const resp = await opts.client.request("s2", `${S2_API}/paper/search/match?${params}`);
        if (resp.status !== 200 && resp.status !== 404) continue;
        const data =
          resp.status === 200 ? ((JSON.parse(resp.body) as { data?: unknown[] }).data ?? []) : [];
        const rec = s2RecordFrom(data[0]);
        const hit = rec ? pairWithS2([row], [rec]).get(row.paper_id) : undefined;
        if (hit) s2Pairs.set(row.paper_id, hit);
        asked.push(row);
      }
      const resolved = await resolvePaired(asked.filter((r) => s2Pairs.has(r.paper_id)));
      for (const row of asked) {
        const hit = s2Pairs.get(row.paper_id);
        if (hit && !resolved.has(row.paper_id)) continue; // TLDR lookup failed: retry later
        if (cache.get(row.paper_id)?.kind === "none") markNone(row, "s2_match", hit?.paperId);
      }
      save();
      if ((i / 20) % 5 === 4)
        opts.log(`  S2 match: ${Math.min(i + 20, pending.length)}/${pending.length}`);
    }
  }

  // Rows the S2 listing did not know are done with the S2 step too.
  if (s2Listed) {
    for (const row of rest) {
      if (cache.get(row.paper_id)?.kind === "none" && !s2Pairs.has(row.paper_id)) {
        markNone(row, "s2");
      }
    }
  }
  save();
  const unsearched = targets.filter((t) => !cache.has(t.paper_id)).length;
  const retryLater = unsearched;
  if (failedBatches) opts.log(`  ${failedBatches} arXiv batch(es) failed this run`);
  const counts = { arxiv: 0, s2_tldr: 0, none: 0 };
  for (const r of cache.values()) counts[r.kind]++;
  opts.log(
    `${conf}: ${JSON.stringify(counts)}${retryLater ? `, ${retryLater} not yet searched on arXiv (re-run to resume)` : ""} -> ${outPath}`,
  );
  return { counts, path: outPath };
}

export async function main(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv, {
    conference: { type: "string", required: true },
    root: { type: "string" },
    "s2-venue": { type: "string" },
    year: { type: "int" },
    "retry-none": { type: "boolean" },
    "s2-match": { type: "boolean" },
    limit: { type: "int" },
  });
  const conference = args.conference as string;
  const prefix = conference.split("-", 1)[0] ?? "";
  const yearFromSlug = Number(/-(\d{4})$/.exec(conference)?.[1] ?? Number.NaN);
  const layout = layoutFor((args.root as string | undefined) ?? DEFAULT_REPO_ROOT);
  const result = await resolveAbstractReplacements({
    conference,
    inputsRoot: layout.inputs,
    s2Venue: (args["s2-venue"] as string | undefined) ?? S2_VENUE_BY_PREFIX[prefix] ?? null,
    year:
      (args.year as number | undefined) ?? (Number.isFinite(yearFromSlug) ? yearFromSlug : null),
    retryNone: Boolean(args["retry-none"]),
    s2Match: Boolean(args["s2-match"]),
    limit: (args.limit as number | undefined) ?? null,
    client: new PacedClient(),
    log: (m) => console.log(m),
    now: () => new Date(),
  });
  void result;
  return 0;
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
