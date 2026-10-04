/**
 * Typed fetch helpers for the published JSON data (design doc §P2 step 4:
 * pages fetch the same paths as today, at runtime, in the browser --
 * never embedded into the build). The actual files are copied from
 * `../../docs` into `public/` by scripts/copy-data.ts (prebuild); in dev
 * that script also runs via `predev`.
 *
 * Every helper returns a `DataResult<T>`, never throws, and never
 * silently treats an error as "no data" -- callers must branch on
 * `status` and render a distinct error state (never render an empty
 * list for what was actually a fetch/parse failure).
 *
 * Schema notes (see docs/design/39-typescript-cloudflare-migration.md §3):
 *   - `search-index-v2.json` has a real schema
 *     (schemas/search-index-v2.schema.json); `SearchIndexEntrySchema`
 *     below is a hand-written zod mirror of it. It is NOT generated and
 *     NOT validated against the JSON Schema by any test -- keep the two
 *     in sync by hand if either changes.
 *   - `@paperpilot/core`'s `validateArtifact` (ajv) is Node/fs-based: it
 *     reads `schemas/*.schema.json` from disk via `node:fs`, which does
 *     not exist in a browser bundle. It must stay build/Node-side (e.g.
 *     a future `apps/pipeline` parity check) and must never be imported
 *     from client-fetched code like this file.
 *   - `papers.json` / `conferences.json` have no schema at all (same
 *     design doc section). `ConferenceSummarySchema` / `PaperSchema`
 *     below are light, permissive (`.passthrough()`) zod shapes covering
 *     only the fields this app reads today; they are deliberately not a
 *     claim of the full/true shape.
 */
import { BASE_PATH, z } from "@paperpilot/core/site";

export type DataResult<T> = { status: "ok"; data: T } | { status: "error"; error: string };

function publicPath(path: string): string {
  if (!path.startsWith("/")) {
    throw new Error(`publicPath: path must start with "/", got ${JSON.stringify(path)}`);
  }
  return `${BASE_PATH}${path}`;
}

async function fetchJson(path: string): Promise<unknown> {
  // no-cache: revalidate every time, as the original viewers did, so a
  // freshly promoted catalog is never hidden behind a stale browser copy.
  const res = await fetch(publicPath(path), { cache: "no-cache" });
  if (!res.ok) {
    throw new Error(`fetch ${path} failed: HTTP ${res.status}`);
  }
  return res.json();
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ---------------------------------------------------------------------
// conferences.json
// ---------------------------------------------------------------------

export const ConferenceSummarySchema = z
  .object({
    name: z.string(),
    papers: z.number(),
    types: z.record(z.string(), z.number()),
    top_tags: z.array(z.tuple([z.string(), z.number()])),
    generated: z.string(),
  })
  .passthrough();
export type ConferenceSummary = z.infer<typeof ConferenceSummarySchema>;

/** Fetches /conferences.json (the catalog index: one summary row per
 * conference).
 *
 * Validates row-by-row (SCR-09's own filtering, extended from
 * landing.js's name/papers-only check to the full row shape): one row
 * with a malformed/unread field (e.g. a future schema change touching
 * `types`/`top_tags`) is dropped, not treated as a reason to reject the
 * whole file and blank out every conference on the landing page. Only a
 * non-array top-level response, an HTTP failure, or a fetch/parse
 * exception is a real `error` result. */
export async function fetchConferences(): Promise<DataResult<ConferenceSummary[]>> {
  try {
    const raw = await fetchJson("/conferences.json");
    if (!Array.isArray(raw)) {
      return { status: "error", error: "conferences.json: expected an array" };
    }
    const rows: ConferenceSummary[] = [];
    for (const item of raw) {
      const parsed = ConferenceSummarySchema.safeParse(item);
      if (parsed.success) rows.push(parsed.data);
    }
    return { status: "ok", data: rows };
  } catch (err) {
    return { status: "error", error: errorMessage(err) };
  }
}

// ---------------------------------------------------------------------
// <conf>/papers.json
// ---------------------------------------------------------------------

export const PaperSchema = z
  .object({
    title: z.string(),
    type: z.string(),
    tags: z.array(z.string()),
    venue: z.string(),
    authors: z.array(z.string()),
    abstract: z.string(),
    arxiv_id: z.string(),
    // build_pages.py's _maybe_int() returns int | None for any CSV cell
    // that is missing or unparseable -- a null here is a real value
    // this app must render (e.g. "citation count unknown"), not a
    // reason to fail the whole conference's catalog.
    citation_count: z.number().nullable(),
    venue_tier: z.number().nullable(),
  })
  .passthrough();
export type Paper = z.infer<typeof PaperSchema>;

const PapersSchema = z.array(PaperSchema);

/** Fetches /<slug>/papers.json (that conference's accepted-paper list). */
export async function fetchConferencePapers(slug: string): Promise<DataResult<Paper[]>> {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) {
    return {
      status: "error",
      error: `fetchConferencePapers: invalid slug ${JSON.stringify(slug)}`,
    };
  }
  try {
    const raw = await fetchJson(`/${slug}/papers.json`);
    const parsed = PapersSchema.safeParse(raw);
    if (!parsed.success) {
      return { status: "error", error: `${slug}/papers.json: ${parsed.error.message}` };
    }
    return { status: "ok", data: parsed.data };
  } catch (err) {
    return { status: "error", error: errorMessage(err) };
  }
}

// ---------------------------------------------------------------------
// search-index-v2.json
// ---------------------------------------------------------------------

/** [title, conferenceSlug, indexInThatConference, authors, tags, year|null, type] */
export const SearchIndexEntrySchema = z.tuple([
  z.string().min(1),
  z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  z.number().int().min(0),
  z.array(z.string()),
  z.array(z.string()),
  z.union([z.number().int().min(1900).max(2200), z.null()]),
  z.enum(["Oral", "Poster"]),
]);
export type SearchIndexEntry = z.infer<typeof SearchIndexEntrySchema>;

const SearchIndexSchema = z.array(SearchIndexEntrySchema);

/** Fetches /search-index-v2.json (the cross-conference search index). */
export async function fetchSearchIndex(): Promise<DataResult<SearchIndexEntry[]>> {
  try {
    const raw = await fetchJson("/search-index-v2.json");
    const parsed = SearchIndexSchema.safeParse(raw);
    if (!parsed.success) {
      return { status: "error", error: `search-index-v2.json: ${parsed.error.message}` };
    }
    return { status: "ok", data: parsed.data };
  } catch (err) {
    return { status: "error", error: errorMessage(err) };
  }
}
