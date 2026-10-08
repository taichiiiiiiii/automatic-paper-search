/**
 * Pure port of docs/assets/search.js's dependency-free core (the part it
 * calls `PaperPilotSearchCore` and exposes on `window` for its own
 * contract tests -- see paperpilot/tests/viewer/test_search_v2.mjs).
 *
 * Everything here is a pure function over plain data: no `document`,
 * `window`, or `fetch`. DOM-facing state (debounce timers, the listbox,
 * `history.pushState`) lives in components/search/*; URL-facing helpers
 * here take/return `URLSearchParams` or path strings so they stay
 * testable without a browser (see SCR-03..SCR-07 in
 * docs/migration/safety-contracts.md).
 */

export const MIN_QUERY = 2;
export const PAGE_SIZE = 20;
export const BLOCK_SIZE = 256;
export const ID_BLOCK_ROOT = "search-paper-ids-v1/";

const TITLE = 0;
const CONFERENCE = 1;
const PAPER_REF = 2;
const AUTHORS = 3;
const TAGS = 4;
const YEAR = 5;
const PAPER_TYPE = 6;

const CONFERENCE_RE = /^[a-z0-9][a-z0-9-]*$/;
export const PAPER_ID_RE = /^[0-9a-f]{40}$/;

/** [title, conferenceSlug, paperRef(=ordinal), authors, tags, year|null, type] */
export type SearchRow = [
  string,
  string,
  number,
  string[],
  string[],
  number | null,
  "Oral" | "Poster",
];

export type MatchKind = "exact-title" | "title" | "author" | "tag";

export const MATCH_LABELS: Record<MatchKind, string> = Object.freeze({
  "exact-title": "タイトル完全一致",
  title: "タイトル一致",
  author: "著者一致",
  tag: "タグ一致",
});

export interface Filters {
  conference: string;
  year: number | null;
  type: string;
  invalid: boolean;
}

export const EMPTY_FILTERS: Filters = Object.freeze({
  conference: "",
  year: null,
  type: "",
  invalid: false,
});

export interface Hit {
  row: SearchRow;
  ordinal: number;
  rank: number;
  matchKind: MatchKind;
  matchLabel: string;
}

export interface ResolvedHit extends Hit {
  paperId: string;
}

export interface IdBlock {
  schema_version: "search-paper-ids-v1";
  block: number;
  start: number;
  paper_ids: string[];
}

export function normalizeText(value: unknown): string {
  return String(value).normalize("NFKC").toLocaleLowerCase("ja").replace(/\s+/gu, " ").trim();
}

function validateStringArray(value: unknown, field: string, ordinal: number): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new Error(`row ${ordinal}: ${field} must be a string array`);
  }
  return value;
}

/** Validates the whole index as one unit (SCR-05: one invalid row rejects
 * everything, never a partial render). Throws on the first violation. */
export function validateIndex(data: unknown): SearchRow[] {
  if (!Array.isArray(data)) throw new Error("search index must be an array");
  data.forEach((row: unknown, ordinal: number) => {
    if (!Array.isArray(row) || row.length !== 7) {
      throw new Error(`row ${ordinal}: expected exactly 7 fields`);
    }
    if (typeof row[TITLE] !== "string" || !row[TITLE].trim()) {
      throw new Error(`row ${ordinal}: title is required`);
    }
    if (typeof row[CONFERENCE] !== "string" || !CONFERENCE_RE.test(row[CONFERENCE])) {
      throw new Error(`row ${ordinal}: conference slug is invalid`);
    }
    if (!Number.isSafeInteger(row[PAPER_REF]) || row[PAPER_REF] !== ordinal) {
      throw new Error(`row ${ordinal}: paper_ref must equal its global ordinal`);
    }
    validateStringArray(row[AUTHORS], "authors", ordinal);
    validateStringArray(row[TAGS], "tags", ordinal);
    if (
      row[YEAR] !== null &&
      (!Number.isInteger(row[YEAR]) || (row[YEAR] as number) < 1900 || (row[YEAR] as number) > 2200)
    ) {
      throw new Error(`row ${ordinal}: year is invalid`);
    }
    if (row[PAPER_TYPE] !== "Oral" && row[PAPER_TYPE] !== "Poster") {
      throw new Error(`row ${ordinal}: paper type is invalid`);
    }
  });
  return data as SearchRow[];
}

/** Facets are a corpus predicate, not a ranking signal -- applied before
 * any match classification so ranking itself stays unchanged. */
export function rowMatchesFacets(row: SearchRow, filters?: Partial<Filters>): boolean {
  const selected = filters || {};
  return (
    (!selected.conference || row[CONFERENCE] === selected.conference) &&
    (selected.year === undefined || selected.year === null || row[YEAR] === selected.year) &&
    (!selected.type || row[PAPER_TYPE] === selected.type)
  );
}

export function rankResults(rows: SearchRow[], query: string, filters?: Partial<Filters>): Hit[] {
  const needle = normalizeText(query);
  if (!needle) return [];
  const hits: Hit[] = [];
  rows.forEach((row, ordinal) => {
    if (!rowMatchesFacets(row, filters)) return;
    const title = normalizeText(row[TITLE]);
    let rank = -1;
    let matchKind: MatchKind | "" = "";
    if (title === needle) {
      rank = 0;
      matchKind = "exact-title";
    } else if (title.includes(needle)) {
      rank = 1;
      matchKind = "title";
    } else if (row[AUTHORS].some((author) => normalizeText(author).includes(needle))) {
      rank = 2;
      matchKind = "author";
    } else if (row[TAGS].some((tag) => normalizeText(tag).includes(needle))) {
      rank = 3;
      matchKind = "tag";
    }
    if (rank >= 0 && matchKind) {
      hits.push({ row, ordinal, rank, matchKind, matchLabel: MATCH_LABELS[matchKind] });
    }
  });
  hits.sort((a, b) => {
    if (a.rank !== b.rank) return a.rank - b.rank;
    const aYear = a.row[YEAR] === null ? -Infinity : a.row[YEAR];
    const bYear = b.row[YEAR] === null ? -Infinity : b.row[YEAR];
    if (aYear !== bYear) return bYear - aYear;
    return a.ordinal - b.ordinal;
  });
  return hits;
}

export interface Page<T> {
  page: number;
  totalPages: number;
  items: T[];
}

export function paginate<T>(hits: T[], requestedPage: number | null, pageSize?: number): Page<T> {
  const size =
    Number.isSafeInteger(pageSize) && (pageSize as number) > 0 ? (pageSize as number) : PAGE_SIZE;
  const totalPages = Math.max(1, Math.ceil(hits.length / size));
  const parsed = Number.parseInt(String(requestedPage), 10);
  const page = Math.min(Math.max(Number.isSafeInteger(parsed) ? parsed : 1, 1), totalPages);
  const start = (page - 1) * size;
  return { page, totalPages, items: hits.slice(start, start + size) };
}

/** `paperRef` here is a *global row ordinal* (matching search.js's own
 * call sites: `blockFile(block * BLOCK_SIZE)`), not a block index. */
export function blockFile(paperRef: number): string {
  if (!Number.isSafeInteger(paperRef) || paperRef < 0) {
    throw new Error("paper_ref must be a non-negative integer");
  }
  const block = Math.floor(paperRef / BLOCK_SIZE);
  return `${ID_BLOCK_ROOT}${String(block).padStart(4, "0")}.json`;
}

export function validateIdBlock(data: unknown, expectedBlock: number, totalRows: number): IdBlock {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("paper ID block must be an object");
  }
  const rec = data as Record<string, unknown>;
  const keys = Object.keys(rec).sort();
  const expectedKeys = ["block", "paper_ids", "schema_version", "start"];
  if (keys.length !== expectedKeys.length || keys.some((key, i) => key !== expectedKeys[i])) {
    throw new Error("paper ID block has unexpected fields");
  }
  if (rec.schema_version !== "search-paper-ids-v1") {
    throw new Error("paper ID block schema_version is invalid");
  }
  if (rec.block !== expectedBlock || rec.start !== expectedBlock * BLOCK_SIZE) {
    throw new Error("paper ID block address does not match requested block");
  }
  const start = rec.start as number;
  const expectedLength = Math.min(BLOCK_SIZE, totalRows - start);
  const paperIds = rec.paper_ids;
  if (
    !Array.isArray(paperIds) ||
    expectedLength <= 0 ||
    paperIds.length !== expectedLength ||
    !paperIds.every((paperId) => typeof paperId === "string" && PAPER_ID_RE.test(paperId))
  ) {
    throw new Error("paper ID block contents are invalid");
  }
  return data as IdBlock;
}

export function confLabel(slug: string): string {
  const match = /^(.*)-(\d{4})$/.exec(slug);
  return match ? `${(match[1] ?? "").toUpperCase()} ${match[2]}` : slug.toUpperCase();
}

/** Percent-encodes both the conference slug and the paper id (SCR-04):
 * a hostile value cannot escape the href via an unencoded `/` or `&`. */
export function resultUrl(row: SearchRow, paperId: string): string {
  return `/${encodeURIComponent(row[CONFERENCE])}/?paper=${encodeURIComponent(paperId)}`;
}

/** Builds the `pathname + search + hash` for a query/page/filters triple,
 * relative to `currentHref`. Pure sibling of search.js's `searchUrl`
 * (which mutated `new URL(window.location.href)` in place). */
export function searchUrl(
  currentHref: string,
  query: string,
  page: number | null,
  filters: Filters,
): string {
  const url = new URL(currentHref);
  if (query) url.searchParams.set("q", query);
  else url.searchParams.delete("q");
  for (const name of ["conference", "year", "type"] as const) {
    url.searchParams.delete(name);
    const value = filters[name];
    if (value !== "" && value !== null) url.searchParams.set(name, String(value));
  }
  if (page === null) url.searchParams.delete("page");
  else url.searchParams.set("page", String(page));
  return `${url.pathname}${url.search}${url.hash}`;
}

export interface UniqueParam {
  value: string;
  invalid: boolean;
}

/** A repeated query-string key (e.g. `?conference=a&conference=b`) is
 * never silently resolved to the first value -- SCR-07. */
export function uniqueParam(params: URLSearchParams, name: string): UniqueParam {
  const values = params.getAll(name);
  return values.length <= 1
    ? { value: values[0] || "", invalid: false }
    : { value: "", invalid: true };
}

export function filtersFromUrl(params: URLSearchParams, rows: readonly SearchRow[]): Filters {
  const conference = uniqueParam(params, "conference");
  const year = uniqueParam(params, "year");
  const type = uniqueParam(params, "type");
  const conferenceValues = new Set(rows.map((row) => row[CONFERENCE]));
  const yearValues = new Set(
    rows.map((row) => row[YEAR]).filter((value): value is number => value !== null),
  );
  const typeValues: Set<string> = new Set(rows.map((row) => row[PAPER_TYPE]));
  const parsedYear = /^\d{4}$/.test(year.value) ? Number(year.value) : null;
  const invalid =
    conference.invalid ||
    year.invalid ||
    type.invalid ||
    Boolean(conference.value && !conferenceValues.has(conference.value)) ||
    Boolean(year.value && (parsedYear === null || !yearValues.has(parsedYear))) ||
    Boolean(type.value && !typeValues.has(type.value));
  return {
    conference: conferenceValues.has(conference.value) ? conference.value : "",
    year: parsedYear !== null && yearValues.has(parsedYear) ? parsedYear : null,
    type: typeValues.has(type.value) ? type.value : "",
    invalid,
  };
}

export function pageFromUrl(params: URLSearchParams): number | null {
  if (!params.has("page")) return null;
  const raw = params.get("page");
  if (!/^\d+$/.test(raw || "")) return 1;
  const page = Number(raw);
  return Number.isSafeInteger(page) && page > 0 ? page : 1;
}

/** Duplicate `q`/`page`/`conference`/`year`/`type` keys, or a malformed
 * `page`, must widen into the fail-closed "invalid filters" state rather
 * than silently picking one value (SCR-07). */
export function urlHasDuplicateSearchState(params: URLSearchParams): boolean {
  const duplicate = ["q", "page", "conference", "year", "type"].some(
    (name) => params.getAll(name).length > 1,
  );
  const rawPage = params.get("page");
  const parsedPage = Number(rawPage);
  const invalidPage =
    rawPage !== null &&
    (!/^\d+$/.test(rawPage) || !Number.isSafeInteger(parsedPage) || parsedPage < 1);
  return duplicate || invalidPage;
}
