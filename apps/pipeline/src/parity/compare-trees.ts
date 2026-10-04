import path from "node:path";
import { listFiles, readFileBytes, readFileText } from "./fs-tree.js";
import { diffJsonValues } from "./json-diff.js";
import { rulesForFile, toIgnoreSegments } from "./rules.js";
import type {
  CompareTreesReport,
  FileResult,
  IgnoredPointerEntry,
  JsonValue,
  ParitySummary,
  RulesFile,
} from "./types.js";

export interface CompareTreesOptions {
  expectedRoot: string;
  actualRoot: string;
  rules?: RulesFile;
  rulesFile?: string;
}

function isJsonPath(relPath: string): boolean {
  return relPath.toLowerCase().endsWith(".json");
}

/**
 * Compares two output trees per §7.2: `.json` files structurally (format-only float
 * differences and key order are tolerated, array order and values are not), every
 * other file byte-for-byte, and the file sets for missing/extra (shard) entries.
 */
export async function compareTrees(options: CompareTreesOptions): Promise<CompareTreesReport> {
  const start = Date.now();
  const rules = options.rules ?? {};

  const [expectedListing, actualListing] = await Promise.all([
    listFiles(options.expectedRoot),
    listFiles(options.actualRoot),
  ]);
  const expectedFiles = expectedListing.files;
  const actualFiles = actualListing.files;
  const expectedSet = new Set(expectedFiles);
  const actualSet = new Set(actualFiles);
  const skippedEntries = [
    ...expectedListing.skipped.map((s) => ({ side: "expected" as const, ...s })),
    ...actualListing.skipped.map((s) => ({ side: "actual" as const, ...s })),
  ];

  const missingFiles = expectedFiles.filter((f) => !actualSet.has(f)).sort();
  const extraFiles = actualFiles.filter((f) => !expectedSet.has(f)).sort();
  const common = expectedFiles.filter((f) => actualSet.has(f)).sort();

  const fileResults: FileResult[] = [];
  const ignoredPointers: IgnoredPointerEntry[] = [];

  for (const relPath of common) {
    const expectedAbs = path.join(options.expectedRoot, relPath);
    const actualAbs = path.join(options.actualRoot, relPath);

    if (isJsonPath(relPath)) {
      fileResults.push(
        await compareJsonFile(relPath, expectedAbs, actualAbs, rules, ignoredPointers),
      );
    } else {
      fileResults.push(await compareBinaryFile(relPath, expectedAbs, actualAbs));
    }
  }

  const summary: ParitySummary = {
    filesCompared: fileResults.length,
    filesEqual: fileResults.filter((f) => f.equal).length,
    filesDiffering: fileResults.filter((f) => !f.equal).length,
    missing: missingFiles.length,
    extra: extraFiles.length,
  };

  const equal =
    missingFiles.length === 0 &&
    extraFiles.length === 0 &&
    summary.filesDiffering === 0 &&
    skippedEntries.length === 0;

  const report: CompareTreesReport = {
    mode: "compare-trees",
    expectedRoot: options.expectedRoot,
    actualRoot: options.actualRoot,
    equal,
    durationMs: Date.now() - start,
    missingFiles,
    extraFiles,
    fileResults,
    summary,
    ignoredPointers,
    skippedEntries,
  };
  if (options.rulesFile) report.rulesFile = options.rulesFile;
  return report;
}

async function compareJsonFile(
  relPath: string,
  expectedAbs: string,
  actualAbs: string,
  rules: RulesFile,
  ignoredPointers: IgnoredPointerEntry[],
): Promise<FileResult> {
  let expectedText: string;
  let actualText: string;
  try {
    expectedText = await readFileText(expectedAbs);
  } catch (err) {
    return {
      path: relPath,
      kind: "json",
      equal: false,
      parseError: `expected: ${(err as Error).message}`,
    };
  }
  try {
    actualText = await readFileText(actualAbs);
  } catch (err) {
    return {
      path: relPath,
      kind: "json",
      equal: false,
      parseError: `actual: ${(err as Error).message}`,
    };
  }

  let expectedValue: JsonValue;
  let actualValue: JsonValue;
  try {
    expectedValue = JSON.parse(expectedText);
  } catch (err) {
    return {
      path: relPath,
      kind: "json",
      equal: false,
      parseError: `expected: ${(err as Error).message}`,
    };
  }
  try {
    actualValue = JSON.parse(actualText);
  } catch (err) {
    return {
      path: relPath,
      kind: "json",
      equal: false,
      parseError: `actual: ${(err as Error).message}`,
    };
  }

  const matched = rulesForFile(rules, relPath);
  for (const m of matched) {
    ignoredPointers.push({ file: relPath, glob: m.glob, pointers: m.pointers });
  }
  const ignoreSegments = toIgnoreSegments(matched);

  const diffs = diffJsonValues(expectedValue, actualValue, ignoreSegments);
  return { path: relPath, kind: "json", equal: diffs.length === 0, diffs };
}

async function compareBinaryFile(
  relPath: string,
  expectedAbs: string,
  actualAbs: string,
): Promise<FileResult> {
  const [expectedBuf, actualBuf] = await Promise.all([
    readFileBytes(expectedAbs),
    readFileBytes(actualAbs),
  ]);
  const equal = expectedBuf.equals(actualBuf);
  const result: FileResult = { path: relPath, kind: "binary", equal };
  if (!equal) {
    result.expectedSize = expectedBuf.length;
    result.actualSize = actualBuf.length;
  }
  return result;
}
