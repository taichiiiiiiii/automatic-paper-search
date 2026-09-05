import {
  REQUEST_ID_PATTERN,
  createRequestId,
  dispatchInputs,
  isRequestId,
} from "./request-id.js";

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
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}
function rejects(fn) {
  let threw = false;
  try { fn(); } catch { threw = true; }
  if (!threw) throw new Error("expected function to throw");
}

const UUID = "123e4567-e89b-42d3-a456-426614174000";
const REQUEST_ID = `theme-${UUID}`;

console.log("worker request ID tests:");
test("creates a namespaced ID from UUID v4", () => eq(createRequestId(() => UUID), REQUEST_ID));
test("generated ID satisfies the public pattern", () => eq(REQUEST_ID_PATTERN.test(REQUEST_ID), true));
test("recognises a valid generated ID", () => eq(isRequestId(REQUEST_ID), true));
test("rejects blank IDs", () => eq(isRequestId(""), false));
test("rejects IDs without namespace", () => eq(isRequestId(UUID), false));
test("rejects non-v4 UUIDs", () => eq(isRequestId("theme-123e4567-e89b-12d3-a456-426614174000"), false));
test("rejects every JavaScript line terminator after an otherwise valid ID", () => {
  for (const terminator of ["\n", "\r", "\u2028", "\u2029"]) {
    eq(REQUEST_ID_PATTERN.test(`${REQUEST_ID}${terminator}`), false);
    eq(isRequestId(`${REQUEST_ID}${terminator}`), false);
  }
});
test("rejects uppercase IDs", () => eq(isRequestId(REQUEST_ID.toUpperCase()), false));
test("create rejects malformed UUID provider output", () => rejects(() => createRequestId(() => "bad")));
test("dispatch input carries theme and request_id", () => {
  eq(dispatchInputs(" Vision Transformer ", REQUEST_ID), {
    theme: "Vision Transformer",
    request_id: REQUEST_ID,
  });
});
test("dispatch input requires a theme", () => rejects(() => dispatchInputs(" ", REQUEST_ID)));
test("dispatch input requires a valid ID", () => rejects(() => dispatchInputs("RAG", "bad")));

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  for (const item of failures) console.log(`  - ${item.name}: ${item.error.stack || item.error.message}`);
  process.exit(1);
}
