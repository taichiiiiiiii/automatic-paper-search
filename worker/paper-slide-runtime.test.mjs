import {
  PAPER_SLIDE_CATALOG_MANIFEST_SCHEMA,
  PAPER_SLIDE_CATALOG_PIN_SCHEMA,
  PAPER_SLIDE_CATALOG_RECORD_SCHEMA,
} from "./paper-slide-catalog.js";
import { PAPER_SLIDE_DURABLE_COORDINATOR_SCHEMA } from "./paper-slide-durable-coordinator.js";
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

function throws(fn, message = "expected throw") {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error(message);
}

const ORIGIN = "https://taichiiiiiiii.github.io";
const PAPER_ID = "a".repeat(40);
const SNAPSHOT = "catalog-2026-09-04.1";
const MANIFEST_KEY = "approved/paper-slides/manifest.json";
const RECORDS_PREFIX = "approved/paper-slides/records/";
const GITHUB_TOKEN = "github-token-value-that-stays-secret";
const UPDATE_TOKEN = "coordinator-update-token-secret-123";
const WORKFLOW_AUTHORIZATION_SECRET = "workflow-authorization-secret-1234";
const CLAIMANT_TOKEN = `psct_${"A".repeat(43)}`;
const JOB_ID = `paper-slide-job-${"A".repeat(22)}`;
const NOW = Date.UTC(2026, 8, 4, 0, 0, 0);

async function digest(text) {
  const bytes = new TextEncoder().encode(text);
  const hashed = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(hashed, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function catalogFixture({ badPin = false } = {}) {
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
    records: [{ paper_id: PAPER_ID, sha256: await digest(recordText) }],
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
      manifest_sha256: badPin ? "0".repeat(64) : await digest(manifestText),
      records_prefix: RECORDS_PREFIX,
      schema_version: PAPER_SLIDE_CATALOG_PIN_SCHEMA,
      snapshot_version: SNAPSHOT,
    },
  };
}

function coordinatorNamespace() {
  const jobs = new Map();
  const requests = new Map();
  const calls = [];
  const internalRequests = [];
  const stub = {
    async fetch(request) {
      const envelope = await request.json();
      calls.push(envelope);
      internalRequests.push({
        envelope,
        updateToken: request.headers.get("x-paper-slide-coordinator-update-token"),
      });
      let result;
      if (envelope.operation === "consume_request_attempt" ||
          envelope.operation === "consume_status_attempt") {
        result = { allowed: true, retry_after_seconds: null };
      } else if (envelope.operation === "reserve_or_join") {
        const existing = jobs.get(envelope.input.job_key);
        const jobId = existing ?? JOB_ID;
        jobs.set(envelope.input.job_key, jobId);
        requests.set(envelope.input.request_id, jobId);
        result = { deduplicated: existing !== undefined, job_id: jobId, ok: true };
      } else if (envelope.operation === "read_authorized_status") {
        const jobId = requests.get(envelope.input.request_id);
        result = jobId === undefined ? { found: false } : {
          found: true,
          status: {
            paper_id: PAPER_ID,
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
          },
        };
      } else if (envelope.operation === "update_job_status" ||
          envelope.operation === "update_claimed_job_status") {
        result = { updated: true };
      } else if (envelope.operation === "claim_job") {
        result = {
          claimed: true,
          reclaimed: false,
          lease_generation: 1,
          lease_expires_at: "2026-09-04T00:15:00.000Z",
        };
      } else if (envelope.operation === "revoke_request") {
        result = { revoked: requests.delete(envelope.input.request_id) };
      } else {
        throw new Error("unexpected coordinator operation");
      }
      return new Response(JSON.stringify({
        schema_version: PAPER_SLIDE_DURABLE_COORDINATOR_SCHEMA,
        ok: true,
        result,
      }), { headers: { "content-type": "application/json" } });
    },
  };
  return {
    calls,
    internalRequests,
    idFromName(name) { return `id:${name}`; },
    get(id) {
      if (id !== "id:paper-slide-coordinator-v1") throw new Error("wrong object name");
      return stub;
    },
  };
}

function randomSource() {
  let seed = 0;
  return (length) => Uint8Array.from({ length }, () => seed++ & 0xff);
}

function baseConfig(pin) {
  return {
    allowedOrigins: [ORIGIN],
    catalogPin: pin,
    githubOwner: "taichiiiiiiii",
    githubRef: "develop",
    githubRepo: "automatic-paper-search",
    githubWorkflow: "paper-slides-on-demand.yml",
  };
}

function post() {
  return new Request("https://worker.example/api/paper-slides", {
    method: "POST",
    headers: {
      origin: ORIGIN,
      "content-type": "application/json",
      "cf-connecting-ip": "203.0.113.7",
    },
    body: JSON.stringify({
      paper_id: PAPER_ID,
      language: "ja",
      coverage_preference: "auto",
    }),
  });
}

async function runtimeFixture({ badPin = false } = {}) {
  const catalog = await catalogFixture({ badPin });
  const namespace = coordinatorNamespace();
  const dispatches = [];
  const dependencies = {
    async fetch(url, options) {
      dispatches.push({ url, options });
      return new Response(null, { status: 204 });
    },
    now: () => NOW,
    randomBytes: randomSource(),
  };
  const factory = createPaperSlideRuntimeFactory({
    config: baseConfig(catalog.pin),
    dependencies,
  });
  const environment = {
    catalogBinding: catalog.binding,
    coordinatorNamespace: namespace,
    coordinatorUpdateToken: UPDATE_TOKEN,
    githubToken: GITHUB_TOKEN,
  };
  return { factory, environment, dispatches, namespace };
}

const tests = [];

tests.push(test("composes the pinned catalog, durable client, dispatcher, and request API", async () => {
  const { factory, environment } = await runtimeFixture();
  const response = await factory(environment).handle(post());
  eq(response.status, 202);
  const body = await response.json();
  eq(body.paper_id, PAPER_ID);
  eq(body.deduplicated, false);
  eq(body.status, "queued");
}));

tests.push(test("dispatches the exact closed workflow payload once and deduplicates joins", async () => {
  const { factory, environment, dispatches } = await runtimeFixture();
  const api = factory(environment);
  const first = await api.handle(post());
  const second = await api.handle(post());
  eq([first.status, second.status], [202, 202]);
  eq((await second.json()).deduplicated, true);
  eq(dispatches.length, 1);
  eq(dispatches[0].url,
    "https://api.github.com/repos/taichiiiiiiii/automatic-paper-search/actions/workflows/paper-slides-on-demand.yml/dispatches");
  const payload = JSON.parse(dispatches[0].options.body);
  eq(Object.keys(payload).sort(), ["inputs", "ref"]);
  eq(payload.ref, "develop");
  eq(Object.keys(payload.inputs).sort(), [
    "coverage_preference", "job_id", "job_key", "language", "paper_id", "snapshot_version",
  ]);
  eq(payload.inputs.job_id, JOB_ID);
  eq(payload.inputs.paper_id, PAPER_ID);
  eq(dispatches[0].options.headers.authorization, `Bearer ${GITHUB_TOKEN}`);
}));

tests.push(test("rejects missing and extra factory, config, dependency, and environment fields", async () => {
  const catalog = await catalogFixture();
  const config = baseConfig(catalog.pin);
  const dependencies = { fetch: async () => new Response(null, { status: 204 }), now: () => NOW, randomBytes: randomSource() };
  throws(() => createPaperSlideRuntimeFactory({ config }));
  throws(() => createPaperSlideRuntimeFactory({ config, dependencies, extra: true }));
  throws(() => createPaperSlideRuntimeFactory({ config: { ...config, extra: true }, dependencies }));
  throws(() => createPaperSlideRuntimeFactory({ config, dependencies: { ...dependencies, extra: true } }));
  const factory = createPaperSlideRuntimeFactory({ config, dependencies });
  const namespace = coordinatorNamespace();
  const complete = {
    catalogBinding: catalog.binding,
    coordinatorNamespace: namespace,
    coordinatorUpdateToken: UPDATE_TOKEN,
    githubToken: GITHUB_TOKEN,
  };
  throws(() => factory({ ...complete, extra: true }));
  const { githubToken: _removed, ...missing } = complete;
  throws(() => factory(missing));
}));

tests.push(test("rejects accessors, insecure or duplicate origins, and a non-approved workflow", async () => {
  const catalog = await catalogFixture();
  const dependencies = { fetch: async () => new Response(null, { status: 204 }), now: () => NOW, randomBytes: randomSource() };
  const accessor = { config: baseConfig(catalog.pin), dependencies };
  Object.defineProperty(accessor, "config", { enumerable: true, get() { return baseConfig(catalog.pin); } });
  throws(() => createPaperSlideRuntimeFactory(accessor));
  throws(() => createPaperSlideRuntimeFactory({
    config: { ...baseConfig(catalog.pin), allowedOrigins: ["http://example.com"] }, dependencies,
  }));
  throws(() => createPaperSlideRuntimeFactory({
    config: { ...baseConfig(catalog.pin), allowedOrigins: [ORIGIN, ORIGIN] }, dependencies,
  }));
  const accessorOrigins = [ORIGIN];
  Object.defineProperty(accessorOrigins, "0", { enumerable: true, get() { return ORIGIN; } });
  throws(() => createPaperSlideRuntimeFactory({
    config: { ...baseConfig(catalog.pin), allowedOrigins: accessorOrigins }, dependencies,
  }));
  throws(() => createPaperSlideRuntimeFactory({
    config: { ...baseConfig(catalog.pin), githubWorkflow: "other.yml" }, dependencies,
  }));
}));

tests.push(test("a catalog digest mismatch fails closed before workflow dispatch", async () => {
  const { factory, environment, dispatches } = await runtimeFixture({ badPin: true });
  const response = await factory(environment).handle(post());
  eq(response.status, 503);
  eq(dispatches.length, 0);
  eq((await response.json()).error_code, "SERVICE_UNAVAILABLE");
}));

tests.push(test("secrets remain outside API objects, responses, payloads, and errors", async () => {
  const { factory, environment, dispatches } = await runtimeFixture();
  const api = factory(environment);
  const response = await api.handle(post());
  const visible = JSON.stringify({ api, body: await response.json(), payload: dispatches[0].options.body });
  eq(visible.includes(GITHUB_TOKEN), false);
  eq(visible.includes(UPDATE_TOKEN), false);
  const error = throws(() => factory({ ...environment, githubToken: "short-secret" }));
  eq(String(error).includes("short-secret"), false);
}));

function workflowRequest(path, body, authorizationSecret = WORKFLOW_AUTHORIZATION_SECRET) {
  return new Request(`https://worker.example${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${authorizationSecret}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

function workflowStatus() {
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
  };
}

function workflowRuntimeFixture() {
  const namespace = coordinatorNamespace();
  const factory = createPaperSlideWorkflowRuntimeFactory({
    dependencies: { now: () => NOW },
  });
  const environment = {
    coordinatorNamespace: namespace,
    coordinatorUpdateToken: UPDATE_TOKEN,
    workflowAuthorizationSecret: WORKFLOW_AUTHORIZATION_SECRET,
  };
  return { factory, environment, namespace };
}

tests.push(test("workflow runtime composes claim and status through the internal durable stub", async () => {
  const { factory, environment, namespace } = workflowRuntimeFixture();
  const api = factory(environment);
  const claim = await api.fetch(workflowRequest(
    "/api/paper-slides/internal/claim",
    {
      claimant_token: CLAIMANT_TOKEN,
      job_id: JOB_ID,
      lease_generation: 0,
      reclaim: false,
    },
  ));
  const status = await api.fetch(workflowRequest(
    "/api/paper-slides/internal/status",
    {
      claimant_token: CLAIMANT_TOKEN,
      job_id: JOB_ID,
      lease_generation: 1,
      status: workflowStatus(),
    },
  ));
  eq(claim.status, 200);
  eq(await claim.json(), {
    schema_version: "paper-slide-workflow-api-v1",
    ok: true,
    claimed: true,
    reclaimed: false,
    lease_generation: 1,
    lease_expires_at: "2026-09-04T00:15:00.000Z",
  });
  eq(status.status, 200);
  eq(await status.json(), {
    schema_version: "paper-slide-workflow-api-v1",
    ok: true,
    updated: true,
  });
  eq(namespace.internalRequests.map((item) => item.envelope.operation), [
    "claim_job", "update_claimed_job_status",
  ]);
  eq(namespace.internalRequests.map((item) => item.updateToken), [UPDATE_TOKEN, UPDATE_TOKEN]);
  eq(namespace.internalRequests[1].envelope.input.status.updated_at,
    "2026-09-04T00:00:00.000Z");
  const claimantHash = await digest(CLAIMANT_TOKEN);
  eq(namespace.internalRequests.map((item) => item.envelope.input.claimant_hash), [
    claimantHash, claimantHash,
  ]);
  eq(JSON.stringify(namespace.internalRequests).includes(CLAIMANT_TOKEN), false);
}));

tests.push(test("workflow runtime validates exact options, dependency, and environment projections", () => {
  throws(() => createPaperSlideWorkflowRuntimeFactory({}));
  throws(() => createPaperSlideWorkflowRuntimeFactory({ dependencies: { now: () => NOW }, extra: true }));
  throws(() => createPaperSlideWorkflowRuntimeFactory({ dependencies: {} }));
  throws(() => createPaperSlideWorkflowRuntimeFactory({ dependencies: { now: () => NOW, extra: true } }));
  const accessor = {};
  let invoked = false;
  Object.defineProperty(accessor, "dependencies", {
    enumerable: true,
    get() { invoked = true; return { now: () => NOW }; },
  });
  throws(() => createPaperSlideWorkflowRuntimeFactory(accessor));
  eq(invoked, false);

  const { factory, environment } = workflowRuntimeFixture();
  throws(() => factory({ ...environment, extra: true }));
  const { workflowAuthorizationSecret: _removed, ...missing } = environment;
  throws(() => factory(missing));
  const environmentAccessor = { ...environment };
  Object.defineProperty(environmentAccessor, "workflowAuthorizationSecret", {
    enumerable: true,
    get() { invoked = true; return WORKFLOW_AUTHORIZATION_SECRET; },
  });
  throws(() => factory(environmentAccessor));
  eq(invoked, false);
}));

tests.push(test("public and workflow runtime environments cannot be mixed", async () => {
  const publicItem = await runtimeFixture();
  const workflowItem = workflowRuntimeFixture();
  throws(() => publicItem.factory(workflowItem.environment));
  throws(() => workflowItem.factory(publicItem.environment));
  eq(Object.keys(publicItem.factory(publicItem.environment)), ["handle"]);
  eq(Object.keys(workflowItem.factory(workflowItem.environment)), ["fetch"]);
}));

tests.push(test("workflow runtime responses and construction errors never expose either secret", async () => {
  const { factory, environment } = workflowRuntimeFixture();
  const api = factory(environment);
  const response = await api.fetch(workflowRequest(
    "/api/paper-slides/internal/claim",
    { job_id: JOB_ID },
    "wrong-workflow-secret-that-is-long-enough",
  ));
  const visible = JSON.stringify({ api, response: await response.json() });
  eq(response.status, 404);
  eq(visible.includes(WORKFLOW_AUTHORIZATION_SECRET), false);
  eq(visible.includes(UPDATE_TOKEN), false);
  const badWorkflow = "short-workflow-secret";
  const firstError = throws(() => factory({ ...environment, workflowAuthorizationSecret: badWorkflow }));
  eq(String(firstError).includes(badWorkflow), false);
  const badUpdate = "short-update-secret";
  const secondError = throws(() => factory({ ...environment, coordinatorUpdateToken: badUpdate }));
  eq(String(secondError).includes(badUpdate), false);
}));

await Promise.all(tests);
process.stdout.write(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exitCode = 1;
