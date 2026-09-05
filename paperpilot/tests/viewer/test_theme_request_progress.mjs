// Unit test for the theme-request progress polling pure helpers.
//
// docs/assets/theme.js exposes failureFromRun() + progressPercentFor()
// as module-local functions. We can't import them directly (theme.js
// runs at module load and touches document.* — which doesn't exist in
// node), so we follow the same trick as test_theme_xaxis_layout.mjs:
// read the source, splice out just the pure-helper definitions, and
// eval them in this scope.
//
// What this guards:
//   - failureFromRun maps every terminal conclusion to a localised
//     failure block (title / message / runUrl) and returns null for
//     non-terminal / success states. A silent regression here would
//     leave users staring at the spinner after the workflow died.
//   - progressPercentFor returns 0..100 monotonically increasing per
//     PROGRESS_STEPS, with the unknown-step → 0 fallback so a typo
//     in the HTML data-step value can't crash the DOM helper.
//   - PROGRESS_STEPS stays in sync with the HTML data-step values
//     (read both files, intersect).
//
// Run via: node paperpilot/tests/viewer/test_theme_request_progress.mjs

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const THEME_JS = resolve(__dirname, "../../../docs/assets/theme.js");
const INDEX_HTML = resolve(__dirname, "../../../docs/themes/index.html");

const themeSrc = readFileSync(THEME_JS, "utf8");
const indexSrc = readFileSync(INDEX_HTML, "utf8");

// ---- helper extraction ----
function extractFunction(src, name) {
  // Match: function NAME(...args) { ... } including nested braces.
  const re = new RegExp(`function\\s+${name}\\s*\\([^)]*\\)\\s*\\{`);
  const m = src.match(re);
  if (!m) throw new Error(`could not find function ${name} in theme.js`);
  const start = m.index;
  let depth = 0;
  let i = src.indexOf("{", start);
  for (; i < src.length; i++) {
    const c = src[i];
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) {
        return src.slice(start, i + 1);
      }
    }
  }
  throw new Error(`could not find end of function ${name}`);
}

function extractConst(src, name) {
  // Match: const NAME = ...; or const NAME = [...]; — single-line for arrays.
  const re = new RegExp(`const\\s+${name}\\s*=[^;]+;`, "m");
  const m = src.match(re);
  if (!m) throw new Error(`could not find const ${name}`);
  return m[0];
}

const code = [
  extractConst(themeSrc, "PROGRESS_STEPS"),
  extractConst(themeSrc, "REQUEST_ID_RE"),
  extractFunction(themeSrc, "failureFromRun"),
  extractFunction(themeSrc, "progressPercentFor"),
  extractFunction(themeSrc, "statusUrlForRequest"),
  // Return the helpers as a record so the caller picks them up cleanly
  // — avoids the TDZ surprises that bite eval-into-let scoping in ESM.
  "return { PROGRESS_STEPS, REQUEST_ID_RE, failureFromRun, progressPercentFor, statusUrlForRequest };",
].join("\n");

// new Function gives us a fresh function scope with no TDZ traps.
const helpers = new Function(code)();
const {
  PROGRESS_STEPS,
  REQUEST_ID_RE,
  failureFromRun,
  progressPercentFor,
  statusUrlForRequest,
} = helpers;

// ---- mini assertion harness ----
let passed = 0;
let failed = 0;
function ok(cond, label) {
  if (cond) {
    console.log(`  ok  ${label}`);
    passed++;
  } else {
    console.log(`  FAIL ${label}`);
    failed++;
  }
}

// ---- tests ----

console.log("PROGRESS_STEPS contract");
ok(Array.isArray(PROGRESS_STEPS), "PROGRESS_STEPS is an array");
ok(PROGRESS_STEPS.length >= 3, "PROGRESS_STEPS has at least 3 entries");
ok(PROGRESS_STEPS.includes("ready"), 'PROGRESS_STEPS includes "ready"');

// HTML must list a <li data-step="..."> for every JS step value, in order.
const htmlSteps = [...indexSrc.matchAll(/<li[^>]*data-step="([^"]+)"/g)].map(
  (m) => m[1],
);
ok(htmlSteps.length === PROGRESS_STEPS.length,
   `HTML data-step list length matches PROGRESS_STEPS (got ${htmlSteps.length}, want ${PROGRESS_STEPS.length})`);
for (let i = 0; i < PROGRESS_STEPS.length; i++) {
  ok(htmlSteps[i] === PROGRESS_STEPS[i],
     `HTML data-step[${i}] = "${htmlSteps[i]}" matches JS PROGRESS_STEPS[${i}] = "${PROGRESS_STEPS[i]}"`);
}

console.log("\nprogressPercentFor");
ok(progressPercentFor("dispatch") === 0,
   "dispatch is at 0%");
ok(progressPercentFor("ready") === 100,
   "ready is at 100%");
ok(progressPercentFor("queue") > 0 && progressPercentFor("queue") < 100,
   "queue is strictly between 0 and 100");
// Monotonic per step list
for (let i = 1; i < PROGRESS_STEPS.length; i++) {
  const prev = progressPercentFor(PROGRESS_STEPS[i - 1]);
  const cur = progressPercentFor(PROGRESS_STEPS[i]);
  ok(cur > prev,
     `percent increases from "${PROGRESS_STEPS[i-1]}" (${prev}) to "${PROGRESS_STEPS[i]}" (${cur})`);
}
ok(progressPercentFor("unknown-step") === 0,
   "unknown step falls back to 0% (defensive)");

console.log("\nrequest ID polling");
const requestId = "theme-123e4567-e89b-42d3-a456-426614174000";
ok(REQUEST_ID_RE.test(requestId), "generated request ID format is accepted");
ok(statusUrlForRequest("https://worker.example/", requestId) ===
   `https://worker.example/api/themes/status?request_id=${requestId}`,
   "status polling uses request_id and normalises trailing slash");
ok(statusUrlForRequest("https://worker.example", "bad") === null,
   "malformed request ID cannot trigger status polling");
ok(statusUrlForRequest("https://worker.example", `${requestId}\n`) === null,
   "line-terminated request ID cannot trigger status polling");
ok(statusUrlForRequest("", requestId) === null,
   "missing API base disables status polling");

console.log("\nfailureFromRun");
ok(failureFromRun(null) === null, "null run → null");
ok(failureFromRun(undefined) === null, "undefined run → null");
ok(failureFromRun({ status: "queued" }) === null,
   "queued run → null (still in flight)");
ok(failureFromRun({ status: "in_progress" }) === null,
   "in_progress run → null (still in flight)");
ok(failureFromRun({ status: "completed", conclusion: "success" }) === null,
   "completed/success → null (manifest poll handles success)");

const failure = failureFromRun({
  status: "completed",
  conclusion: "failure",
  html_url: "https://github.com/owner/repo/actions/runs/123",
});
ok(failure !== null, "failure conclusion → object");
ok(typeof failure?.title === "string" && failure.title.length > 0,
   "failure has non-empty title");
ok(typeof failure?.message === "string" && failure.message.length > 0,
   "failure has non-empty message");
ok(failure?.runUrl === "https://github.com/owner/repo/actions/runs/123",
   "failure preserves run html_url");

const cancelled = failureFromRun({
  status: "completed",
  conclusion: "cancelled",
});
ok(cancelled !== null, "cancelled conclusion → object");
ok(cancelled?.runUrl === "",
   "missing html_url → empty string (no broken link)");

const timedOut = failureFromRun({
  status: "completed",
  conclusion: "timed_out",
  html_url: "https://x/run/9",
});
ok(timedOut !== null, "timed_out conclusion → object");
ok(timedOut.title.includes("タイムアウト"),
   "timed_out title mentions timeout (i18n smoke)");

ok(failureFromRun({ status: "completed", conclusion: "neutral" }) === null,
   "unknown conclusion (e.g. neutral) → null (don't surface fake failures)");

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
