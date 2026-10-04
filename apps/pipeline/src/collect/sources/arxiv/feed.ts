/**
 * Strict Atom feed parsing for the arXiv API — TS port of the detection half
 * of `paperpilot/utils/arxiv_feed.py` plus the entry-building half of the
 * (Python-only) `arxiv` package's `_feed.py`, combined into one module
 * because there is no Node arXiv client to wrap: this IS the client's
 * parser (design doc §6.1: "arXiv は公式の Node クライアントがないため Atom
 * を自前で取得・解析する").
 *
 * Covers COL-01..04 (docs/migration/safety-contracts.md):
 *   - COL-02/03: a 200 body is rejected as non-feed unless it is valid XML,
 *     Atom-feed-rooted, carries `opensearch:totalResults`, and (when that
 *     total is nonzero) carries at least one `<entry>` whenever `startIndex`
 *     is still inside the claimed total (a page truly past the end of the
 *     result set is legitimately empty, not lost).
 *   - COL-01/06: within an otherwise well-formed feed, an `<entry>` missing
 *     `<id>`, `<updated>`, or `<published>` is counted as *skipped* rather
 *     than silently dropped or silently kept with missing fields — mirrors
 *     `arxiv._feed._build_result`'s `Skipping entry ...` behaviour, but as a
 *     per-page count this module hands back instead of a side-channel log
 *     line a caller has to go watch for (the Python library's "watch a
 *     logger" approach COL-01's `MalformedFeedWatch` exists to work around
 *     is unnecessary once we own the parser).
 *   - COL-04 applies at the caller (`arxiv.ts`): this module is stateless
 *     and per-call, so there is no cross-call "flag" to clear on a good
 *     retry — the caller already only ever looks at the LAST page fetched
 *     for a given offset, which is the same end state COL-04's per-URL
 *     clearing achieves, by construction rather than by bookkeeping.
 *
 * INTENTIONAL SIMPLIFICATION vs. the Python detector: namespace prefixes
 * (`opensearch:`, `arxiv:`) are matched LITERALLY rather than resolved via
 * their `xmlns:*` declaration URIs (which is how `lxml` + explicit `{uri}tag`
 * matching works in `arxiv_feed.py`/`_feed.py`). Every real arXiv API
 * response and every fixture in the ported test suite declares exactly
 * `xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/"` and
 * `xmlns:arxiv="http://arxiv.org/schemas/atom"`, so literal-prefix matching
 * is observably identical for every input this module is ever fed. The
 * Atom *root* element IS checked by namespace URI (`xmlns="...Atom..."`),
 * since that is the one check a throttle/error page could otherwise forge
 * by coincidentally using the literal tag name `feed`.
 */

import { XMLParser, XMLValidator } from "fast-xml-parser";

const ATOM_NS = "http://www.w3.org/2005/Atom";
const SNIPPET_LIMIT = 80;

const ARRAY_TAGS = new Set(["entry", "author", "link", "category", "arxiv:affiliation"]);

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
  removeNSPrefix: false,
  isArray: (name: string) => ARRAY_TAGS.has(name),
});

function snippet(body: string): string {
  return JSON.stringify(body.slice(0, SNIPPET_LIMIT));
}

export interface ArxivFeedLink {
  href: string;
  title: string | null;
  rel: string;
  contentType: string | null;
}

export interface ArxivFeedAuthor {
  name: string;
  affiliations: string[];
}

export interface ArxivFeedEntry {
  entryId: string;
  /** ISO `YYYY-MM-DD`, UTC — the day component of `<published>`. */
  publishedDate: string;
  title: string;
  authors: ArxivFeedAuthor[];
  summary: string;
  comment: string | null;
  journalRef: string | null;
  doi: string | null;
  primaryCategory: string;
  categories: string[];
  pdfUrl: string | null;
}

export interface ArxivFeedPage {
  ok: true;
  totalResults: number;
  itemsPerPage: number;
  startIndex: number;
  entries: ArxivFeedEntry[];
  /** One reason string per entry this page dropped (COL-01/06). */
  skipped: string[];
}

export interface ArxivFeedBodyError {
  ok: false;
  /** Always prefixed `"non-feed 200 response body: "`, matching the Python hook's wrapping. */
  reason: string;
}

export type ArxivFeedResult = ArxivFeedPage | ArxivFeedBodyError;

function collapseWhitespace(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/** `datetime.fromisoformat` after `Z` -> `+00:00`, with a naive timestamp assumed UTC (matches the installed `arxiv` package's `_parse_datetime`). */
function parseAtomDateTime(raw: string): Date | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const hasZone = /(?:[zZ]|[+-]\d{2}:?\d{2})$/.test(trimmed);
  const withZone = hasZone ? trimmed : `${trimmed}Z`;
  const d = new Date(withZone);
  return Number.isNaN(d.getTime()) ? null : d;
}

function toUtcDateString(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function asString(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function opensearchInt(feed: Record<string, unknown>, key: string): number {
  const raw = feed[key];
  if (typeof raw !== "string") return 0;
  const n = Number.parseInt(raw.trim(), 10);
  return Number.isNaN(n) ? 0 : n;
}

function asArray<T>(v: T | T[] | undefined): T[] {
  if (v === undefined) return [];
  return Array.isArray(v) ? v : [v];
}

function buildEntry(
  raw: Record<string, unknown>,
): { entry: ArxivFeedEntry } | { skipReason: string } {
  const id = asString(raw["id"]);
  if (!id) return { skipReason: "Skipping entry without <id>" };

  const updatedRaw = asString(raw["updated"]);
  const publishedRaw = asString(raw["published"]);
  const updated = updatedRaw ? parseAtomDateTime(updatedRaw) : null;
  const published = publishedRaw ? parseAtomDateTime(publishedRaw) : null;
  if (!updated || !published) {
    const missing = !updated ? "updated" : "published";
    return { skipReason: `Skipping entry ${id} missing <${missing}>` };
  }

  const title = collapseWhitespace(asString(raw["title"]) ?? "");
  const summary = asString(raw["summary"]) ?? "";

  const authors: ArxivFeedAuthor[] = asArray(
    raw["author"] as Record<string, unknown> | Record<string, unknown>[] | undefined,
  ).map((a) => {
    const affRaw = asArray(a["arxiv:affiliation"] as string | string[] | undefined);
    return {
      name: asString(a["name"]) ?? "",
      affiliations: affRaw.filter((x): x is string => typeof x === "string"),
    };
  });

  const linkEntries = asArray(
    raw["link"] as Record<string, unknown> | Record<string, unknown>[] | undefined,
  );
  const links: ArxivFeedLink[] = [];
  for (const l of linkEntries) {
    const href = asString(l["@_href"]);
    if (!href) continue;
    links.push({
      href,
      title: asString(l["@_title"]),
      rel: asString(l["@_rel"]) ?? "",
      contentType: asString(l["@_type"]),
    });
  }
  const pdfUrl = links.find((l) => l.title === "pdf")?.href ?? null;

  const categories = asArray(
    raw["category"] as Record<string, unknown> | Record<string, unknown>[] | undefined,
  )
    .map((c) => asString(c["@_term"]))
    .filter((t): t is string => t !== null);

  const primaryCategoryRaw = raw["arxiv:primary_category"] as Record<string, unknown> | undefined;
  const primaryCategory = (primaryCategoryRaw && asString(primaryCategoryRaw["@_term"])) || "";

  const entry: ArxivFeedEntry = {
    entryId: id,
    publishedDate: toUtcDateString(published),
    title,
    authors,
    summary,
    comment: asString(raw["arxiv:comment"]),
    journalRef: asString(raw["arxiv:journal_ref"]),
    doi: asString(raw["arxiv:doi"]),
    primaryCategory,
    categories,
    pdfUrl,
  };
  return { entry };
}

/**
 * Parse one arXiv API response body. `null`-equivalent-free: always
 * returns a discriminated result, never throws (a body this parser cannot
 * even validate as XML is reported via `{ ok: false, reason }`, same as a
 * structurally wrong one).
 */
export function parseArxivFeed(body: string): ArxivFeedResult {
  const validation = XMLValidator.validate(body);
  if (validation !== true) {
    return {
      ok: false,
      reason: `non-feed 200 response body: not valid XML (${validation.err.msg}): ${snippet(body)}`,
    };
  }

  let parsed: unknown;
  try {
    parsed = parser.parse(body);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      ok: false,
      reason: `non-feed 200 response body: not valid XML (${msg}): ${snippet(body)}`,
    };
  }

  const root = parsed as Record<string, unknown>;
  const feed = root["feed"];
  if (!feed || typeof feed !== "object" || Array.isArray(feed)) {
    const rootTag = Object.keys(root).find((k) => k !== "?xml");
    return {
      ok: false,
      reason: rootTag
        ? `non-feed 200 response body: unexpected root element ${JSON.stringify(rootTag)} (not an Atom feed): ${snippet(body)}`
        : `non-feed 200 response body: empty document: ${snippet(body)}`,
    };
  }
  const feedObj = feed as Record<string, unknown>;
  if (feedObj["@_xmlns"] !== ATOM_NS) {
    return {
      ok: false,
      reason: `non-feed 200 response body: unexpected root element "feed" (not an Atom feed, xmlns=${JSON.stringify(
        feedObj["@_xmlns"] ?? null,
      )}): ${snippet(body)}`,
    };
  }
  if (feedObj["opensearch:totalResults"] === undefined) {
    return {
      ok: false,
      reason: `non-feed 200 response body: Atom feed missing opensearch:totalResults: ${snippet(body)}`,
    };
  }

  const totalResults = opensearchInt(feedObj, "opensearch:totalResults");
  const itemsPerPage = opensearchInt(feedObj, "opensearch:itemsPerPage");
  const startIndex = opensearchInt(feedObj, "opensearch:startIndex");

  const rawEntries = asArray(
    feedObj["entry"] as Record<string, unknown> | Record<string, unknown>[] | undefined,
  );

  if (totalResults > 0 && rawEntries.length === 0 && startIndex < totalResults) {
    return {
      ok: false,
      reason:
        `non-feed 200 response body: Atom feed claims totalResults=${totalResults} but this page has zero ` +
        `<entry> elements (startIndex=${startIndex}): ${snippet(body)}`,
    };
  }

  const entries: ArxivFeedEntry[] = [];
  const skipped: string[] = [];
  for (const raw of rawEntries) {
    const built = buildEntry(raw);
    if ("entry" in built) entries.push(built.entry);
    else skipped.push(built.skipReason);
  }

  return { ok: true, totalResults, itemsPerPage, startIndex, entries, skipped };
}
