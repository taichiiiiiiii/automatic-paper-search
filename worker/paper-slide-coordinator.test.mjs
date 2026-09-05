import {
  InMemoryPaperSlideCoordinator,
  PaperSlideCoordinatorError,
} from "./paper-slide-coordinator.js";

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

const NOW = Date.UTC(2026, 8, 4, 0, 0, 0);
const PAPER_ID = "a".repeat(40);
const UPDATED_AT = "2026-09-04T00:00:00Z";
const DECK_ID = `sd1-${"b".repeat(64)}`;
const JOB_KEY = "e".repeat(64);
const PUBLIC_URL = `/automatic-paper-search/paper-slides-v1/decks/${DECK_ID}/${"c".repeat(64)}-${"d".repeat(64)}.html`;
const BASE = {
  paperId: PAPER_ID,
  language: "ja",
  coveragePreference: "auto",
  jobKey: JOB_KEY,
  nowMs: NOW,
};

function reservation(index, overrides = {}) {
  const suffix = ["A", "Q", "g", "w"][index];
  return {
    ...BASE,
    requestId: `paper-slide-AAAAAAAAAAAAAAAAAAAAA${suffix}`,
    capabilityHash: String(index).repeat(64),
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
    updated_at: UPDATED_AT,
    retryable: null,
    ...overrides,
  };
}

const tests = [];

tests.push(test("atomically deduplicates concurrent requests while preserving aliases", async () => {
  const coordinator = new InMemoryPaperSlideCoordinator();
  const [first, second] = await Promise.all([
    coordinator.reserveOrJoin(reservation(0)),
    coordinator.reserveOrJoin(reservation(1)),
  ]);
  eq(first.ok, true);
  eq(second.ok, true);
  eq([first.deduplicated, second.deduplicated].sort(), [false, true]);
  eq(first.jobId, second.jobId);
  eq(coordinator.jobsCreated, 1);
  eq(coordinator.requestCount, 2);
}));

tests.push(test("uses the documented request and new-job defaults", () => {
  const coordinator = new InMemoryPaperSlideCoordinator();
  eq(coordinator.requestLimitPerHour, 2);
  eq(coordinator.dailyJobLimit, 20);
}));

tests.push(test("does not deduplicate distinct trusted canonical job keys", async () => {
  const coordinator = new InMemoryPaperSlideCoordinator();
  const first = await coordinator.reserveOrJoin(reservation(0));
  const second = await coordinator.reserveOrJoin(reservation(1, { jobKey: "f".repeat(64) }));
  eq([first.deduplicated, second.deduplicated], [false, false]);
  truthy(first.jobId !== second.jobId);
  eq(coordinator.jobsCreated, 2);
}));

tests.push(test("status capability scopes each fresh request alias", async () => {
  const coordinator = new InMemoryPaperSlideCoordinator();
  await coordinator.reserveOrJoin(reservation(0));
  await coordinator.reserveOrJoin(reservation(1));
  truthy(await coordinator.readAuthorizedStatus({
    requestId: reservation(0).requestId,
    capabilityHash: reservation(0).capabilityHash,
    nowMs: NOW,
  }));
  eq(await coordinator.readAuthorizedStatus({
    requestId: reservation(0).requestId,
    capabilityHash: reservation(1).capabilityHash,
    nowMs: NOW,
  }), null);
}));

tests.push(test("deduplicated requests do not consume the daily new-job ceiling", async () => {
  const coordinator = new InMemoryPaperSlideCoordinator({ dailyJobLimit: 1 });
  eq((await coordinator.reserveOrJoin(reservation(0))).ok, true);
  const duplicate = await coordinator.reserveOrJoin(reservation(1));
  eq(duplicate.ok, true);
  eq(duplicate.deduplicated, true);
  const blocked = await coordinator.reserveOrJoin(reservation(2, {
    language: "en",
    jobKey: "f".repeat(64),
  }));
  eq(blocked, { ok: false, reason: "daily_job_limited", retryAfterSeconds: 86400 });
}));

tests.push(test("failed jobs do not suppress an explicit retry", async () => {
  const coordinator = new InMemoryPaperSlideCoordinator();
  const first = await coordinator.reserveOrJoin(reservation(0));
  await coordinator.updateJobStatus(first.jobId, jobStatus({
    status: "failed",
    message_code: "PAPER_SLIDE_FAILED",
    retryable: true,
  }), NOW);
  const retry = await coordinator.reserveOrJoin(reservation(1));
  eq(retry.ok, true);
  eq(retry.deduplicated, false);
  truthy(retry.jobId !== first.jobId);
  eq(coordinator.jobsCreated, 2);
}));

tests.push(test("published and awaiting-review jobs remain deduplication targets", async () => {
  for (const status of ["awaiting_review", "published"]) {
    const coordinator = new InMemoryPaperSlideCoordinator();
    const first = await coordinator.reserveOrJoin(reservation(0));
    await coordinator.updateJobStatus(first.jobId, jobStatus({
      status: "running",
      phase: "generating",
      message_code: "PAPER_SLIDE_GENERATING",
    }), NOW);
    await coordinator.updateJobStatus(first.jobId, jobStatus({
      status: "validating",
      phase: "validating",
      message_code: "PAPER_SLIDE_VALIDATING",
    }), NOW);
    await coordinator.updateJobStatus(first.jobId, jobStatus({
      status: "awaiting_review",
      phase: "awaiting_review",
      coverage: "full_text",
      deck_id: DECK_ID,
      message_code: "PAPER_SLIDE_AWAITING_REVIEW",
    }), NOW);
    if (status === "published") {
      await coordinator.updateJobStatus(first.jobId, jobStatus({
        status: "publishing",
        phase: "promoting",
        coverage: "full_text",
        deck_id: DECK_ID,
        message_code: "PAPER_SLIDE_PROMOTING",
      }), NOW);
      await coordinator.updateJobStatus(first.jobId, jobStatus({
        status,
        coverage: "full_text",
        deck_id: DECK_ID,
        public_url: PUBLIC_URL,
        message_code: "PAPER_SLIDE_PUBLISHED",
      }), NOW);
    }
    eq((await coordinator.reserveOrJoin(reservation(1))).deduplicated, true);
    eq(coordinator.jobsCreated, 1);
  }
}));

tests.push(test("enforces per-IP request attempts before catalog work", async () => {
  const coordinator = new InMemoryPaperSlideCoordinator({ requestLimitPerHour: 2 });
  eq((await coordinator.consumeRequestAttempt("ip-a", NOW)).allowed, true);
  eq((await coordinator.consumeRequestAttempt("ip-a", NOW)).allowed, true);
  eq(await coordinator.consumeRequestAttempt("ip-a", NOW), {
    allowed: false,
    retryAfterSeconds: 3600,
  });
  eq((await coordinator.consumeRequestAttempt("ip-b", NOW)).allowed, true);
}));

tests.push(test("enforces per-IP and global status limits atomically", async () => {
  const coordinator = new InMemoryPaperSlideCoordinator({
    statusLimitPerMinute: 2,
    statusGlobalLimitPerMinute: 3,
  });
  eq((await coordinator.consumeStatusAttempt("ip-a", NOW)).allowed, true);
  eq((await coordinator.consumeStatusAttempt("ip-a", NOW)).allowed, true);
  eq((await coordinator.consumeStatusAttempt("ip-a", NOW)).allowed, false);
  eq((await coordinator.consumeStatusAttempt("ip-b", NOW)).allowed, true);
  eq((await coordinator.consumeStatusAttempt("ip-c", NOW)).allowed, false);
}));

tests.push(test("rotates fixed request, status, and UTC new-job windows", async () => {
  const coordinator = new InMemoryPaperSlideCoordinator({
    requestLimitPerHour: 1,
    statusLimitPerMinute: 1,
    statusGlobalLimitPerMinute: 10,
    dailyJobLimit: 1,
  });
  await coordinator.consumeRequestAttempt("ip", NOW);
  eq((await coordinator.consumeRequestAttempt("ip", NOW + 3_600_000)).allowed, true);
  eq(coordinator.requestAttempts.size, 1);
  await coordinator.consumeStatusAttempt("ip", NOW);
  eq((await coordinator.consumeStatusAttempt("ip", NOW + 60_000)).allowed, true);
  eq(coordinator.statusAttempts.size, 1);
  eq(coordinator.statusGlobalAttempts.size, 1);
  await coordinator.reserveOrJoin(reservation(0));
  const tomorrow = NOW + 86_400_000;
  eq((await coordinator.reserveOrJoin(reservation(1, {
    language: "en",
    jobKey: "f".repeat(64),
    nowMs: tomorrow,
  }))).ok, true);
  eq(coordinator.dailyJobs.size, 1);
}));

tests.push(test("expires request aliases without disclosing whether the job survives", async () => {
  const coordinator = new InMemoryPaperSlideCoordinator({ requestTtlSeconds: 60 });
  await coordinator.reserveOrJoin(reservation(0));
  eq(await coordinator.readAuthorizedStatus({
    requestId: reservation(0).requestId,
    capabilityHash: reservation(0).capabilityHash,
    nowMs: NOW + 60_000,
  }), null);
}));

tests.push(test("allows only monotonic closed status transitions", async () => {
  const coordinator = new InMemoryPaperSlideCoordinator();
  const first = await coordinator.reserveOrJoin(reservation(0));
  await coordinator.updateJobStatus(first.jobId, jobStatus({
    status: "running",
    phase: "generating",
    message_code: "PAPER_SLIDE_GENERATING",
  }), NOW);
  await coordinator.updateJobStatus(first.jobId, jobStatus({
    status: "validating",
    phase: "validating",
    message_code: "PAPER_SLIDE_VALIDATING",
  }), NOW);
  await coordinator.updateJobStatus(first.jobId, jobStatus({
    status: "awaiting_review",
    phase: "awaiting_review",
    coverage: "abstract_only",
    deck_id: DECK_ID,
    message_code: "PAPER_SLIDE_AWAITING_REVIEW",
  }), NOW);
  let threw = false;
  try {
    await coordinator.updateJobStatus(first.jobId, jobStatus({
      status: "running",
      phase: "generating",
      message_code: "PAPER_SLIDE_GENERATING",
    }), NOW);
  } catch (error) {
    threw = error instanceof PaperSlideCoordinatorError;
  }
  truthy(threw);
}));

tests.push(test("rejects unknown update fields, phase regressions, and timestamp regressions", async () => {
  const coordinator = new InMemoryPaperSlideCoordinator();
  const first = await coordinator.reserveOrJoin(reservation(0));
  await coordinator.updateJobStatus(first.jobId, jobStatus({
    status: "running",
    phase: "generating",
    message_code: "PAPER_SLIDE_GENERATING",
    updated_at: "2026-09-04T00:00:10Z",
  }), NOW + 10_000);
  for (const invalid of [
    { ...jobStatus({
      status: "running",
      phase: "generating",
      message_code: "PAPER_SLIDE_GENERATING",
      updated_at: "2026-09-04T00:00:11Z",
    }), progress: 99 },
    jobStatus({
      status: "running",
      phase: "fetching",
      message_code: "PAPER_SLIDE_FETCHING",
      updated_at: "2026-09-04T00:00:11Z",
    }),
    jobStatus({
      status: "running",
      phase: "generating",
      message_code: "PAPER_SLIDE_GENERATING",
      updated_at: "2026-09-04T00:00:09Z",
    }),
  ]) {
    let threw = false;
    try {
      await coordinator.updateJobStatus(first.jobId, invalid, NOW + 11_000);
    } catch (error) {
      threw = error instanceof PaperSlideCoordinatorError;
    }
    truthy(threw);
  }
}));

tests.push(test("atomically expires stale review candidates but keeps terminal status until request TTL", async () => {
  const coordinator = new InMemoryPaperSlideCoordinator({
    requestTtlSeconds: 3600,
    candidateTtlSeconds: 60,
  });
  const first = await coordinator.reserveOrJoin(reservation(0));
  await coordinator.updateJobStatus(first.jobId, jobStatus({
    status: "running",
    phase: "generating",
    message_code: "PAPER_SLIDE_GENERATING",
  }), NOW);
  await coordinator.updateJobStatus(first.jobId, jobStatus({
    status: "validating",
    phase: "validating",
    message_code: "PAPER_SLIDE_VALIDATING",
  }), NOW);
  await coordinator.updateJobStatus(first.jobId, jobStatus({
    status: "awaiting_review",
    phase: "awaiting_review",
    coverage: "full_text",
    deck_id: DECK_ID,
    preview_available: true,
    preview_expires_at: "2026-09-04T00:01:00Z",
    message_code: "PAPER_SLIDE_AWAITING_REVIEW",
  }), NOW);

  let promotionRejected = false;
  try {
    await coordinator.updateJobStatus(first.jobId, jobStatus({
      status: "publishing",
      phase: "promoting",
      coverage: "full_text",
      deck_id: DECK_ID,
      message_code: "PAPER_SLIDE_PROMOTING",
      updated_at: "2026-09-04T00:01:00Z",
    }), NOW + 60_000);
  } catch (error) {
    promotionRejected = error instanceof PaperSlideCoordinatorError;
  }
  truthy(promotionRejected, "an expired candidate must not enter publishing");

  const expired = await coordinator.readAuthorizedStatus({
    requestId: reservation(0).requestId,
    capabilityHash: reservation(0).capabilityHash,
    nowMs: NOW + 60_000,
  });
  eq(expired.status, "expired");
  eq(expired.preview_available, false);
  eq(expired.preview_expires_at, null);

  const retry = await coordinator.reserveOrJoin(reservation(1, { nowMs: NOW + 60_000 }));
  eq(retry.deduplicated, false);
  truthy(retry.jobId !== first.jobId);
}));

tests.push(test("rejects request and candidate TTLs beyond the 24-hour logical maximum", () => {
  for (const options of [
    { requestTtlSeconds: 86_401 },
    { candidateTtlSeconds: 86_401 },
  ]) {
    let threw = false;
    try {
      new InMemoryPaperSlideCoordinator(options);
    } catch (error) {
      threw = error instanceof TypeError;
    }
    truthy(threw);
  }
}));

tests.push(test("rejects request-id and capability-hash collisions", async () => {
  const coordinator = new InMemoryPaperSlideCoordinator();
  await coordinator.reserveOrJoin(reservation(0));
  let threw = false;
  try {
    await coordinator.reserveOrJoin(reservation(0, { language: "en" }));
  } catch (error) {
    threw = error instanceof PaperSlideCoordinatorError;
  }
  truthy(threw);
}));

await Promise.all(tests);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  for (const item of failures) console.log(`  - ${item.name}: ${item.error.stack || item.error.message}`);
  process.exit(1);
}
