/**
 * Shared catalog writer for the authoritative conference collectors
 * (OpenReview / CVF; the arXiv and ACL collectors reuse the same
 * function) — TS port of `paperpilot/scripts/collect_conference.py::write_outputs`
 * (CNF-15, CNF-16, CNF-17, CNF-18, CNF-19 of docs/migration/safety-contracts.md).
 *
 * INTENTIONAL DEVIATION from the Python signature: Python defaults
 * `output_root` to `paperpilot/output` (`PROJECT / "output"`) when the
 * caller omits it. The TS port of this module must never write into the
 * Python tree it is only allowed to *read* during the migration (CLAUDE.md
 * "TypeScript 移行中の開発ルール"), so `outputRoot` is a REQUIRED
 * parameter here — every caller (tests, the openreview/cvf CLIs) must
 * pass an explicit directory. This is a deliberate, documented API
 * difference, not a parity gap in the write behavior itself.
 */

import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import * as path from "node:path";
import { neutralizeRow } from "../../collect/exporters/csvSafety.js";
import { atomicWriteText } from "../../collect/state/atomic.js";
import {
  IdentityError,
  identityFromUrl,
  normalizeAlias,
} from "../../release/identity/sourceIds.js";
import { validateConferenceSlug } from "./conferenceSlug.js";
import { type ConferenceRow, CSV_COLUMNS } from "./csvColumns.js";

export interface WriteOutputsOptions {
  /** Directory the per-conference subdirectory is created under. REQUIRED — see module doc. */
  outputRoot: string;
  /** `YYYY-MM-DD`; defaults to `deps.now()`'s UTC date. */
  date?: string;
  /**
   * Delete an existing `oral_summaries_ja.md` when `oralTitles` is empty.
   * Default `false` — an empty list is usually "this run found no oral
   * evidence", not "this venue has no orals" (CNF-15); only an explicit
   * operator opt-in removes the published file (CNF-16).
   */
  clearOral?: boolean;
}

export interface WriteOutputsDeps {
  /** Injected clock for the default `date` — never the real wall clock in tests. */
  now?: () => Date;
}

function utcDateString(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function csvField(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

function csvLine(values: readonly string[]): string {
  return `${values.map(csvField).join(",")}\r\n`;
}

function cellToString(v: unknown): string {
  if (v === undefined || v === null) return "";
  return typeof v === "string" ? v : String(v);
}

/**
 * Write `papers_<date>.csv` (+ `oral_summaries_ja.md`) under
 * `<outputRoot>/<conference>/`. Shared by all four conference collectors
 * so the rest of the chain (build_summary_csv / build_pages / scaffold)
 * sees one identical schema regardless of source.
 *
 * Step order mirrors the Python original EXACTLY, including a surprising
 * consequence that failure-path parity depends on: `mkdir` happens BEFORE
 * the identity projection, so a row that fails identity validation
 * (IdentityError) still leaves an (empty) `<outputRoot>/<conference>/`
 * directory behind as a side effect — the CSV/MD themselves are not
 * written in that case (atomicWriteText is never reached), so there is no
 * partial/torn catalog file, just an empty directory.
 */
export function writeOutputs(
  conference: string,
  rows: readonly ConferenceRow[],
  oralTitles: readonly string[],
  options: WriteOutputsOptions,
  deps: WriteOutputsDeps = {},
): string {
  validateConferenceSlug(conference);
  const root = options.outputRoot;
  const outDir = path.join(root, conference);

  // Defense-in-depth: validateConferenceSlug's allowlist regex already
  // makes traversal structurally impossible, but a resolve()-based
  // containment check costs nothing and protects against a future
  // loosening of that regex (mirrors the Python original).
  const resolvedRoot = path.resolve(root);
  const resolvedOutDir = path.resolve(outDir);
  const withinRoot =
    resolvedRoot === resolvedOutDir || resolvedOutDir.startsWith(resolvedRoot + path.sep);
  if (!withinRoot) {
    throw new Error(`conference output dir ${resolvedOutDir} escapes ${resolvedRoot}`);
  }

  mkdirSync(outDir, { recursive: true });

  const now = deps.now ?? (() => new Date());
  const day = options.date ?? utcDateString(now());

  const projectedRows: ConferenceRow[] = [];
  for (const row of rows) {
    const identity = identityFromUrl(String(row.url ?? ""));
    const declaredSource = String(row.source ?? "").trim();
    const declaredSourceId = String(row.source_id ?? "").trim();
    if (Boolean(declaredSource) !== Boolean(declaredSourceId)) {
      throw new IdentityError("source and source_id must be present together");
    }
    if (declaredSource) {
      const [normSource, normId] = normalizeAlias(declaredSource, declaredSourceId);
      if (normSource !== identity.source || normId !== identity.sourceId) {
        throw new IdentityError("declared source/source_id does not match the native source URL");
      }
    }
    projectedRows.push({ ...row, source: identity.source, source_id: identity.sourceId });
  }

  const csvPath = path.join(outDir, `papers_${day}.csv`);
  let csvText = csvLine(CSV_COLUMNS);
  for (const row of projectedRows) {
    const neutralized = neutralizeRow(row);
    csvText += csvLine(CSV_COLUMNS.map((col) => cellToString(neutralized[col])));
  }
  atomicWriteText(csvPath, csvText, { encoding: "utf-8-sig" });

  // The oral file drives the catalog's Oral/Poster split, so an empty list
  // here is ambiguous (CVF/ACL without --oral-arxiv-query, or an overlay
  // whose fetch came back empty, both produce [] while the venue may still
  // have orals) — kept as-is unless the operator opted into clearOral.
  const oralMdPath = path.join(outDir, "oral_summaries_ja.md");
  if (oralTitles.length > 0) {
    const lines = [
      `# ${conference} Oral / Highlight\n`,
      "*Oral / Highlight と判定された採択論文*\n",
      ...oralTitles.map((t, i) => `## ${i + 1}. ${t}`),
    ];
    atomicWriteText(oralMdPath, `${lines.join("\n")}\n`);
  } else if (options.clearOral && existsSync(oralMdPath)) {
    unlinkSync(oralMdPath);
  }

  return csvPath;
}
