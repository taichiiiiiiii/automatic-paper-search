// Tests for the Vercel Function `api/themes.js`. We import only the
// pure helpers (slugify + THEME_PATTERN) and assert their shape /
// behaviour. The HTTP handler itself is exercised in the broader
// frontend integration smoke; mocking GitHub's API surface here would
// add coverage cost without catching real bugs.

import { slugify, THEME_PATTERN } from "./themes.js";

let passed = 0, failed = 0;
const failures = [];
function test(name, fn) {
  try { fn(); passed++; process.stdout.write(`  ok  ${name}\n`); }
  catch (e) { failed++; failures.push({ name, e }); process.stdout.write(`  FAIL ${name}\n    ${e.message}\n`); }
}
function eq(a, b, msg = "") {
  if (a !== b) throw new Error(`${msg}\n    expected: ${JSON.stringify(b)}\n    actual:   ${JSON.stringify(a)}`);
}
function truthy(v, msg) { if (!v) throw new Error(msg || `expected truthy, got ${v}`); }

console.log("api/themes.js slugify():");

test("simple ASCII title", () => eq(slugify("Mixture of Experts"), "mixture-of-experts"));
test("hyphens preserved", () => eq(slugify("Direct-Preference-Optimization"), "direct-preference-optimization"));
test("underscores collapse to hyphen", () => eq(slugify("Vision_Transformer"), "vision-transformer"));
test("multiple spaces collapse", () => eq(slugify("Vision    Transformer"), "vision-transformer"));
test("leading/trailing whitespace stripped", () => eq(slugify("  Diffusion Model  "), "diffusion-model"));
test("mixed case lowered", () => eq(slugify("RLHF"), "rlhf"));
test("digits kept", () => eq(slugify("BERT 2018"), "bert-2018"));
test("64-char cap applies", () => {
  const long = "a".repeat(200);
  const slug = slugify(long);
  if (slug.length > 64) throw new Error(`slug length ${slug.length} > 64`);
});
test("non-alpha runs collapse to single hyphen", () => {
  eq(slugify("foo!!bar??baz"), "foo-bar-baz");
});

console.log("\napi/themes.js THEME_PATTERN:");

test("accepts plain titles", () => {
  truthy(THEME_PATTERN.test("Vision Transformer"));
  truthy(THEME_PATTERN.test("BERT"));
  truthy(THEME_PATTERN.test("Direct-Preference-Optimization"));
  truthy(THEME_PATTERN.test("Mix_of_Experts"));
});
test("rejects shell-shaped inputs", () => {
  truthy(!THEME_PATTERN.test("$(rm -rf ~)"));
  truthy(!THEME_PATTERN.test("foo; ls"));
  truthy(!THEME_PATTERN.test("foo`whoami`"));
  truthy(!THEME_PATTERN.test("../../etc/passwd"));
});
test("rejects too short / too long", () => {
  truthy(!THEME_PATTERN.test("a"));
  truthy(!THEME_PATTERN.test("a".repeat(81)));
});
test("rejects unicode", () => {
  truthy(!THEME_PATTERN.test("テスト"));
  truthy(!THEME_PATTERN.test("café"));
  truthy(!THEME_PATTERN.test("résumé"));
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) {
  for (const { name, e } of failures) console.error(`\nFAILED: ${name}\n${e.stack}`);
  process.exit(1);
}
