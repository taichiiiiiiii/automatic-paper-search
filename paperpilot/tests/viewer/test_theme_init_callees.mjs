// Static-analysis regression test for the init() flow in docs/assets/theme.js.
//
// Why this exists:
//
// PR #229 (2026-05-30) removed a helper function (`populateThemeDatalist`)
// from theme.js but left the call site inside `init()`. The viewer's
// existing test suite (test_theme_xaxis_layout.mjs) only exercises pure
// layout / encoding functions — it never invokes init() — so the
// "ReferenceError: populateThemeDatalist is not defined" thrown on every
// page load shipped to production. The lineage SVG silently stayed empty
// for ~5 days until somebody (me, in PR #243) opened the page in a real
// browser.
//
// This test is a cheap, dependency-free guard against that exact class
// of bug: for every identifier called inside `init()`, assert it is
// either defined in theme.js or is a known JS/DOM builtin. No Playwright,
// no DOM emulation, no live network — just text + a small allowlist.
//
// Run via: node paperpilot/tests/viewer/test_theme_init_callees.mjs

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const THEME_JS = resolve(__dirname, "../../../docs/assets/theme.js");

// JS / browser builtins + DOM APIs theme.js may reasonably reference
// without a local definition. Keep this list narrow: a typo in a real
// helper should NOT be silently accepted by appearing here.
const BUILTINS = new Set([
  // Async / promise primitives
  "Promise", "Symbol", "fetch", "requestAnimationFrame", "setTimeout",
  "clearTimeout", "setInterval", "clearInterval", "queueMicrotask",
  // Console + error / debug
  "console", "Error", "TypeError", "RangeError",
  // Constructor / coercion helpers
  "Map", "Set", "WeakMap", "WeakSet", "Array", "Object", "Number", "String",
  "Boolean", "Date", "RegExp", "JSON", "Math",
  // Iteration helpers
  "isNaN", "isFinite", "parseInt", "parseFloat",
  // DOM globals
  "document", "window", "location", "history", "localStorage",
  "sessionStorage", "URL", "URLSearchParams", "navigator",
  // Event constructors
  "Event", "CustomEvent", "KeyboardEvent", "MouseEvent",
  // Encoders
  "encodeURIComponent", "decodeURIComponent",
  // Workers, network probes — theme.js does not use these but harmless
  "AbortController", "Headers", "Request", "Response",
]);

const src = readFileSync(THEME_JS, "utf8");

// Find init() body. Matches `async function init() {` through to the
// matching closing brace at the start of a line — relies on theme.js
// using its house style of one-line `}` to close top-level functions.
const initStart = src.search(/^async function init\(\) \{/m);
if (initStart < 0) {
  throw new Error("could not locate `async function init() {` in theme.js");
}
const tail = src.slice(initStart);
const initEnd = tail.search(/^\}\n/m);
if (initEnd < 0) {
  throw new Error("could not locate end of init() body");
}
const initBody = tail.slice(0, initEnd + 1);

// Strip block + line comments so a hypothetical commented-out call
// isn't flagged. Same minimal scrubber as the layout test uses elsewhere.
const stripped = initBody
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/\/\/[^\n]*\n/g, "\n");

// Match every identifier immediately followed by `(` — i.e., function
// call sites. We intentionally accept member calls (`x.foo(...)`) and
// ignore them: the parent reference (`x`) is what would need to be
// defined, and JS member lookups don't throw a ReferenceError.
// Strategy: match the head identifier of a call expression that is NOT
// preceded by `.` (a method call). Awaits and `new` are stripped first
// so they don't show up as identifiers.
const calls = new Set();
const callRe = /(^|[^.\w$])([a-zA-Z_$][a-zA-Z0-9_$]*)\s*\(/g;
let m;
while ((m = callRe.exec(stripped)) !== null) {
  const name = m[2];
  // Skip control keywords that look call-shaped.
  if (
    name === "if" || name === "for" || name === "while" || name === "switch" ||
    name === "catch" || name === "return" || name === "function" ||
    name === "await" || name === "new" || name === "typeof"
  ) continue;
  calls.add(name);
}

// For each callee, look for a definition somewhere in theme.js.
// We accept any of:
//   function NAME(
//   async function NAME(
//   const NAME =
//   let NAME =
//   var NAME =
// The same scrubber removes comments from src so a definition inside a
// /* */ block doesn't satisfy the check.
const srcStripped = src
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/\/\/[^\n]*\n/g, "\n");

function isDefined(name) {
  if (BUILTINS.has(name)) return true;
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Accepts: function decl, async function decl, top-level binding,
  // and destructured imports from a global (`const { foo, bar } = src.PP`).
  // The destructuring branch lets `escapeHtml` etc. — pulled from
  // `window.PP` at the top of theme.js — count as defined without us
  // having to whitelist them individually.
  const def = new RegExp(
    `(?:^|\\n)\\s*(?:export\\s+)?(?:async\\s+)?function\\s+${escaped}\\s*\\(` +
    `|(?:^|\\n)\\s*(?:export\\s+)?(?:const|let|var)\\s+${escaped}\\s*(?:=|,|;|\\n)` +
    `|\\{[^{}]*\\b${escaped}\\b[^{}]*\\}\\s*=`,
    "m",
  );
  return def.test(srcStripped);
}

let passed = 0;
let failed = 0;
const missing = [];

console.log("init() callees defined?");
for (const name of [...calls].sort()) {
  if (isDefined(name)) {
    passed++;
    process.stdout.write(`  ok  ${name}\n`);
  } else {
    failed++;
    missing.push(name);
    process.stdout.write(`  FAIL ${name}: not defined in theme.js\n`);
  }
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error(
    `\nFAILURE: init() in docs/assets/theme.js calls these identifiers,\n` +
    `but no definition was found anywhere in the file:\n  ${missing.join(", ")}\n\n` +
    `Add the missing function, remove the call, or — if the symbol is a new\n` +
    `JS/DOM builtin not on this test's allowlist — extend the BUILTINS set\n` +
    `at the top of ${THEME_JS.split("/").slice(-3).join("/")}.\n` +
    `\nThis test exists because PR #229 removed populateThemeDatalist() but\n` +
    `left the call site, and the bug shipped to production for ~5 days. See\n` +
    `PR #243 for the postmortem.`,
  );
  process.exit(1);
}
