/**
 * `no-skip-gate` (p5-plan.md §2 A4). The report shapes below mirror the
 * REAL `vitest run --reporter=json` output, confirmed once offline
 * against a throwaway spec with one passing, one `it.skip`, and one
 * `it.todo` test (recorded in this changeset's handback) — not guessed
 * from Jest's differently-named fields.
 */
import { expect, it } from "vitest";
import { checkNoSkip, NoSkipGateError, runNoSkipGate } from "../../src/release/noSkipGate.js";

function report(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    numTotalTests: 3,
    numPendingTests: 0,
    numTodoTests: 0,
    testResults: [
      {
        name: "probe.test.ts",
        assertionResults: [
          { title: "passes", status: "passed" },
          { title: "also passes", status: "passed" },
          { title: "fails", status: "failed" },
        ],
      },
    ],
    ...overrides,
  };
}

it("checkNoSkip passes a clean all-passed/failed report", () => {
  expect(() => checkNoSkip(report(), "x.json")).not.toThrow();
});

it("checkNoSkip rejects a report with any pending (skipped) test", () => {
  expect(() => checkNoSkip(report({ numPendingTests: 1 }), "x.json")).toThrow(/pending/);
});

it("checkNoSkip rejects a report with any todo test", () => {
  expect(() => checkNoSkip(report({ numTodoTests: 1 }), "x.json")).toThrow(/todo/);
});

it("checkNoSkip rejects a zero-test report (misconfigured/misdirected reporter)", () => {
  expect(() => checkNoSkip(report({ numTotalTests: 0, testResults: [] }), "x.json")).toThrow(
    /zero total tests/,
  );
});

it("checkNoSkip rejects an assertionResults entry with a status outside passed/failed (e.g. real vitest 'skipped'/'todo')", () => {
  const withSkippedAssertion = report({
    testResults: [
      {
        name: "probe.test.ts",
        assertionResults: [
          { title: "passes", status: "passed" },
          { title: "is skipped", status: "skipped" },
        ],
      },
    ],
  });
  expect(() => checkNoSkip(withSkippedAssertion, "x.json")).toThrow(/is skipped/);
});

it("checkNoSkip rejects a non-object report", () => {
  expect(() => checkNoSkip(null, "x.json")).toThrow(/not a vitest JSON report/);
  expect(() => checkNoSkip("oops", "x.json")).toThrow(/not a vitest JSON report/);
});

it("runNoSkipGate rejects invalid JSON with the offending path named", () => {
  expect(() => runNoSkipGate(["a.json"], { readFile: () => "{not json" })).toThrow(
    /a\.json: invalid JSON/,
  );
});

it("runNoSkipGate checks every path given, not just the first", () => {
  const files: Record<string, string> = {
    "good.json": JSON.stringify(report()),
    "bad.json": JSON.stringify(report({ numPendingTests: 2 })),
  };
  expect(() =>
    runNoSkipGate(["good.json", "bad.json"], { readFile: (p) => files[p] as string }),
  ).toThrow(/bad\.json/);
});

it("runNoSkipGate requires at least one path", () => {
  expect(() => runNoSkipGate([])).toThrow(NoSkipGateError);
});

it("runNoSkipGate passes when every report is clean", () => {
  const files: Record<string, string> = {
    "a.json": JSON.stringify(report()),
    "b.json": JSON.stringify(report()),
  };
  expect(() =>
    runNoSkipGate(["a.json", "b.json"], { readFile: (p) => files[p] as string }),
  ).not.toThrow();
});
