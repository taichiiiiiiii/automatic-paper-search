import { createPaperPilotWorker } from "./entrypoint.js";
import { createPaperSlideApi } from "./paper-slide-api.js";

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
  if (actual !== expected) {
    throw new Error(`${message}\nexpected ${JSON.stringify(expected)}\nactual   ${JSON.stringify(actual)}`);
  }
}

function makeWorker(paperSlideApi, extraOptions = {}) {
  const calls = [];
  const worker = createPaperPilotWorker({
    handleThemePost: async (request, env) => {
      calls.push(["theme-post", request, env]);
      return new Response("theme post", { status: 201 });
    },
    handleThemeStatusGet: async (request, env) => {
      calls.push(["theme-status", request, env]);
      return new Response("theme status");
    },
    ...(paperSlideApi === undefined ? {} : { paperSlideApi }),
    ...extraOptions,
  });
  return { worker, calls };
}

const tests = [];

tests.push(test("factory validates its required theme handlers", async () => {
  let failuresSeen = 0;
  for (const options of [
    {},
    { handleThemePost() {} },
    { handleThemePost() {}, handleThemeStatusGet() {}, paperSlideApi: null },
    { handleThemePost() {}, handleThemeStatusGet() {}, paperSlideApi: {} },
    { handleThemePost() {}, handleThemeStatusGet() {}, paperSlideApiFactory: null },
    { handleThemePost() {}, handleThemeStatusGet() {}, paperSlideWorkflowApi: null },
    { handleThemePost() {}, handleThemeStatusGet() {}, paperSlideWorkflowApi: {} },
    { handleThemePost() {}, handleThemeStatusGet() {}, paperSlideWorkflowApiFactory: null },
    {
      handleThemePost() {},
      handleThemeStatusGet() {},
      paperSlideApi: { handle() {} },
      paperSlideApiFactory() {},
    },
    {
      handleThemePost() {},
      handleThemeStatusGet() {},
      paperSlideWorkflowApi: { fetch() {} },
      paperSlideWorkflowApiFactory() {},
    },
  ]) {
    try {
      createPaperPilotWorker(options);
    } catch (error) {
      failuresSeen++;
      eq(error instanceof TypeError, true);
    }
  }
  eq(failuresSeen, 10);
}));

tests.push(test("theme POST and status GET keep their existing entrypoint routes", async () => {
  const { worker, calls } = makeWorker();
  const env = { marker: "env" };
  eq((await worker.fetch(new Request("https://worker.test/api/themes", { method: "POST" }), env)).status, 201);
  eq((await worker.fetch(new Request("https://worker.test/api/themes/status"), env)).status, 200);
  eq(calls.length, 2);
  eq(calls[0][0], "theme-post");
  eq(calls[0][2], env);
  eq(calls[1][0], "theme-status");
}));

tests.push(test("Paper Slide routes are dormant without an injected adapter", async () => {
  const { worker, calls } = makeWorker();
  for (const path of [
    "/api/paper-slides",
    "/api/paper-slides/status",
    "/api/paper-slides/internal/claim",
    "/api/paper-slides/internal/status",
  ]) {
    for (const method of ["POST", "OPTIONS"]) {
      const response = await worker.fetch(new Request(`https://worker.test${path}`, { method }), {});
      eq(response.status, 404, `${method} ${path}`);
    }
  }
  eq(calls.length, 0);
}));

tests.push(test("only exact internal workflow paths delegate to the injected callback API", async () => {
  const delegated = [];
  const { worker } = makeWorker(undefined, {
    paperSlideWorkflowApi: {
      async fetch(request) {
        delegated.push(request);
        return new Response("workflow callback", { status: 211 });
      },
    },
  });
  for (const path of [
    "/api/paper-slides/internal/claim",
    "/api/paper-slides/internal/status",
  ]) {
    const request = new Request(`https://worker.test${path}`, { method: "POST" });
    eq((await worker.fetch(request, {})).status, 211);
    eq(delegated.at(-1), request);
  }
  for (const path of [
    "/api/paper-slides/internal/claim/",
    "/api/paper-slides/internal/status/extra",
    "/api/paper-slides/internal",
  ]) {
    eq((await worker.fetch(new Request(`https://worker.test${path}`, {
      method: "POST",
    }), {})).status, 404);
  }
  eq(delegated.length, 2);
}));

tests.push(test("workflow callback factory receives env only for exact internal paths", async () => {
  const factoryCalls = [];
  const { worker } = makeWorker(undefined, {
    paperSlideWorkflowApiFactory: async (env, executionContext) => {
      factoryCalls.push([env, executionContext]);
      return { async fetch() { return new Response("claimed", { status: 212 }); } };
    },
  });
  const env = { marker: "workflow-bindings" };
  const executionContext = { waitUntil() {} };
  eq((await worker.fetch(new Request(
    "https://worker.test/api/paper-slides/internal/claim",
    { method: "POST" },
  ), env, executionContext)).status, 212);
  eq(factoryCalls.length, 1);
  eq(factoryCalls[0][0], env);
  eq(factoryCalls[0][1], executionContext);
  eq((await worker.fetch(new Request(
    "https://worker.test/api/paper-slides",
    { method: "POST" },
  ), env, executionContext)).status, 404);
  eq(factoryCalls.length, 1);
}));

tests.push(test("workflow callback factory faults stay generic and dormant", async () => {
  for (const [paperSlideWorkflowApiFactory, expectedStatus] of [
    [async () => undefined, 404],
    [async () => null, 503],
    [async () => ({}), 503],
    [async () => { throw new Error("workflow callback secret"); }, 503],
  ]) {
    const { worker } = makeWorker(undefined, { paperSlideWorkflowApiFactory });
    const response = await worker.fetch(new Request(
      "https://worker.test/api/paper-slides/internal/status",
      { method: "POST" },
    ), {});
    eq(response.status, expectedStatus);
    eq((await response.text()).includes("workflow callback secret"), false);
  }
}));

tests.push(test("Paper Slide namespace near-misses never inherit generic theme CORS", async () => {
  const { worker } = makeWorker(undefined, {
    paperSlideWorkflowApi: {
      async fetch() { throw new Error("must not delegate"); },
    },
  });
  for (const path of [
    "/api/paper-slides/",
    "/api/paper-slides/internal/claim/",
    "/api/paper-slides/internal/status/extra",
    "/api/paper-slides/unknown",
    "/api/paper-slides%2Finternal%2Fclaim",
    "/api/paper-slides-status",
  ]) {
    const response = await worker.fetch(new Request(`https://worker.test${path}`, {
      method: "OPTIONS",
    }), {});
    eq(response.status, 404, path);
    eq(response.headers.get("access-control-allow-origin"), null, path);
  }
}));

tests.push(test("fixed adapter methods are snapshotted without invoking accessors", async () => {
  let invoked = false;
  const accessor = Object.defineProperty({}, "fetch", {
    enumerable: true,
    get() {
      invoked = true;
      return async () => new Response("unsafe");
    },
  });
  let error = null;
  try {
    makeWorker(undefined, { paperSlideWorkflowApi: accessor });
  } catch (caught) {
    error = caught;
  }
  eq(error instanceof TypeError, true);
  eq(invoked, false);

  const stable = { async fetch() { return new Response("first", { status: 213 }); } };
  const { worker } = makeWorker(undefined, { paperSlideWorkflowApi: stable });
  stable.fetch = async () => new Response("replacement", { status: 214 });
  const response = await worker.fetch(new Request(
    "https://worker.test/api/paper-slides/internal/claim",
    { method: "POST" },
  ), {});
  eq(response.status, 213);

  const inherited = Object.create({
    async fetch() { return new Response("inherited"); },
  });
  error = null;
  try {
    makeWorker(undefined, { paperSlideWorkflowApi: inherited });
  } catch (caught) {
    error = caught;
  }
  eq(error instanceof TypeError, true);
}));

tests.push(test("worker configuration rejects accessors without invoking them", async () => {
  let invoked = false;
  const options = Object.defineProperty({
    handleThemePost() {},
    handleThemeStatusGet() {},
  }, "paperSlideWorkflowApiFactory", {
    enumerable: true,
    get() {
      invoked = true;
      return async () => undefined;
    },
  });
  let error = null;
  try {
    createPaperPilotWorker(options);
  } catch (caught) {
    error = caught;
  }
  eq(error instanceof TypeError, true);
  eq(invoked, false);
}));

tests.push(test("factory adapter accessors and delegate faults fail closed", async () => {
  let invoked = false;
  const accessorFactory = async () => Object.defineProperty({}, "fetch", {
    enumerable: true,
    get() {
      invoked = true;
      return async () => new Response("unsafe");
    },
  });
  for (const paperSlideWorkflowApiFactory of [
    accessorFactory,
    async () => ({ async fetch() { throw new Error("workflow secret detail"); } }),
    async () => ({ async fetch() { return { status: 200, secret: "workflow secret detail" }; } }),
  ]) {
    const { worker } = makeWorker(undefined, { paperSlideWorkflowApiFactory });
    const response = await worker.fetch(new Request(
      "https://worker.test/api/paper-slides/internal/status",
      { method: "POST" },
    ), {});
    eq(response.status, 503);
    eq((await response.text()).includes("workflow secret detail"), false);
  }
  eq(invoked, false);
}));

tests.push(test("only exact Paper Slide paths delegate to the injected adapter", async () => {
  const delegated = [];
  const paperSlideApi = {
    async handle(request) {
      delegated.push(request);
      return new Response("paper slide", { status: 209 });
    },
  };
  const { worker } = makeWorker(paperSlideApi);
  for (const path of ["/api/paper-slides", "/api/paper-slides/status?request=1"]) {
    const request = new Request(`https://worker.test${path}`, { method: "POST" });
    const response = await worker.fetch(request, {});
    eq(response.status, 209);
    eq(delegated.at(-1), request);
  }
  eq((await worker.fetch(new Request("https://worker.test/api/paper-slides/", { method: "POST" }), {})).status, 404);
  eq((await worker.fetch(new Request("https://worker.test/api/paper-slides-status", { method: "POST" }), {})).status, 404);
  eq(delegated.length, 2);
}));

tests.push(test("a production factory receives env and execution context only for exact slide routes", async () => {
  const factoryCalls = [];
  const delegated = [];
  const { worker, calls } = makeWorker(undefined, {
    paperSlideApiFactory: async (env, executionContext) => {
      factoryCalls.push([env, executionContext]);
      return {
        async handle(request) {
          delegated.push(request);
          return new Response("factory paper slide", { status: 210 });
        },
      };
    },
  });
  const env = { marker: "production-bindings" };
  const executionContext = { waitUntil() {} };

  eq((await worker.fetch(
    new Request("https://worker.test/api/paper-slides", { method: "POST" }),
    env,
    executionContext,
  )).status, 210);
  eq(factoryCalls.length, 1);
  eq(factoryCalls[0][0], env);
  eq(factoryCalls[0][1], executionContext);
  eq(delegated.length, 1);

  eq((await worker.fetch(
    new Request("https://worker.test/api/themes", { method: "POST" }),
    env,
    executionContext,
  )).status, 201);
  eq(factoryCalls.length, 1);
  eq(calls.length, 1);
}));

tests.push(test("a disabled production factory keeps Paper Slide dormant", async () => {
  const { worker } = makeWorker(undefined, {
    paperSlideApiFactory: async () => undefined,
  });
  const response = await worker.fetch(new Request(
    "https://worker.test/api/paper-slides/status",
    { method: "POST" },
  ), {});
  eq(response.status, 404);
  eq(await response.text(), "Not Found");
}));

tests.push(test("factory faults fail closed without exposing their error", async () => {
  for (const paperSlideApiFactory of [
    async () => null,
    async () => ({}),
    async () => { throw new Error("secret binding detail"); },
  ]) {
    const { worker } = makeWorker(undefined, { paperSlideApiFactory });
    const response = await worker.fetch(new Request(
      "https://worker.test/api/paper-slides",
      { method: "POST" },
    ), {});
    eq(response.status, 503);
    eq(response.headers.get("cache-control"), "private, no-store");
    eq((await response.text()).includes("secret binding detail"), false);
  }
}));

tests.push(test("exact Paper Slide preflight delegates Authorization CORS to its API", async () => {
  const paperSlideApi = createPaperSlideApi({
    allowedOrigins: ["https://taichiiiiiiii.github.io"],
    catalog: { async resolve() { return null; } },
    coordinator: {},
    randomBytes(length) { return new Uint8Array(length); },
  });
  const { worker } = makeWorker(paperSlideApi);
  for (const path of ["/api/paper-slides", "/api/paper-slides/status"]) {
    const response = await worker.fetch(new Request(`https://worker.test${path}`, {
      method: "OPTIONS",
      headers: { origin: "https://taichiiiiiiii.github.io" },
    }), {});
    eq(response.status, 204);
    eq(response.headers.get("access-control-allow-headers"), "authorization, content-type");
    eq(response.headers.get("access-control-allow-origin"), "https://taichiiiiiiii.github.io");
  }
}));

tests.push(test("generic API preflight keeps the theme CORS contract", async () => {
  const paperSlideApi = { async handle() { throw new Error("must not delegate"); } };
  const { worker } = makeWorker(paperSlideApi);
  const response = await worker.fetch(new Request("https://worker.test/api/themes", {
    method: "OPTIONS",
    headers: { origin: "https://example.test" },
  }), {});
  eq(response.status, 204);
  eq(response.headers.get("access-control-allow-origin"), "*");
  eq(response.headers.get("access-control-allow-methods"), "GET, POST, OPTIONS");
  eq(response.headers.get("access-control-allow-headers"), "content-type");
  eq(response.headers.get("access-control-max-age"), "86400");
}));

tests.push(test("non-API requests remain not found", async () => {
  const { worker } = makeWorker();
  const response = await worker.fetch(new Request("https://worker.test/themes/"), {});
  eq(response.status, 404);
  eq(await response.text(), "Not Found");
}));

await Promise.all(tests);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  for (const failure of failures) {
    console.log(`  - ${failure.name}: ${failure.error.stack || failure.error.message}`);
  }
  process.exit(1);
}
