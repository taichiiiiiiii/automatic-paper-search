// Unit tests for the run-matching logic in worker/run-match.js.
//
// The full `findRecentRun` in index.ts owns the GitHub API fetch plus
// this pure-logic step — splitting the match out lets us exercise
// every branch without an HTTP mock. Mirrors the existing pattern of
// worker/slug.test.mjs / worker/response.test.mjs (Node's built-in
// test runner, no TS).

import { pickMatchingRun } from "./run-match.js";

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed++;
    process.stdout.write(`  ok  ${name}\n`);
  } catch (e) {
    failed++;
    failures.push({ name, e });
    process.stdout.write(`  FAIL ${name}\n    ${e.message}\n`);
  }
}

function eq(a, b, msg = "") {
  if (a !== b) throw new Error(`${msg}\n    expected: ${JSON.stringify(b)}\n    actual:   ${JSON.stringify(a)}`);
}

function isNull(v, msg = "") {
  if (v !== null) throw new Error(`${msg}\n    expected null, got: ${JSON.stringify(v)}`);
}

function mkRun(title, overrides = {}) {
  return {
    status: "completed",
    conclusion: "success",
    html_url: `https://x/${title}`,
    created_at: "2026-05-26T00:00:00Z",
    run_started_at: "2026-05-26T00:00:05Z",
    display_title: title,
    ...overrides,
  };
}

console.log("pickMatchingRun tests:");

test("returns null when runs is missing", () => {
  isNull(pickMatchingRun(undefined, "Theme"));
  isNull(pickMatchingRun(null, "Theme"));
});

test("returns null when runs is not an array", () => {
  isNull(pickMatchingRun("not-an-array", "Theme"));
  isNull(pickMatchingRun({}, "Theme"));
});

test("returns null when theme is missing or non-string", () => {
  isNull(pickMatchingRun([mkRun("theme-on-demand: X")], ""));
  isNull(pickMatchingRun([mkRun("theme-on-demand: X")], "   "));
  isNull(pickMatchingRun([mkRun("theme-on-demand: X")], null));
  isNull(pickMatchingRun([mkRun("theme-on-demand: X")], 42));
});

test("matches when display_title ends with ': <theme>'", () => {
  const r = pickMatchingRun(
    [mkRun("theme-on-demand: Vision Transformer")],
    "Vision Transformer",
  );
  eq(r?.display_title, "theme-on-demand: Vision Transformer");
});

test("returns the FIRST matching run (API returns desc by created_at)", () => {
  // Two matches; the array order encodes recency. Pick the first.
  const runs = [
    mkRun("theme-on-demand: RAG", { created_at: "2026-05-26T10:00:00Z", html_url: "https://x/new" }),
    mkRun("theme-on-demand: RAG", { created_at: "2026-05-26T09:00:00Z", html_url: "https://x/old" }),
  ];
  const r = pickMatchingRun(runs, "RAG");
  eq(r?.html_url, "https://x/new");
});

test("skips non-matching runs that share a substring", () => {
  // The endsWith rule (": <theme>") prevents "Optim" from matching
  // a "Hyperparam Optim" run.
  const runs = [
    mkRun("theme-on-demand: Hyperparam Optim"),
    mkRun("theme-on-demand: Optim"),
  ];
  const r = pickMatchingRun(runs, "Optim");
  eq(r?.display_title, "theme-on-demand: Optim");
});

test("substring-anywhere does not match — only suffix after ': '", () => {
  // A run for a different theme that happens to mention our theme
  // in the middle of its title must NOT match.
  const r = pickMatchingRun(
    [mkRun("Run about Vision Transformer and others")],
    "Vision Transformer",
  );
  isNull(r);
});

test("ignores runs with non-string display_title", () => {
  const runs = [
    { ...mkRun("real"), display_title: null },
    { ...mkRun("real"), display_title: 42 },
    mkRun("theme-on-demand: TT"),
  ];
  const r = pickMatchingRun(runs, "TT");
  eq(r?.display_title, "theme-on-demand: TT");
});

test("trims whitespace from the supplied theme", () => {
  const r = pickMatchingRun(
    [mkRun("theme-on-demand: BERT")],
    "  BERT  ",
  );
  eq(r?.display_title, "theme-on-demand: BERT");
});

test("returns null when no run matches", () => {
  const r = pickMatchingRun(
    [mkRun("theme-on-demand: Other")],
    "Vision Transformer",
  );
  isNull(r);
});

test("preserves the full run object on match", () => {
  const run = mkRun("theme-on-demand: T", {
    status: "in_progress",
    conclusion: null,
    run_started_at: "2026-05-26T01:00:00Z",
  });
  const r = pickMatchingRun([run], "T");
  eq(r?.status, "in_progress");
  eq(r?.conclusion, null);
  eq(r?.run_started_at, "2026-05-26T01:00:00Z");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  for (const f of failures) console.log(`  - ${f.name}: ${f.e.stack || f.e.message}`);
  process.exit(1);
}
