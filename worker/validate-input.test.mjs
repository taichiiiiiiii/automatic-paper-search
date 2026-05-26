// Unit tests for `validatePostInput` in worker/validate-input.js.
// Mirrors the test-harness pattern of slug.test.mjs / response.test.mjs.

import { validatePostInput } from "./validate-input.js";
import { themeSlug } from "./slug.js";

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

function truthy(v, msg) { if (!v) throw new Error(msg || `expected truthy, got ${v}`); }

console.log("validatePostInput tests:");

test("rejects missing body", () => {
  const r = validatePostInput(null, themeSlug);
  eq(r.ok, false);
  eq(r.status, 400);
  eq(r.body.status, "invalid");
});

test("rejects body without theme field", () => {
  const r = validatePostInput({}, themeSlug);
  eq(r.ok, false);
  eq(r.body.status, "invalid");
});

test("rejects non-string theme field", () => {
  const r = validatePostInput({ theme: 42 }, themeSlug);
  eq(r.ok, false);
});

test("rejects shell-shaped inputs", () => {
  for (const evil of ["$(rm -rf ~)", "foo; ls", "foo`whoami`", "../../etc/passwd"]) {
    const r = validatePostInput({ theme: evil }, themeSlug);
    eq(r.ok, false, `evil input passed: ${evil}`);
  }
});

test("rejects too-short and too-long themes", () => {
  eq(validatePostInput({ theme: "a" }, themeSlug).ok, false);
  eq(validatePostInput({ theme: "a".repeat(81) }, themeSlug).ok, false);
});

test("rejects unicode (must stay ASCII for slug safety)", () => {
  eq(validatePostInput({ theme: "テスト" }, themeSlug).ok, false);
});

test("trims leading/trailing whitespace before validating", () => {
  const r = validatePostInput({ theme: "  Vision Transformer  " }, themeSlug);
  eq(r.ok, true);
  eq(r.raw, "Vision Transformer");
});

test("accepts plain ASCII title and derives slug", () => {
  const r = validatePostInput({ theme: "Mixture of Experts" }, themeSlug);
  eq(r.ok, true);
  eq(r.raw, "Mixture of Experts");
  eq(r.slug, "mixture-of-experts");
});

test("returns slug-failure body when themeSlug throws", () => {
  const broken = () => { throw new Error("boom"); };
  const r = validatePostInput({ theme: "Anything Valid" }, broken);
  eq(r.ok, false);
  eq(r.status, 400);
  truthy(r.body.message.includes("boom"), "must surface the throw message");
});

test("does not leak the raw body content into the error response", () => {
  // Sanity: the error body shouldn't echo user-supplied text verbatim
  // (which would let a crafted request smuggle bytes into the JSON
  // response). Spot-check that the canonical message is what comes
  // back instead of the rejected input.
  const r = validatePostInput({ theme: "<script>" }, themeSlug);
  eq(r.ok, false);
  truthy(!r.body.message.includes("<script>"), "must not echo rejected input");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  for (const f of failures) console.log(`  - ${f.name}: ${f.e.stack || f.e.message}`);
  process.exit(1);
}
