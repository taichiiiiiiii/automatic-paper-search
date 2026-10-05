/**
 * `no-skip-gate <vitest-json-report>...` — p5-plan.md §2 A4, §3 "Validate"
 * step 2's parenthetical ("reporter json -> `no-skip-gate`; the shell
 * promoter did not enforce no-skip, the release did. Keep that split").
 *
 * Reads one or more Vitest `--reporter=json` output files and fails if
 * any test was skipped, is `todo`, has any status other than
 * `passed`/`failed`, or if a report has zero tests at all (a `0
 * numTotalTests` report is what an unconfigured/mispointed reporter
 * produces, and that must not pass silently as "no skips found").
 *
 * The exact field names (`numTotalTests`, `numPendingTests`,
 * `numTodoTests`, `testResults[].assertionResults[].status` with values
 * `"passed"`/`"failed"`/`"skipped"`/`"todo"`) were confirmed by running
 * `vitest run --reporter=json` once offline against a throwaway spec
 * with one passing, one `it.skip`, and one `it.todo` test (recorded in
 * this changeset's handback) — not guessed from Jest's differently-named
 * fields.
 */
import { readFileSync } from "node:fs";

export class NoSkipGateError extends Error {}

interface VitestAssertionResult {
  status?: string;
  title?: string;
  fullName?: string;
}

interface VitestTestResult {
  assertionResults?: VitestAssertionResult[];
  name?: string;
}

interface VitestJsonReport {
  numTotalTests?: number;
  numPendingTests?: number;
  numTodoTests?: number;
  testResults?: VitestTestResult[];
}

const ALLOWED_STATUSES = new Set(["passed", "failed"]);

/** Checks one already-parsed report. `path` is only for error messages. */
export function checkNoSkip(report: unknown, path: string): void {
  if (typeof report !== "object" || report === null) {
    throw new NoSkipGateError(`${path}: not a vitest JSON report (not an object)`);
  }
  const r = report as VitestJsonReport;
  if (typeof r.numTotalTests !== "number" || r.numTotalTests === 0) {
    throw new NoSkipGateError(
      `${path}: report has zero total tests (misconfigured or misdirected reporter?)`,
    );
  }
  if ((r.numPendingTests ?? 0) > 0) {
    throw new NoSkipGateError(`${path}: ${r.numPendingTests} pending (skipped) test(s)`);
  }
  if ((r.numTodoTests ?? 0) > 0) {
    throw new NoSkipGateError(`${path}: ${r.numTodoTests} todo test(s)`);
  }
  for (const suite of r.testResults ?? []) {
    for (const assertion of suite.assertionResults ?? []) {
      if (assertion.status === undefined || !ALLOWED_STATUSES.has(assertion.status)) {
        const title = assertion.fullName ?? assertion.title ?? "<unknown test>";
        throw new NoSkipGateError(
          `${path}: test ${JSON.stringify(title)} has status ${JSON.stringify(assertion.status)}`,
        );
      }
    }
  }
}

export interface RunNoSkipGateOptions {
  /** Injectable for tests; defaults to reading the file from disk. */
  readFile?: (path: string) => string;
}

/** `no-skip-gate <path>...`: every path must parse as JSON and pass {@link checkNoSkip}. */
export function runNoSkipGate(paths: readonly string[], options: RunNoSkipGateOptions = {}): void {
  if (paths.length === 0) {
    throw new NoSkipGateError("usage: no-skip-gate <vitest-json-report>...");
  }
  const readFile = options.readFile ?? ((path: string) => readFileSync(path, "utf-8"));
  for (const path of paths) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFile(path));
    } catch (exc) {
      throw new NoSkipGateError(`${path}: invalid JSON (${(exc as Error).message})`);
    }
    checkNoSkip(parsed, path);
  }
}
