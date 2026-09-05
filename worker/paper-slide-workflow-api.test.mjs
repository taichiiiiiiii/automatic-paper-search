import {
  PAPER_SLIDE_WORKFLOW_API_MAX_BODY_BYTES,
  PAPER_SLIDE_WORKFLOW_API_SCHEMA,
  createPaperSlideWorkflowApi,
} from "./paper-slide-workflow-api.js";

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

function truthy(value, message = "expected truthy") {
  if (!value) throw new Error(message);
}

const NOW = Date.UTC(2026, 8, 4, 12, 34, 56, 789);
const TOKEN = "workflow-callback-secret-0123456789";
const CLAIMANT_TOKEN = `psct_${"A".repeat(43)}`;
const JOB_ID = `paper-slide-job-${"A".repeat(22)}`;
const CLAIM_PATH = "/api/paper-slides/internal/claim";
const STATUS_PATH = "/api/paper-slides/internal/status";

function validStatus(overrides = {}) {
  return {
    status: "running",
    phase: "fetching",
    coverage: null,
    deck_id: null,
    preview_available: false,
    preview_expires_at: null,
    public_url: null,
    message_code: "PAPER_SLIDE_FETCHING",
    retryable: null,
    ...overrides,
  };
}

function claimBody(overrides = {}) {
  return {
    claimant_token: CLAIMANT_TOKEN,
    job_id: JOB_ID,
    lease_generation: 0,
    reclaim: false,
    ...overrides,
  };
}

function statusBody(status = validStatus(), overrides = {}) {
  return {
    claimant_token: CLAIMANT_TOKEN,
    job_id: JOB_ID,
    lease_generation: 1,
    status,
    ...overrides,
  };
}

function fixture(overrides = {}) {
  const calls = [];
  const coordinator = {
    async claimJob(jobId, claimantToken, options) {
      calls.push(["claim", jobId, claimantToken, structuredClone(options)]);
      return {
        claimed: true,
        reclaimed: false,
        leaseGeneration: 1,
        leaseExpiresAt: "2026-09-04T12:49:56.789Z",
      };
    },
    async updateClaimedJobStatus(jobId, status, claimantToken, leaseGeneration) {
      calls.push([
        "status", jobId, structuredClone(status), claimantToken, leaseGeneration,
      ]);
    },
    ...overrides,
  };
  const api = createPaperSlideWorkflowApi({
    authorizationSecret: TOKEN,
    coordinator,
    now: () => NOW,
  });
  return { api, calls, coordinator };
}

function request(path, body, options = {}) {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  const headers = new Headers({
    authorization: `Bearer ${TOKEN}`,
    "content-type": "application/json",
    ...options.headers,
  });
  return new Request(`https://worker.invalid${path}${options.query ?? ""}`, {
    method: options.method ?? "POST",
    headers,
    body: options.method === "GET" ? undefined : text,
  });
}

async function json(response) {
  return JSON.parse(await response.text());
}

function assertClosedHeaders(response) {
  eq(response.headers.get("cache-control"), "private, no-store");
  eq(response.headers.get("content-type"), "application/json; charset=utf-8");
  eq(response.headers.get("x-content-type-options"), "nosniff");
  eq(response.headers.get("referrer-policy"), "no-referrer");
  eq(response.headers.get("access-control-allow-origin"), null);
}

const tests = [];

tests.push(test("claims an exact job once and returns only the closed decision", async () => {
  const item = fixture();
  const response = await item.api.fetch(request(CLAIM_PATH, claimBody()));
  eq(response.status, 200);
  eq(await json(response), {
    schema_version: PAPER_SLIDE_WORKFLOW_API_SCHEMA,
    ok: true,
    claimed: true,
    reclaimed: false,
    lease_generation: 1,
    lease_expires_at: "2026-09-04T12:49:56.789Z",
  });
  eq(item.calls, [[
    "claim", JOB_ID, CLAIMANT_TOKEN, { leaseGeneration: 0, reclaim: false },
  ]]);
  truthy(!(await (await item.api.fetch(request(CLAIM_PATH, claimBody()))).text()).includes(
    CLAIMANT_TOKEN,
  ));
  assertClosedHeaders(response);
}));

tests.push(test("passes double-claim and late or unknown false through without a reason", async () => {
  let claims = 0;
  const item = fixture({
    async claimJob(jobId, claimantToken, options) {
      item.calls.push(["claim", jobId, claimantToken, structuredClone(options)]);
      claims++;
      return claims === 1
        ? {
            claimed: true,
            reclaimed: false,
            leaseGeneration: 1,
            leaseExpiresAt: "2026-09-04T12:49:56.789Z",
          }
        : {
            claimed: false,
            reclaimed: false,
            leaseGeneration: null,
            leaseExpiresAt: null,
          };
    },
  });
  const first = await item.api.fetch(request(CLAIM_PATH, claimBody()));
  const second = await item.api.fetch(request(CLAIM_PATH, claimBody()));
  eq((await json(first)).claimed, true);
  eq(await json(second), {
    schema_version: PAPER_SLIDE_WORKFLOW_API_SCHEMA,
    ok: true,
    claimed: false,
    reclaimed: false,
    lease_generation: null,
    lease_expires_at: null,
  });
}));

tests.push(test("passes only the explicit bounded reclaim inputs and closed result", async () => {
  const item = fixture({
    async claimJob(jobId, claimantToken, options) {
      item.calls.push(["claim", jobId, claimantToken, structuredClone(options)]);
      return {
        claimed: true,
        reclaimed: true,
        leaseGeneration: 2,
        leaseExpiresAt: "2026-09-04T12:49:56.789Z",
      };
    },
  });
  const response = await item.api.fetch(request(CLAIM_PATH, claimBody({
    lease_generation: 1,
    reclaim: true,
  })));
  eq(await json(response), {
    schema_version: PAPER_SLIDE_WORKFLOW_API_SCHEMA,
    ok: true,
    claimed: true,
    reclaimed: true,
    lease_generation: 2,
    lease_expires_at: "2026-09-04T12:49:56.789Z",
  });
  eq(item.calls, [[
    "claim", JOB_ID, CLAIMANT_TOKEN, { leaseGeneration: 1, reclaim: true },
  ]]);
}));

tests.push(test("adds the server timestamp to a closed status before coordinator update", async () => {
  const item = fixture();
  const body = statusBody();
  const response = await item.api.fetch(request(STATUS_PATH, body));
  eq(response.status, 200);
  eq(await json(response), {
    schema_version: PAPER_SLIDE_WORKFLOW_API_SCHEMA,
    ok: true,
    updated: true,
  });
  eq(item.calls, [["status", JOB_ID, {
    coverage: null,
    deck_id: null,
    message_code: "PAPER_SLIDE_FETCHING",
    phase: "fetching",
    preview_available: false,
    preview_expires_at: null,
    public_url: null,
    retryable: null,
    status: "running",
    updated_at: "2026-09-04T12:34:56.789Z",
  }, CLAIMANT_TOKEN, 1]]);
}));

tests.push(test("rejects caller-provided updated_at and unknown nested status fields", async () => {
  for (const status of [
    { ...validStatus(), updated_at: "2000-01-01T00:00:00.000Z" },
    { ...validStatus(), detail: "secret" },
  ]) {
    const item = fixture();
    const response = await item.api.fetch(request(STATUS_PATH, statusBody(status)));
    eq(response.status, 400);
    eq(item.calls, []);
  }
}));

tests.push(test("rejects semantically invalid status records before the coordinator", async () => {
  const invalid = [
    validStatus({ phase: "generating", message_code: "PAPER_SLIDE_FETCHING" }),
    validStatus({ status: "made_up" }),
    validStatus({ public_url: "https://attacker.invalid/deck" }),
  ];
  for (const status of invalid) {
    const item = fixture();
    const response = await item.api.fetch(request(STATUS_PATH, statusBody(status)));
    eq(response.status, 400);
    eq(item.calls, []);
  }
}));

tests.push(test("requires exact request shapes and exact job identifiers", async () => {
  const bodies = [
    {},
    claimBody({ extra: true }),
    claimBody({ job_id: "paper-slide-job-short" }),
    claimBody({ job_id: `${JOB_ID}suffix` }),
    statusBody(validStatus(), { extra: true }),
    claimBody({ claimant_token: "psct_short" }),
    claimBody({ lease_generation: 3 }),
    claimBody({ reclaim: "true" }),
    statusBody(validStatus(), { lease_generation: 0 }),
  ];
  for (const body of bodies) {
    const item = fixture();
    const path = Object.hasOwn(body, "status") ? STATUS_PATH : CLAIM_PATH;
    const response = await item.api.fetch(request(path, body));
    eq(response.status, 400);
    eq(item.calls, []);
  }
}));

tests.push(test("uses indistinguishable not-found responses for absent or wrong auth and unknown routes", async () => {
  const item = fixture();
  const attempts = [
    request(CLAIM_PATH, claimBody(), { headers: { authorization: "" } }),
    request(CLAIM_PATH, claimBody(), { headers: { authorization: "Bearer wrong-secret-that-is-long-enough" } }),
    request("/api/paper-slides/internal/missing", claimBody()),
    request(CLAIM_PATH, claimBody(), { query: "?token=x" }),
  ];
  let expectedBody = null;
  for (const attempt of attempts) {
    const response = await item.api.fetch(attempt);
    eq(response.status, 404);
    const body = await response.text();
    expectedBody ??= body;
    eq(body, expectedBody);
    truthy(!body.includes(TOKEN));
    assertClosedHeaders(response);
  }
  eq(item.calls, []);
}));

tests.push(test("bounds hostile authorization headers before secret comparison", async () => {
  const item = fixture();
  const response = await item.api.fetch(request(CLAIM_PATH, claimBody(), {
    headers: { authorization: `Bearer ${"x".repeat(8192)}` },
  }));
  eq(response.status, 404);
  eq(item.calls, []);
  assertClosedHeaders(response);
}));

tests.push(test("permits POST only and never emits CORS headers", async () => {
  const item = fixture();
  const response = await item.api.fetch(request(CLAIM_PATH, "", { method: "GET" }));
  eq(response.status, 405);
  assertClosedHeaders(response);
  eq(item.calls, []);
}));

tests.push(test("requires JSON with identity encoding", async () => {
  for (const headers of [
    { "content-type": "text/plain" },
    { "content-encoding": "gzip" },
  ]) {
    const item = fixture();
    const response = await item.api.fetch(request(CLAIM_PATH, claimBody(), { headers }));
    eq(response.status, 400);
    eq(item.calls, []);
  }
}));

tests.push(test("bounds declared and streamed bodies in bytes", async () => {
  const item = fixture();
  const declared = request(CLAIM_PATH, claimBody(), {
    headers: { "content-length": String(PAPER_SLIDE_WORKFLOW_API_MAX_BODY_BYTES + 1) },
  });
  eq((await item.api.fetch(declared)).status, 413);

  const bytes = new Uint8Array(PAPER_SLIDE_WORKFLOW_API_MAX_BODY_BYTES + 1).fill(32);
  const streamed = new Request(`https://worker.invalid${CLAIM_PATH}`, {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body: new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } }),
    duplex: "half",
  });
  eq((await item.api.fetch(streamed)).status, 413);
  eq(item.calls, []);
}));

tests.push(test("rejects malformed JSON, invalid UTF-8, and content-length mismatch", async () => {
  const item = fixture();
  const malformed = request(CLAIM_PATH, "{");
  const invalidUtf8 = new Request(`https://worker.invalid${CLAIM_PATH}`, {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body: new Uint8Array([0xff]),
  });
  const mismatch = request(CLAIM_PATH, claimBody(), { headers: { "content-length": "1" } });
  for (const attempt of [malformed, invalidUtf8, mismatch]) {
    eq((await item.api.fetch(attempt)).status, 400);
  }
  eq(item.calls, []);
}));

tests.push(test("fails closed for malformed, accessor, and prototype coordinator results", async () => {
  const values = [
    null,
    { claimed: true, extra: true },
    Object.create({ claimed: true }),
    Object.defineProperty({}, "claimed", { enumerable: true, get() { throw new Error("getter ran"); } }),
    { claimed: false, reclaimed: true, leaseGeneration: null, leaseExpiresAt: null },
    { claimed: true, reclaimed: false, leaseGeneration: 3, leaseExpiresAt: "bad" },
  ];
  for (const value of values) {
    const item = fixture({ async claimJob() { return value; } });
    const response = await item.api.fetch(request(CLAIM_PATH, claimBody()));
    eq(response.status, 503);
    truthy(!(await response.text()).includes("getter ran"));
  }
}));

tests.push(test("fails closed when coordinator calls throw or status result is non-void", async () => {
  const throwing = fixture({ async claimJob() { throw new Error(`do not leak ${TOKEN}`); } });
  const claim = await throwing.api.fetch(request(CLAIM_PATH, claimBody()));
  eq(claim.status, 503);
  truthy(!(await claim.text()).includes(TOKEN));

  const malformed = fixture({
    async updateClaimedJobStatus() { return { updated: true }; },
  });
  const status = await malformed.api.fetch(request(STATUS_PATH, statusBody()));
  eq(status.status, 503);
}));

tests.push(test("rejects hostile configuration shapes without invoking accessors", async () => {
  let invoked = false;
  const accessor = Object.defineProperty({}, "authorizationSecret", {
    enumerable: true,
    get() { invoked = true; return TOKEN; },
  });
  for (const config of [
    accessor,
    Object.assign(Object.create({}), { authorizationSecret: TOKEN, coordinator: {}, now: () => NOW }),
    { authorizationSecret: TOKEN, coordinator: {}, now: () => NOW, extra: true },
  ]) {
    let error = null;
    try { createPaperSlideWorkflowApi(config); } catch (caught) { error = caught; }
    truthy(error instanceof TypeError);
  }
  eq(invoked, false);
}));

tests.push(test("validates secret, coordinator, clock, and maximum date without leakage", async () => {
  for (const authorizationSecret of ["short", `bad\n${TOKEN}`, "x".repeat(257)]) {
    let error = null;
    try {
      createPaperSlideWorkflowApi({ authorizationSecret, coordinator: fixture().coordinator, now: () => NOW });
    } catch (caught) { error = caught; }
    truthy(error instanceof TypeError);
    truthy(!error.message.includes(authorizationSecret));
  }
  for (const value of [NaN, -1, Date.UTC(10000, 0, 1)]) {
    const item = createPaperSlideWorkflowApi({
      authorizationSecret: TOKEN,
      coordinator: fixture().coordinator,
      now: () => value,
    });
    const response = await item.fetch(request(STATUS_PATH, statusBody()));
    eq(response.status, 503);
  }

  const maximum = createPaperSlideWorkflowApi({
    authorizationSecret: TOKEN,
    coordinator: fixture().coordinator,
    now: () => Date.UTC(10000, 0, 1) - 1,
  });
  const response = await maximum.fetch(request(
    STATUS_PATH,
    statusBody(),
  ));
  eq(response.status, 200);
}));

await Promise.all(tests);
process.stdout.write(`\n${passed} passed, ${failed} failed\n`);
if (failures.length > 0) process.exitCode = 1;
