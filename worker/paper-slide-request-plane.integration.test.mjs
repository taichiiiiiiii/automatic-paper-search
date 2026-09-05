import {
  PAPER_SLIDE_CATALOG_MANIFEST_SCHEMA,
  PAPER_SLIDE_CATALOG_PIN_SCHEMA,
  PAPER_SLIDE_CATALOG_RECORD_SCHEMA,
} from "./paper-slide-catalog.js";
import { PaperSlideDurableCoordinatorService } from "./paper-slide-durable-coordinator.js";
import {
  createPaperSlideRuntimeFactory,
  createPaperSlideWorkflowRuntimeFactory,
} from "./paper-slide-runtime.js";

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
  constructor() {
    this.entries = new Map();
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
      this.entries = working;
      return result;
    } finally {
      release();
    }
  }
}

class FakeDurableNamespace {
  constructor(object) {
    this.object = object;
  }

  idFromName(name) {
    return `id:${name}`;
  }

  get(id) {
    if (id !== "id:paper-slide-coordinator-v1") throw new Error("unexpected object id");
    return { fetch: (request) => this.object.fetch(request) };
  }
}

const NOW = Date.UTC(2026, 8, 5, 0, 0, 0);
const ORIGIN = "https://taichiiiiiiii.github.io";
const PAPER_ID = "a".repeat(40);
const SNAPSHOT = "catalog-2026-09-05.1";
const JOB_ID = `paper-slide-job-${"A".repeat(22)}`;
const DECK_ID = `sd1-${"b".repeat(64)}`;
const CLAIMANT_TOKEN = `psct_${"C".repeat(43)}`;
const OTHER_CLAIMANT_TOKEN = `psct_${"D".repeat(43)}`;
const UPDATE_TOKEN = "coordinator-update-token-secret-123";
const WORKFLOW_SECRET = "workflow-authorization-secret-1234";
const GITHUB_TOKEN = "github-dispatch-token-secret-value";
const MANIFEST_KEY = "approved/paper-slides/manifest.json";
const RECORDS_PREFIX = "approved/paper-slides/records/";

async function sha256(text) {
  const bytes = new TextEncoder().encode(text);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function catalogFixture() {
  const record = {
    canonical_material: {
      deck_profile: "paper-slide-v1",
      deck_schema_version: "slide-deck-v1",
      extractor_version: "extractor-v1",
      input: {
        content_sha256: "1".repeat(64),
        coverage: "abstract_only",
        pdf_url: null,
      },
      license_policy_version: "license-policy-v1",
      model: "gpt-5.6-sol",
      paper_id: PAPER_ID,
      prompt_version: "paper-slide-prompt-v1",
      provider: "openai",
      source: {
        landing_url: "https://openreview.net/forum?id=trusted-source",
        source: "openreview",
        source_id: "trusted-source",
      },
    },
    eligible: true,
    failure_code: null,
    paper_id: PAPER_ID,
    schema_version: PAPER_SLIDE_CATALOG_RECORD_SCHEMA,
    snapshot_version: SNAPSHOT,
  };
  const recordText = JSON.stringify(record);
  const manifest = {
    record_count: 1,
    records: [{ paper_id: PAPER_ID, sha256: await sha256(recordText) }],
    schema_version: PAPER_SLIDE_CATALOG_MANIFEST_SCHEMA,
    snapshot_version: SNAPSHOT,
  };
  const manifestText = JSON.stringify(manifest);
  const objects = new Map([
    [MANIFEST_KEY, manifestText],
    [`${RECORDS_PREFIX}${PAPER_ID}.json`, recordText],
  ]);
  return {
    binding: { async get(key) { return objects.get(key) ?? null; } },
    pin: {
      manifest_key: MANIFEST_KEY,
      manifest_sha256: await sha256(manifestText),
      records_prefix: RECORDS_PREFIX,
      schema_version: PAPER_SLIDE_CATALOG_PIN_SCHEMA,
      snapshot_version: SNAPSHOT,
    },
  };
}

function randomBytes() {
  let next = 0;
  return (length) => Uint8Array.from({ length }, () => next++ & 0xff);
}

function publicPost(ip = "203.0.113.7") {
  return new Request("https://worker.example/api/paper-slides", {
    method: "POST",
    headers: {
      origin: ORIGIN,
      "cf-connecting-ip": ip,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      paper_id: PAPER_ID,
      language: "ja",
      coverage_preference: "auto",
    }),
  });
}

function publicStatus(requestId, capability, ip = "203.0.113.7") {
  return new Request("https://worker.example/api/paper-slides/status", {
    method: "POST",
    headers: {
      origin: ORIGIN,
      authorization: `PaperSlide ${capability}`,
      "cf-connecting-ip": ip,
      "content-type": "application/json",
    },
    body: JSON.stringify({ request_id: requestId }),
  });
}

function workflowPost(path, body, secret = WORKFLOW_SECRET) {
  return new Request(`https://worker.example${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${secret}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

function claimedStatus(overrides) {
  return {
    coverage: null,
    deck_id: null,
    message_code: "PAPER_SLIDE_GENERATING",
    phase: "generating",
    preview_available: false,
    preview_expires_at: null,
    public_url: null,
    retryable: null,
    status: "running",
    ...overrides,
  };
}

async function fixture() {
  const storage = new FakeDurableStorage();
  const object = new PaperSlideDurableCoordinatorService(
    { storage },
    { PAPER_SLIDE_COORDINATOR_UPDATE_TOKEN: UPDATE_TOKEN },
    { now: () => NOW, createJobId: () => JOB_ID },
  );
  const namespace = new FakeDurableNamespace(object);
  const catalog = await catalogFixture();
  const dispatches = [];
  const publicFactory = createPaperSlideRuntimeFactory({
    config: {
      allowedOrigins: [ORIGIN],
      catalogPin: catalog.pin,
      githubOwner: "taichiiiiiiii",
      githubRef: "develop",
      githubRepo: "automatic-paper-search",
      githubWorkflow: "paper-slides-on-demand.yml",
    },
    dependencies: {
      fetch: async (url, options) => {
        dispatches.push({ url, options });
        return new Response(null, { status: 204 });
      },
      now: () => NOW,
      randomBytes: randomBytes(),
    },
  });
  const publicApi = publicFactory({
    catalogBinding: catalog.binding,
    coordinatorNamespace: namespace,
    coordinatorUpdateToken: UPDATE_TOKEN,
    githubToken: GITHUB_TOKEN,
  });
  const workflowApi = createPaperSlideWorkflowRuntimeFactory({
    dependencies: { now: () => NOW },
  })({
    coordinatorNamespace: namespace,
    coordinatorUpdateToken: UPDATE_TOKEN,
    workflowAuthorizationSecret: WORKFLOW_SECRET,
  });
  return { dispatches, publicApi, storage, workflowApi };
}

async function createAndClaim(item) {
  const createdResponse = await item.publicApi.handle(publicPost());
  eq(createdResponse.status, 202);
  const created = await createdResponse.json();
  eq(item.dispatches.length, 1);
  const dispatched = JSON.parse(item.dispatches[0].options.body);
  eq(dispatched.inputs.job_id, JOB_ID);
  const claimResponse = await item.workflowApi.fetch(workflowPost(
    "/api/paper-slides/internal/claim",
    {
      claimant_token: CLAIMANT_TOKEN,
      job_id: JOB_ID,
      lease_generation: 0,
      reclaim: false,
    },
  ));
  eq(claimResponse.status, 200);
  const claim = await claimResponse.json();
  eq(claim.claimed, true);
  eq(claim.lease_generation, 1);
  return { claim, created, dispatched };
}

async function updateClaimed(item, status) {
  const response = await item.workflowApi.fetch(workflowPost(
    "/api/paper-slides/internal/status",
    {
      claimant_token: CLAIMANT_TOKEN,
      job_id: JOB_ID,
      lease_generation: 1,
      status,
    },
  ));
  eq(response.status, 200);
  eq(await response.json(), {
    schema_version: "paper-slide-workflow-api-v1",
    ok: true,
    updated: true,
  });
}

const tests = [];

tests.push(test("connects public reserve and exact dispatch to the real durable service", async () => {
  const item = await fixture();
  const { claim, created, dispatched } = await createAndClaim(item);
  eq(Object.keys(dispatched.inputs).sort(), [
    "coverage_preference", "job_id", "job_key", "language", "paper_id", "snapshot_version",
  ]);
  eq(dispatched.ref, "develop");
  eq(item.dispatches[0].url,
    "https://api.github.com/repos/taichiiiiiiii/automatic-paper-search/actions/" +
      "workflows/paper-slides-on-demand.yml/dispatches");
  eq(item.dispatches[0].options.method, "POST");
  eq(created.paper_id, PAPER_ID);
  eq(created.deduplicated, false);
  eq(created.status, "queued");
  const dispatchBody = item.dispatches[0].options.body;
  for (const secret of [
    created.request_id,
    created.status_cap,
    CLAIMANT_TOKEN,
    UPDATE_TOKEN,
    WORKFLOW_SECRET,
    GITHUB_TOKEN,
  ]) {
    truthy(!dispatchBody.includes(secret), "dispatch body exposed a request-plane secret");
  }
  const returned = JSON.stringify({ claim, created });
  for (const secret of [CLAIMANT_TOKEN, UPDATE_TOKEN, WORKFLOW_SECRET, GITHUB_TOKEN]) {
    truthy(!returned.includes(secret), "HTTP response exposed an internal secret");
  }
}));

tests.push(test("atomically deduplicates simultaneous public POSTs to one dispatch", async () => {
  const item = await fixture();
  const responses = await Promise.all([
    item.publicApi.handle(publicPost("203.0.113.20")),
    item.publicApi.handle(publicPost("203.0.113.21")),
  ]);
  eq(responses.map((response) => response.status), [202, 202]);
  const created = await Promise.all(responses.map((response) => response.json()));
  eq(created.map((value) => value.deduplicated).sort(), [false, true]);
  truthy(created[0].request_id !== created[1].request_id);
  truthy(created[0].status_cap !== created[1].status_cap);
  eq(item.dispatches.length, 1);

  for (let index = 0; index < created.length; index++) {
    const status = await item.publicApi.handle(publicStatus(
      created[index].request_id,
      created[index].status_cap,
      `203.0.113.${30 + index}`,
    ));
    eq(status.status, 200);
    eq((await status.json()).status, "queued");
  }
}));

tests.push(test("replays a lost initial claim response without changing ownership", async () => {
  const item = await fixture();
  const { claim } = await createAndClaim(item);
  const replayResponse = await item.workflowApi.fetch(workflowPost(
    "/api/paper-slides/internal/claim",
    {
      claimant_token: CLAIMANT_TOKEN,
      job_id: JOB_ID,
      lease_generation: 0,
      reclaim: false,
    },
  ));
  eq(replayResponse.status, 200);
  eq(await replayResponse.json(), claim);

  const otherResponse = await item.workflowApi.fetch(workflowPost(
    "/api/paper-slides/internal/claim",
    {
      claimant_token: OTHER_CLAIMANT_TOKEN,
      job_id: JOB_ID,
      lease_generation: 0,
      reclaim: false,
    },
  ));
  eq(otherResponse.status, 200);
  eq(await otherResponse.json(), {
    schema_version: "paper-slide-workflow-api-v1",
    ok: true,
    claimed: false,
    reclaimed: false,
    lease_generation: null,
    lease_expires_at: null,
  });
  const stored = JSON.stringify(Array.from(item.storage.entries.values()));
  truthy(!stored.includes(CLAIMANT_TOKEN));
  truthy(!stored.includes(OTHER_CLAIMANT_TOKEN));
  truthy(!stored.includes(WORKFLOW_SECRET));
  truthy(!stored.includes(UPDATE_TOKEN));
}));

tests.push(test("makes claim, provider fence, validation, and review status one visible chain", async () => {
  const item = await fixture();
  const { created } = await createAndClaim(item);
  await updateClaimed(item, claimedStatus({}));
  await updateClaimed(item, claimedStatus({
    message_code: "PAPER_SLIDE_VALIDATING",
    phase: "validating",
    status: "validating",
  }));
  await updateClaimed(item, claimedStatus({
    coverage: "abstract_only",
    deck_id: DECK_ID,
    message_code: "PAPER_SLIDE_AWAITING_REVIEW",
    phase: "awaiting_review",
    status: "awaiting_review",
  }));
  const response = await item.publicApi.handle(publicStatus(
    created.request_id,
    created.status_cap,
  ));
  eq(response.status, 200);
  const visible = await response.json();
  eq(visible.status, "awaiting_review");
  eq(visible.coverage, "abstract_only");
  eq(visible.deck_id, DECK_ID);
  eq(visible.preview_available, false);
  eq(visible.public_url, null);
  truthy(!JSON.stringify(visible).includes(CLAIMANT_TOKEN));
  truthy(!JSON.stringify(visible).includes(UPDATE_TOKEN));
}));

tests.push(test("joins a reviewed underlying job with an independent request capability", async () => {
  const item = await fixture();
  const { created: first } = await createAndClaim(item);
  await updateClaimed(item, claimedStatus({}));
  await updateClaimed(item, claimedStatus({
    message_code: "PAPER_SLIDE_VALIDATING",
    phase: "validating",
    status: "validating",
  }));
  await updateClaimed(item, claimedStatus({
    coverage: "abstract_only",
    deck_id: DECK_ID,
    message_code: "PAPER_SLIDE_AWAITING_REVIEW",
    phase: "awaiting_review",
    status: "awaiting_review",
  }));
  const joinedResponse = await item.publicApi.handle(publicPost("203.0.113.8"));
  eq(joinedResponse.status, 202);
  const joined = await joinedResponse.json();
  eq(joined.deduplicated, true);
  truthy(joined.request_id !== first.request_id);
  truthy(joined.status_cap !== first.status_cap);
  eq(item.dispatches.length, 1);
  const joinedStatus = await item.publicApi.handle(publicStatus(
    joined.request_id,
    joined.status_cap,
    "203.0.113.8",
  ));
  eq((await joinedStatus.json()).deck_id, DECK_ID);
  eq((await item.publicApi.handle(publicStatus(
    joined.request_id,
    first.status_cap,
    "203.0.113.9",
  ))).status, 404);
}));

tests.push(test("rejects a second claimant permanently after the provider fence", async () => {
  const item = await fixture();
  await createAndClaim(item);
  await updateClaimed(item, claimedStatus({}));
  const duplicate = await item.workflowApi.fetch(workflowPost(
    "/api/paper-slides/internal/claim",
    {
      claimant_token: OTHER_CLAIMANT_TOKEN,
      job_id: JOB_ID,
      lease_generation: 1,
      reclaim: true,
    },
  ));
  eq(duplicate.status, 200);
  eq(await duplicate.json(), {
    schema_version: "paper-slide-workflow-api-v1",
    ok: true,
    claimed: false,
    reclaimed: false,
    lease_generation: null,
    lease_expires_at: null,
  });
  const stored = JSON.stringify(Array.from(item.storage.entries.values()));
  for (const secret of [
    CLAIMANT_TOKEN,
    OTHER_CLAIMANT_TOKEN,
    UPDATE_TOKEN,
    WORKFLOW_SECRET,
    GITHUB_TOKEN,
  ]) {
    truthy(!stored.includes(secret), "durable storage exposed a raw secret");
  }
}));

await Promise.all(tests);
process.stdout.write(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exitCode = 1;
