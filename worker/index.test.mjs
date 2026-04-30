// Pure-logic tests for the slug derivation shared by the CF Worker,
// the front-end form, and (via paperpilot/tests/test_worker_slug_parity.py)
// the Python theme_slug() implementation. We test the JS module
// directly — no TS-strip needed — and a Python-side parity test compares
// the same inputs across both implementations.

import { themeSlug, THEME_INPUT_PATTERN } from "./slug.js";

let passed = 0, failed = 0;
const failures = [];
function test(name, fn) {
  try { fn(); passed++; process.stdout.write(`  ok  ${name}\n`); }
  catch (e) { failed++; failures.push({ name, e }); process.stdout.write(`  FAIL ${name}\n    ${e.message}\n`); }
}
function eq(a, b, msg = "") {
  if (a !== b) throw new Error(`${msg}\n    expected: ${JSON.stringify(b)}\n    actual:   ${JSON.stringify(a)}`);
}
function throws(fn, msg) {
  let threw = false;
  try { fn(); } catch { threw = true; }
  if (!threw) throw new Error(msg || "expected throw");
}
function truthy(v, msg) { if (!v) throw new Error(msg || `expected truthy, got ${v}`); }

console.log("worker themeSlug tests:");

test("simple ASCII title", () => eq(themeSlug("Mixture of Experts"), "mixture-of-experts"));
test("hyphens preserved", () => eq(themeSlug("Direct-Preference-Optimization"), "direct-preference-optimization"));
test("underscores collapse to hyphen", () => eq(themeSlug("Vision_Transformer"), "vision-transformer"));
test("multiple spaces collapse", () => eq(themeSlug("Vision    Transformer"), "vision-transformer"));
test("leading/trailing whitespace stripped", () => eq(themeSlug("  Diffusion Model  "), "diffusion-model"));
test("mixed case lowered", () => eq(themeSlug("RLHF"), "rlhf"));
test("digits kept", () => eq(themeSlug("BERT 2018"), "bert-2018"));
test("empty input throws", () => throws(() => themeSlug("")));
test("whitespace-only throws", () => throws(() => themeSlug("   ")));
test("64-char cap applies", () => {
  const long = "a".repeat(200);
  const slug = themeSlug(long);
  if (slug.length > 64) throw new Error(`slug length ${slug.length} > 64`);
});

console.log("\ninput pattern tests:");
test("THEME_INPUT_PATTERN accepts plain titles", () => {
  truthy(THEME_INPUT_PATTERN.test("Vision Transformer"));
  truthy(THEME_INPUT_PATTERN.test("BERT"));
  truthy(THEME_INPUT_PATTERN.test("Direct-Preference-Optimization"));
});
test("THEME_INPUT_PATTERN rejects shell-shaped inputs", () => {
  truthy(!THEME_INPUT_PATTERN.test("$(rm -rf ~)"));
  truthy(!THEME_INPUT_PATTERN.test("foo; ls"));
  truthy(!THEME_INPUT_PATTERN.test("foo`whoami`"));
  truthy(!THEME_INPUT_PATTERN.test("../../etc/passwd"));
});
test("THEME_INPUT_PATTERN rejects too short / too long", () => {
  truthy(!THEME_INPUT_PATTERN.test("a")); // 1 char
  truthy(!THEME_INPUT_PATTERN.test("a".repeat(81)));
});
test("THEME_INPUT_PATTERN rejects unicode", () => {
  truthy(!THEME_INPUT_PATTERN.test("テスト"));
  truthy(!THEME_INPUT_PATTERN.test("café"));
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  for (const f of failures) console.log(`  - ${f.name}: ${f.e.stack || f.e.message}`);
  process.exit(1);
}
