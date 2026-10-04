/**
 * Shared types for the parity tool (docs/design/39-typescript-cloudflare-migration.md §7.2).
 *
 * The tool compares two output trees (an "expected" tree, usually produced by the
 * Python pipeline, and an "actual" tree produced by the TypeScript port) and reports
 * whether they are equivalent under the rules in §7.2:
 *   - `.json` files are compared structurally (object key order ignored, array order
 *     significant, numbers must be value-equal with no tolerance).
 *   - every other file (`.csv`, `.xml`, `.md`, `.html`, `.txt`, unknown extensions, ...)
 *     is compared byte-for-byte.
 *   - shard assignment is file-set equality (missing/extra files are reported).
 */

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export type DiffKind =
  | "missing-in-actual"
  | "missing-in-expected"
  | "type-mismatch"
  | "value-mismatch"
  | "length-mismatch";

export interface JsonDiffEntry {
  /** RFC 6901 JSON pointer, e.g. "/items/0/score". Root is "". */
  pointer: string;
  kind: DiffKind;
  expected?: unknown;
  actual?: unknown;
}

export interface FileResult {
  /** Posix-style path relative to the tree root. */
  path: string;
  kind: "json" | "binary";
  equal: boolean;
  diffs?: JsonDiffEntry[];
  /** Set instead of `diffs` when one or both sides failed to parse as JSON. */
  parseError?: string;
  expectedSize?: number;
  actualSize?: number;
}

/** One entry of the optional `--json-rules` file. */
export interface IgnoreRule {
  /** Glob matched against the file's posix-style relative path. */
  glob: string;
  /** RFC 6901 JSON pointers to ignore in files matching `glob`. A `*` segment matches any key/index. */
  pointers: string[];
}

export interface RulesFile {
  ignore?: IgnoreRule[];
}

/** Reported even when the ignored field does not actually differ, so nothing is silently skipped. */
export interface IgnoredPointerEntry {
  file: string;
  glob: string;
  pointers: string[];
}

export interface ParitySummary {
  filesCompared: number;
  filesEqual: number;
  filesDiffering: number;
  missing: number;
  extra: number;
}

interface ParityReportBase {
  mode: "compare-trees" | "expect-unchanged";
  equal: boolean;
  durationMs: number;
  /** Present in expected/snapshot tree but absent from actual/dir tree. */
  missingFiles: string[];
  /** Present in actual/dir tree but absent from expected/snapshot tree. */
  extraFiles: string[];
  fileResults: FileResult[];
  summary: ParitySummary;
}

export interface CompareTreesReport extends ParityReportBase {
  mode: "compare-trees";
  expectedRoot: string;
  actualRoot: string;
  rulesFile?: string;
  ignoredPointers: IgnoredPointerEntry[];
}

export interface ExpectUnchangedReport extends ParityReportBase {
  mode: "expect-unchanged";
  dir: string;
  snapshot: string;
  command?: string;
  commandExitCode?: number;
  expectedExitCode?: number;
  commandExitOk?: boolean;
}

export type ParityReport = CompareTreesReport | ExpectUnchangedReport;
