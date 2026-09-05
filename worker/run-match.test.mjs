import { pickMatchingRun } from "./run-match.js";

let passed = 0;
let failed = 0;
const failures = [];
function test(name, fn) {
  try {
    fn();
    passed++;
    process.stdout.write(`  ok  ${name}\n`);
  } catch (error) {
    failed++;
    failures.push({ name, error });
    process.stdout.write(`  FAIL ${name}\n    ${error.message}\n`);
  }
}
function eq(actual, expected) {
  if (actual !== expected) throw new Error(`expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
function isNull(value) {
  if (value !== null) throw new Error(`expected null, got ${JSON.stringify(value)}`);
}
function mkRun(theme, requestId, overrides = {}) {
  return {
    status: "completed",
    conclusion: "success",
    html_url: `https://x/${requestId}`,
    created_at: "2026-08-30T00:00:00Z",
    run_started_at: "2026-08-30T00:00:05Z",
    display_title: `theme-on-demand: ${theme} / ${requestId}`,
    ...overrides,
  };
}

const ID_A = "theme-123e4567-e89b-42d3-a456-426614174000";
const ID_B = "theme-123e4567-e89b-42d3-b456-426614174001";

console.log("pickMatchingRun request-ID tests:");
test("returns null when runs is missing", () => {
  isNull(pickMatchingRun(undefined, ID_A));
  isNull(pickMatchingRun(null, ID_A));
});
test("returns null when runs is not an array", () => {
  isNull(pickMatchingRun({}, ID_A));
  isNull(pickMatchingRun("runs", ID_A));
});
test("rejects blank, malformed, and non-string IDs", () => {
  isNull(pickMatchingRun([mkRun("RAG", ID_A)], ""));
  isNull(pickMatchingRun([mkRun("RAG", ID_A)], "theme-bad"));
  isNull(pickMatchingRun([mkRun("RAG", ID_A)], null));
});
test("matches an exact request-ID suffix", () => {
  eq(pickMatchingRun([mkRun("RAG", ID_A)], ID_A)?.html_url, `https://x/${ID_A}`);
});
test("same theme with a different ID does not match", () => {
  isNull(pickMatchingRun([mkRun("RAG", ID_B)], ID_A));
});
test("different theme with the requested ID still correlates", () => {
  eq(pickMatchingRun([mkRun("Vision Transformer", ID_A)], ID_A)?.display_title,
    `theme-on-demand: Vision Transformer / ${ID_A}`);
});
test("returns the first matching run in API order", () => {
  const runs = [
    mkRun("RAG", ID_A, { html_url: "https://x/new" }),
    mkRun("RAG", ID_A, { html_url: "https://x/old" }),
  ];
  eq(pickMatchingRun(runs, ID_A)?.html_url, "https://x/new");
});
test("does not match an ID appearing before the suffix", () => {
  const run = mkRun("RAG", ID_B, {
    display_title: `theme-on-demand: ${ID_A} / ${ID_B}`,
  });
  isNull(pickMatchingRun([run], ID_A));
});
test("ignores a non-string display_title", () => {
  const bad = { ...mkRun("RAG", ID_A), display_title: null };
  eq(pickMatchingRun([bad, mkRun("RAG", ID_A)], ID_A)?.html_url, `https://x/${ID_A}`);
});
test("does not trim or case-normalise opaque IDs", () => {
  isNull(pickMatchingRun([mkRun("RAG", ID_A)], ` ${ID_A}`));
  isNull(pickMatchingRun([mkRun("RAG", ID_A)], ID_A.toUpperCase()));
});
test("returns only the explicit public run fields", () => {
  const run = mkRun("RAG", ID_A, {
    status: "in_progress",
    conclusion: null,
    head_sha: "must-not-leak",
    actor: { login: "must-not-leak" },
  });
  const match = pickMatchingRun([run], ID_A);
  eq(match?.status, "in_progress");
  eq(match?.conclusion, null);
  eq(Object.hasOwn(match, "head_sha"), false);
  eq(Object.hasOwn(match, "actor"), false);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  for (const item of failures) console.log(`  - ${item.name}: ${item.error.stack || item.error.message}`);
  process.exit(1);
}
