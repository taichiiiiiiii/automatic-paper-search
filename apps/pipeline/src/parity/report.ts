import type { ParityReport } from "./types.js";

const MAX_LISTED = 20;
const MAX_DIFFS_PER_FILE = 10;

function listLines(label: string, items: readonly string[]): string[] {
  if (items.length === 0) return [];
  const lines = [`  ${label} (${items.length}):`];
  for (const item of items.slice(0, MAX_LISTED)) {
    lines.push(`    - ${item}`);
  }
  if (items.length > MAX_LISTED) {
    lines.push(`    ... and ${items.length - MAX_LISTED} more`);
  }
  return lines;
}

export function formatSummary(report: ParityReport): string {
  const lines: string[] = [];
  lines.push(`Parity check (${report.mode}): ${report.equal ? "PASS" : "FAIL"}`);

  if (report.mode === "compare-trees") {
    lines.push(`  expected: ${report.expectedRoot}`);
    lines.push(`  actual:   ${report.actualRoot}`);
    if (report.rulesFile) lines.push(`  rules:    ${report.rulesFile}`);
  } else {
    lines.push(`  dir:      ${report.dir}`);
    lines.push(`  snapshot: ${report.snapshot}`);
    if (report.command !== undefined) {
      lines.push(`  command:  ${report.command}`);
      lines.push(`  exit code: ${report.commandExitCode} (expected ${report.expectedExitCode})`);
    }
  }

  lines.push(
    `  files: ${report.summary.filesCompared} compared, ${report.summary.filesEqual} equal, ` +
      `${report.summary.filesDiffering} differing, ${report.summary.missing} missing, ${report.summary.extra} extra`,
  );

  lines.push(...listLines("missing files", report.missingFiles));
  lines.push(...listLines("extra files", report.extraFiles));

  const differing = report.fileResults.filter((f) => !f.equal);
  if (differing.length > 0) {
    lines.push(`  differing files (${differing.length}):`);
    for (const file of differing.slice(0, MAX_LISTED)) {
      lines.push(`    - ${file.path} (${file.kind})`);
      if (file.parseError) {
        lines.push(`        parse error: ${file.parseError}`);
      } else if (file.diffs) {
        for (const diff of file.diffs.slice(0, MAX_DIFFS_PER_FILE)) {
          lines.push(
            `        ${diff.pointer || "(root)"}: ${diff.kind} expected=${stringify(diff.expected)} actual=${stringify(diff.actual)}`,
          );
        }
        if (file.diffs.length > MAX_DIFFS_PER_FILE) {
          lines.push(`        ... and ${file.diffs.length - MAX_DIFFS_PER_FILE} more diffs`);
        }
      } else if (file.kind === "binary") {
        lines.push(
          `        byte mismatch (expected ${file.expectedSize} bytes, actual ${file.actualSize} bytes)`,
        );
      }
    }
    if (differing.length > MAX_LISTED) {
      lines.push(`    ... and ${differing.length - MAX_LISTED} more`);
    }
  }

  if (report.mode === "compare-trees" && report.ignoredPointers.length > 0) {
    lines.push(`  ignored pointers (${report.ignoredPointers.length}):`);
    for (const entry of report.ignoredPointers.slice(0, MAX_LISTED)) {
      lines.push(`    - ${entry.file} [${entry.glob}]: ${entry.pointers.join(", ")}`);
    }
    if (report.ignoredPointers.length > MAX_LISTED) {
      lines.push(`    ... and ${report.ignoredPointers.length - MAX_LISTED} more`);
    }
  }

  lines.push(`  duration: ${report.durationMs}ms`);
  return lines.join("\n");
}

function stringify(value: unknown): string {
  if (value === undefined) return "<absent>";
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
