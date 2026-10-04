/**
 * Build `search-index-v2.json` / `search-index.json` / `search-paper-ids-v1`
 * blocks — TS port of `paperpilot/scripts/build_search_index.py`.
 *
 * The catalog is split one `papers.json` per conference, so a visitor who
 * wants "every diffusion paper across all ten venues" has no way to ask:
 * each catalog page only knows its own proceedings. This folds all of them
 * into one small index the landing page can search.
 *
 * This is one of the two "derived builders" the Node promoter
 * (`../promote.ts`) invokes to refresh shared outputs after staging a
 * `conference`-kind candidate (mirrors `refresh_shared_outputs()`'s
 * `conference)` branch in `.github/scripts/promote-generated.sh`). It lives
 * under `apps/pipeline/src/release/derived/` rather than
 * `apps/pipeline/src/catalog/` only because of this change's edit limits —
 * see the final report for the consolidation note.
 *
 * `docs/search-index.json` (v1) is kept for parity until P5 removes it
 * (design doc §9.3); this module still produces it.
 */

import { mkdirSync, readdirSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { identityFromUrl, normalizeAlias } from "@paperpilot/core/identity";
import { codepointCompare, pyJsonDumps, pyStrip } from "@paperpilot/core/pycompat";
import { atomicWriteText } from "../../collect/state/atomic.js";

export const INDEX_FILENAME = "search-index.json";
export const INDEX_V2_FILENAME = "search-index-v2.json";
export const PAPER_ID_BLOCK_DIRNAME = "search-paper-ids-v1";

// Entries are positional pairs rather than objects: [title, conference].
export const TITLE = 0;
export const CONFERENCE = 1;
export const PAPER_REF = 2;
export const AUTHORS = 3;
export const TAGS = 4;
export const YEAR = 5;
export const PAPER_TYPE = 6;
export const PAPER_ID_BLOCK_SIZE = 256;

const CONFERENCE_YEAR_RE = /-(\d{4})$/;

/**
 * `paperpilot/scripts/build_pages.py::NON_CONFERENCE` — `daily` is the
 * daily-watch collection output, not a conference; it has no catalog page.
 * Inlined here (rather than imported) because `build_pages.py`'s TS port
 * lives in the concurrently-developed `apps/pipeline/src/catalog/`.
 */
export const NON_CONFERENCE: ReadonlySet<string> = new Set(["daily"]);

export type V1Entry = [string, string];
export type V2Entry = [string, string, number, string[], string[], number | null, string];

function sortedConferenceDirs(docsRoot: string): string[] {
  let names: string[];
  try {
    names = readdirSync(docsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
  return names.slice().sort(codepointCompare);
}

function readJsonArray(path: string, context: string): unknown[] {
  const raw = JSON.parse(readFileSync(path, "utf-8"));
  if (!Array.isArray(raw)) {
    throw new Error(`${context}: papers.json must be an array`);
  }
  return raw;
}

/**
 * Fold every conference `papers.json` into a flat entry list.
 *
 * Returns `{ entries, skipped }` where `skipped` counts rows with no title.
 * Conferences are walked in sorted order so a rebuild with unchanged inputs
 * is byte-identical.
 */
export function buildIndex(docsRoot: string): { entries: V1Entry[]; skipped: number } {
  const entries: V1Entry[] = [];
  let skipped = 0;

  for (const name of sortedConferenceDirs(docsRoot)) {
    if (NON_CONFERENCE.has(name)) continue;
    const papersJson = join(docsRoot, name, "papers.json");
    try {
      statSync(papersJson);
    } catch {
      continue;
    }

    const rows = JSON.parse(readFileSync(papersJson, "utf-8")) as Array<Record<string, unknown>>;
    for (const row of rows) {
      const title = pyStrip(typeof row.title === "string" ? row.title : "");
      if (!title) {
        skipped += 1;
        continue;
      }
      entries.push([title, name]);
    }
  }

  return { entries, skipped };
}

/** Write the index with compact separators (it ships to every searcher). */
export function writeIndex(docsRoot: string, entries: V1Entry[]): string {
  const out = join(docsRoot, INDEX_FILENAME);
  atomicWriteText(out, pyJsonDumps(entries, { ensureAscii: false, separators: [",", ":"] }));
  return out;
}

function stringList(value: unknown, field: string, conference: string, ordinal: number): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new Error(`${conference} row ${ordinal}: ${field} must be a string array`);
  }
  return value;
}

/** Build the identity-rich search projection with strict row validation. */
export function buildIndexV2(docsRoot: string): { entries: V2Entry[]; paperIds: string[] } {
  const entries: V2Entry[] = [];
  const paperIds: string[] = [];

  for (const name of sortedConferenceDirs(docsRoot)) {
    if (NON_CONFERENCE.has(name)) continue;
    const papersJson = join(docsRoot, name, "papers.json");
    try {
      statSync(papersJson);
    } catch {
      continue;
    }

    const rows = readJsonArray(papersJson, name);
    rows.forEach((rawRow, ordinal) => {
      if (typeof rawRow !== "object" || rawRow === null || Array.isArray(rawRow)) {
        throw new Error(`${name} row ${ordinal}: paper must be an object`);
      }
      const row = rawRow as Record<string, unknown>;
      const title = row.title;
      if (typeof title !== "string" || !pyStrip(title)) {
        throw new Error(`${name} row ${ordinal}: title is required`);
      }

      const arxivUrl = typeof row.arxiv_url === "string" ? row.arxiv_url : "";
      const identity = identityFromUrl(arxivUrl);
      const embeddedId = row.paper_id;
      if (embeddedId !== undefined && embeddedId !== null && embeddedId !== identity.paperId) {
        throw new Error(`${name} row ${ordinal}: embedded paper_id does not match source URL`);
      }
      const embeddedSource = row.source;
      const embeddedSourceId = row.source_id;
      if (
        (embeddedSource !== undefined && embeddedSource !== null) ||
        (embeddedSourceId !== undefined && embeddedSourceId !== null)
      ) {
        if (typeof embeddedSource !== "string" || typeof embeddedSourceId !== "string") {
          throw new Error(`${name} row ${ordinal}: source/source_id must be strings`);
        }
        const [normSource, normId] = normalizeAlias(embeddedSource, embeddedSourceId);
        if (normSource !== identity.source || normId !== identity.sourceId) {
          throw new Error(`${name} row ${ordinal}: embedded source identity mismatch`);
        }
      }

      const authors = stringList(row.authors, "authors", name, ordinal);
      const tags = stringList(row.tags, "tags", name, ordinal);
      const paperType = row.type;
      if (paperType !== "Oral" && paperType !== "Poster") {
        throw new Error(`${name} row ${ordinal}: type must be Oral or Poster`);
      }

      const sourceYear = row.year;
      if (
        sourceYear !== undefined &&
        sourceYear !== null &&
        (typeof sourceYear !== "number" || !Number.isInteger(sourceYear))
      ) {
        // Matches Python's `isinstance(source_year, int)`: a JSON float
        // like 2024.5 must be rejected, not silently truncated/accepted —
        // only `typeof === "number"` would let it through (JS has no
        // separate int/float type).
        throw new Error(`${name} row ${ordinal}: year must be integer or null`);
      }
      const match = CONFERENCE_YEAR_RE.exec(name);
      const year: number | null =
        sourceYear !== undefined && sourceYear !== null
          ? (sourceYear as number)
          : match
            ? Number.parseInt(match[1] as string, 10)
            : null;

      entries.push([pyStrip(title), name, paperIds.length, authors, tags, year, paperType]);
      paperIds.push(identity.paperId);
    });
  }

  return { entries, paperIds };
}

/** Write the compact v2 index consumed by the unified landing search. */
export function writeIndexV2(docsRoot: string, entries: V2Entry[]): string {
  const out = join(docsRoot, INDEX_V2_FILENAME);
  atomicWriteText(out, pyJsonDumps(entries, { ensureAscii: false, separators: [",", ":"] }));
  return out;
}

function paperIdBlockPayload(block: number, paperIds: string[]): string {
  return (
    pyJsonDumps(
      {
        schema_version: "search-paper-ids-v1",
        block,
        start: block * PAPER_ID_BLOCK_SIZE,
        paper_ids: paperIds,
      },
      { ensureAscii: false, separators: [",", ":"] },
    ) + "\n"
  );
}

/**
 * Write fixed-size canonical-ID blocks addressed by v2 `paper_ref`.
 *
 * Publishing is deliberately two-phase with {@link prunePaperIdBlocks}: the
 * caller writes these blocks, then the index that addresses them, then
 * prunes. An interrupted run therefore leaves `search-index-v2.json`
 * byte-identical instead of replaced by an index whose blocks never landed.
 */
export function writePaperIdBlocks(docsRoot: string, paperIds: string[]): string[] {
  const blockRoot = join(docsRoot, PAPER_ID_BLOCK_DIRNAME);
  mkdirSync(blockRoot, { recursive: true });
  const outputs: string[] = [];
  for (let start = 0; start < paperIds.length; start += PAPER_ID_BLOCK_SIZE) {
    const block = Math.floor(start / PAPER_ID_BLOCK_SIZE);
    const output = join(blockRoot, `${String(block).padStart(4, "0")}.json`);
    atomicWriteText(
      output,
      paperIdBlockPayload(block, paperIds.slice(start, start + PAPER_ID_BLOCK_SIZE)),
    );
    outputs.push(output);
  }
  return outputs;
}

/** Delete blocks outside `published` — only once the new index is live. */
export function prunePaperIdBlocks(docsRoot: string, published: string[]): string[] {
  const expected = new Set(published);
  const removed: string[] = [];
  const blockRoot = join(docsRoot, PAPER_ID_BLOCK_DIRNAME);
  let names: string[];
  try {
    names = readdirSync(blockRoot).filter((name) => name.endsWith(".json"));
  } catch {
    return removed;
  }
  for (const name of names) {
    const stale = join(blockRoot, name);
    if (!expected.has(stale)) {
      unlinkSync(stale);
      removed.push(stale);
    }
  }
  return removed;
}

export interface WriteSearchIndexesResult {
  entries: V1Entry[];
  entriesV2: V2Entry[];
  skipped: number;
  idBlocks: string[];
  outV1: string;
  outV2: string;
  removedBlocks: string[];
}

/**
 * The non-`--check` body of `main()`: write v1, then ID blocks, then v2,
 * then prune. This exact order is what keeps a published index and its
 * block set from being torn apart by a failure part-way through.
 */
export function writeSearchIndexes(docsRoot: string): WriteSearchIndexesResult {
  const { entries, skipped } = buildIndex(docsRoot);
  const { entries: entriesV2, paperIds } = buildIndexV2(docsRoot);

  const outV1 = writeIndex(docsRoot, entries);
  const idBlocks = writePaperIdBlocks(docsRoot, paperIds);
  const outV2 = writeIndexV2(docsRoot, entriesV2);
  const removedBlocks = prunePaperIdBlocks(docsRoot, idBlocks);

  return { entries, entriesV2, skipped, idBlocks, outV1, outV2, removedBlocks };
}

/** The `--check` body of `main()`: raise if committed outputs are stale. */
export function checkSearchIndexes(docsRoot: string): void {
  const { entries } = buildIndex(docsRoot);
  const { entries: entriesV2, paperIds } = buildIndexV2(docsRoot);

  const expectedV1 = pyJsonDumps(entries, { ensureAscii: false, separators: [",", ":"] });
  const expectedV2 = pyJsonDumps(entriesV2, { ensureAscii: false, separators: [",", ":"] });
  const actualV1 = readFileSync(join(docsRoot, INDEX_FILENAME), "utf-8");
  const actualV2 = readFileSync(join(docsRoot, INDEX_V2_FILENAME), "utf-8");
  if (actualV1 !== expectedV1 || actualV2 !== expectedV2) {
    throw new Error("committed search indexes are stale; rebuild without --check");
  }

  const blockRoot = join(docsRoot, PAPER_ID_BLOCK_DIRNAME);
  const expectedBlocks = new Map<string, string>();
  for (let start = 0; start < paperIds.length; start += PAPER_ID_BLOCK_SIZE) {
    const block = Math.floor(start / PAPER_ID_BLOCK_SIZE);
    const path = join(blockRoot, `${String(block).padStart(4, "0")}.json`);
    expectedBlocks.set(
      path,
      paperIdBlockPayload(block, paperIds.slice(start, start + PAPER_ID_BLOCK_SIZE)),
    );
  }
  let actualNames: string[] = [];
  try {
    actualNames = readdirSync(blockRoot).filter((name) => name.endsWith(".json"));
  } catch {
    // treated as an empty set below, which will mismatch unless both are empty
  }
  const actualPaths = new Set(actualNames.map((name) => join(blockRoot, name)));
  const expectedPaths = new Set(expectedBlocks.keys());
  const sameSet =
    actualPaths.size === expectedPaths.size && [...actualPaths].every((p) => expectedPaths.has(p));
  // Short-circuit on `sameSet`: a missing expected block (sameSet already
  // false) must still report the clean "stale" error below, not crash
  // with an uncaught ENOENT from reading a block that `sameSet` already
  // proved doesn't exist.
  const sameContent =
    sameSet &&
    [...expectedBlocks.entries()].every(
      ([path, payload]) => readFileSync(path, "utf-8") === payload,
    );
  if (!sameSet || !sameContent) {
    throw new Error("committed search paper ID blocks are stale");
  }
}
