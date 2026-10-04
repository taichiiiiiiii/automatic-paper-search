/**
 * unarXive 2022 citation context lookup (S2-free) — TS port of the READ
 * side of `paperpilot/utils/unarxive.py`.
 *
 * FOLLOW-UP NEEDING APPROVAL (per the P4d brief): this repo's Node
 * toolchain has no installed DuckDB binding, and this task is under a
 * strict "no new deps" rule, so the actual DuckDB query execution is
 * NOT ported here. Instead, the read interface (`fetchContexts`/
 * `isAvailable`) is expressed behind an injected {@link UnarxiveAdapter},
 * and {@link UNAVAILABLE_ADAPTER} — the default — reproduces Python's own
 * graceful-degradation path exactly: `_open_readonly()` returns `None`
 * whenever the DuckDB file is absent OR the `duckdb` package isn't
 * installed, `fetch_contexts()` then returns `[]`, and `is_available()`
 * returns `False`. Nothing here regresses the "no crash, no warning
 * spam" guarantee the Python docstring calls out. A real adapter backed
 * by a DuckDB Node binding (e.g. `@duckdb/node-api`, which would need
 * explicit approval as a new dependency) can be substituted later without
 * changing this module's call sites — see `UnarxiveAdapter`.
 *
 * The id-normalization logic below (`normaliseArxivId`,
 * `normaliseOpenalexShort`) has no such gap and is a full, faithful port:
 * it has no C-extension dependency and is exercised by its own tests.
 */

import { isArxivHost } from "@paperpilot/core/identity";
import { openalexShortId } from "../theme/openalexWork.js";

const OPENALEX_URL_PREFIX = "https://openalex.org/";
const OPENALEX_PAPERID_PREFIX = "openalex:";

// unarXive stores the bare modern `year.serial` form; pre-2007
// `cs.LG/0512345` ids are outside its coverage and map to `null`.
const ARXIV_MODERN_PATTERN = "[0-9]{4}\\.[0-9]{4,5}";
const ARXIV_BARE_RE = new RegExp(`^(${ARXIV_MODERN_PATTERN})(?:v\\d+)?$`);
const ARXIV_URL_PATH_RE = new RegExp(
  `^/(?:abs|pdf)/(${ARXIV_MODERN_PATTERN})(?:v\\d+)?(?:\\.pdf)?/?$`,
  "i",
);
const ARXIV_DATACITE_DOI_RE = new RegExp(
  `^10\\.48550/arxiv\\.(${ARXIV_MODERN_PATTERN})(?:v\\d+)?$`,
  "i",
);
const DOI_HOSTS = new Set(["doi.org", "dx.doi.org", "www.doi.org"]);

/**
 * Bare `W12345` short ID from any of: the URL form
 * (`https://openalex.org/W12345`), the PaperPilot prefixed form
 * (`openalex:W12345`), or the bare short itself. `null` for inputs that
 * don't end in a `W`-prefixed identifier.
 */
export function normaliseOpenalexShort(value: string | null | undefined): string | null {
  if (typeof value !== "string" || !value) return null;
  let candidate = value.trim();
  if (candidate.startsWith(OPENALEX_URL_PREFIX)) {
    candidate = candidate.slice(OPENALEX_URL_PREFIX.length);
  } else if (candidate.startsWith(OPENALEX_PAPERID_PREFIX)) {
    candidate = candidate.slice(OPENALEX_PAPERID_PREFIX.length);
  }
  return openalexShortId(candidate);
}

/**
 * Bare `year.serial` arXiv id from any of the forms PaperPilot
 * encounters, stripping any version suffix (`v2`): bare modern id,
 * `arXiv:` prefix, an arXiv URL (`/abs/<id>` or `/pdf/<id>`), or a
 * DataCite arXiv DOI (`10.48550/arXiv.<id>`, bare or as a doi.org URL).
 * `null` for genuinely non-arXiv input.
 */
export function normaliseArxivId(value: string | null | undefined): string | null {
  if (typeof value !== "string" || !value) return null;
  let bare = value.trim();
  if (bare.includes("://")) {
    let url: URL;
    try {
      url = new URL(bare);
    } catch {
      return null;
    }
    if (url.search || url.username || url.password || url.port) return null;
    const host = url.hostname.toLowerCase();
    let match: RegExpMatchArray | null;
    if (isArxivHost(host)) {
      match = ARXIV_URL_PATH_RE.exec(url.pathname);
    } else if (DOI_HOSTS.has(host)) {
      match = ARXIV_DATACITE_DOI_RE.exec(url.pathname.replace(/^\/+/, ""));
    } else {
      return null;
    }
    return match ? match[1]! : null;
  }
  const doiMatch = ARXIV_DATACITE_DOI_RE.exec(bare);
  if (doiMatch) return doiMatch[1]!;
  if (bare.toLowerCase().startsWith("arxiv:")) {
    bare = bare.slice("arxiv:".length);
  }
  const match = ARXIV_BARE_RE.exec(bare);
  return match ? match[1]! : null;
}

/**
 * Injected backend for the actual DuckDB lookup. `query` returns the
 * matching `text` column values (already truncated upstream, per the
 * Python builder), or `null` if the backend cannot answer right now
 * (treated identically to "no match" by {@link fetchContexts} — this
 * module never throws out of a lookup).
 */
export interface UnarxiveAdapter {
  readonly available: boolean;
  query(args: { arxivId: string; openalexLabel: string; limit: number }): string[] | null;
}

/** The default adapter: DuckDB is never available in this Node port (see module doc comment). */
export const UNAVAILABLE_ADAPTER: UnarxiveAdapter = {
  available: false,
  query: () => null,
};

/** TS port of `is_available()`. */
export function isAvailable(adapter: UnarxiveAdapter = UNAVAILABLE_ADAPTER): boolean {
  return adapter.available;
}

/**
 * TS port of `fetch_contexts()`: paragraphs where the citing paper
 * (`childArxivId`) mentions the cited paper (`parentOpenalexId`) via
 * unarXive. Returns `[]` when either id is missing/unparseable, the
 * adapter is unavailable, or no matching context exists. Never throws.
 */
export function fetchContexts(
  args: { childArxivId: string | null | undefined; parentOpenalexId: string; limit?: number },
  adapter: UnarxiveAdapter = UNAVAILABLE_ADAPTER,
): string[] {
  const { childArxivId, parentOpenalexId, limit = 5 } = args;
  const arxivId = normaliseArxivId(childArxivId);
  const shortId = normaliseOpenalexShort(parentOpenalexId);
  if (!arxivId || !shortId) return [];
  if (!adapter.available) return [];
  const label = `${OPENALEX_URL_PREFIX}${shortId}`;
  let rows: string[] | null;
  try {
    rows = adapter.query({ arxivId, openalexLabel: label, limit });
  } catch {
    return [];
  }
  if (rows === null) return [];
  return rows.filter((text) => Boolean(text));
}
