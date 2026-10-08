/**
 * OpenAlex `Work` → S2-shape paper dict conversion — TS port of the
 * OpenAlex-helper section of `paperpilot/scripts/build_theme_lineage.py`
 * (`_decode_abstract_inverted_index`, `_openalex_short_id`,
 * `_arxiv_id_from_work`, `_work_to_paper_dict`, `_trustworthy_year`,
 * `_extract_doi`), plus the two small shared predicates it leans on
 * (`paperpilot/utils/payload.py::openalex_short_id`,
 * `paperpilot/utils/unarxive.py::_normalise_arxiv_id`) — neither of those
 * two is ported elsewhere in the repo yet, so they live here, scoped to
 * this module's needs, rather than as a `packages/core` promotion (the
 * identity helpers this module DOES share, `ARXIV_MODERN_PATTERN` /
 * `isArxivHost`, were promoted to `@paperpilot/core/identity` per
 * docs/migration/p4-followups.md #1/#2/#9/#20).
 *
 * Safety contracts: LIN-20 (partial-chunk OpenAlex fetch failures do not
 * cache — see `fetchOpenAlexWorksByIds.ts`), LIN-22 (DataCite DOI must
 * not be promoted to an identity-bearing arXiv alias unless the caller
 * explicitly opts in via `allowDataciteDoi`).
 */

import { ARXIV_MODERN_PATTERN, isArxivHost } from "@paperpilot/core/identity";

// ---- openalex_short_id (utils/payload.py) ----

const OPENALEX_SHORT_ID_RE = /^W[0-9]+$/;
const OPENALEX_ID_URL_RE = /^https?:\/\/(?:api\.)?openalex\.org\/(?:works\/)?(W[0-9]+)\/?$/;

/** `https://openalex.org/W123` or `W123` -> `"W123"`, else `null`.
 *
 * The host is part of the identity: the last path segment of any URL is
 * NOT accepted, so a spoofed host (`https://evil.example/W123`) is
 * rejected rather than silently normalized to a real OpenAlex id. */
export function openalexShortId(value: unknown): string | null {
  if (typeof value !== "string" || !value) return null;
  const candidate = value.trim();
  if (OPENALEX_SHORT_ID_RE.test(candidate)) return candidate;
  const match = OPENALEX_ID_URL_RE.exec(candidate);
  return match ? (match[1] ?? null) : null;
}

// ---- _normalise_arxiv_id (utils/unarxive.py) ----

const DOI_HOSTS: ReadonlySet<string> = new Set(["doi.org", "dx.doi.org", "www.doi.org"]);
const ARXIV_BARE_RE = new RegExp(`^(${ARXIV_MODERN_PATTERN})(?:v\\d+)?$`);
const ARXIV_URL_PATH_RE = new RegExp(
  `^/(?:abs|pdf)/(${ARXIV_MODERN_PATTERN})(?:v\\d+)?(?:\\.pdf)?/?$`,
  "i",
);
const ARXIV_DATACITE_DOI_RE = new RegExp(
  `^10\\.48550/arxiv\\.(${ARXIV_MODERN_PATTERN})(?:v\\d+)?$`,
  "i",
);

/** Minimal `urlsplit`-equivalent for the one thing this module needs:
 * scheme, host (lowercased), path, and whether query/userinfo/port are
 * present. Returns `null` for anything that is not a parseable
 * `scheme://...` URL (mirroring Python catching `ValueError` from
 * `.port` on a malformed authority). */
function splitUrlForArxiv(
  raw: string,
): { host: string; path: string; hasQueryOrAuthExtras: boolean } | null {
  try {
    const u = new URL(raw);
    const hasQueryOrAuthExtras = u.search !== "" || u.username !== "" || u.password !== "";
    return { host: u.hostname.toLowerCase(), path: u.pathname, hasQueryOrAuthExtras };
  } catch {
    return null;
  }
}

/** Return the bare `year.serial` arXiv id from any of the forms
 * PaperPilot encounters, stripping any version suffix (`v2`):
 *
 *  - bare modern id: `2010.11929` (with optional `v3`)
 *  - `arXiv:2010.11929` prefix some callers attach
 *  - arXiv URL: `https://arxiv.org/abs/<id>` or `.../pdf/<id>`
 *  - DataCite arXiv DOI: `10.48550/arXiv.<id>` (also as a
 *    `https://doi.org/...` URL)
 *
 * Returns `null` for genuinely non-arXiv input. */
export function normaliseArxivId(value: unknown): string | null {
  if (typeof value !== "string" || !value) return null;
  const bare = value.trim();
  if (bare.includes("://")) {
    const split = splitUrlForArxiv(bare);
    if (split === null || split.hasQueryOrAuthExtras) return null;
    const { host, path } = split;
    let match: RegExpExecArray | null;
    if (isArxivHost(host)) {
      match = ARXIV_URL_PATH_RE.exec(path);
    } else if (DOI_HOSTS.has(host)) {
      match = ARXIV_DATACITE_DOI_RE.exec(path.replace(/^\/+/, ""));
    } else {
      return null;
    }
    return match ? (match[1] ?? null) : null;
  }
  const doiMatch = ARXIV_DATACITE_DOI_RE.exec(bare);
  if (doiMatch) return doiMatch[1] ?? null;
  let rest = bare;
  if (rest.toLowerCase().startsWith("arxiv:")) {
    rest = rest.slice("arxiv:".length);
  }
  const match = ARXIV_BARE_RE.exec(rest);
  return match ? (match[1] ?? null) : null;
}

// ---- _decode_abstract_inverted_index ----

/** Upper bound on the reconstructed abstract length, in words. */
const ABSTRACT_MAX_POSITION = 20_000;

/** Reconstruct an abstract from OpenAlex's `abstract_inverted_index`
 * (`{word: [positions, ...]}`). Returns `""` when the input is missing,
 * malformed, or yields no positions. */
export function decodeAbstractInvertedIndex(inverted: unknown): string {
  if (inverted === null || typeof inverted !== "object" || Array.isArray(inverted)) return "";
  const byPosition = new Map<number, string>();
  for (const [word, positions] of Object.entries(inverted as Record<string, unknown>)) {
    if (typeof word !== "string" || !Array.isArray(positions)) continue;
    for (const pos of positions) {
      if (typeof pos === "number" && Number.isInteger(pos) && pos >= 0) {
        byPosition.set(pos, word);
      }
    }
  }
  if (byPosition.size === 0) return "";
  const maxPos = Math.min(Math.max(...byPosition.keys()), ABSTRACT_MAX_POSITION);
  const out: string[] = [];
  for (let i = 0; i <= maxPos; i++) {
    out.push(byPosition.get(i) ?? "");
  }
  return out.join(" ").trim();
}

// ---- _trustworthy_year ----

/** OpenAlex `publication_year` corruption guard (#273): fall back to
 * `created_date`'s year only when `publication_year` is at least this
 * many years AHEAD of it (a one-way guard — see Python docstring). */
const PUBLICATION_YEAR_DRIFT_THRESHOLD = 3;

export function trustworthyYear(work: Record<string, unknown>): number | null {
  const pubYear = work.publication_year;
  if (typeof pubYear !== "number" || !Number.isInteger(pubYear)) {
    return pubYear === null || pubYear === undefined ? null : null;
  }
  const createdDate = typeof work.created_date === "string" ? work.created_date : "";
  if (createdDate.length < 4) return pubYear;
  const createdPrefix = createdDate.slice(0, 4);
  if (!/^\d{4}$/.test(createdPrefix)) return pubYear;
  const createdYear = Number.parseInt(createdPrefix, 10);
  if (pubYear - createdYear >= PUBLICATION_YEAR_DRIFT_THRESHOLD) {
    return createdYear;
  }
  return pubYear;
}

// ---- _extract_doi ----

/** Minimal `urlparse`-equivalent sufficient for `_extract_doi`: splits a
 * `scheme://netloc/path` prefix off `raw` when present (never throws —
 * a bare DOI like `"10.1234/x"` has no `scheme://` and passes through
 * with `scheme=""`, matching Python's lenient `urlparse`). */
function parseSchemeNetlocPath(raw: string): { scheme: string; netloc: string; path: string } {
  const match = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/([^/]*)(\/.*)?$/.exec(raw);
  if (!match) return { scheme: "", netloc: "", path: raw };
  return { scheme: match[1] ?? "", netloc: match[2] ?? "", path: match[3] ?? "" };
}

const DOI_URL_HOSTS: ReadonlySet<string> = new Set(["doi.org", "www.doi.org", "dx.doi.org"]);

/** Pull the bare DOI (no URL prefix) out of an OpenAlex Work dict. */
export function extractDoi(work: Record<string, unknown>): string | null {
  const raw0 = work.doi ?? (work.ids as Record<string, unknown> | undefined)?.doi;
  if (typeof raw0 !== "string") return null;
  const raw = raw0.trim();
  if (!raw) return null;
  const parsed = parseSchemeNetlocPath(raw);
  const bare =
    parsed.scheme && DOI_URL_HOSTS.has(parsed.netloc.toLowerCase())
      ? parsed.path.replace(/^\/+/, "")
      : raw;
  const trimmed = bare.trim();
  return trimmed || null;
}

// ---- _arxiv_id_from_work ----

/** Routing prefix that marks a paper dict whose `paperId` came from
 * OpenAlex rather than S2 (`fetch_related`/BFS dispatches on it). */
export const OPENALEX_PAPER_ID_PREFIX = "openalex:";

type WorkLocation = { landing_page_url?: unknown; pdf_url?: unknown };

/** Recover the citing/cited paper's bare arXiv id from an OpenAlex Work.
 *
 * Candidate order (cheapest / most authoritative first): `ids.arxiv_id`,
 * the primary location's URLs, every secondary location's URLs, and
 * (only when `allowDataciteDoi`) `ids.doi` / top-level `doi` (the
 * DataCite arXiv DOI form — NOT a strong identity declaration; identity
 * callers must pass `allowDataciteDoi: false`, per LIN-22). */
export function arxivIdFromWork(
  work: unknown,
  options?: { allowDataciteDoi?: boolean },
): string | null {
  const allowDataciteDoi = options?.allowDataciteDoi ?? true;
  if (work === null || typeof work !== "object" || Array.isArray(work)) return null;
  const w = work as Record<string, unknown>;

  const candidates: unknown[] = [];
  const ids = (
    w.ids && typeof w.ids === "object" ? (w.ids as Record<string, unknown>) : {}
  ) as Record<string, unknown>;
  candidates.push(ids.arxiv_id);
  const primary = w.primary_location;
  if (primary !== null && typeof primary === "object") {
    const p = primary as WorkLocation;
    candidates.push(p.landing_page_url);
    candidates.push(p.pdf_url);
  }
  const locations = w.locations;
  if (Array.isArray(locations)) {
    for (const loc of locations) {
      if (loc !== null && typeof loc === "object") {
        const l = loc as WorkLocation;
        candidates.push(l.landing_page_url);
        candidates.push(l.pdf_url);
      }
    }
  }
  if (allowDataciteDoi) {
    candidates.push(ids.doi);
    candidates.push(w.doi);
  }

  for (const candidate of candidates) {
    if (typeof candidate !== "string") continue;
    const arxivId = normaliseArxivId(candidate);
    if (arxivId) return arxivId;
  }
  return null;
}

// ---- _work_to_paper_dict ----

export interface ThemePaperAuthor {
  name: string;
}

/** The S2-shape paper dict every downstream theme-pipeline function
 * consumes (seed filters, seed scoring, BFS via `fetch_related`). */
export interface ThemePaper {
  paperId: string;
  title: string;
  year: number | null;
  venue: string;
  citationCount: number;
  abstract: string;
  authors: ThemePaperAuthor[];
  externalIds: Record<string, string>;
  // Fields populated later by BFS edge construction, not by seed discovery.
  _intents?: string[] | null;
  _contexts?: unknown[];
  _is_influential?: boolean | null;
  seed_paper_id?: string;
  [extra: string]: unknown;
}

/** Convert an OpenAlex `/works` payload to an S2-shape paper dict.
 *
 * Returns `null` when the Work is missing an OpenAlex id, has no title,
 * or is otherwise unusable — callers filter `null` out. */
export function workToPaperDict(work: Record<string, unknown>): ThemePaper | null {
  const short = openalexShortId(work.id ?? "");
  if (!short) return null;
  const title =
    (work.title as string | undefined) || (work.display_name as string | undefined) || "";
  if (!title) return null;

  const doi = extractDoi(work) || "";
  const externalIds: Record<string, string> = { OpenAlex: short };
  if (doi) externalIds.DOI = doi;

  const idsBlock = (work.ids && typeof work.ids === "object" ? work.ids : {}) as Record<
    string,
    unknown
  >;
  const arxivId = arxivIdFromWork(work, { allowDataciteDoi: false });
  if (arxivId) externalIds.ArXiv = arxivId;
  for (const [kOa, kOut] of [
    ["mag", "MAG"],
    ["pmid", "PMID"],
  ] as const) {
    const v = idsBlock[kOa];
    if (typeof v === "string" && v.trim()) externalIds[kOut] = v.trim();
  }

  const abstract = decodeAbstractInvertedIndex(work.abstract_inverted_index);
  const primaryLocation = (
    work.primary_location && typeof work.primary_location === "object" ? work.primary_location : {}
  ) as Record<string, unknown>;
  const source = (
    primaryLocation.source && typeof primaryLocation.source === "object"
      ? primaryLocation.source
      : {}
  ) as Record<string, unknown>;
  const venue = (source.display_name as string | undefined) || "";

  const authors: ThemePaperAuthor[] = [];
  const authorships = Array.isArray(work.authorships) ? work.authorships : [];
  for (const authorship of authorships) {
    if (authorship === null || typeof authorship !== "object") continue;
    const author = (authorship as Record<string, unknown>).author;
    const authorObj = (author && typeof author === "object" ? author : {}) as Record<
      string,
      unknown
    >;
    const name = authorObj.display_name;
    if (typeof name === "string" && name.trim()) authors.push({ name: name.trim() });
  }

  return {
    paperId: `${OPENALEX_PAPER_ID_PREFIX}${short}`,
    title,
    year: trustworthyYear(work),
    venue,
    citationCount: Number(work.cited_by_count) || 0,
    abstract,
    authors,
    externalIds,
  };
}
