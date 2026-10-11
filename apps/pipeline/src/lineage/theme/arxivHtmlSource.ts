/**
 * R2-28 (design 41, research 47 §2.1): fetch + cache side of the arXiv
 * HTML citation-context source (`./arxivHtml.ts` parses).
 *
 * Used only for pairs whose Semantic Scholar contexts are empty or missing
 * (`./s2Relations.ts::deriveS2Relation`), and only when enabled
 * (`PAPERPILOT_ARXIV_HTML=on`, default off; see `cli.ts`).
 *
 * Politeness (arXiv robots.txt: `Allow: /html`, `Crawl-delay: 15`;
 * `/e-print` and `/src` are disallowed and never requested):
 *  - one request at a time, >= {@link ARXIV_CRAWL_DELAY_MS} between the
 *    starts of two requests;
 *  - at most `maxFetches` pages per run (default
 *    {@link DEFAULT_MAX_FETCHES}: 40 x 15 s = 10 min of a 120-min theme job);
 *  - a 429 / 403 / 5xx stops fetching for the rest of the run (nothing is
 *    retried in a loop); the pair falls back to its S2-only result.
 *
 * Cache `data/state/lineage-cache/arxiv_html_contexts.json` (one line per
 * citing paper; only the pairs that were asked are stored, never the HTML):
 *
 *   { "schema_version": "arxiv-html-contexts-v1",
 *     "entries": {
 *       "<arXiv id, no version>": {
 *         "v": "v3" | null,               // rendered version, when stated
 *         "fetched_at": "2026-10-11T00:00:00Z",
 *         "ok": true | false,             // false = arXiv has no HTML (404)
 *         "pairs": { "<cited graph id>": {"b": "bib.bib30" | null, "c": [contexts]} } } } }
 *
 * `b: null` = no bib entry matched the cited paper. A pair the entry does
 * not hold refetches the page (within the run budget; the page is parsed
 * once per run). Entries expire after {@link HTML_TTL_DAYS} days
 * ({@link NO_HTML_TTL_DAYS} for "no HTML").
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import type { HeadersLike } from "../../collect/http/requestWithRetry.js";
import { atomicWriteText } from "../../collect/state/atomic.js";
import { type CitedRef, matchBibEntry, type ParsedArxivHtml, parseArxivHtml } from "./arxivHtml.js";
import { graphIdOf, identifiersOf } from "./s2Citations.js";

export const ARXIV_HTML_SCHEMA = "arxiv-html-contexts-v1";
export const ARXIV_HTML_FILENAME = "arxiv_html_contexts.json";
export const ARXIV_CRAWL_DELAY_MS = 15_000;
export const DEFAULT_MAX_FETCHES = 40;
export const HTML_TTL_DAYS = 180;
export const NO_HTML_TTL_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;
const ARXIV_HTML_BASE = "https://arxiv.org/html/";

export interface TextResponseLike {
  status: number;
  headers?: HeadersLike;
  text(): Promise<string>;
}

export type FetchTextLike = (
  url: string,
  init: { method: string; headers?: Record<string, string>; timeoutMs: number },
) => Promise<TextResponseLike>;

export interface ArxivHtmlDeps {
  fetchText: FetchTextLike;
  sleep: (ms: number) => Promise<void>;
  now?: () => Date;
  monotonicNow?: () => number;
  /** Contact e-mail for the User-Agent (arXiv asks bots to identify). */
  contact?: string | null;
  crawlDelayMs?: number;
  maxFetches?: number;
  logger?: { warn: (msg: string) => void };
}

export interface StoredHtmlPair {
  b: string | null;
  c: string[];
}

export interface HtmlEntry {
  v: string | null;
  fetched_at: string;
  ok: boolean;
  pairs: Record<string, StoredHtmlPair>;
}

export type HtmlContextResult =
  | { kind: "contexts"; contexts: string[]; arxiv: string; version: string | null; bib: string }
  | {
      kind: "none";
      reason: "no-html" | "no-bib-match" | "no-sentence" | "budget" | "blocked" | "fetch-failed";
    };

export interface ArxivHtmlStats {
  lookups: number;
  cacheHits: number;
  fetches: number;
  noHtml: number;
  failed: number;
  budgetSkips: number;
  blocked: boolean;
  matched: number;
  withContexts: number;
  /** Pairs whose HTML contexts produced a strong claim used on the edge. */
  strongEdges: number;
}

const ARXIV_NEW = /^\d{4}\.\d{4,5}$/;
const ARXIV_OLD = /^[a-z-]+(\.[A-Z]{2})?\/\d{7}$/;

export function isArxivId(id: string | null | undefined): id is string {
  return typeof id === "string" && (ARXIV_NEW.test(id) || ARXIV_OLD.test(id));
}

function isoZ(d: Date): string {
  return `${d.toISOString().slice(0, 19)}Z`;
}

function isEntry(x: unknown): x is HtmlEntry {
  if (x === null || typeof x !== "object" || Array.isArray(x)) return false;
  const e = x as Record<string, unknown>;
  return (
    (e.v === null || typeof e.v === "string") &&
    typeof e.fetched_at === "string" &&
    typeof e.ok === "boolean" &&
    e.pairs !== null &&
    typeof e.pairs === "object" &&
    !Array.isArray(e.pairs)
  );
}

export function readArxivHtmlCache(path: string | null): Record<string, HtmlEntry> {
  if (path === null || !existsSync(path)) return {};
  try {
    const raw = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
    if (raw.schema_version !== ARXIV_HTML_SCHEMA) return {};
    const out: Record<string, HtmlEntry> = {};
    for (const [k, v] of Object.entries((raw.entries ?? {}) as Record<string, unknown>)) {
      if (isEntry(v)) out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

/** One line per entry, keys sorted (small git diffs). */
export function serializeArxivHtmlCache(entries: Record<string, HtmlEntry>): string {
  const keys = Object.keys(entries).sort();
  const lines = keys.map((k, i) => {
    const e = entries[k] as HtmlEntry;
    const pairs = Object.fromEntries(
      Object.keys(e.pairs)
        .sort()
        .map((p) => [p, e.pairs[p]]),
    );
    const body = JSON.stringify({ v: e.v, fetched_at: e.fetched_at, ok: e.ok, pairs });
    return `    ${JSON.stringify(k)}: ${body}${i < keys.length - 1 ? "," : ""}`;
  });
  return (
    `{\n  "schema_version": ${JSON.stringify(ARXIV_HTML_SCHEMA)},\n  "entries": {\n` +
    `${lines.join("\n")}${lines.length ? "\n" : ""}  }\n}\n`
  );
}

/** The cited paper as {@link matchBibEntry} wants it. */
export function citedRefOf(cited: Record<string, unknown>): CitedRef {
  const ids = identifiersOf(cited);
  return {
    title: cited.title,
    authors: cited.authors,
    year: cited.year,
    arxiv: ids.arxiv,
    doi: ids.doi,
  };
}

export class ArxivHtmlContextSource {
  private readonly cachePath: string | null;
  private readonly deps: ArxivHtmlDeps;
  private readonly entries: Record<string, HtmlEntry>;
  private readonly dirty = new Set<string>();
  /** Pages parsed this run (null = fetch failed / no HTML this run). */
  private readonly memo = new Map<string, ParsedArxivHtml | null>();
  private lastRequestAt: number | null = null;
  readonly stats: ArxivHtmlStats = {
    lookups: 0,
    cacheHits: 0,
    fetches: 0,
    noHtml: 0,
    failed: 0,
    budgetSkips: 0,
    blocked: false,
    matched: 0,
    withContexts: 0,
    strongEdges: 0,
  };

  constructor(cachePath: string | null, deps: ArxivHtmlDeps) {
    this.cachePath = cachePath;
    this.deps = deps;
    this.entries = readArxivHtmlCache(cachePath);
  }

  private now(): Date {
    return this.deps.now ? this.deps.now() : new Date();
  }

  private fresh(e: HtmlEntry): boolean {
    const at = Date.parse(e.fetched_at);
    if (Number.isNaN(at)) return false;
    return this.now().getTime() - at < (e.ok ? HTML_TTL_DAYS : NO_HTML_TTL_DAYS) * DAY_MS;
  }

  /**
   * Contexts in which the arXiv paper `arxivId` (the citing paper) cites
   * `cited` (its graph id keys the stored pair).
   */
  async contexts(arxivId: string, cited: Record<string, unknown>): Promise<HtmlContextResult> {
    this.stats.lookups += 1;
    const id = arxivId.replace(/^arxiv:/i, "").replace(/v\d+$/, "");
    const citedKey = graphIdOf(cited);
    if (!isArxivId(id) || citedKey === null) return { kind: "none", reason: "no-html" };
    let entry = this.entries[id];
    if (entry && !this.fresh(entry)) entry = undefined;
    if (entry && !entry.ok) {
      this.stats.cacheHits += 1;
      return { kind: "none", reason: "no-html" };
    }
    if (entry && Object.hasOwn(entry.pairs, citedKey)) {
      this.stats.cacheHits += 1;
      return this.result(id, entry.v, entry.pairs[citedKey] as StoredHtmlPair);
    }
    const parsed = await this.page(id);
    if (typeof parsed === "string") return { kind: "none", reason: parsed };
    if (parsed === null) {
      return { kind: "none", reason: "no-html" };
    }
    const current = this.entries[id] as HtmlEntry;
    const match = matchBibEntry(parsed.bibs, citedRefOf(cited));
    const pair: StoredHtmlPair =
      match === null
        ? { b: null, c: [] }
        : { b: match.key, c: parsed.contexts.get(match.key) ?? [] };
    current.pairs[citedKey] = pair;
    this.dirty.add(id);
    return this.result(id, current.v, pair);
  }

  private result(id: string, v: string | null, pair: StoredHtmlPair): HtmlContextResult {
    if (pair.b === null) return { kind: "none", reason: "no-bib-match" };
    this.stats.matched += 1;
    if (pair.c.length === 0) return { kind: "none", reason: "no-sentence" };
    this.stats.withContexts += 1;
    return { kind: "contexts", contexts: [...pair.c], arxiv: id, version: v, bib: pair.b };
  }

  /** The parsed page (fetched at most once per run), `null` = no HTML. */
  private async page(
    id: string,
  ): Promise<ParsedArxivHtml | null | "budget" | "blocked" | "fetch-failed"> {
    if (this.memo.has(id)) return this.memo.get(id) ?? null;
    if (this.stats.blocked) return "blocked";
    const max = this.deps.maxFetches ?? DEFAULT_MAX_FETCHES;
    if (this.stats.fetches >= max) {
      this.stats.budgetSkips += 1;
      return "budget";
    }
    await this.pace();
    this.stats.fetches += 1;
    const ua = `PaperPilot/0.1 (theme lineage citation contexts${
      this.deps.contact ? `; mailto:${this.deps.contact}` : ""
    })`;
    let status: number;
    let html = "";
    try {
      const resp = await this.deps.fetchText(`${ARXIV_HTML_BASE}${id}`, {
        method: "GET",
        headers: { "User-Agent": ua, Accept: "text/html" },
        timeoutMs: 60_000,
      });
      status = resp.status;
      if (status === 200) html = await resp.text();
    } catch (exc) {
      this.stats.failed += 1;
      this.deps.logger?.warn(`arxiv html: ${id} failed: ${String(exc)}`);
      this.memo.set(id, null);
      return "fetch-failed";
    }
    if (status === 404 || status === 410) {
      this.stats.noHtml += 1;
      this.entries[id] = { v: null, fetched_at: isoZ(this.now()), ok: false, pairs: {} };
      this.dirty.add(id);
      this.memo.set(id, null);
      return null;
    }
    if (status !== 200) {
      this.stats.failed += 1;
      if (status === 429 || status === 403 || status >= 500) {
        // Be polite: stop for the rest of the run, never hammer.
        this.stats.blocked = true;
        this.deps.logger?.warn(
          `arxiv html: ${id} answered ${status}; no more arXiv requests this run`,
        );
        return "blocked";
      }
      this.memo.set(id, null);
      return "fetch-failed";
    }
    const parsed = parseArxivHtml(html, id);
    if (parsed.bibs.length === 0) {
      // A page without a LaTeXML bibliography (conversion failed): no HTML.
      this.stats.noHtml += 1;
      this.entries[id] = { v: parsed.version, fetched_at: isoZ(this.now()), ok: false, pairs: {} };
      this.dirty.add(id);
      this.memo.set(id, null);
      return null;
    }
    this.memo.set(id, parsed);
    const old = this.entries[id];
    this.entries[id] = {
      v: parsed.version,
      fetched_at: isoZ(this.now()),
      ok: true,
      // A new version invalidates the stored pairs.
      pairs: old && old.ok && old.v === parsed.version && this.fresh(old) ? old.pairs : {},
    };
    this.dirty.add(id);
    return parsed;
  }

  private async pace(): Promise<void> {
    const clock = this.deps.monotonicNow ?? Date.now;
    const delay = this.deps.crawlDelayMs ?? ARXIV_CRAWL_DELAY_MS;
    if (this.lastRequestAt !== null) {
      const wait = this.lastRequestAt + delay - clock();
      if (wait > 0) await this.deps.sleep(wait);
    }
    this.lastRequestAt = clock();
  }

  /** Merge this run's entries into the file on disk, drop expired ones,
   * write atomically. No-op without a cache path / directory. */
  flush(): number {
    if (this.cachePath === null || this.dirty.size === 0) return 0;
    if (!existsSync(dirname(this.cachePath))) return 0;
    const onDisk = readArxivHtmlCache(this.cachePath);
    for (const k of this.dirty) {
      const mine = this.entries[k] as HtmlEntry;
      const theirs = onDisk[k];
      onDisk[k] =
        theirs && theirs.ok && mine.ok && theirs.v === mine.v && this.fresh(theirs)
          ? { ...mine, pairs: { ...theirs.pairs, ...mine.pairs } }
          : mine;
    }
    for (const [k, e] of Object.entries(onDisk)) if (!this.fresh(e)) delete onDisk[k];
    atomicWriteText(this.cachePath, serializeArxivHtmlCache(onDisk));
    const n = this.dirty.size;
    this.dirty.clear();
    return n;
  }

  summary(): string {
    const s = this.stats;
    return (
      `arxiv html summary: lookups=${s.lookups} (cache hits ${s.cacheHits}), fetches=${s.fetches}/` +
      `${this.deps.maxFetches ?? DEFAULT_MAX_FETCHES} (no-html ${s.noHtml}, failed ${s.failed}, ` +
      `budget skips ${s.budgetSkips}${s.blocked ? ", BLOCKED" : ""}), bib matched=${s.matched}, ` +
      `with contexts=${s.withContexts}, strong edges from html=${s.strongEdges}`
    );
  }
}
