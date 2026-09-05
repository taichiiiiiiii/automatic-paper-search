import {
  PAPER_SLIDE_DISPATCH_ERROR_CODE,
  PAPER_SLIDE_DISPATCH_OUTCOMES,
  PAPER_SLIDE_WORKFLOW_FILE,
  createPaperSlideDispatchAdapter,
  validatePaperSlideDispatchRequest,
} from "./paper-slide-dispatch.js";

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  return Promise.resolve().then(fn).then(() => {
    passed++;
    process.stdout.write(`  ok  ${name}\n`);
  }).catch((error) => {
    failed++;
    failures.push({ name, error });
    process.stdout.write(`  FAIL ${name}\n    ${error.stack || error.message}\n`);
  });
}

function eq(actual, expected, message = "") {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${message}\nexpected ${JSON.stringify(expected)}\nactual   ${JSON.stringify(actual)}`);
  }
}

async function rejects(fn) {
  let threw = false;
  try { await fn(); } catch { threw = true; }
  if (!threw) throw new Error("expected function to throw");
}

const OWNER = "taichiiiiiiii";
const REPO = "automatic-paper-search";
const TOKEN = "github_pat_fixture_value_1234567890";
const PAPER_ID = "32fca56a660c08f89792c13f21b20b1b34110f3e";
const JOB_ID = `paper-slide-job-${"A".repeat(22)}`;
const INPUT = Object.freeze({
  paper_id: PAPER_ID,
  job_id: JOB_ID,
  language: "ja",
  coverage_preference: "auto",
  snapshot_version: "catalog-v1:2026-09-04",
  job_key: "a".repeat(64),
});

const ACCEPTED = Object.freeze({ outcome: PAPER_SLIDE_DISPATCH_OUTCOMES.ACCEPTED });
const REJECTED = Object.freeze({
  outcome: PAPER_SLIDE_DISPATCH_OUTCOMES.REJECTED,
  error_code: PAPER_SLIDE_DISPATCH_ERROR_CODE,
});
const UNCERTAIN = Object.freeze({
  outcome: PAPER_SLIDE_DISPATCH_OUTCOMES.UNCERTAIN,
  error_code: PAPER_SLIDE_DISPATCH_ERROR_CODE,
});

function makeAdapter(fetchImpl, overrides = {}) {
  return createPaperSlideDispatchAdapter({
    fetch: fetchImpl,
    token: TOKEN,
    owner: OWNER,
    repo: REPO,
    ref: "develop",
    workflow: PAPER_SLIDE_WORKFLOW_FILE,
    ...overrides,
  });
}

const tests = [];

tests.push(test("accepts closed approved-catalog and coordinator identity", async () => {
  eq(await validatePaperSlideDispatchRequest(INPUT), true);
}));

tests.push(test("rejects malformed identity and every unknown input field", async () => {
  eq(await validatePaperSlideDispatchRequest({ ...INPUT, paper_id: "0".repeat(39) }), false);
  for (const [key, value] of [
    ["title", "A title"],
    ["url", "https://example.test/paper.pdf"],
    ["token", TOKEN],
    ["request_id", "paper-slide-AAAAAAAAAAAAAAAAAAAAAA"],
    ["budget", 999],
    ["source", "arxiv"],
    ["source_id", "2601.01234"],
  ]) {
    eq(await validatePaperSlideDispatchRequest({ ...INPUT, [key]: value }), false, key);
  }
}));

tests.push(test("rejects malformed catalog fields, language, coverage, and job IDs", async () => {
  for (const patch of [
    { paper_id: "0".repeat(39) },
    { snapshot_version: "catalog/version" },
    { job_key: "A".repeat(64) },
    { language: "fr" },
    { coverage_preference: "full_text" },
    { job_id: "job/one" },
    { job_id: "job one" },
    { job_id: "paper-slide-job-1" },
    { job_id: `paper-slide-job-${"A".repeat(21)}` },
    { job_id: `paper-slide-job-${"A".repeat(23)}` },
    { job_id: `paper-slide-job-${"A".repeat(21)}!` },
  ]) {
    eq(await validatePaperSlideDispatchRequest({ ...INPUT, ...patch }), false, JSON.stringify(patch));
  }
}));

tests.push(test("validates owner, repo, ref, workflow, token, and bounded limits", async () => {
  const invalid = [
    { owner: "-owner" },
    { owner: "owner--name" },
    { repo: "repo/name" },
    { ref: "refs/heads/develop" },
    { ref: "feature//slides" },
    { workflow: "theme-on-demand.yml" },
    { apiBase: "https://attacker.test" },
    { token: "short" },
    { validateJobId: true },
    { timeoutMs: 0 },
    { maximumResponseBodyBytes: 65_537 },
  ];
  for (const overrides of invalid) {
    await rejects(() => makeAdapter(async () => new Response(null, { status: 204 }), overrides));
  }
}));

tests.push(test("supports an injected production coordinator job ID validator", async () => {
  const validateJobId = (value) => /^prod_[0-9]{6}$/.test(value);
  eq(validatePaperSlideDispatchRequest({ ...INPUT, job_id: "prod_123456" }, validateJobId), true);
  eq(validatePaperSlideDispatchRequest(INPUT, validateJobId), false);
  let calls = 0;
  const adapter = makeAdapter(async () => {
    calls++;
    return new Response(null, { status: 204 });
  }, { validateJobId });
  eq(await adapter.dispatch({ ...INPUT, job_id: "prod_123456" }), ACCEPTED);
  eq(await adapter.dispatch(INPUT), REJECTED);
  eq(calls, 1);
}));

tests.push(test("sends only the closed workflow input allowlist to the fixed HTTPS GitHub endpoint", async () => {
  const calls = [];
  const adapter = makeAdapter(async (...args) => {
    calls.push(args);
    return new Response(null, { status: 204 });
  });
  eq(await adapter.dispatch(INPUT), ACCEPTED);
  eq(calls.length, 1);
  const [url, init] = calls[0];
  eq(url, "https://api.github.com/repos/taichiiiiiiii/automatic-paper-search/actions/workflows/paper-slides-on-demand.yml/dispatches");
  eq(init.method, "POST");
  eq(init.redirect, "error");
  eq(init.headers.authorization, `Bearer ${TOKEN}`);
  eq(JSON.parse(init.body), {
    ref: "develop",
    inputs: {
      paper_id: PAPER_ID,
      job_id: JOB_ID,
      language: "ja",
      coverage_preference: "auto",
      snapshot_version: "catalog-v1:2026-09-04",
      job_key: "a".repeat(64),
    },
  });
  eq(init.body.includes("title"), false);
  eq(init.body.includes("https://"), false);
  eq(init.body.includes(TOKEN), false);
}));

tests.push(test("rejects invalid input without invoking injected fetch", async () => {
  let calls = 0;
  const adapter = makeAdapter(async () => {
    calls++;
    return new Response(null, { status: 204 });
  });
  eq(await adapter.dispatch({ ...INPUT, title: "must not dispatch" }), REJECTED);
  eq(calls, 0);
}));

tests.push(test("treats only status 204 as accepted and classifies definitive 4xx rejection", async () => {
  for (const status of [400, 401, 403, 404, 405, 410, 422]) {
    const adapter = makeAdapter(async () => new Response("provider detail", { status }));
    eq(await adapter.dispatch(INPUT), REJECTED, String(status));
  }
  for (const status of [200, 201, 202, 205, 408, 409, 425, 429, 500, 503]) {
    const adapter = makeAdapter(async () => new Response("provider detail", { status }));
    eq(await adapter.dispatch(INPUT), UNCERTAIN, String(status));
  }
}));

tests.push(test("masks network errors and redirects as delivery-uncertain", async () => {
  const cases = [
    async () => { throw new Error(`secret ${TOKEN}`); },
    async () => ({ status: 204, redirected: true, url: "https://attacker.test/", body: null }),
  ];
  for (const fixtureFetch of cases) {
    const result = await makeAdapter(fixtureFetch).dispatch(INPUT);
    eq(result, UNCERTAIN);
    eq(JSON.stringify(result).includes(TOKEN), false);
    eq(Object.hasOwn(result, "status"), false);
    eq(Object.hasOwn(result, "body"), false);
    eq(Object.hasOwn(result, "url"), false);
  }
}));

tests.push(test("bounds an error response body and cancels the stream", async () => {
  let cancelled = false;
  const stream = new ReadableStream({
    pull(controller) { controller.enqueue(new Uint8Array(5)); },
    cancel() { cancelled = true; },
  });
  const adapter = makeAdapter(async () => ({
    status: 500,
    redirected: false,
    url: "",
    body: stream,
  }), { maximumResponseBodyBytes: 8 });
  eq(await adapter.dispatch(INPUT), UNCERTAIN);
  eq(cancelled, true);
}));

tests.push(test("applies one timeout to fetch and response-body reading and aborts fetch", async () => {
  for (const fixture of ["fetch", "body"]) {
    let signal;
    const adapter = makeAdapter(async (_url, init) => {
      signal = init.signal;
      if (fixture === "fetch") return await new Promise(() => {});
      return {
        status: 500,
        redirected: false,
        url: "",
        body: new ReadableStream({ pull() { return new Promise(() => {}); } }),
      };
    }, { timeoutMs: 10 });
    eq(await adapter.dispatch(INPUT), UNCERTAIN, fixture);
    eq(signal.aborted, true, fixture);
  }
}));

tests.push(test("has no global fetch fallback", async () => {
  await rejects(() => createPaperSlideDispatchAdapter({
    token: TOKEN,
    owner: OWNER,
    repo: REPO,
    ref: "develop",
  }));
}));

await Promise.all(tests);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  for (const failure of failures) {
    console.log(`  - ${failure.name}: ${failure.error.stack || failure.error.message}`);
  }
  process.exit(1);
}
