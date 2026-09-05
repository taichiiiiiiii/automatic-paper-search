import {
  PAPER_SLIDE_DURABLE_COORDINATOR_MAX_BODY_BYTES,
  PAPER_SLIDE_DURABLE_COORDINATOR_NAME,
  PAPER_SLIDE_DURABLE_COORDINATOR_SCHEMA,
  PAPER_SLIDE_DURABLE_CLAIM_LEASE_SECONDS,
  PAPER_SLIDE_DURABLE_CLAIM_RECLAIM_GRACE_SECONDS,
  PaperSlideDurableCoordinatorService,
  PaperSlideDurableCoordinatorClientError,
  createPaperSlideDurableCoordinatorClient,
  isPaperSlideDurableJobId,
} from "./paper-slide-durable-coordinator.js";

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

class FakeDurableStorage {
  constructor(entries = new Map()) {
    this.entries = entries;
    this.tail = Promise.resolve();
  }

  async transaction(callback) {
    const previous = this.tail;
    let release;
    this.tail = new Promise((resolve) => { release = resolve; });
    await previous;
    const working = new Map(Array.from(
      this.entries,
      ([key, value]) => [key, structuredClone(value)],
    ));
    const transaction = {
      get: async (key) => working.has(key) ? structuredClone(working.get(key)) : undefined,
      put: async (key, value) => { working.set(key, structuredClone(value)); },
      delete: async (key) => working.delete(key),
    };
    try {
      const result = await callback(transaction);
      this.entries.clear();
      for (const [key, value] of working) this.entries.set(key, value);
      return result;
    } finally {
      release();
    }
  }
}

class FakeDurableNamespace {
  constructor(object) {
    this.object = object;
    this.names = [];
    this.getCalls = [];
  }

  idFromName(name) {
    this.names.push(name);
    return `id:${name}`;
  }

  get(id) {
    this.getCalls.push(id);
    return { fetch: (request) => this.object.fetch(request) };
  }
}

const NOW = Date.UTC(2026, 8, 4, 0, 0, 0);
const PAPER_ID = "a".repeat(40);
const JOB_KEY = "e".repeat(64);
const UPDATE_TOKEN = "internal-update-token-0123456789";
const CLAIMANT_TOKEN = `psct_${"A".repeat(43)}`;
const OTHER_CLAIMANT_TOKEN = `psct_${"B".repeat(43)}`;
const THIRD_CLAIMANT_TOKEN = `psct_${"C".repeat(43)}`;
const DECK_ID = `sd1-${"b".repeat(64)}`;

function claimOptions(leaseGeneration = 0, reclaim = false) {
  return { leaseGeneration, reclaim };
}

function unclaimedResult() {
  return {
    claimed: false,
    reclaimed: false,
    leaseGeneration: null,
    leaseExpiresAt: null,
  };
}

function reservation(index, overrides = {}) {
  const suffix = ["A", "Q", "g", "w"][index];
  return {
    paperId: PAPER_ID,
    language: "ja",
    coveragePreference: "auto",
    jobKey: JOB_KEY,
    requestId: `paper-slide-AAAAAAAAAAAAAAAAAAAAA${suffix}`,
    capabilityHash: String(index).repeat(64),
    nowMs: -999_999,
    ...overrides,
  };
}

function jobStatus(overrides = {}) {
  return {
    status: "queued",
    phase: null,
    coverage: null,
    deck_id: null,
    preview_available: false,
    preview_expires_at: null,
    public_url: null,
    message_code: "PAPER_SLIDE_QUEUED",
    updated_at: new Date(NOW).toISOString(),
    retryable: null,
    ...overrides,
  };
}

function fixture(envOverrides = {}) {
  let nowMs = NOW;
  const storage = new FakeDurableStorage();
  const state = { storage };
  const env = {
    PAPER_SLIDE_COORDINATOR_UPDATE_TOKEN: UPDATE_TOKEN,
    ...envOverrides,
  };
  let jobNumber = 0;
  const object = new PaperSlideDurableCoordinatorService(state, env, {
    now: () => nowMs,
    createJobId: () => `paper-slide-job-${String(jobNumber++).padStart(22, "A")}`,
  });
  const namespace = new FakeDurableNamespace(object);
  const client = createPaperSlideDurableCoordinatorClient({ namespace, updateToken: UPDATE_TOKEN });
  return {
    client,
    env,
    namespace,
    object,
    setNow(value) { nowMs = value; },
    state,
    storage,
  };
}

function internalRequest(operation, input, { headers = {}, query = "", path = "/v1/paper-slide-coordinator" } = {}) {
  return new Request(`https://durable.invalid${path}${query}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({
      schema_version: PAPER_SLIDE_DURABLE_COORDINATOR_SCHEMA,
      operation,
      input,
    }),
  });
}

const tests = [];

tests.push(test("client pins every operation to one named Durable Object", async () => {
  const { client, namespace } = fixture();
  await client.consumeRequestAttempt("203.0.113.1", Number.MAX_SAFE_INTEGER);
  await client.consumeStatusAttempt("203.0.113.1", -1);
  eq(namespace.names, [PAPER_SLIDE_DURABLE_COORDINATOR_NAME]);
  eq(namespace.getCalls, [`id:${PAPER_SLIDE_DURABLE_COORDINATOR_NAME}`]);
}));

tests.push(test("atomically creates one underlying job and durable independent aliases", async () => {
  const { client, storage } = fixture();
  const [first, second] = await Promise.all([
    client.reserveOrJoin(reservation(0)),
    client.reserveOrJoin(reservation(1)),
  ]);
  eq([first.deduplicated, second.deduplicated].sort(), [false, true]);
  eq(first.jobId, second.jobId);
  truthy(isPaperSlideDurableJobId(first.jobId));
  const jobs = Array.from(storage.entries.keys()).filter((key) => key.startsWith("job:"));
  const requests = Array.from(storage.entries.keys()).filter((key) => key.startsWith("request:"));
  eq(jobs.length, 1);
  eq(requests.length, 2);
}));

tests.push(test("persists capability hashes and authorization across object re-instantiation", async () => {
  const first = fixture();
  await first.client.reserveOrJoin(reservation(0));
  const serialized = JSON.stringify(Array.from(first.storage.entries));
  truthy(serialized.includes(reservation(0).capabilityHash));
  truthy(!serialized.includes("psc_"), "raw capabilities must never enter durable storage");

  const replacement = new PaperSlideDurableCoordinatorService(first.state, first.env, {
    now: () => NOW,
    createJobId: () => `paper-slide-job-${"B".repeat(22)}`,
  });
  const client = createPaperSlideDurableCoordinatorClient({
    namespace: new FakeDurableNamespace(replacement),
    updateToken: UPDATE_TOKEN,
  });
  eq((await client.readAuthorizedStatus({
    requestId: reservation(0).requestId,
    capabilityHash: reservation(0).capabilityHash,
    nowMs: NOW + 999_999_999,
  })).status, "queued");
  eq(await client.readAuthorizedStatus({
    requestId: reservation(0).requestId,
    capabilityHash: reservation(1).capabilityHash,
  }), null);
}));

tests.push(test("uses the object clock for fixed windows and rejects clock rollback", async () => {
  const item = fixture({ PAPER_SLIDE_REQUEST_LIMIT_PER_HOUR: "1" });
  eq((await item.client.consumeRequestAttempt("ip", NOW + 86_400_000)).allowed, true);
  eq((await item.client.consumeRequestAttempt("ip", NOW + 86_400_000)).allowed, false);
  item.setNow(NOW - 1);
  let error = null;
  try {
    await item.client.consumeStatusAttempt("ip", NOW + 999_999_999);
  } catch (caught) {
    error = caught;
  }
  truthy(error instanceof PaperSlideDurableCoordinatorClientError);
  eq(error.message, "Paper Slide durable coordinator is unavailable");
}));

tests.push(test("bounds rotating-IP rate storage and replaces expired windows in place", async () => {
  const item = fixture({
    PAPER_SLIDE_REQUEST_LIMIT_PER_HOUR: "2",
    PAPER_SLIDE_REQUEST_GLOBAL_LIMIT_PER_HOUR: "3",
    PAPER_SLIDE_STATUS_LIMIT_PER_MINUTE: "12",
    PAPER_SLIDE_STATUS_GLOBAL_LIMIT_PER_MINUTE: "2",
  });
  const statusResults = [];
  for (let index = 0; index < 20; index++) {
    statusResults.push((await item.client.consumeStatusAttempt(`status-ip-${index}`, NOW)).allowed);
  }
  eq(statusResults.filter(Boolean).length, 2);
  const statusRecord = item.storage.entries.get("rate:status:current");
  eq(statusRecord.globalCount, 2);
  eq(Object.keys(statusRecord.counts).length, 2);
  eq(Array.from(item.storage.entries.keys()).filter((key) => key.startsWith("rate:status")).length, 1);

  const requestResults = [];
  for (let index = 0; index < 20; index++) {
    requestResults.push((await item.client.consumeRequestAttempt(`request-ip-${index}`, NOW)).allowed);
  }
  eq(requestResults.filter(Boolean).length, 3);
  eq(Object.keys(item.storage.entries.get("rate:request:current").counts).length, 3);
  eq(Array.from(item.storage.entries.keys()).filter((key) => key.startsWith("rate:request")).length, 1);

  item.setNow(NOW + 3_600_000);
  eq((await item.client.consumeStatusAttempt("fresh-status-ip", NOW)).allowed, true);
  eq((await item.client.consumeRequestAttempt("fresh-request-ip", NOW)).allowed, true);
  eq(Object.keys(item.storage.entries.get("rate:status:current").counts).length, 1);
  eq(Object.keys(item.storage.entries.get("rate:request:current").counts).length, 1);
}));

tests.push(test("enforces logical request TTL without caller-controlled time", async () => {
  const item = fixture({ PAPER_SLIDE_REQUEST_TTL_SECONDS: "60" });
  await item.client.reserveOrJoin(reservation(0));
  item.setNow(NOW + 60_000);
  eq(await item.client.readAuthorizedStatus({
    requestId: reservation(0).requestId,
    capabilityHash: reservation(0).capabilityHash,
    nowMs: NOW,
  }), null);
  truthy(!item.storage.entries.has(`capability:${reservation(0).capabilityHash}`));
}));

tests.push(test("bounded expiry ring physically removes stale request credentials", async () => {
  const item = fixture({ PAPER_SLIDE_REQUEST_TTL_SECONDS: "60" });
  await item.client.reserveOrJoin(reservation(0));
  truthy(item.storage.entries.has(`request:${reservation(0).requestId}`));
  item.setNow(NOW + 25 * 3_600_000);
  await item.client.reserveOrJoin(reservation(1));
  truthy(!item.storage.entries.has(`request:${reservation(0).requestId}`));
  truthy(!item.storage.entries.has(`capability:${reservation(0).capabilityHash}`));
  eq(Array.from(item.storage.entries.keys()).filter((key) =>
    key.startsWith("expiry:request:")
  ).length, 1);
}));

tests.push(test("restart sweep removes a full bounded bucket of expired aliases", async () => {
  const item = fixture({ PAPER_SLIDE_REQUEST_TTL_SECONDS: "60" });
  for (let index = 0; index < 200; index++) {
    await item.client.reserveOrJoin({
      ...reservation(0),
      requestId: `paper-slide-${index.toString(36).padStart(22, "A")}`,
      capabilityHash: index.toString(16).padStart(64, "0"),
    });
  }
  eq(Array.from(item.storage.entries.keys()).filter((key) => key.startsWith("request:")).length, 200);
  eq(Array.from(item.storage.entries.keys()).filter((key) => key.startsWith("capability:")).length, 200);

  const replacement = new PaperSlideDurableCoordinatorService(item.state, item.env, {
    now: () => NOW + 25 * 3_600_000,
    createJobId: () => `paper-slide-job-${"W".repeat(22)}`,
  });
  const client = createPaperSlideDurableCoordinatorClient({
    namespace: new FakeDurableNamespace(replacement),
    updateToken: UPDATE_TOKEN,
  });
  await client.reserveOrJoin({
    ...reservation(0),
    requestId: `paper-slide-${(200).toString(36).padStart(22, "A")}`,
    capabilityHash: (200).toString(16).padStart(64, "0"),
  });
  eq(Array.from(item.storage.entries.keys()).filter((key) => key.startsWith("request:")).length, 1);
  eq(Array.from(item.storage.entries.keys()).filter((key) => key.startsWith("capability:")).length, 1);
  eq(Array.from(item.storage.entries.keys()).filter((key) => key.startsWith("expiry:request:")).length, 1);
}));

tests.push(test("expiry ring separates adjacent issue-hour cohorts without amplification", async () => {
  const item = fixture({ PAPER_SLIDE_REQUEST_TTL_SECONDS: "60" });
  for (let index = 0; index < 400; index++) {
    if (index === 0) item.setNow(NOW + 3_599_000);
    if (index === 200) item.setNow(NOW + 3_600_000);
    await item.client.reserveOrJoin({
      ...reservation(0),
      requestId: `paper-slide-${index.toString(36).padStart(22, "A")}`,
      capabilityHash: index.toString(16).padStart(64, "0"),
    });
  }
  const buckets = Array.from(item.storage.entries.entries()).filter(([key]) =>
    key.startsWith("expiry:request:")
  );
  eq(buckets.length, 2);
  eq(buckets.map(([, bucket]) => bucket.entries.length).sort(), [200, 200]);
  const jobs = Array.from(item.storage.entries.values()).filter((value) =>
    value && typeof value === "object" && Object.hasOwn(value, "aliasCount")
  );
  eq(jobs.length, 1);
  eq(jobs[0].aliasCount, 400);
}));

tests.push(test("expired credential reuse releases the old job alias exactly once", async () => {
  const byRequest = fixture({ PAPER_SLIDE_REQUEST_TTL_SECONDS: "60" });
  const first = await byRequest.client.reserveOrJoin(reservation(0));
  byRequest.setNow(NOW + 60_000);
  await byRequest.client.reserveOrJoin(reservation(0, {
    capabilityHash: "1".repeat(64),
    jobKey: "f".repeat(64),
    language: "en",
  }));
  eq(byRequest.storage.entries.get(`job:${first.jobId}`).aliasCount, 0);

  const byCapability = fixture({ PAPER_SLIDE_REQUEST_TTL_SECONDS: "60" });
  const original = await byCapability.client.reserveOrJoin(reservation(0));
  byCapability.setNow(NOW + 60_000);
  await byCapability.client.reserveOrJoin(reservation(1, {
    capabilityHash: reservation(0).capabilityHash,
    jobKey: "f".repeat(64),
    language: "en",
  }));
  truthy(!byCapability.storage.entries.has(`request:${reservation(0).requestId}`));
  eq(byCapability.storage.entries.get(`job:${original.jobId}`).aliasCount, 0);
}));

tests.push(test("fixed job retention bounds job and cache records across restart", async () => {
  const item = fixture();
  const first = await item.client.reserveOrJoin(reservation(0));
  const replacement = new PaperSlideDurableCoordinatorService(item.state, item.env, {
    now: () => NOW + 30 * 86_400_000,
    createJobId: () => `paper-slide-job-${"V".repeat(22)}`,
  });
  const client = createPaperSlideDurableCoordinatorClient({
    namespace: new FakeDurableNamespace(replacement),
    updateToken: UPDATE_TOKEN,
  });
  const second = await client.reserveOrJoin(reservation(1));
  eq(second.deduplicated, false);
  truthy(second.jobId !== first.jobId);
  eq(Array.from(item.storage.entries.keys()).filter((key) => key.startsWith("job:")).length, 1);
  eq(Array.from(item.storage.entries.keys()).filter((key) => key.startsWith("cache:")).length, 1);
  eq(await client.readAuthorizedStatus({
    requestId: reservation(0).requestId,
    capabilityHash: reservation(0).capabilityHash,
  }), null);
}));

tests.push(test("retention expires a published dedup target even when its sweep day was idle", async () => {
  const item = fixture();
  const first = await item.client.reserveOrJoin(reservation(0));
  const claim = await item.client.claimJob(first.jobId, CLAIMANT_TOKEN, claimOptions());
  await item.client.updateClaimedJobStatus(first.jobId, jobStatus({
    status: "running", phase: "generating", message_code: "PAPER_SLIDE_GENERATING",
  }), CLAIMANT_TOKEN, claim.leaseGeneration);
  await item.client.updateClaimedJobStatus(first.jobId, jobStatus({
    status: "validating", phase: "validating", message_code: "PAPER_SLIDE_VALIDATING",
  }), CLAIMANT_TOKEN, claim.leaseGeneration);
  await item.client.updateClaimedJobStatus(first.jobId, jobStatus({
    status: "awaiting_review",
    phase: "awaiting_review",
    coverage: "abstract_only",
    deck_id: DECK_ID,
    preview_available: false,
    message_code: "PAPER_SLIDE_AWAITING_REVIEW",
  }), CLAIMANT_TOKEN, claim.leaseGeneration);
  await item.client.updateJobStatus(first.jobId, jobStatus({
    status: "publishing",
    phase: "smoke",
    coverage: "abstract_only",
    deck_id: DECK_ID,
    message_code: "PAPER_SLIDE_SMOKE",
  }));
  await item.client.updateJobStatus(first.jobId, jobStatus({
    status: "published",
    coverage: "abstract_only",
    deck_id: DECK_ID,
    public_url: `/automatic-paper-search/paper-slides-v1/decks/${DECK_ID}/${"c".repeat(64)}-${"d".repeat(64)}.html`,
    message_code: "PAPER_SLIDE_PUBLISHED",
  }));

  item.setNow(NOW + 31 * 86_400_000);
  const second = await item.client.reserveOrJoin(reservation(1));
  eq(second.deduplicated, false);
  truthy(second.jobId !== first.jobId);

  // A later ring sweep must tolerate aliases whose retained job has already
  // been removed, and must still remove the stale credentials.
  item.setNow(NOW + 750 * 3_600_000);
  await item.client.reserveOrJoin(reservation(2));
  truthy(!item.storage.entries.has(`request:${reservation(0).requestId}`));
}));

tests.push(test("deduplicated aliases do not consume the daily new-job ceiling", async () => {
  const { client } = fixture({ PAPER_SLIDE_DAILY_JOB_LIMIT: "1" });
  eq((await client.reserveOrJoin(reservation(0))).ok, true);
  eq((await client.reserveOrJoin(reservation(1))).deduplicated, true);
  eq(await client.reserveOrJoin(reservation(2, {
    language: "en",
    jobKey: "f".repeat(64),
  })), { ok: false, reason: "daily_job_limited", retryAfterSeconds: 86400 });
}));

tests.push(test("queued dispatch deadline survives restart, fails closed, and permits retry", async () => {
  const item = fixture({ PAPER_SLIDE_DISPATCH_TTL_SECONDS: "900" });
  const first = await item.client.reserveOrJoin(reservation(0));
  item.setNow(NOW + 899_999);
  eq((await item.client.readAuthorizedStatus({
    requestId: reservation(0).requestId,
    capabilityHash: reservation(0).capabilityHash,
    nowMs: NOW + 9_999_999,
  })).status, "queued");

  const replacement = new PaperSlideDurableCoordinatorService(item.state, item.env, {
    now: () => NOW + 900_000,
    createJobId: () => `paper-slide-job-${"Z".repeat(22)}`,
  });
  const client = createPaperSlideDurableCoordinatorClient({
    namespace: new FakeDurableNamespace(replacement),
    updateToken: UPDATE_TOKEN,
  });
  const expired = await client.readAuthorizedStatus({
    requestId: reservation(0).requestId,
    capabilityHash: reservation(0).capabilityHash,
  });
  eq(expired.status, "failed");
  eq(expired.message_code, "PAPER_SLIDE_FAILED");
  eq(expired.retryable, true);
  eq(item.storage.entries.get(`job:${first.jobId}`).dispatchExpiresAtMs, null);

  const retry = await client.reserveOrJoin(reservation(1));
  eq(retry.deduplicated, false);
  truthy(retry.jobId !== first.jobId);
}));

tests.push(test("only one restarted workflow can atomically claim a queued job", async () => {
  const item = fixture();
  const created = await item.client.reserveOrJoin(reservation(0));
  const replacement = new PaperSlideDurableCoordinatorService(item.state, item.env, {
    now: () => NOW + 1,
    createJobId: () => `paper-slide-job-${"Y".repeat(22)}`,
  });
  const firstClient = createPaperSlideDurableCoordinatorClient({
    namespace: new FakeDurableNamespace(replacement),
    updateToken: UPDATE_TOKEN,
  });
  const secondClient = createPaperSlideDurableCoordinatorClient({
    namespace: new FakeDurableNamespace(replacement),
    updateToken: UPDATE_TOKEN,
  });
  const claims = await Promise.all([
    firstClient.claimJob(created.jobId, CLAIMANT_TOKEN, claimOptions()),
    secondClient.claimJob(created.jobId, OTHER_CLAIMANT_TOKEN, claimOptions()),
  ]);
  eq(claims.map((value) => value.claimed).sort(), [false, true]);
  const winner = claims[0].claimed ? CLAIMANT_TOKEN : OTHER_CLAIMANT_TOKEN;
  const loser = claims[0].claimed ? OTHER_CLAIMANT_TOKEN : CLAIMANT_TOKEN;
  const confirmed = await firstClient.claimJob(created.jobId, winner, claimOptions());
  eq([confirmed.claimed, confirmed.leaseGeneration], [true, 1]);
  eq(
    await firstClient.claimJob(created.jobId, loser, claimOptions()),
    unclaimedResult(),
  );
  eq(await firstClient.claimJob(
    `paper-slide-job-${"X".repeat(22)}`,
    winner,
    claimOptions(),
  ), unclaimedResult());
  const status = await firstClient.readAuthorizedStatus({
    requestId: reservation(0).requestId,
    capabilityHash: reservation(0).capabilityHash,
  });
  eq([status.status, status.phase], ["running", "resolving_source"]);
  eq(item.storage.entries.get(`job:${created.jobId}`).dispatchExpiresAtMs, null);
}));

tests.push(test("same claimant safely re-confirms a lost claim response without persisting its token", async () => {
  const item = fixture();
  const created = await item.client.reserveOrJoin(reservation(0));
  const first = await item.client.claimJob(created.jobId, CLAIMANT_TOKEN, claimOptions());
  const replay = await item.client.claimJob(created.jobId, CLAIMANT_TOKEN, claimOptions());
  eq(replay, first);
  truthy(!JSON.stringify(Array.from(item.storage.entries)).includes(CLAIMANT_TOKEN));

  item.setNow(NOW + 1_000);
  const heartbeat = await item.client.claimJob(
    created.jobId,
    CLAIMANT_TOKEN,
    claimOptions(first.leaseGeneration),
  );
  eq(heartbeat.claimed, true);
  eq(
    Date.parse(heartbeat.leaseExpiresAt),
    NOW + 1_000 + PAPER_SLIDE_DURABLE_CLAIM_LEASE_SECONDS * 1000,
  );
}));

tests.push(test("expired pre-provider lease has one explicit grace-delayed fenced reclaim", async () => {
  const item = fixture();
  const created = await item.client.reserveOrJoin(reservation(0));
  const first = await item.client.claimJob(created.jobId, CLAIMANT_TOKEN, claimOptions());
  const reclaimAt = Date.parse(first.leaseExpiresAt) +
    PAPER_SLIDE_DURABLE_CLAIM_RECLAIM_GRACE_SECONDS * 1000;

  item.setNow(reclaimAt - 1);
  eq(await item.client.claimJob(
    created.jobId,
    OTHER_CLAIMANT_TOKEN,
    claimOptions(first.leaseGeneration, true),
  ), unclaimedResult());

  item.setNow(reclaimAt);
  const reclaimed = await item.client.claimJob(
    created.jobId,
    OTHER_CLAIMANT_TOKEN,
    claimOptions(first.leaseGeneration, true),
  );
  eq([reclaimed.claimed, reclaimed.reclaimed, reclaimed.leaseGeneration], [true, true, 2]);
  eq(await item.client.claimJob(
    created.jobId,
    OTHER_CLAIMANT_TOKEN,
    claimOptions(first.leaseGeneration, true),
  ), reclaimed, "a lost reclaim response must be safely re-confirmable");
  let staleRejected = false;
  try {
    await item.client.updateClaimedJobStatus(
      created.jobId,
      jobStatus({ status: "failed", message_code: "PAPER_SLIDE_FAILED", retryable: true }),
      CLAIMANT_TOKEN,
      first.leaseGeneration,
    );
  } catch { staleRejected = true; }
  truthy(staleRejected);

  item.setNow(Date.parse(reclaimed.leaseExpiresAt) +
    PAPER_SLIDE_DURABLE_CLAIM_RECLAIM_GRACE_SECONDS * 1000);
  eq(await item.client.claimJob(
    created.jobId,
    THIRD_CLAIMANT_TOKEN,
    claimOptions(reclaimed.leaseGeneration, true),
  ), unclaimedResult());
}));

tests.push(test("provider fence is idempotent for its claimant and is never timeout-reclaimed", async () => {
  const item = fixture();
  const created = await item.client.reserveOrJoin(reservation(0));
  const claim = await item.client.claimJob(created.jobId, CLAIMANT_TOKEN, claimOptions());
  const generating = jobStatus({
    status: "running", phase: "generating", message_code: "PAPER_SLIDE_GENERATING",
  });
  await item.client.updateClaimedJobStatus(
    created.jobId, generating, CLAIMANT_TOKEN, claim.leaseGeneration,
  );
  let stored = item.storage.entries.get(`job:${created.jobId}`);
  eq([stored.providerFenced, stored.claimLeaseExpiresAtMs], [true, null]);

  item.setNow(NOW + 7 * 86_400_000);
  eq(await item.client.claimJob(
    created.jobId,
    OTHER_CLAIMANT_TOKEN,
    claimOptions(claim.leaseGeneration, true),
  ), unclaimedResult());
  eq(await item.client.claimJob(
    created.jobId,
    CLAIMANT_TOKEN,
    claimOptions(claim.leaseGeneration),
  ), unclaimedResult());

  await item.client.updateClaimedJobStatus(
    created.jobId, generating, CLAIMANT_TOKEN, claim.leaseGeneration,
  );
  await item.client.updateClaimedJobStatus(created.jobId, jobStatus({
    status: "validating", phase: "validating", message_code: "PAPER_SLIDE_VALIDATING",
  }), CLAIMANT_TOKEN, claim.leaseGeneration);
  await item.client.updateClaimedJobStatus(created.jobId, jobStatus({
    status: "awaiting_review",
    phase: "awaiting_review",
    coverage: "abstract_only",
    deck_id: DECK_ID,
    preview_available: false,
    message_code: "PAPER_SLIDE_AWAITING_REVIEW",
  }), CLAIMANT_TOKEN, claim.leaseGeneration);
  stored = item.storage.entries.get(`job:${created.jobId}`);
  eq([stored.claimantHash, stored.claimLeaseExpiresAtMs, stored.providerFenced], [null, null, false]);
}));

tests.push(test("claimant cannot skip the atomic provider fence", async () => {
  const item = fixture();
  const created = await item.client.reserveOrJoin(reservation(0));
  const claim = await item.client.claimJob(created.jobId, CLAIMANT_TOKEN, claimOptions());
  let rejected = false;
  try {
    await item.client.updateClaimedJobStatus(created.jobId, jobStatus({
      status: "validating", phase: "validating", message_code: "PAPER_SLIDE_VALIDATING",
    }), CLAIMANT_TOKEN, claim.leaseGeneration);
  } catch { rejected = true; }
  truthy(rejected);
  const stored = item.storage.entries.get(`job:${created.jobId}`);
  eq([stored.status.status, stored.status.phase, stored.providerFenced], [
    "running", "resolving_source", false,
  ]);
}));

tests.push(test("authenticated reconciliation can only close an active claim as failed", async () => {
  const item = fixture();
  const created = await item.client.reserveOrJoin(reservation(0));
  const claim = await item.client.claimJob(created.jobId, CLAIMANT_TOKEN, claimOptions());
  await item.client.updateClaimedJobStatus(created.jobId, jobStatus({
    status: "running", phase: "generating", message_code: "PAPER_SLIDE_GENERATING",
  }), CLAIMANT_TOKEN, claim.leaseGeneration);
  await item.client.updateJobStatus(created.jobId, jobStatus({
    status: "failed", message_code: "PAPER_SLIDE_FAILED", retryable: true,
  }));
  const stored = item.storage.entries.get(`job:${created.jobId}`);
  eq([stored.status.status, stored.claimantHash, stored.providerFenced], ["failed", null, false]);

  let cannotRestart = false;
  try {
    await item.client.updateJobStatus(created.jobId, jobStatus({
      status: "running", phase: "resolving_source", message_code: "PAPER_SLIDE_RESOLVING_SOURCE",
    }));
  } catch { cannotRestart = true; }
  truthy(cannotRestart);
}));

tests.push(test("late workflow claim atomically expires queued dispatch and is rejected", async () => {
  const item = fixture({ PAPER_SLIDE_DISPATCH_TTL_SECONDS: "60" });
  const created = await item.client.reserveOrJoin(reservation(0));
  item.setNow(NOW + 60_000);
  eq(
    await item.client.claimJob(created.jobId, CLAIMANT_TOKEN, claimOptions()),
    unclaimedResult(),
  );
  eq((await item.client.readAuthorizedStatus({
    requestId: reservation(0).requestId,
    capabilityHash: reservation(0).capabilityHash,
  })).status, "failed");
}));

tests.push(test("status updates are authenticated, closed, monotonic, and safe to read", async () => {
  const item = fixture();
  const created = await item.client.reserveOrJoin(reservation(0));
  const claim = await item.client.claimJob(created.jobId, CLAIMANT_TOKEN, claimOptions());
  await item.client.updateClaimedJobStatus(created.jobId, jobStatus({
    status: "running",
    phase: "extracting",
    message_code: "PAPER_SLIDE_EXTRACTING",
  }), CLAIMANT_TOKEN, claim.leaseGeneration);
  eq(item.storage.entries.get(`job:${created.jobId}`).dispatchExpiresAtMs, null);
  eq((await item.client.readAuthorizedStatus({
    requestId: reservation(0).requestId,
    capabilityHash: reservation(0).capabilityHash,
  })).phase, "extracting");

  for (const invalid of [
    jobStatus({ status: "queued", progress: 3 }),
    jobStatus({ status: "running", phase: "fetching", message_code: "PAPER_SLIDE_FETCHING" }),
  ]) {
    let threw = false;
    try {
      await item.client.updateClaimedJobStatus(
        created.jobId,
        invalid,
        CLAIMANT_TOKEN,
        claim.leaseGeneration,
      );
    } catch { threw = true; }
    truthy(threw);
  }

  const noToken = createPaperSlideDurableCoordinatorClient({
    namespace: new FakeDurableNamespace(item.object),
  });
  let denied = false;
  try {
    await noToken.updateClaimedJobStatus(
      created.jobId,
      jobStatus(),
      CLAIMANT_TOKEN,
      claim.leaseGeneration,
    );
  } catch { denied = true; }
  truthy(denied);
}));

tests.push(test("atomically expires candidates while retaining terminal alias status", async () => {
  const item = fixture({ PAPER_SLIDE_CANDIDATE_TTL_SECONDS: "60" });
  const created = await item.client.reserveOrJoin(reservation(0));
  const claim = await item.client.claimJob(created.jobId, CLAIMANT_TOKEN, claimOptions());
  await item.client.updateClaimedJobStatus(created.jobId, jobStatus({
    status: "running", phase: "generating", message_code: "PAPER_SLIDE_GENERATING",
  }), CLAIMANT_TOKEN, claim.leaseGeneration);
  await item.client.updateClaimedJobStatus(created.jobId, jobStatus({
    status: "validating", phase: "validating", message_code: "PAPER_SLIDE_VALIDATING",
  }), CLAIMANT_TOKEN, claim.leaseGeneration);
  await item.client.updateClaimedJobStatus(created.jobId, jobStatus({
    status: "awaiting_review",
    phase: "awaiting_review",
    coverage: "full_text",
    deck_id: DECK_ID,
    preview_available: true,
    preview_expires_at: "2026-09-04T00:01:00Z",
    message_code: "PAPER_SLIDE_AWAITING_REVIEW",
  }), CLAIMANT_TOKEN, claim.leaseGeneration);
  item.setNow(NOW + 60_000);
  const status = await item.client.readAuthorizedStatus({
    requestId: reservation(0).requestId,
    capabilityHash: reservation(0).capabilityHash,
  });
  eq(status.status, "expired");
  eq(status.preview_available, false);
  eq(status.retryable, true);
}));

tests.push(test("administrative promotion atomically expires a stale candidate first", async () => {
  const item = fixture({ PAPER_SLIDE_CANDIDATE_TTL_SECONDS: "60" });
  const created = await item.client.reserveOrJoin(reservation(0));
  const claim = await item.client.claimJob(created.jobId, CLAIMANT_TOKEN, claimOptions());
  await item.client.updateClaimedJobStatus(created.jobId, jobStatus({
    status: "running", phase: "generating", message_code: "PAPER_SLIDE_GENERATING",
  }), CLAIMANT_TOKEN, claim.leaseGeneration);
  await item.client.updateClaimedJobStatus(created.jobId, jobStatus({
    status: "validating", phase: "validating", message_code: "PAPER_SLIDE_VALIDATING",
  }), CLAIMANT_TOKEN, claim.leaseGeneration);
  await item.client.updateClaimedJobStatus(created.jobId, jobStatus({
    status: "awaiting_review",
    phase: "awaiting_review",
    coverage: "full_text",
    deck_id: DECK_ID,
    preview_available: true,
    preview_expires_at: "2026-09-04T00:01:00Z",
    message_code: "PAPER_SLIDE_AWAITING_REVIEW",
  }), CLAIMANT_TOKEN, claim.leaseGeneration);

  item.setNow(NOW + 60_000);
  let rejected = false;
  try {
    await item.client.updateJobStatus(created.jobId, jobStatus({
      status: "publishing",
      phase: "promoting",
      coverage: "full_text",
      deck_id: DECK_ID,
      message_code: "PAPER_SLIDE_PROMOTING",
      updated_at: "2026-09-04T00:01:00Z",
    }));
  } catch (error) {
    rejected = error instanceof PaperSlideDurableCoordinatorClientError;
  }
  truthy(rejected, "an expired candidate must not enter publishing");

  const status = await item.client.readAuthorizedStatus({
    requestId: reservation(0).requestId,
    capabilityHash: reservation(0).capabilityHash,
  });
  eq(status.status, "expired");
  eq(status.preview_available, false);
  eq(status.preview_expires_at, null);
}));

tests.push(test("authenticated revoke removes only the alias and capability index", async () => {
  const item = fixture();
  const created = await item.client.reserveOrJoin(reservation(0));
  eq(await item.client.revokeRequest(reservation(0).requestId), true);
  eq(await item.client.revokeRequest(reservation(0).requestId), false);
  eq(await item.client.readAuthorizedStatus({
    requestId: reservation(0).requestId,
    capabilityHash: reservation(0).capabilityHash,
  }), null);
  truthy(item.storage.entries.has(`job:${created.jobId}`), "revoke must not destroy a shared job");
  truthy(!item.storage.entries.has(`capability:${reservation(0).capabilityHash}`));
}));

tests.push(test("failed-dispatch update plus revoke removes the stuck dedup target", async () => {
  const item = fixture();
  const first = await item.client.reserveOrJoin(reservation(0));
  await item.client.updateJobStatus(first.jobId, jobStatus({
    status: "failed",
    message_code: "PAPER_SLIDE_FAILED",
    retryable: true,
  }));
  eq(await item.client.revokeRequest(reservation(0).requestId), true);
  truthy(!item.storage.entries.has(`job:${first.jobId}`));
  truthy(!item.storage.entries.has(`cache:${JOB_KEY}`));
  const retry = await item.client.reserveOrJoin(reservation(1));
  eq(retry.deduplicated, false);
  truthy(retry.jobId !== first.jobId);
}));

tests.push(test("enforces a bounded closed internal request schema", async () => {
  const { object } = fixture();
  const extra = await object.fetch(new Request("https://durable.invalid/v1/paper-slide-coordinator", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      schema_version: PAPER_SLIDE_DURABLE_COORDINATOR_SCHEMA,
      operation: "consume_request_attempt",
      input: { ip: "ip", now_ms: NOW },
    }),
  }));
  eq(extra.status, 400);
  eq(await extra.json(), {
    schema_version: PAPER_SLIDE_DURABLE_COORDINATOR_SCHEMA,
    ok: false,
    error: "invalid_request",
  });

  const oversized = await object.fetch(new Request("https://durable.invalid/v1/paper-slide-coordinator", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "content-length": String(PAPER_SLIDE_DURABLE_COORDINATOR_MAX_BODY_BYTES + 1),
    },
    body: "{}",
  }));
  eq(oversized.status, 400);
  eq((await oversized.json()).error, "invalid_request");

  eq((await object.fetch(internalRequest(
    "consume_request_attempt",
    { ip: "ip" },
    { query: "?debug=1" },
  ))).status, 404);

  const readerFailure = await object.fetch({
    url: "https://durable.invalid/v1/paper-slide-coordinator",
    method: "POST",
    headers: new Headers({ "content-type": "application/json" }),
    body: { getReader() { throw new Error("secret reader failure"); } },
  });
  eq(readerFailure.status, 400);
  truthy(!(await readerFailure.text()).includes("secret"));
}));

tests.push(test("direct status mutation requires the internal update credential", async () => {
  const { object } = fixture();
  const response = await object.fetch(internalRequest("revoke_request", {
    request_id: reservation(0).requestId,
  }));
  eq(response.status, 403);
  eq(await response.json(), {
    schema_version: PAPER_SLIDE_DURABLE_COORDINATOR_SCHEMA,
    ok: false,
    error: "forbidden",
  });

  const oversized = await object.fetch(internalRequest("revoke_request", {
    request_id: reservation(0).requestId,
  }, {
    headers: { "x-paper-slide-coordinator-update-token": "x".repeat(10_000) },
  }));
  eq(oversized.status, 403);
  eq(await oversized.json(), {
    schema_version: PAPER_SLIDE_DURABLE_COORDINATOR_SCHEMA,
    ok: false,
    error: "forbidden",
  });
}));

tests.push(test("storage and clock failures return the same non-leaking service error", async () => {
  const badState = {
    storage: {
      async transaction() { throw new Error("secret durable storage failure"); },
    },
  };
  const object = new PaperSlideDurableCoordinatorService(badState, {
    PAPER_SLIDE_COORDINATOR_UPDATE_TOKEN: UPDATE_TOKEN,
  }, { now: () => NOW });
  const response = await object.fetch(internalRequest("consume_request_attempt", { ip: "ip" }));
  eq(response.status, 503);
  const text = await response.text();
  truthy(!text.includes("secret"));
  eq(JSON.parse(text).error, "service_unavailable");

  const malformedNamespace = {
    idFromName() { return "id"; },
    get() {
      return {
        async fetch() {
          return { body: { getReader() { throw new Error("secret response reader failure"); } } };
        },
      };
    },
  };
  const malformedClient = createPaperSlideDurableCoordinatorClient({
    namespace: malformedNamespace,
  });
  let clientError = null;
  try {
    await malformedClient.consumeRequestAttempt("ip", NOW);
  } catch (error) {
    clientError = error;
  }
  truthy(clientError instanceof PaperSlideDurableCoordinatorClientError);
  truthy(!clientError.message.includes("secret"));
}));

tests.push(test("malformed durable associations and cache records fail closed", async () => {
  const missingCapability = fixture();
  await missingCapability.client.reserveOrJoin(reservation(0));
  missingCapability.storage.entries.delete(`capability:${reservation(0).capabilityHash}`);
  let missingError = null;
  try {
    await missingCapability.client.readAuthorizedStatus({
      requestId: reservation(0).requestId,
      capabilityHash: reservation(0).capabilityHash,
    });
  } catch (error) {
    missingError = error;
  }
  truthy(missingError instanceof PaperSlideDurableCoordinatorClientError);

  const mismatchedCache = fixture();
  const created = await mismatchedCache.client.reserveOrJoin(reservation(0));
  const storedJob = mismatchedCache.storage.entries.get(`job:${created.jobId}`);
  storedJob.cacheKey = "f".repeat(64);
  mismatchedCache.storage.entries.set(`job:${created.jobId}`, storedJob);
  let cacheError = null;
  try {
    await mismatchedCache.client.reserveOrJoin(reservation(1));
  } catch (error) {
    cacheError = error;
  }
  truthy(cacheError instanceof PaperSlideDurableCoordinatorClientError);
}));

tests.push(test("corrupted daily job counters fail closed without bypassing the ceiling", async () => {
  for (const dailyRecord of [
    { day: "2026-99-99", count: 20 },
    { day: "2026-09-04", count: 21 },
  ]) {
    const item = fixture();
    item.storage.entries.set("daily:current", dailyRecord);
    let error = null;
    try {
      await item.client.reserveOrJoin(reservation(0));
    } catch (caught) {
      error = caught;
    }
    truthy(error instanceof PaperSlideDurableCoordinatorClientError);
    eq(Array.from(item.storage.entries.keys()).filter((key) => key.startsWith("job:")).length, 0);
  }
}));

tests.push(test("rejects configuration above every approved cost and abuse ceiling", async () => {
  for (const [binding, value] of [
    ["PAPER_SLIDE_REQUEST_LIMIT_PER_HOUR", "3"],
    ["PAPER_SLIDE_REQUEST_GLOBAL_LIMIT_PER_HOUR", "201"],
    ["PAPER_SLIDE_STATUS_LIMIT_PER_MINUTE", "13"],
    ["PAPER_SLIDE_STATUS_GLOBAL_LIMIT_PER_MINUTE", "61"],
    ["PAPER_SLIDE_DAILY_JOB_LIMIT", "21"],
    ["PAPER_SLIDE_DISPATCH_TTL_SECONDS", "901"],
    ["PAPER_SLIDE_REQUEST_TTL_SECONDS", "86401"],
    ["PAPER_SLIDE_CANDIDATE_TTL_SECONDS", "86401"],
    ["PAPER_SLIDE_CLAIM_LEASE_SECONDS", "901"],
    ["PAPER_SLIDE_CLAIM_LEASE_SECONDS", "0"],
  ]) {
    const item = fixture({ [binding]: value });
    const response = await item.object.fetch(internalRequest("consume_request_attempt", { ip: "ip" }));
    eq(response.status, 503, binding);
    eq((await response.json()).error, "service_unavailable", binding);
  }
}));

tests.push(test("bounds durable time so retention and lease timestamps remain four-digit ISO", async () => {
  const maxDateMs = Date.UTC(10000, 0, 1) - 1;
  const maxServerNowMs = maxDateMs - 30 * 86_400_000;
  const item = fixture();
  item.setNow(maxServerNowMs);
  const created = await item.client.reserveOrJoin(reservation(0));
  const stored = item.storage.entries.get(`job:${created.jobId}`);
  eq(stored.retentionExpiresAtMs, maxDateMs);
  truthy(stored.status.updated_at.startsWith("9999-"));
  const claim = await item.client.claimJob(created.jobId, CLAIMANT_TOKEN, claimOptions());
  truthy(claim.leaseExpiresAt.startsWith("9999-"));

  const tooLate = fixture();
  tooLate.setNow(maxServerNowMs + 1);
  const response = await tooLate.object.fetch(internalRequest("consume_request_attempt", { ip: "ip" }));
  eq(response.status, 503);
  eq((await response.json()).error, "service_unavailable");
}));

await Promise.all(tests);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  for (const item of failures) console.log(`  - ${item.name}: ${item.error.stack || item.error.message}`);
  process.exit(1);
}
