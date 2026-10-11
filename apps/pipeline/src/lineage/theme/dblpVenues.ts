/**
 * R2-28 (design 41, research 47 §2.3): venue correction for lineage nodes
 * shown as an arXiv preprint (OpenAlex `venue` "arXiv (Cornell
 * University)" / "arXiv" / CoRR / empty) when DBLP has the same work as a
 * conference / journal record (FlashAttention -> NeurIPS 2022, PipeMoE ->
 * INFOCOM 2023, ScheMoE -> EuroSys 2024, Switch -> JMLR 2022).
 *
 * Source: the DBLP SPARQL endpoint (`https://sparql.dblp.org/sparql`,
 * QLever; DBLP data is CC0). The DBLP search API answers bots with an
 * Anubis challenge and is not used. Lookup per batch of nodes:
 *  1. by DOI (the node's DOI and its arXiv DataCite DOI) -> DBLP titles;
 *  2. by exact title literal (the node title, with / without a final ".",
 *     plus the DBLP titles from 1) -> every record with that title, its
 *     venue (`dblp:publishedIn`), year, DOI and author names.
 * A record is accepted only when it is not CoRR, its normalised title
 * equals the node's, its year is within [node year - 1, node year + 3],
 * and (when the node lists authors) a surname matches. Several accepted
 * venues -> the earliest (ties: a conference before a journal).
 *
 * Off unless `PAPERPILOT_DBLP_VENUES=on`; at most `maxQueries` SPARQL
 * requests per run, >= 1 s apart, one at a time; a 429 / 5xx stops it.
 * Cache `data/state/lineage-cache/dblp_venues.json` keyed by node id:
 *   { "schema_version": "dblp-venues-cache-v1",
 *     "entries": { "<node id>": {"fetched_at": "…", "venue": "NeurIPS" | null,
 *                                "year": 2022 | null, "key": "conf/nips/DaoFERR22" | null} } }
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import type { FetchLike } from "../../collect/http/requestWithRetry.js";
import { atomicWriteText } from "../../collect/state/atomic.js";
import { type ThemeGraphNode, venueTierFor } from "../shared/node.js";
import { identifiersOf, normTitle } from "./s2Citations.js";

export const DBLP_SCHEMA = "dblp-venues-cache-v1";
export const DBLP_FILENAME = "dblp_venues.json";
export const DBLP_SPARQL = "https://sparql.dblp.org/sparql";
export const DBLP_MIN_INTERVAL_MS = 1000;
export const DBLP_DEFAULT_MAX_QUERIES = 20;
export const DBLP_BATCH = 10;
export const DBLP_TTL_DAYS = 90;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface DblpVenueEntry {
  fetched_at: string;
  venue: string | null;
  year: number | null;
  key: string | null;
}

export interface DblpDeps {
  fetchImpl: FetchLike;
  sleep: (ms: number) => Promise<void>;
  now?: () => Date;
  monotonicNow?: () => number;
  contact?: string | null;
  maxQueries?: number;
  logger?: { warn: (msg: string) => void };
}

/** One DBLP record from the title query. */
export interface DblpRecord {
  key: string;
  title: string;
  venue: string | null;
  year: number | null;
  authors: string[];
}

const PREPRINT_VENUE =
  /^\s*$|arxiv|\bcorr\b|ssrn|preprint|research square|techrxiv|biorxiv|medrxiv/i;

/** The node's venue says preprint (or nothing). */
export function isPreprintVenue(venue: unknown): boolean {
  return typeof venue !== "string" || PREPRINT_VENUE.test(venue);
}

function isoZ(d: Date): string {
  return `${d.toISOString().slice(0, 19)}Z`;
}

function sparqlString(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, " ")}"`;
}

/** Query 1: DBLP titles of records with these DOIs. */
export function doiQuery(dois: readonly string[]): string {
  const values = dois.map((d) => `<https://doi.org/${encodeURI(d)}>`).join(" ");
  return (
    "PREFIX dblp: <https://dblp.org/rdf/schema#>\n" +
    `SELECT DISTINCT ?doi ?title WHERE { VALUES ?doi { ${values} } ?pub dblp:doi ?doi ; dblp:title ?title . }`
  );
}

/** Query 2: every record with one of these exact titles. */
export function titleQuery(titles: readonly string[]): string {
  const values = titles.map(sparqlString).join(" ");
  return (
    "PREFIX dblp: <https://dblp.org/rdf/schema#>\n" +
    'SELECT ?pub ?title ?venue ?year (GROUP_CONCAT(?an; separator="|") AS ?authors) WHERE {\n' +
    `  VALUES ?title { ${values} }\n` +
    "  ?pub dblp:title ?title .\n" +
    "  OPTIONAL { ?pub dblp:publishedIn ?venue } OPTIONAL { ?pub dblp:yearOfPublication ?year }\n" +
    "  OPTIONAL { ?pub dblp:authoredBy ?a . ?a dblp:primaryCreatorName ?an }\n" +
    "} GROUP BY ?pub ?title ?venue ?year"
  );
}

type Binding = Record<string, { value?: string } | undefined>;

function bindingsOf(body: unknown): Binding[] {
  const b = (body as { results?: { bindings?: unknown } } | null)?.results?.bindings;
  return Array.isArray(b) ? (b as Binding[]) : [];
}

export function parseTitleRecords(body: unknown): DblpRecord[] {
  return bindingsOf(body).map((b) => {
    const year = Number.parseInt(b.year?.value ?? "", 10);
    return {
      key: (b.pub?.value ?? "").replace(/^https:\/\/dblp\.org\/rec\//, ""),
      title: b.title?.value ?? "",
      venue: b.venue?.value ?? null,
      year: Number.isFinite(year) ? year : null,
      authors: (b.authors?.value ?? "").split("|").filter(Boolean),
    };
  });
}

function surname(name: unknown): string | null {
  const s = typeof name === "string" ? name : (name as { name?: unknown } | null)?.name;
  if (typeof s !== "string") return null;
  const parts = normTitle(s.replace(/\s+\d{4}$/, ""))
    .split(" ")
    .filter(Boolean);
  return parts[parts.length - 1] ?? null;
}

/** The venue DBLP gives `node`, from the title-query records, or null. */
export function pickVenue(
  node: { title?: unknown; year?: unknown; authors?: unknown },
  records: readonly DblpRecord[],
): DblpRecord | null {
  const title = normTitle(node.title);
  if (!title) return null;
  const year = typeof node.year === "number" ? node.year : null;
  const nodeSurnames = new Set(
    (Array.isArray(node.authors) ? node.authors : []).map(surname).filter((x): x is string => !!x),
  );
  const ok = records.filter((r) => {
    if (normTitle(r.title) !== title) return false;
    if (!r.venue || /^corr$/i.test(r.venue) || r.key.startsWith("journals/corr/")) return false;
    if (year !== null && r.year !== null && (r.year < year - 1 || r.year > year + 3)) return false;
    if (nodeSurnames.size > 0) {
      const theirs = r.authors.map(surname);
      if (!theirs.some((s) => s !== null && nodeSurnames.has(s))) return false;
    }
    return true;
  });
  if (ok.length === 0) return null;
  return [...ok].sort(
    (a, b) =>
      (a.year ?? 9999) - (b.year ?? 9999) ||
      Number(b.key.startsWith("conf/")) - Number(a.key.startsWith("conf/")) ||
      (a.key < b.key ? -1 : 1),
  )[0] as DblpRecord;
}

export function readDblpCache(path: string | null): Record<string, DblpVenueEntry> {
  if (path === null || !existsSync(path)) return {};
  try {
    const raw = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
    if (raw.schema_version !== DBLP_SCHEMA) return {};
    const out: Record<string, DblpVenueEntry> = {};
    for (const [k, v] of Object.entries((raw.entries ?? {}) as Record<string, unknown>)) {
      const e = v as Record<string, unknown> | null;
      if (e && typeof e.fetched_at === "string") {
        out[k] = {
          fetched_at: e.fetched_at,
          venue: typeof e.venue === "string" ? e.venue : null,
          year: typeof e.year === "number" ? e.year : null,
          key: typeof e.key === "string" ? e.key : null,
        };
      }
    }
    return out;
  } catch {
    return {};
  }
}

export function serializeDblpCache(entries: Record<string, DblpVenueEntry>): string {
  const keys = Object.keys(entries).sort();
  const lines = keys.map((k, i) => {
    const e = entries[k] as DblpVenueEntry;
    const body = JSON.stringify({
      fetched_at: e.fetched_at,
      venue: e.venue,
      year: e.year,
      key: e.key,
    });
    return `    ${JSON.stringify(k)}: ${body}${i < keys.length - 1 ? "," : ""}`;
  });
  return (
    `{\n  "schema_version": ${JSON.stringify(DBLP_SCHEMA)},\n  "entries": {\n` +
    `${lines.join("\n")}${lines.length ? "\n" : ""}  }\n}\n`
  );
}

export interface DblpStats {
  candidates: number;
  cacheHits: number;
  queries: number;
  failed: number;
  blocked: boolean;
  budgetSkips: number;
  corrected: number;
}

export class DblpVenueSource {
  private readonly cachePath: string | null;
  private readonly deps: DblpDeps;
  private readonly entries: Record<string, DblpVenueEntry>;
  private readonly dirty = new Set<string>();
  private lastQueryAt: number | null = null;
  readonly stats: DblpStats = {
    candidates: 0,
    cacheHits: 0,
    queries: 0,
    failed: 0,
    blocked: false,
    budgetSkips: 0,
    corrected: 0,
  };

  constructor(cachePath: string | null, deps: DblpDeps) {
    this.cachePath = cachePath;
    this.deps = deps;
    this.entries = readDblpCache(cachePath);
  }

  private now(): Date {
    return this.deps.now ? this.deps.now() : new Date();
  }

  private fresh(e: DblpVenueEntry): boolean {
    const at = Date.parse(e.fetched_at);
    return !Number.isNaN(at) && this.now().getTime() - at < DBLP_TTL_DAYS * DAY_MS;
  }

  private async query(q: string): Promise<unknown | null> {
    if (this.stats.blocked) return null;
    if (this.stats.queries >= (this.deps.maxQueries ?? DBLP_DEFAULT_MAX_QUERIES)) {
      this.stats.budgetSkips += 1;
      return null;
    }
    const clock = this.deps.monotonicNow ?? Date.now;
    if (this.lastQueryAt !== null) {
      const wait = this.lastQueryAt + DBLP_MIN_INTERVAL_MS - clock();
      if (wait > 0) await this.deps.sleep(wait);
    }
    this.lastQueryAt = clock();
    this.stats.queries += 1;
    try {
      const resp = await this.deps.fetchImpl(DBLP_SPARQL, {
        method: "POST",
        headers: {
          Accept: "application/sparql-results+json",
          "Content-Type": "application/x-www-form-urlencoded",
          "User-Agent": `PaperPilot/0.1 (theme lineage venues${this.deps.contact ? `; mailto:${this.deps.contact}` : ""})`,
        },
        body: `query=${encodeURIComponent(q)}`,
        timeoutMs: 60_000,
      });
      if (resp.status !== 200) {
        this.stats.failed += 1;
        if (resp.status === 429 || resp.status >= 500 || resp.status === 403) {
          this.stats.blocked = true;
          this.deps.logger?.warn(
            `dblp: SPARQL answered ${resp.status}; no more DBLP queries this run`,
          );
        }
        return null;
      }
      return await resp.json();
    } catch (exc) {
      this.stats.failed += 1;
      this.deps.logger?.warn(`dblp: SPARQL failed: ${String(exc)}`);
      return null;
    }
  }

  /**
   * Replace the venue of every node shown as a preprint for which DBLP has
   * a venue record (mutates `nodes`; recomputes `venue_tier`). Returns
   * the number of nodes corrected.
   */
  async correctVenues(nodes: Map<string, ThemeGraphNode> | ThemeGraphNode[]): Promise<number> {
    const list = Array.isArray(nodes) ? nodes : [...nodes.values()];
    const todo: ThemeGraphNode[] = [];
    for (const n of list) {
      if (!isPreprintVenue(n.venue) || !normTitle(n.title)) continue;
      this.stats.candidates += 1;
      const cached = this.entries[n.id];
      if (cached && this.fresh(cached)) {
        this.stats.cacheHits += 1;
        continue;
      }
      todo.push(n);
    }
    for (let i = 0; i < todo.length; i += DBLP_BATCH) {
      const batch = todo.slice(i, i + DBLP_BATCH);
      const dois = new Set<string>();
      for (const n of batch) {
        const ids = identifiersOf(n as unknown as Record<string, unknown>);
        if (ids.doi) {
          // DBLP keeps the publisher's DOI case (10.1109/INFOCOM…).
          dois.add(ids.doi);
          dois.add(ids.doi.toUpperCase());
          if (typeof n.doi === "string")
            dois.add(n.doi.replace(/^https?:\/\/(dx\.)?doi\.org\//i, ""));
        }
        if (ids.arxiv) {
          dois.add(`10.48550/arXiv.${ids.arxiv}`);
          dois.add(`10.48550/ARXIV.${ids.arxiv}`);
        }
      }
      const titles = new Set<string>();
      for (const n of batch) {
        const t = String(n.title).replace(/\s+/g, " ").trim();
        titles.add(t.endsWith(".") ? t : `${t}.`);
        titles.add(t.replace(/\.$/, ""));
      }
      if (dois.size > 0) {
        const byDoi = await this.query(doiQuery([...dois]));
        if (byDoi === null && this.stats.blocked) break;
        for (const b of bindingsOf(byDoi)) if (b.title?.value) titles.add(b.title.value);
      }
      const body = await this.query(titleQuery([...titles]));
      if (body === null) break; // budget / failure: leave the rest unchecked
      const records = parseTitleRecords(body);
      const at = isoZ(this.now());
      for (const n of batch) {
        const rec = pickVenue(n, records);
        this.entries[n.id] = {
          fetched_at: at,
          venue: rec?.venue ?? null,
          year: rec?.year ?? null,
          key: rec?.key ?? null,
        };
        this.dirty.add(n.id);
      }
    }
    let corrected = 0;
    for (const n of list) {
      if (!isPreprintVenue(n.venue)) continue;
      const e = this.entries[n.id];
      if (!e || !e.venue || !this.fresh(e)) continue;
      n.venue = e.venue;
      n.venue_tier = venueTierFor(e.venue);
      corrected += 1;
    }
    this.stats.corrected += corrected;
    return corrected;
  }

  flush(): number {
    if (this.cachePath === null || this.dirty.size === 0) return 0;
    if (!existsSync(dirname(this.cachePath))) return 0;
    const onDisk = readDblpCache(this.cachePath);
    for (const k of this.dirty) onDisk[k] = this.entries[k] as DblpVenueEntry;
    for (const [k, e] of Object.entries(onDisk)) if (!this.fresh(e)) delete onDisk[k];
    atomicWriteText(this.cachePath, serializeDblpCache(onDisk));
    const n = this.dirty.size;
    this.dirty.clear();
    return n;
  }

  summary(): string {
    const s = this.stats;
    return (
      `dblp venues summary: preprint-venue nodes=${s.candidates} (cache hits ${s.cacheHits}), ` +
      `queries=${s.queries}/${this.deps.maxQueries ?? DBLP_DEFAULT_MAX_QUERIES} (failed ${s.failed}, ` +
      `budget skips ${s.budgetSkips}${s.blocked ? ", BLOCKED" : ""}), venues corrected=${s.corrected}`
    );
  }
}
