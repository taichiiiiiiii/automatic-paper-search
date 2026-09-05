import { createPaperSlideApi } from "./paper-slide-api.js";
import { InMemoryPaperSlideCoordinator } from "./paper-slide-coordinator.js";
import { createPaperSlideDispatchAdapter } from "./paper-slide-dispatch.js";

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed++;
      process.stdout.write(`  ok  ${name}\n`);
    })
    .catch((error) => {
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

const ORIGIN = "https://taichiiiiiiii.github.io";
const WORKER = "https://paperpilot.example";
const NOW = Date.UTC(2026, 8, 4, 0, 0, 0);
const PAPER_ID = "a".repeat(40);
const JOB_KEY = "9".repeat(64);
const BODY = {
  paper_id: PAPER_ID,
  language: "ja",
  coverage_preference: "auto",
};

function randomSource() {
  let seed = 0;
  return (length) => Uint8Array.from({ length }, () => seed++ & 0xff);
}

function makeCatalog(record = {
  paper_id: PAPER_ID,
  eligible: true,
  snapshot_version: "catalog-v1",
  job_key: JOB_KEY,
}) {
  return {
    calls: 0,
    resolutions: [],
    async resolve(paperId, language) {
      this.calls++;
      this.resolutions.push([paperId, language]);
      return paperId === PAPER_ID ? record : null;
    },
  };
}

function makeApi(overrides = {}) {
  const coordinator = overrides.coordinator ?? new InMemoryPaperSlideCoordinator();
  const catalog = overrides.catalog ?? makeCatalog();
  let nowMs = NOW;
  const api = createPaperSlideApi({
    allowedOrigins: [ORIGIN],
    coordinator,
    catalog,
    randomBytes: randomSource(),
    now: () => nowMs,
    ...overrides,
  });
  return { api, coordinator, catalog, setNow: (value) => { nowMs = value; } };
}

function postRequest(body = BODY, headers = {}) {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return new Request(`${WORKER}/api/paper-slides`, {
    method: "POST",
    headers: {
      origin: ORIGIN,
      "content-type": "application/json",
      "cf-connecting-ip": "203.0.113.5",
      ...headers,
    },
    body: text,
  });
}

function statusRequest(requestId, capability, headers = {}, body = null, query = "") {
  return new Request(
    `${WORKER}/api/paper-slides/status${query}`,
    {
      method: "POST",
      headers: {
        origin: ORIGIN,
        "content-type": "application/json",
        "cf-connecting-ip": "203.0.113.5",
        authorization: `PaperSlide ${capability}`,
        ...headers,
      },
      body: JSON.stringify(body ?? { request_id: requestId }),
    },
  );
}

async function json(response) {
  return JSON.parse(await response.text());
}

const tests = [];

tests.push(test("POST returns a fresh capability-scoped queued request", async () => {
  const { api } = makeApi();
  const response = await api.handle(postRequest());
  eq(response.status, 202);
  eq(await json(response), {
    ok: true,
    status: "queued",
    request_id: "paper-slide-AAECAwQFBgcICQoLDA0ODw",
    status_cap: "psc_EBESExQVFhcYGRobHB0eHyAhIiMkJSYnKCkqKywtLi8",
    paper_id: PAPER_ID,
    deduplicated: false,
  });
  eq(response.headers.get("cache-control"), "private, no-store");
  eq(response.headers.get("access-control-allow-origin"), ORIGIN);
  eq(response.headers.get("vary"), "Origin");
  eq(response.headers.get("x-content-type-options"), "nosniff");
}));

tests.push(test("same paper creates fresh credentials but only one underlying job", async () => {
  const { api, coordinator } = makeApi();
  const [firstResponse, secondResponse] = await Promise.all([
    api.handle(postRequest()),
    api.handle(postRequest()),
  ]);
  const [first, second] = await Promise.all([json(firstResponse), json(secondResponse)]);
  truthy(first.request_id !== second.request_id);
  truthy(first.status_cap !== second.status_cap);
  eq([first.deduplicated, second.deduplicated].sort(), [false, true]);
  eq(coordinator.jobsCreated, 1);
  eq(coordinator.jobsCreated, 1);
  const storedRequests = JSON.stringify(Array.from(coordinator.requests.values()));
  truthy(!storedRequests.includes(first.status_cap));
  truthy(!storedRequests.includes(second.status_cap));
}));

tests.push(test("same paper with a different trusted canonical job key creates a new job", async () => {
  let resolves = 0;
  const catalog = {
    async resolve(paperId) {
      resolves++;
      return {
        paper_id: paperId,
        eligible: true,
        snapshot_version: "catalog-v1",
        job_key: (resolves === 1 ? "8" : "9").repeat(64),
      };
    },
  };
  const { api, coordinator } = makeApi({ catalog });
  const first = await json(await api.handle(postRequest()));
  const second = await json(await api.handle(postRequest()));
  eq([first.deduplicated, second.deduplicated], [false, false]);
  eq(coordinator.jobsCreated, 2);
}));

tests.push(test("catalog resolution is language-bound so ja and en cannot collide", async () => {
  const catalog = {
    resolutions: [],
    async resolve(paperId, language) {
      this.resolutions.push([paperId, language]);
      return {
        paper_id: paperId,
        eligible: true,
        snapshot_version: "catalog-v1",
        job_key: (language === "ja" ? "7" : "8").repeat(64),
      };
    },
  };
  const { api, coordinator } = makeApi({ catalog });
  const ja = await api.handle(postRequest(BODY));
  const en = await api.handle(postRequest({ ...BODY, language: "en" }));
  eq([ja.status, en.status], [202, 202]);
  eq(catalog.resolutions, [[PAPER_ID, "ja"], [PAPER_ID, "en"]]);
  eq(coordinator.jobsCreated, 2);
}));

tests.push(test("dispatches exactly one closed job identity for a new underlying job", async () => {
  const dispatcher = {
    calls: [],
    async dispatch(value) {
      this.calls.push(value);
      return { outcome: "accepted" };
    },
  };
  const { api } = makeApi({ dispatcher });
  const [first, second] = await Promise.all([
    api.handle(postRequest()),
    api.handle(postRequest()),
  ]);
  eq([first.status, second.status], [202, 202]);
  eq(dispatcher.calls, [{
    job_id: "fixture-job-1",
    paper_id: PAPER_ID,
    language: "ja",
    coverage_preference: "auto",
    snapshot_version: "catalog-v1",
    job_key: JOB_KEY,
  }]);
  eq((await json(second)).deduplicated, true);
}));

tests.push(test("definitively rejected dispatch is masked, revoked, and retryable", async () => {
  let shouldFail = true;
  const dispatcher = {
    calls: 0,
    async dispatch() {
      this.calls++;
      return shouldFail
        ? { outcome: "rejected", error_code: "PAPER_SLIDE_DISPATCH_FAILED" }
        : { outcome: "accepted" };
    },
  };
  const { api, coordinator } = makeApi({ dispatcher });
  const failedResponse = await api.handle(postRequest());
  eq(failedResponse.status, 503);
  truthy(!(await failedResponse.text()).includes("DISPATCH"));
  eq(coordinator.requestCount, 0);
  eq(Array.from(coordinator.jobs.values())[0].status.status, "failed");

  shouldFail = false;
  const retry = await api.handle(postRequest());
  eq(retry.status, 202);
  eq((await json(retry)).deduplicated, false);
  eq(coordinator.jobsCreated, 2);
  eq(dispatcher.calls, 2);
}));

tests.push(test("rejection cleanup failures never expose the unreturned capability", async () => {
  const coordinator = new InMemoryPaperSlideCoordinator();
  coordinator.updateJobStatus = async () => { throw new Error("secret update failure"); };
  coordinator.revokeRequest = async () => { throw new Error("secret revoke failure"); };
  const dispatcher = {
    async dispatch() {
      return { outcome: "rejected", error_code: "PAPER_SLIDE_DISPATCH_FAILED" };
    },
  };
  const { api } = makeApi({ coordinator, dispatcher });
  const response = await api.handle(postRequest());
  const text = await response.text();
  eq(response.status, 503);
  eq(JSON.parse(text).error_code, "SERVICE_UNAVAILABLE");
  truthy(!text.includes("paper-slide-AAECAwQFBgcICQoLDA0ODw"));
  truthy(!text.includes("psc_"));
  truthy(!text.includes("secret"));
}));

tests.push(test("delivery-uncertain dispatch stays queued and a repeated request never redispatches", async () => {
  const dispatcher = {
    calls: 0,
    async dispatch() {
      this.calls++;
      return { outcome: "uncertain", error_code: "PAPER_SLIDE_DISPATCH_FAILED" };
    },
  };
  const { api, coordinator } = makeApi({ dispatcher });
  const firstResponse = await api.handle(postRequest());
  const first = await json(firstResponse);
  eq(firstResponse.status, 202);
  eq(first.deduplicated, false);
  eq(Array.from(coordinator.jobs.values())[0].status.status, "queued");

  const repeatedResponse = await api.handle(postRequest());
  const repeated = await json(repeatedResponse);
  eq(repeatedResponse.status, 202);
  eq(repeated.deduplicated, true);
  eq(coordinator.jobsCreated, 1);
  eq(dispatcher.calls, 1);
}));

tests.push(test("GitHub dispatch timeout keeps one queued job and never redispatches it", async () => {
  let fetchCalls = 0;
  const dispatcher = createPaperSlideDispatchAdapter({
    fetch: async (_url, init) => {
      fetchCalls++;
      return await new Promise((_, reject) => {
        init.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    },
    token: "github_pat_fixture_value_1234567890",
    owner: "taichiiiiiiii",
    repo: "automatic-paper-search",
    ref: "develop",
    timeoutMs: 5,
    validateJobId: (value) => /^fixture-job-[1-9][0-9]*$/.test(value),
  });
  const { api, coordinator } = makeApi({ dispatcher });

  const firstResponse = await api.handle(postRequest());
  const repeatedResponse = await api.handle(postRequest());
  eq([firstResponse.status, repeatedResponse.status], [202, 202]);
  eq((await json(firstResponse)).deduplicated, false);
  eq((await json(repeatedResponse)).deduplicated, true);
  eq(Array.from(coordinator.jobs.values())[0].status.status, "queued");
  eq(coordinator.jobsCreated, 1);
  eq(fetchCalls, 1);
}));

tests.push(test("thrown or malformed dispatch result is conservatively delivery-uncertain", async () => {
  let getterReads = 0;
  const accessorResult = {};
  Object.defineProperty(accessorResult, "outcome", {
    enumerable: true,
    get() { getterReads++; return "accepted"; },
  });
  const symbolResult = { outcome: "accepted" };
  symbolResult[Symbol("extra")] = true;
  for (const dispatch of [
    async () => { throw new Error("timeout after possible delivery"); },
    async () => ({ outcome: "accepted", extra: true }),
    async () => ({ outcome: "rejected" }),
    async () => ({ ok: true }),
    async () => Object.create({ outcome: "accepted" }),
    async () => accessorResult,
    async () => symbolResult,
  ]) {
    const { api, coordinator } = makeApi({ dispatcher: { dispatch } });
    const response = await api.handle(postRequest());
    eq(response.status, 202);
    eq(Array.from(coordinator.jobs.values())[0].status.status, "queued");
  }
  eq(getterReads, 0);
}));

tests.push(test("POST status returns only the safe closed status envelope", async () => {
  const { api } = makeApi();
  const created = await json(await api.handle(postRequest()));
  const request = statusRequest(created.request_id, created.status_cap);
  truthy(!request.url.includes(created.status_cap));
  truthy(!(await request.clone().text()).includes(created.status_cap));
  const response = await api.handle(request);
  eq(response.status, 200);
  eq(await json(response), {
    ok: true,
    request_id: created.request_id,
    paper_id: PAPER_ID,
    status: "queued",
    phase: null,
    coverage: null,
    deck_id: null,
    preview_available: false,
    preview_expires_at: null,
    public_url: null,
    message_code: "PAPER_SLIDE_QUEUED",
    updated_at: "2026-09-04T00:00:00.000Z",
  });
}));

tests.push(test("wrong capability, unknown, revoked, and expired requests are indistinguishable", async () => {
  const fixture = makeApi({ coordinator: new InMemoryPaperSlideCoordinator({ requestTtlSeconds: 60 }) });
  const created = await json(await fixture.api.handle(postRequest()));
  const revokedCreated = await json(await fixture.api.handle(postRequest()));
  const wrong = await fixture.api.handle(statusRequest(
    created.request_id,
    `psc_${"A".repeat(43)}`,
  ));
  const unknown = await fixture.api.handle(statusRequest(
    "paper-slide-AAAAAAAAAAAAAAAAAAAAAA",
    created.status_cap,
  ));
  truthy(fixture.coordinator.revokeRequest(revokedCreated.request_id));
  const revoked = await fixture.api.handle(statusRequest(
    revokedCreated.request_id,
    revokedCreated.status_cap,
  ));
  fixture.setNow(NOW + 60_001);
  const expired = await fixture.api.handle(statusRequest(created.request_id, created.status_cap));
  eq([wrong.status, unknown.status, revoked.status, expired.status], [404, 404, 404, 404]);
  const wrongBody = await wrong.text();
  const unknownBody = await unknown.text();
  const revokedBody = await revoked.text();
  const expiredBody = await expired.text();
  eq(wrongBody, unknownBody);
  eq(unknownBody, revokedBody);
  eq(unknownBody, expiredBody);
}));

tests.push(test("rejects missing, null, comma-list, and suffix-confused origins", async () => {
  for (const origin of ["", "null", `${ORIGIN}, https://evil.example`, `${ORIGIN}.evil.example`]) {
    const { api } = makeApi();
    const request = postRequest(BODY, { origin });
    const response = await api.handle(request);
    eq(response.status, 403, origin);
    eq(response.headers.get("access-control-allow-origin"), null);
  }
}));

tests.push(test("accepts only application/json with optional utf-8 charset", async () => {
  for (const contentType of ["application/json", "application/json; charset=utf-8", "Application/JSON;Charset=\"UTF-8\""]) {
    const { api } = makeApi();
    eq((await api.handle(postRequest(BODY, { "content-type": contentType }))).status, 202, contentType);
  }
  for (const contentType of ["", "text/plain", "application/json-patch+json", "application/json; profile=x", "application/json, text/plain"]) {
    const { api } = makeApi();
    eq((await api.handle(postRequest(BODY, { "content-type": contentType }))).status, 415, contentType);
  }
}));

tests.push(test("rejects encoded, malformed, and non-UTF-8 request bodies", async () => {
  const encoded = makeApi();
  eq((await encoded.api.handle(postRequest(BODY, { "content-encoding": "gzip" }))).status, 415);
  const malformed = makeApi();
  eq((await malformed.api.handle(postRequest("{"))).status, 400);
  const invalidBytes = new Uint8Array([0xff, 0xfe]);
  const invalid = new Request(`${WORKER}/api/paper-slides`, {
    method: "POST",
    headers: {
      origin: ORIGIN,
      "content-type": "application/json",
      "cf-connecting-ip": "203.0.113.5",
    },
    body: invalidBytes,
  });
  eq((await makeApi().api.handle(invalid)).status, 400);
}));

tests.push(test("enforces declared and streamed body limits before JSON parsing", async () => {
  const declared = makeApi();
  eq((await declared.api.handle(postRequest(BODY, { "content-length": "513" }))).status, 413);
  const invalidLength = makeApi();
  eq((await invalidLength.api.handle(postRequest(BODY, { "content-length": "12x" }))).status, 400);
  const oversized = postRequest(`{"paper_id":"${"a".repeat(600)}"}`);
  eq((await makeApi().api.handle(oversized)).status, 413);
}));

tests.push(test("closed request validation prevents catalog access", async () => {
  const { api, catalog } = makeApi();
  const response = await api.handle(postRequest({ ...BODY, title: "untrusted" }));
  eq(response.status, 400);
  eq(catalog.calls, 0);
  const queryResponse = await api.handle(new Request(`${WORKER}/api/paper-slides?extra=1`, {
    method: "POST",
    headers: {
      origin: ORIGIN,
      "content-type": "application/json",
      "cf-connecting-ip": "203.0.113.5",
    },
    body: JSON.stringify(BODY),
  }));
  eq(queryResponse.status, 400);
  eq(catalog.calls, 0);
}));

tests.push(test("requires the Cloudflare edge IP before rate or catalog work", async () => {
  const { api, catalog } = makeApi();
  const response = await api.handle(postRequest(BODY, { "cf-connecting-ip": "" }));
  eq(response.status, 400);
  eq(catalog.calls, 0);
}));

tests.push(test("unknown and unavailable papers never reserve a job", async () => {
  const unknown = makeApi({ catalog: makeCatalog(null) });
  eq((await unknown.api.handle(postRequest())).status, 404);
  eq(unknown.coordinator.jobsCreated, 0);

  const unavailable = makeApi({ catalog: makeCatalog({
    paper_id: PAPER_ID,
    eligible: false,
    snapshot_version: "catalog-v1",
    job_key: JOB_KEY,
    failure_code: "PAPER_SLIDE_SOURCE_UNTRUSTED",
  }) });
  const response = await unavailable.api.handle(postRequest());
  eq(response.status, 422);
  eq(await json(response), {
    schema_version: "paper-slide-error-v1",
    error_code: "PAPER_UNAVAILABLE",
    failure_code: "PAPER_SLIDE_SOURCE_UNTRUSTED",
  });
  eq(unavailable.coordinator.jobsCreated, 0);
}));

tests.push(test("request and daily new-job limits are closed and carry bounded retry advice", async () => {
  const attemptLimited = makeApi({
    coordinator: new InMemoryPaperSlideCoordinator({ requestLimitPerHour: 0 }),
  });
  const attempt = await attemptLimited.api.handle(postRequest());
  eq(attempt.status, 429);
  eq(attempt.headers.get("retry-after"), "3600");
  eq(attemptLimited.catalog.calls, 0);

  const costLimited = makeApi({
    coordinator: new InMemoryPaperSlideCoordinator({ dailyJobLimit: 0 }),
  });
  const cost = await costLimited.api.handle(postRequest());
  eq(cost.status, 429);
  eq((await json(cost)).error_code, "BUDGET_EXHAUSTED");
  eq(costLimited.coordinator.jobsCreated, 0);
}));

tests.push(test("status limiter runs before capability lookup", async () => {
  const { api } = makeApi({
    coordinator: new InMemoryPaperSlideCoordinator({ statusLimitPerMinute: 0 }),
  });
  const response = await api.handle(statusRequest(
    "paper-slide-AAAAAAAAAAAAAAAAAAAAAA",
    `psc_${"A".repeat(43)}`,
  ));
  eq(response.status, 429);
  eq(response.headers.get("retry-after"), "60");
}));

tests.push(test("status accepts only exact JSON body, bearer header, and no query", async () => {
  const { api } = makeApi();
  const validId = "paper-slide-AAAAAAAAAAAAAAAAAAAAAA";
  const validCap = `psc_${"A".repeat(43)}`;
  eq((await api.handle(statusRequest("bad", validCap))).status, 400);
  eq((await api.handle(statusRequest(validId, validCap, { authorization: "Bearer nope" }))).status, 400);
  eq((await api.handle(statusRequest(validId, validCap, {}, {
    request_id: validId,
    status_cap: validCap,
  }))).status, 400);
  eq((await api.handle(statusRequest(validId, validCap, {}, { request_id: validId }, "?extra=1"))).status, 400);
  eq((await api.handle(statusRequest(validId, validCap, {
    "content-type": "text/plain",
  }))).status, 415);
  eq((await api.handle(statusRequest(validId, validCap, {}, {
    request_id: "a".repeat(600),
  }))).status, 413);
}));

tests.push(test("OPTIONS is exact-route and exact-origin only", async () => {
  const { api } = makeApi();
  for (const path of ["/api/paper-slides", "/api/paper-slides/status"]) {
    const response = await api.handle(new Request(`${WORKER}${path}`, {
      method: "OPTIONS",
      headers: { origin: ORIGIN },
    }));
    eq(response.status, 204);
    eq(response.headers.get("access-control-allow-origin"), ORIGIN);
    eq(response.headers.get("access-control-allow-headers"), "authorization, content-type");
    eq(response.headers.get("access-control-allow-methods"), "POST, OPTIONS");
  }
  eq((await api.handle(new Request(`${WORKER}/api/anything`, {
    method: "OPTIONS",
    headers: { origin: ORIGIN },
  }))).status, 404);
}));

tests.push(test("catalog/coordinator exceptions fail closed without leaking messages", async () => {
  const catalog = { async resolve() { throw new Error("secret catalog failure"); } };
  const first = await makeApi({ catalog }).api.handle(postRequest());
  eq(first.status, 503);
  truthy(!(await first.text()).includes("secret"));

  const coordinator = {
    async consumeRequestAttempt() { throw new Error("secret storage failure"); },
  };
  const second = await makeApi({ coordinator }).api.handle(postRequest());
  eq(second.status, 503);
  truthy(!(await second.text()).includes("secret"));

  const clock = await makeApi({
    now: () => { throw new Error("secret clock failure"); },
  }).api.handle(postRequest());
  eq(clock.status, 503);
  truthy(!(await clock.text()).includes("secret"));
}));

tests.push(test("malformed trusted catalog/status records fail closed", async () => {
  const badCatalog = makeApi({ catalog: makeCatalog({
    paper_id: PAPER_ID,
    eligible: true,
    snapshot_version: "catalog\u0000collision",
    job_key: JOB_KEY,
  }) });
  eq((await badCatalog.api.handle(postRequest())).status, 503);

  const badJobKey = makeApi({ catalog: makeCatalog({
    paper_id: PAPER_ID,
    eligible: true,
    snapshot_version: "catalog-v1",
    job_key: "not-canonical",
  }) });
  eq((await badJobKey.api.handle(postRequest())).status, 503);

  const coordinator = {
    async consumeStatusAttempt() { return { allowed: true, retryAfterSeconds: null }; },
    async readAuthorizedStatus() {
      return {
        paper_id: PAPER_ID,
        status: "published",
        phase: null,
        coverage: "full_text",
        deck_id: `sd1-${"b".repeat(64)}`,
        preview_available: false,
        preview_expires_at: null,
        public_url: "https://evil.example/deck.html",
        message_code: "PAPER_SLIDE_PUBLISHED",
        updated_at: "2026-09-04T00:00:00Z",
        retryable: null,
      };
    },
  };
  const api = makeApi({ coordinator }).api;
  const response = await api.handle(statusRequest(
    "paper-slide-AAAAAAAAAAAAAAAAAAAAAA",
    `psc_${"A".repeat(43)}`,
  ));
  eq(response.status, 503);
  truthy(!(await response.text()).includes("evil.example"));
}));

tests.push(test("catalog records are detached from accessors before reservation or dispatch", async () => {
  let getterReads = 0;
  let reservations = 0;
  let dispatches = 0;
  const record = {
    paper_id: PAPER_ID,
    eligible: true,
    snapshot_version: "catalog-v1",
    get job_key() {
      getterReads++;
      return getterReads === 1 ? JOB_KEY : "8".repeat(64);
    },
  };
  const coordinator = {
    async consumeRequestAttempt() { return { allowed: true, retryAfterSeconds: null }; },
    async reserveOrJoin() { reservations++; return { ok: true, deduplicated: false, jobId: "fixture-job-1" }; },
    async updateJobStatus() {},
    async revokeRequest() {},
  };
  const dispatcher = {
    async dispatch() { dispatches++; return { outcome: "accepted" }; },
  };
  const response = await makeApi({
    catalog: makeCatalog(record),
    coordinator,
    dispatcher,
  }).api.handle(postRequest());
  eq(response.status, 503);
  eq(getterReads, 0);
  eq(reservations, 0);
  eq(dispatches, 0);
}));

tests.push(test("an out-of-range clock fails before reservation and dispatch cleanup", async () => {
  let reservations = 0;
  let dispatches = 0;
  const coordinator = {
    async consumeRequestAttempt() { return { allowed: true, retryAfterSeconds: null }; },
    async reserveOrJoin() { reservations++; return { ok: true, deduplicated: false, jobId: "fixture-job-1" }; },
    async updateJobStatus() {},
    async revokeRequest() {},
  };
  const dispatcher = {
    async dispatch() { dispatches++; return { outcome: "uncertain", error_code: "PAPER_SLIDE_DISPATCH_FAILED" }; },
  };
  const response = await makeApi({
    coordinator,
    dispatcher,
    now: () => 8_640_000_000_000_001,
  }).api.handle(postRequest());
  eq(response.status, 503);
  eq(reservations, 0);
  eq(dispatches, 0);
}));

tests.push(test("rejects non-HTTP localhost origins at configuration time", () => {
  let threw = false;
  try {
    makeApi({ allowedOrigins: ["ws://localhost"] });
  } catch (error) {
    threw = error instanceof TypeError;
  }
  truthy(threw);
}));

tests.push(test("locked request bodies fail closed", async () => {
  const request = postRequest();
  const reader = request.body.getReader();
  try {
    eq((await makeApi().api.handle(request)).status, 400);
  } finally {
    reader.releaseLock();
  }
}));

tests.push(test("the fixture API never calls global fetch or dispatch", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    throw new Error("network forbidden");
  };
  try {
    const { api } = makeApi();
    const response = await api.handle(postRequest());
    eq(response.status, 202);
    eq(calls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
}));

tests.push(test("unsupported routes and methods stay closed", async () => {
  const { api } = makeApi();
  eq((await api.handle(new Request(`${WORKER}/api/paper-slides`, {
    method: "GET",
    headers: { origin: ORIGIN },
  }))).status, 405);
  eq((await api.handle(new Request(`${WORKER}/api/paper-slides/status`, {
    method: "GET",
    headers: {
      origin: ORIGIN,
      authorization: `PaperSlide psc_${"A".repeat(43)}`,
    },
  }))).status, 405);
  eq((await api.handle(new Request(`${WORKER}/api/paper-slides/status?request_id=legacy`, {
    method: "GET",
    headers: { origin: ORIGIN },
  }))).status, 400);
  eq((await api.handle(new Request(`${WORKER}/api/themes`, {
    headers: { origin: ORIGIN },
  }))).status, 404);
}));

await Promise.all(tests);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  for (const item of failures) console.log(`  - ${item.name}: ${item.error.stack || item.error.message}`);
  process.exit(1);
}
