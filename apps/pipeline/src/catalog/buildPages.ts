/**
 * Build static catalog JSON from summary.csv — TS port of
 * `paperpilot/scripts/build_pages.py` (CAT-01..24 of
 * docs/migration/safety-contracts.md).
 *
 * Converts `<outputRoot>/<conference>/summary.csv` ->
 * `<docsRoot>/<conference>/papers.json`, aggregates `<docsRoot>/conferences.json`,
 * and writes the 256 `<docsRoot>/paper-details-v1/<prefix>.json` full-abstract
 * shards. Running without a specific conference rebuilds every conference
 * directory that has a summary.csv.
 *
 * Unlike the Python original (which hardcodes `PROJECT`/`DOCS_ROOT` from
 * `__file__`, overridden in tests via `monkeypatch.setattr`), every
 * function here takes its roots as an explicit {@link CatalogRoots}
 * parameter — the same substitution point, just as an ordinary argument
 * instead of a mutable module global.
 *
 * See the Python module's own doc comment for the full shrink-gate /
 * two-phase-publish rationale; this port preserves it verbatim.
 *
 * Scope note on the no-JS "paper links" page: see `paperLinksGate.ts`'s
 * doc comment. This module still enforces that gate before publish; it
 * writes no `paper-links.html`/`.json` (the data the web route reads is
 * `papers.json` itself).
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pyJsonDumps, pyRstrip, pySplit, pyStrip } from "@paperpilot/core/pycompat";
import { unneutralize } from "../collect/exporters/csvSafety.js";
import { atomicWriteText } from "../collect/state/atomic.js";
import { SUMMARY_META_FILENAME } from "./buildSummary.js";
import { dictReader } from "./csv.js";
import { IdentityError, identityFromUrl, normalizeAlias } from "./identity.js";
import { assertPaperLinksGate } from "./paperLinksGate.js";
import { validateConferenceSlug } from "./slug.js";

export interface CatalogRoots {
  /** Directory containing `<conference>/summary.csv` (Python: `PROJECT / "output"`). */
  outputRoot: string;
  /** Directory containing `<conference>/papers.json`, `conferences.json`, `paper-details-v1/` (Python: `DOCS_ROOT`). */
  docsRoot: string;
}

/**
 * Output dirs that have a summary.csv but are NOT conferences and must
 * not appear in the conference index / catalog. "daily" is the
 * daily-watch collection output.
 */
export const NON_CONFERENCE: ReadonlySet<string> = new Set(["daily"]);

// papers.json ships in full to every catalog visitor; the list view only
// needs a teaser.
const ABSTRACT_PREVIEW_CHARS = 320;

/**
 * The public paths `scaffold_conference_page.py` reserves under `docs/`
 * (`_RESERVED_CONFERENCE_PATHS`, paperpilot/scripts/scaffold_conference_page.py:44-56),
 * minus its own template conference (`cvpr-2026`, a real published
 * catalog this build must keep producing). Hardcoded here (not derived
 * from a shared module) since `scaffold_conference_page.py` is Python and
 * out of this task's edit scope — keep both lists in sync by hand until
 * that script is ported.
 */
const RESERVED_PUBLIC_PATHS: ReadonlySet<string> = new Set([
  "assets",
  "daily",
  "design",
  "how-it-works",
  "paper-details-v1",
  "paper-slides-v1",
  "research",
  "search-paper-ids-v1",
  "themes",
]);

export class CatalogShrinkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CatalogShrinkError";
  }
}

function abstractPreview(text: string | null | undefined): string {
  const trimmed = pyStrip(text ?? "");
  const chars = Array.from(trimmed); // code-point aware, matching Python's `len`/slicing on `str`.
  if (chars.length <= ABSTRACT_PREVIEW_CHARS) return trimmed;
  const head = chars.slice(0, ABSTRACT_PREVIEW_CHARS).join("");
  const lastSpace = head.lastIndexOf(" ");
  const cut = pyRstrip(lastSpace === -1 ? head : head.slice(0, lastSpace));
  return `${cut || pyRstrip(head)}…`;
}

const FLOAT_LIKE_RE = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;

/** Parse a numeric field from the CSV. Empty / missing / unparseable -> null. */
function maybeInt(value: string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const trimmed = pyStrip(value);
  if (!trimmed) return null;
  if (!FLOAT_LIKE_RE.test(trimmed)) return null; // reject JS-only numeric forms Python's float() would reject.
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed)) return null;
  return Math.trunc(parsed);
}

// Python's `_safe_http_url` (CAT-19) is not ported here: it only guarded
// `render_paper_links_page`'s rendered links, and that rendering moved to
// `apps/web/app/[conf]/paper-links/logic.ts` (`safeHttpUrl` there) — see
// `paperLinksGate.ts`'s doc comment.

/**
 * Return a conference slug or fail before any filesystem access. Uses the
 * collectors' own `validateConferenceSlug` so a name one of them was
 * allowed to write under `<outputRoot>/<slug>/` is always buildable here,
 * plus the public paths `scaffold_conference_page.py` reserves under `docs/`.
 */
function validateConferenceSlugForPages(value: unknown): string {
  if (typeof value !== "string") {
    throw new RangeError("conference must be a lowercase slug and not a reserved public path");
  }
  if (RESERVED_PUBLIC_PATHS.has(value)) {
    throw new RangeError(
      `conference ${JSON.stringify(value)} is a reserved public path under docs/`,
    );
  }
  return validateConferenceSlug(value);
}

/** Resolve a path the way Python's `Path.resolve(strict=False)` does: follow symlinks for the existing prefix, lexically normalize the rest. */
function resolvePythonStyle(p: string): string {
  let existing = resolve(p);
  const remainder: string[] = [];
  while (existing !== dirname(existing) && !existsSync(existing)) {
    remainder.unshift(existing.slice(existing.lastIndexOf(sep) + 1));
    existing = dirname(existing);
  }
  const base = existsSync(existing) ? realpathSync(existing) : existing;
  return remainder.length > 0 ? resolve(base, ...remainder) : base;
}

/** Join below `root` and reject symlink/path escapes fail-closed. */
export function containedPath(root: string, ...parts: string[]): string {
  const candidate = join(root, ...parts);
  const resolvedRoot = resolvePythonStyle(root);
  const resolvedCandidate = resolvePythonStyle(candidate);
  const rel = relative(resolvedRoot, resolvedCandidate);
  if (rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel))) {
    return candidate;
  }
  throw new RangeError(`conference path escapes configured root: ${candidate}`);
}

// ---- summary.csv reading ------------------------------------------------
//
// `_paper_title`/`_paper_title_sort_key` (Python) are not ported here: they
// backed `render_paper_links_page`'s sort order, and that rendering moved
// to `apps/web/app/[conf]/paper-links/logic.ts` (`paperTitle`/`titleSortKey`,
// using `pyCasefold`-equivalent `.normalize("NFKC")` + casefold there too)
// — see `paperLinksGate.ts`'s doc comment for why.

export interface CatalogPaper {
  title: string;
  type: string;
  tags: string[];
  venue: string;
  authors: string[];
  arxiv_url: string;
  pdf_url: string;
  abstract: string;
  arxiv_id: string;
  citation_count: number | null;
  venue_tier: number | null;
  github_stars: number | null;
  paper_id: string;
  source: string;
  source_id: string;
}

/**
 * Load one catalog projection and its full-abstract detail records. Cells
 * come back without the spreadsheet formula guard, so the published text
 * is the upstream text.
 */
export function loadSummaryWithDetails(summaryCsv: string): {
  papers: CatalogPaper[];
  details: Map<string, string>;
} {
  const papers: CatalogPaper[] = [];
  const details = new Map<string, string>();
  const text = readFileSync(summaryCsv, "utf-8");
  const { rows } = dictReader(text);
  for (const rawRow of rows) {
    const row: Record<string, string | null> = {};
    for (const [k, v] of Object.entries(rawRow)) {
      row[k] = typeof v === "string" ? unneutralize(v) : v;
    }
    const identity = identityFromUrl(row.arxiv_url ?? "");
    const declaredSource = pyStrip(row.source ?? "");
    const declaredSourceId = pyStrip(row.source_id ?? "");
    if (Boolean(declaredSource) !== Boolean(declaredSourceId)) {
      throw new IdentityError("source and source_id must be present together");
    }
    if (declaredSource) {
      const [normSource, normId] = normalizeAlias(declaredSource, declaredSourceId);
      if (normSource !== identity.source || normId !== identity.sourceId) {
        throw new IdentityError("declared source/source_id does not match the native source URL");
      }
    }

    const fullAbstract = pyStrip(row.abstract ?? "");
    const existingAbstract = details.get(identity.paperId);
    if (existingAbstract !== undefined && existingAbstract !== fullAbstract) {
      throw new IdentityError(`conflicting abstracts for paper_id ${identity.paperId}`);
    }
    details.set(identity.paperId, fullAbstract);
    papers.push({
      title: row.title ?? "",
      type: row.type ?? "",
      tags: row.tags ? pySplit(row.tags) : [],
      venue: row.venue ?? "",
      authors: (row.authors ?? "")
        .split(/[;,]/)
        .map((a) => pyStrip(a))
        .filter(Boolean),
      arxiv_url: row.arxiv_url ?? "",
      pdf_url: row.pdf_url ?? "",
      abstract: abstractPreview(fullAbstract),
      arxiv_id: row.arxiv_id ?? "",
      citation_count: maybeInt(row.citation_count),
      venue_tier: maybeInt(row.venue_tier),
      github_stars: maybeInt(row.github_stars),
      paper_id: identity.paperId,
      source: identity.source,
      source_id: identity.sourceId,
    });
  }
  return { papers, details };
}

const DATA_DATE_RE = /^papers_(\d{4}-\d{2}-\d{2})\.csv$/;

function latestDataDate(confDir: string): string | null {
  let entries: string[];
  try {
    entries = readdirSync(confDir);
  } catch {
    entries = [];
  }
  const dates = entries
    .map((name) => DATA_DATE_RE.exec(name)?.[1])
    .filter((d): d is string => typeof d === "string")
    .sort();
  return dates.length > 0 ? (dates[dates.length - 1] as string) : null;
}

function generatedDate(confDir: string): string | null {
  let meta: unknown;
  try {
    meta = JSON.parse(readFileSync(join(confDir, SUMMARY_META_FILENAME), "utf-8"));
  } catch {
    return latestDataDate(confDir);
  }
  if (
    meta !== null &&
    typeof meta === "object" &&
    typeof (meta as { source?: unknown }).source === "string"
  ) {
    const source = (meta as { source: string }).source;
    const match = DATA_DATE_RE.exec(source);
    if (match && existsSync(join(confDir, source))) {
      return match[1] as string;
    }
  }
  return latestDataDate(confDir);
}

function oralRows(rows: readonly unknown[]): number {
  return rows.filter(
    (row) => isPlainObject(row) && (row as Record<string, unknown>).type === "Oral",
  ).length;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Fields that must not come back empty while their row survives. */
const CONTENT_FIELDS = ["abstract", "authors"] as const;

function overrideHint(name: string): string {
  return (
    `Re-run with --allow-shrink (all conferences) or --allow-shrink-for ${name} ` +
    "(this conference only) once the collection has been checked by hand."
  );
}

function fieldIsEmpty(value: unknown): boolean {
  if (typeof value === "string") return pyStrip(value) === "";
  if (Array.isArray(value)) return value.every((item) => fieldIsEmpty(item));
  return value === null || value === undefined;
}

function namedIds(ids: readonly string[], limit = 3): string {
  let shown = ids.slice(0, limit).join(", ");
  const more = ids.length - limit;
  if (more > 0) shown += ` and ${more} more`;
  return `${shown} (${ids.length} in total)`;
}

function publishedRowsById(published: readonly unknown[]): Map<string, Record<string, unknown>> {
  const rows = new Map<string, Record<string, unknown>>();
  for (const row of published) {
    if (!isPlainObject(row)) continue;
    const paperId = row.paper_id;
    if (typeof paperId === "string" && paperId) {
      rows.set(paperId, row);
    }
  }
  return rows;
}

function collapsedContentIds(
  publishedRows: Map<string, Record<string, unknown>>,
  newRows: Map<string, Record<string, unknown>>,
  field: string,
): string[] {
  const collapsed: string[] = [];
  for (const [paperId, publishedRow] of publishedRows) {
    const newRow = newRows.get(paperId);
    if (newRow === undefined) continue;
    const hadContent = !fieldIsEmpty(publishedRow[field]);
    if (hadContent && fieldIsEmpty(newRow[field])) {
      collapsed.push(paperId);
    }
  }
  return collapsed;
}

function readJsonArrayOrThrow(path: string, context: string, hint: string): unknown[] | null {
  if (!existsSync(path)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf-8"));
  } catch (exc) {
    throw new CatalogShrinkError(
      `${context} ${path} exists but cannot be inspected ` +
        `(${(exc as Error).constructor.name}: ${(exc as Error).message}); refusing to overwrite it blindly. ` +
        `Check that file by hand. ${hint}`,
    );
  }
  if (!Array.isArray(parsed)) {
    throw new CatalogShrinkError(
      `${context} ${path} is not a JSON array; refusing to overwrite it. Check that file by hand. ${hint}`,
    );
  }
  return parsed;
}

function refuseCatalogShrink(
  name: string,
  publishedJsonPath: string,
  papers: readonly CatalogPaper[],
  options: { allowShrink: boolean },
): void {
  if (options.allowShrink || !existsSync(publishedJsonPath)) return;

  const published = readJsonArrayOrThrow(
    publishedJsonPath,
    `${name}: published catalog`,
    overrideHint(name),
  );
  if (published === null) return;

  if (papers.length < published.length) {
    throw new CatalogShrinkError(
      `${name}: the new catalog has ${papers.length} row(s) while the published catalog ` +
        `${publishedJsonPath} has ${published.length}; refusing to publish a smaller catalog. ${overrideHint(name)}`,
    );
  }

  const publishedOral = oralRows(published);
  const newOral = oralRows(papers as unknown as unknown[]);
  if (newOral < publishedOral) {
    throw new CatalogShrinkError(
      `${name}: the published catalog labels ${publishedOral} row(s) Oral and the new ` +
        `catalog labels ${newOral} (a skipped or partial arXiv oral overlay?); refusing ` +
        `to erase Oral labels. ${overrideHint(name)}`,
    );
  }

  const publishedRows = publishedRowsById(published);
  const newRows = new Map<string, Record<string, unknown>>(
    papers.map((row) => [row.paper_id, row as unknown as Record<string, unknown>]),
  );
  const lostIds = [...publishedRows.keys()].filter((id) => !newRows.has(id));
  if (lostIds.length > 0) {
    throw new CatalogShrinkError(
      `${name}: ${lostIds.length} published paper_id(s) are missing from the new ` +
        `catalog although the row count did not drop: ${namedIds(lostIds)}. Refusing ` +
        `to publish a different set of papers. ${overrideHint(name)}`,
    );
  }

  for (const field of CONTENT_FIELDS) {
    const collapsed = collapsedContentIds(publishedRows, newRows, field);
    if (collapsed.length > 0) {
      throw new CatalogShrinkError(
        `${name}: ${collapsed.length} paper(s) kept their row but lost their ` +
          `'${field}' content: ${namedIds(collapsed)}. Refusing to publish empty ` +
          `'${field}' fields. ${overrideHint(name)}`,
      );
    }
  }
}

function publishedIndexNames(publishedIndex: string): string[] {
  const published = readJsonArrayOrThrow(
    publishedIndex,
    "published catalog index",
    "Check that file by hand, or re-run with --allow-shrink once the tree has been checked.",
  );
  if (published === null) return [];
  return published
    .filter(
      (entry): entry is { name: string } =>
        isPlainObject(entry) && typeof entry.name === "string" && entry.name !== "",
    )
    .map((entry) => entry.name);
}

function refuseIndexShrink(
  publishedIndex: string,
  building: readonly string[],
  publishedNames: readonly string[],
  options: { allowShrinkFor: ReadonlySet<string> },
): void {
  const buildingSet = new Set(building);
  const missing = publishedNames.filter(
    (name) => !buildingSet.has(name) && !options.allowShrinkFor.has(name),
  );
  if (missing.length === 0) return;
  throw new CatalogShrinkError(
    `${namedIds(missing)} conference(s) are listed by the published index ` +
      `${publishedIndex} but are not part of this full build; refusing to republish the ` +
      "landing index without them. Restore their output/<conference>/summary.csv, or " +
      "re-run with --allow-shrink (all conferences) or --allow-shrink-for <name> (one " +
      "of them) once the tree has been checked by hand.",
  );
}

function validatedShrinkAcks(
  entries: readonly string[],
  options: {
    building: readonly string[];
    selected: string | null;
    publishedNames: readonly string[];
  },
): Set<string> {
  const acknowledged = new Set<string>();
  const buildingSet = new Set(options.building);
  for (const entry of entries) {
    let name: string;
    try {
      name = validateConferenceSlugForPages(entry);
    } catch (exc) {
      throw new RangeError(`--allow-shrink-for: ${(exc as Error).message}`);
    }
    if (options.selected !== null) {
      if (name !== options.selected) {
        throw new RangeError(
          `--allow-shrink-for ${name} acknowledges nothing: this build is scoped ` +
            `to --conference ${options.selected}`,
        );
      }
    } else if (!buildingSet.has(name) && !options.publishedNames.includes(name)) {
      throw new RangeError(
        `--allow-shrink-for ${name} acknowledges nothing: it is neither one of the ` +
          `conferences this build publishes (${options.building.join(", ") || "none"}) nor a ` +
          `conference the published index lists (${options.publishedNames.join(", ") || "none"})`,
      );
    }
    acknowledged.add(name);
  }
  return acknowledged;
}

// ---- prepare / publish --------------------------------------------------

export interface PreparedConference {
  outJson: string;
  papersJson: string;
  entry: {
    name: string;
    papers: number;
    types: Record<string, number>;
    top_tags: Array<[string, number]>;
    generated: string | null;
  };
}

export interface PrepareConferenceOptions {
  detailSink?: Map<string, string>;
  allowShrink?: boolean;
}

/**
 * Build and validate `name`'s artifacts without writing anything. Returns
 * `null` when the conference has no summary.csv.
 */
export function prepareConference(
  name: string,
  roots: CatalogRoots,
  options: PrepareConferenceOptions = {},
): PreparedConference | null {
  const validatedName = validateConferenceSlugForPages(name);
  const summaryCsv = containedPath(roots.outputRoot, validatedName, "summary.csv");
  if (!existsSync(summaryCsv)) {
    console.log(`  skip ${validatedName}: no summary.csv`);
    return null;
  }
  const confDir = dirname(summaryCsv);

  const { papers, details } = loadSummaryWithDetails(summaryCsv);
  if (options.detailSink !== undefined) {
    for (const [paperId, abstract] of details) {
      const existing = options.detailSink.get(paperId);
      if (existing !== undefined && existing !== abstract) {
        throw new IdentityError(`conflicting abstracts for paper_id ${paperId}`);
      }
      options.detailSink.set(paperId, abstract);
    }
  }
  const outJson = join(containedPath(roots.docsRoot, validatedName), "papers.json");

  refuseCatalogShrink(validatedName, outJson, papers, {
    allowShrink: options.allowShrink ?? false,
  });

  // The no-JS fallback is rendered by apps/web directly from papers.json
  // (see paperLinksGate.ts's doc comment); this gate still refuses to
  // publish a catalog that fallback could never legally render.
  assertPaperLinksGate(papers);

  const tagCounts = new Map<string, number>();
  const typeCounts = new Map<string, number>();
  for (const p of papers) {
    for (const t of p.tags) tagCounts.set(t, (tagCounts.get(t) ?? 0) + 1);
    typeCounts.set(p.type, (typeCounts.get(p.type) ?? 0) + 1);
  }
  const topTags = [...tagCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);

  return {
    outJson,
    papersJson: pyJsonDumps(papers, { indent: 0, ensureAscii: false }),
    entry: {
      name: validatedName,
      papers: papers.length,
      types: Object.fromEntries(typeCounts),
      top_tags: topTags,
      generated: generatedDate(confDir),
    },
  };
}

/** Atomically replace one conference's `papers.json`. */
export function publishConference(prepared: PreparedConference): void {
  mkdirSync(dirname(prepared.outJson), { recursive: true });
  // The committed catalogs end in one newline, so the payload must too:
  // without it a full rebuild rewrites every unchanged papers.json with a
  // newline-only diff, and the promotion allowlist check dies on those
  // tracked changes.
  atomicWriteText(prepared.outJson, `${prepared.papersJson}\n`);
}

/** Prepare and publish `name` in one step, for single-catalog rebuilds. */
export function buildConference(
  name: string,
  roots: CatalogRoots,
  options: PrepareConferenceOptions = {},
): PreparedConference["entry"] | null {
  const prepared = prepareConference(name, roots, options);
  if (prepared === null) return null;
  publishConference(prepared);
  return prepared.entry;
}

export function writeIndex(
  docsRoot: string,
  conferences: ReadonlyArray<PreparedConference["entry"]>,
): void {
  const indexPath = join(docsRoot, "conferences.json");
  atomicWriteText(indexPath, pyJsonDumps(conferences, { indent: 2, ensureAscii: false }));
}

/** Write 256 deterministic, lazily loaded full-abstract shards. */
export function writeDetailShards(docsRoot: string, details: Map<string, string>): string[] {
  const shardRoot = join(docsRoot, "paper-details-v1");
  mkdirSync(shardRoot, { recursive: true });
  const byPrefix = new Map<string, Array<[string, string]>>();
  for (let value = 0; value < 256; value++) {
    byPrefix.set(value.toString(16).padStart(2, "0"), []);
  }
  for (const paperId of [...details.keys()].sort()) {
    if (!/^[0-9a-f]{40}$/.test(paperId)) {
      throw new IdentityError(`invalid paper_id in detail projection: ${JSON.stringify(paperId)}`);
    }
    const abstract = details.get(paperId) as string;
    (byPrefix.get(paperId.slice(0, 2)) as Array<[string, string]>).push([paperId, abstract]);
  }

  const outputs: string[] = [];
  for (const [prefix, papers] of byPrefix) {
    const output = join(shardRoot, `${prefix}.json`);
    const payload = pyJsonDumps(
      { schema_version: "paper-details-v1", prefix, papers },
      { ensureAscii: false, separators: [",", ":"] },
    );
    atomicWriteText(output, `${payload}\n`);
    outputs.push(output);
  }
  return outputs;
}

// ---- CLI entry point -----------------------------------------------------

export interface BuildPagesArgs {
  conference?: string;
  allowShrink: boolean;
  allowShrinkFor: string[];
}

export function parseBuildPagesArgs(argv: readonly string[]): BuildPagesArgs {
  const args: BuildPagesArgs = { allowShrink: false, allowShrinkFor: [] };
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    switch (tok) {
      case "--conference":
        args.conference = argv[++i];
        break;
      case "--allow-shrink":
        args.allowShrink = true;
        break;
      case "--allow-shrink-for":
        args.allowShrinkFor.push(argv[++i] as string);
        break;
      default:
        break;
    }
  }
  return args;
}

export interface BuildPagesMainResult {
  exitCode: number;
}

/** `main()`: mirrors Python's control flow exactly, including exit codes. Pure w.r.t. stdout (logged, not asserted by parity). */
export function buildPagesMain(args: BuildPagesArgs, roots: CatalogRoots): BuildPagesMainResult {
  let confDirs: string[];
  if (args.conference) {
    confDirs = [args.conference];
  } else {
    // Matches Python's `output_dir.iterdir()`: a missing/unreadable output
    // root is an uncaught exception there (crash, non-zero exit), NOT an
    // empty "No conferences" skip — only an output root that exists but is
    // genuinely empty takes that path. Swallowing ENOENT here used to turn
    // a missing `paperpilot/output/` into a silent, successful no-op run.
    const entries = readdirSync(roots.outputRoot);
    confDirs = entries
      .filter((name) => {
        const dir = join(roots.outputRoot, name);
        if (NON_CONFERENCE.has(name)) return false;
        try {
          return statSync(dir).isDirectory() && existsSync(join(dir, "summary.csv"));
        } catch {
          return false;
        }
      })
      .sort();
  }

  const publishedIndex = join(roots.docsRoot, "conferences.json");
  const inspectIndex = !args.conference && (args.allowShrinkFor.length > 0 || !args.allowShrink);

  let publishedNames: string[] = [];
  let allowShrinkFor: Set<string>;
  try {
    publishedNames = inspectIndex ? publishedIndexNames(publishedIndex) : [];
    allowShrinkFor = validatedShrinkAcks(args.allowShrinkFor, {
      building: confDirs,
      selected: args.conference ?? null,
      publishedNames,
    });
  } catch (exc) {
    console.log(`⚠️  ${(exc as Error).message}`);
    return { exitCode: 1 };
  }

  if (confDirs.length === 0) {
    console.log(`No conferences with summary.csv found under ${roots.outputRoot}`);
    return { exitCode: 0 };
  }

  console.log(`Building ${confDirs.length} conference(s):`);
  const results: PreparedConference[] = [];
  const details = new Map<string, string>();
  for (const name of confDirs) {
    let prepared: PreparedConference | null;
    try {
      prepared = prepareConference(name, roots, {
        detailSink: details,
        allowShrink: args.allowShrink || allowShrinkFor.has(name),
      });
    } catch (exc) {
      console.log(`⚠️  ${(exc as Error).message}`);
      return { exitCode: 1 };
    }
    if (prepared === null) {
      if (!args.conference) continue;
      const expected = containedPath(roots.outputRoot, name, "summary.csv");
      console.log(`⚠️  ${name}: nothing to build — ${expected} does not exist`);
      return { exitCode: 1 };
    }
    results.push(prepared);
  }

  if (!args.conference && !args.allowShrink) {
    try {
      refuseIndexShrink(publishedIndex, confDirs, publishedNames, { allowShrinkFor });
    } catch (exc) {
      console.log(`⚠️  ${(exc as Error).message}`);
      return { exitCode: 1 };
    }
  }

  for (const prepared of results) {
    publishConference(prepared);
    console.log(`  ${prepared.entry.name}: ${prepared.entry.papers} papers`);
  }

  if (args.conference) {
    console.log("\nScoped build complete; global conferences.json and detail shards unchanged.");
  } else {
    writeIndex(
      roots.docsRoot,
      results.map((r) => r.entry),
    );
    writeDetailShards(roots.docsRoot, details);
    console.log(`\nWrote conferences.json -> ${roots.docsRoot}/`);
  }
  return { exitCode: 0 };
}
