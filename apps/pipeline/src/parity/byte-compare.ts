import path from "node:path";
import { listFiles, readFileBytes } from "./fs-tree.js";
import type { ExpectUnchangedReport, FileResult, ParitySummary } from "./types.js";

export interface CompareByteExactOptions {
  /** Directory that must be unchanged (e.g. the output directory after a refused write). */
  dir: string;
  /** Known-good snapshot to compare `dir` against. */
  snapshot: string;
}

/**
 * Failure-path check (§7.2): asserts `dir` is byte-identical to `snapshot`, file set
 * included. Every file is compared byte-for-byte regardless of extension — this mode
 * is about "nothing was written", not structural JSON equivalence.
 */
export async function compareTreesByteExact(
  options: CompareByteExactOptions,
): Promise<ExpectUnchangedReport> {
  const start = Date.now();

  const [dirFiles, snapshotFiles] = await Promise.all([
    listFiles(options.dir),
    listFiles(options.snapshot),
  ]);
  const dirSet = new Set(dirFiles);
  const snapshotSet = new Set(snapshotFiles);

  const missingFiles = snapshotFiles.filter((f) => !dirSet.has(f)).sort();
  const extraFiles = dirFiles.filter((f) => !snapshotSet.has(f)).sort();
  const common = snapshotFiles.filter((f) => dirSet.has(f)).sort();

  const fileResults: FileResult[] = [];
  for (const relPath of common) {
    const [a, b] = await Promise.all([
      readFileBytes(path.join(options.dir, relPath)),
      readFileBytes(path.join(options.snapshot, relPath)),
    ]);
    const equal = a.equals(b);
    const result: FileResult = { path: relPath, kind: "binary", equal };
    if (!equal) {
      result.actualSize = a.length;
      result.expectedSize = b.length;
    }
    fileResults.push(result);
  }

  const summary: ParitySummary = {
    filesCompared: fileResults.length,
    filesEqual: fileResults.filter((f) => f.equal).length,
    filesDiffering: fileResults.filter((f) => !f.equal).length,
    missing: missingFiles.length,
    extra: extraFiles.length,
  };

  const equal =
    missingFiles.length === 0 && extraFiles.length === 0 && summary.filesDiffering === 0;

  return {
    mode: "expect-unchanged",
    dir: options.dir,
    snapshot: options.snapshot,
    equal,
    durationMs: Date.now() - start,
    missingFiles,
    extraFiles,
    fileResults,
    summary,
  };
}
