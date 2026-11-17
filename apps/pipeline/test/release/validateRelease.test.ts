/**
 * TS port (portable subset) of the validate-pages-release checks described
 * by `paperpilot/tests/test_pages_release_workflow.py`'s string-level
 * assertions (PUB-26..37) plus the two Cloudflare-era additions from
 * design doc §4.3/§4.4 (no design/research publishing, CSP meta present).
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LAYOUT_MODE } from "@paperpilot/core/layout";
import { afterEach, beforeEach, expect, it } from "vitest";
import {
  DEFAULT_REQUIRED_ARTIFACTS,
  DEPLOYMENT_MARKER_FILENAME,
  requiredArtifactsFor,
  smokeRemote,
  ValidateReleaseError,
  validateBundle,
  validateJsonBundle,
  validateLocal,
  validateSha,
} from "../../src/release/validateRelease.js";

let docs: string;
beforeEach(() => {
  docs = mkdtempSync(join(tmpdir(), "paperpilot-validate-release-"));
});
afterEach(() => {
  rmSync(docs, { recursive: true, force: true });
});

const SHA = "a".repeat(40);

function writeValidBundle(): void {
  for (const artifact of DEFAULT_REQUIRED_ARTIFACTS) {
    const path = join(docs, artifact);
    mkdirSync(join(path, ".."), { recursive: true });
  }
  writeFileSync(
    join(docs, "index.html"),
    '<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src \'self\'"></head></html>',
  );
  writeFileSync(
    join(docs, "404.html"),
    '<!doctype html><meta http-equiv="Content-Security-Policy" content="x">',
  );
  mkdirSync(join(docs, "iclr-2026"), { recursive: true });
  writeFileSync(join(docs, "iclr-2026", "papers.json"), "[]");
  writeFileSync(join(docs, "conferences.json"), JSON.stringify([{ name: "iclr-2026" }]));
  writeFileSync(join(docs, "search-index.json"), "[]");
  writeFileSync(join(docs, "search-index-v2.json"), "[]");
  writeFileSync(join(docs, "lineage-quality-v1.json"), "{}");
  writeFileSync(join(docs, "sitemap.xml"), '<?xml version="1.0"?><urlset></urlset>');
  mkdirSync(join(docs, "assets"), { recursive: true });
  writeFileSync(join(docs, "assets", "versions.json"), "{}");
  // p5-only required artifacts (Next's static-export postbuild outputs);
  // written unconditionally (harmless extra files under legacy, where
  // they're not in DEFAULT_REQUIRED_ARTIFACTS and nothing checks their
  // absence) so this fixture is a valid bundle under BOTH layout modes.
  writeFileSync(join(docs, "_redirects"), "/old /new 301\n");
  writeFileSync(join(docs, "_headers"), "/*\n  Content-Security-Policy: frame-ancestors 'self'\n");
}

it("validateSha rejects anything but 40 lowercase hex", () => {
  expect(() => validateSha(SHA)).not.toThrow();
  expect(() => validateSha("ABC")).toThrow(ValidateReleaseError);
  expect(() => validateSha(SHA.toUpperCase())).toThrow(ValidateReleaseError);
});

it("validateLocal passes a well-formed bundle at the expected SHA", () => {
  writeValidBundle();
  expect(() =>
    validateLocal({ expectedSha: SHA, docsRoot: docs, actualHeadSha: SHA }),
  ).not.toThrow();
});

it("validateLocal rejects a checkout at the wrong SHA", () => {
  writeValidBundle();
  expect(() =>
    validateLocal({ expectedSha: SHA, docsRoot: docs, actualHeadSha: "b".repeat(40) }),
  ).toThrow(/checkout SHA/);
});

it("validateLocal rejects a missing required artifact", () => {
  writeValidBundle();
  rmSync(join(docs, "404.html"));
  expect(() => validateLocal({ expectedSha: SHA, docsRoot: docs, actualHeadSha: SHA })).toThrow(
    /missing Pages artifact: 404.html/,
  );
});

it("validateJsonBundle rejects invalid JSON anywhere under the docs root", () => {
  writeValidBundle();
  writeFileSync(join(docs, "iclr-2026", "papers.json"), "{not json");
  expect(() => validateJsonBundle(docs)).toThrow(/invalid JSON/);
});

it("validateJsonBundle rejects an invalid sitemap.xml", () => {
  writeValidBundle();
  writeFileSync(join(docs, "sitemap.xml"), "<urlset><bad></urlset>");
  expect(() => validateJsonBundle(docs)).toThrow(/sitemap/);
});

// PUB-35: validateJsonBundle's own conferences.json must be a non-empty
// array (distinct from the "entry with no catalog" check below, which
// requires the array to be non-empty and then checks each entry).
it("validateJsonBundle rejects an empty local conferences.json", () => {
  writeValidBundle();
  writeFileSync(join(docs, "conferences.json"), "[]");
  expect(() => validateJsonBundle(docs)).toThrow(/conferences.json must be a non-empty array/);
});

it("validateJsonBundle rejects a conferences.json that is not an array at all", () => {
  writeValidBundle();
  writeFileSync(join(docs, "conferences.json"), '{"name":"iclr-2026"}');
  expect(() => validateJsonBundle(docs)).toThrow(/conferences.json must be a non-empty array/);
});

it("validateJsonBundle rejects a conferences.json entry with no catalog", () => {
  writeValidBundle();
  writeFileSync(
    join(docs, "conferences.json"),
    JSON.stringify([{ name: "iclr-2026" }, { name: "ghost-2026" }]),
  );
  expect(() => validateJsonBundle(docs)).toThrow(/missing catalog for conference "ghost-2026"/);
});

it("validateJsonBundle rejects published docs/design content", () => {
  writeValidBundle();
  mkdirSync(join(docs, "design"), { recursive: true });
  writeFileSync(join(docs, "design", "39-plan.md"), "secret plan");
  expect(() => validateJsonBundle(docs)).toThrow(/forbidden published path/);
});

it("validateJsonBundle rejects a published *_IMPLEMENTER.md file", () => {
  writeValidBundle();
  writeFileSync(join(docs, "QWEN_IMPLEMENTER.md"), "ops notes");
  expect(() => validateJsonBundle(docs)).toThrow(/forbidden published path/);
});

it("validateJsonBundle rejects an HTML page with no CSP meta tag", () => {
  writeValidBundle();
  writeFileSync(join(docs, "no-csp.html"), "<!doctype html><html></html>");
  expect(() => validateJsonBundle(docs)).toThrow(/missing CSP meta tag/);
});

// ---- smoke (injected fetch, no real network) ----

function fakeFetch(routes: Record<string, string>) {
  return async (url: string) => {
    const path = url.replace(/^https?:\/\/[^/]+/, "");
    const body = routes[path];
    if (body === undefined) {
      return {
        status: 404,
        async text() {
          return "not found";
        },
      };
    }
    return {
      status: 200,
      async text() {
        return body;
      },
    };
  };
}

function validSmokeRoutes(sha: string): Record<string, string> {
  return {
    "/": "<!doctype html><html></html>",
    "/_paperpilot-deployment.json": JSON.stringify({ source_sha: sha }),
    "/conferences.json": JSON.stringify([{ name: "iclr-2026" }]),
    "/search-index-v2.json": JSON.stringify([["T", "iclr-2026", 0, [], [], 2026, "Oral"]]),
    "/lineage-quality-v1.json": JSON.stringify({
      collections: [{ path: "iclr-2026/lineage/", availability: "ready", audit_status: "passed" }],
    }),
    "/iclr-2026/": "<!doctype html><html></html>",
    "/iclr-2026/lineage/": "<!doctype html><html></html>",
  };
}

it("smokeRemote passes a well-formed deployment and follows the ready+passed lineage route", async () => {
  const result = await smokeRemote({
    baseUrl: "https://paperpilot.pages.dev",
    expectedSha: SHA,
    fetchImpl: fakeFetch(validSmokeRoutes(SHA)),
    // Not what this test is about (see the dedicated checkCspHeader:true/
    // false-by-default tests below); fakeFetch's responses don't expose
    // `.headers` at all, so this must be explicit rather than relying on
    // LAYOUT_MODE's default.
    checkCspHeader: false,
  });
  expect(result.routes).toEqual([
    "https://paperpilot.pages.dev/iclr-2026/",
    "https://paperpilot.pages.dev/iclr-2026/lineage/",
  ]);
});

// LOW: the shell original percent-encodes the smoke path with
// `urllib.parse.quote(path, safe="/-._~")` before fetching it — a route
// segment with a space or non-ASCII character must be encoded the same
// way (byte-wise UTF-8 %XX, "/" left alone), not passed through raw.
it("smokeRemote percent-encodes smoke route paths like Python's urllib.parse.quote", async () => {
  const routes = validSmokeRoutes(SHA);
  routes["/conferences.json"] = JSON.stringify([{ name: "a conf" }]);
  routes["/a%20conf/"] = "<!doctype html><html></html>";
  routes["/lineage-quality-v1.json"] = JSON.stringify({
    collections: [{ path: "thème/lineage/", availability: "ready", audit_status: "passed" }],
  });
  routes["/th%C3%A8me/lineage/"] = "<!doctype html><html></html>";

  const result = await smokeRemote({
    baseUrl: "https://paperpilot.pages.dev",
    expectedSha: SHA,
    fetchImpl: fakeFetch(routes),
    checkCspHeader: false, // not what this test is about; see comment above
  });
  expect(result.routes).toEqual([
    "https://paperpilot.pages.dev/a%20conf/",
    "https://paperpilot.pages.dev/th%C3%A8me/lineage/",
  ]);
});

it("smokeRemote rejects a non-https base URL", async () => {
  await expect(
    smokeRemote({
      baseUrl: "http://paperpilot.pages.dev",
      expectedSha: SHA,
      fetchImpl: fakeFetch(validSmokeRoutes(SHA)),
    }),
  ).rejects.toThrow(/https/);
});

it("smokeRemote rejects a marker SHA mismatch", async () => {
  await expect(
    smokeRemote({
      baseUrl: "https://paperpilot.pages.dev",
      expectedSha: SHA,
      fetchImpl: fakeFetch(validSmokeRoutes("b".repeat(40))),
    }),
  ).rejects.toThrow(/does not match/);
});

// PUB-35: the deployed root response must actually be the HTML shell, not
// e.g. a JSON error page or an empty body that happened to return 200.
it("smokeRemote rejects a deployed root page that is not HTML", async () => {
  const routes = validSmokeRoutes(SHA);
  routes["/"] = '{"error":"not found"}';
  await expect(
    smokeRemote({
      baseUrl: "https://paperpilot.pages.dev",
      expectedSha: SHA,
      fetchImpl: fakeFetch(routes),
    }),
  ).rejects.toThrow(/root page is not HTML/);
});

// PUB-35: the first conferences.json entry (used as the representative
// smoke route) must carry a `name` string, or there is nothing to smoke
// beyond the already-checked conferences.json/search-index-v2.json/
// lineage-quality-v1.json fetches themselves.
it("smokeRemote rejects a representative conference entry with no name", async () => {
  const routes = validSmokeRoutes(SHA);
  routes["/conferences.json"] = JSON.stringify([{ papers: 10 }]);
  await expect(
    smokeRemote({
      baseUrl: "https://paperpilot.pages.dev",
      expectedSha: SHA,
      fetchImpl: fakeFetch(routes),
    }),
  ).rejects.toThrow(/representative conference has no name/);
});

it("smokeRemote rejects an empty deployed search-index-v2.json", async () => {
  const routes = validSmokeRoutes(SHA);
  routes["/search-index-v2.json"] = "[]";
  await expect(
    smokeRemote({
      baseUrl: "https://paperpilot.pages.dev",
      expectedSha: SHA,
      fetchImpl: fakeFetch(routes),
    }),
  ).rejects.toThrow(/search-index-v2.json is empty/);
});

it("smokeRemote rejects an empty deployed conferences.json", async () => {
  const routes = validSmokeRoutes(SHA);
  routes["/conferences.json"] = "[]";
  await expect(
    smokeRemote({
      baseUrl: "https://paperpilot.pages.dev",
      expectedSha: SHA,
      fetchImpl: fakeFetch(routes),
    }),
  ).rejects.toThrow(/conferences.json is empty/);
});

it("smokeRemote rejects an unsafe lineage path from lineage-quality-v1.json", async () => {
  const routes = validSmokeRoutes(SHA);
  routes["/lineage-quality-v1.json"] = JSON.stringify({
    collections: [{ path: "https://evil.example/", availability: "ready", audit_status: "passed" }],
  });
  await expect(
    smokeRemote({
      baseUrl: "https://paperpilot.pages.dev",
      expectedSha: SHA,
      fetchImpl: fakeFetch(routes),
    }),
  ).rejects.toThrow(/unsafe smoke path/);
});

// ---- M6: per-fetch timeout + retry, matching the shell's
// `curl --connect-timeout 5 --max-time 15 --retry 2 --retry-all-errors` ----

function noSleep(): Promise<void> {
  return Promise.resolve();
}

it("smokeRemote retries a transient failure and succeeds on the 3rd attempt", async () => {
  const routes = validSmokeRoutes(SHA);
  let indexAttempts = 0;
  const fetchImpl = async (url: string) => {
    const path = url.replace(/^https?:\/\/[^/]+/, "");
    if (path === "/") {
      indexAttempts += 1;
      if (indexAttempts < 3) {
        return {
          status: 503,
          async text() {
            return "unavailable";
          },
        };
      }
    }
    const body = routes[path];
    return {
      status: body === undefined ? 404 : 200,
      async text() {
        return body ?? "not found";
      },
    };
  };

  const result = await smokeRemote({
    baseUrl: "https://paperpilot.pages.dev",
    expectedSha: SHA,
    fetchImpl,
    sleep: noSleep,
    checkCspHeader: false, // not what this test is about; its fetchImpl returns no headers
  });
  expect(indexAttempts).toBe(3);
  expect(result.routes.length).toBeGreaterThan(0);
});

it("smokeRemote gives up after the configured retries (bounded attempts, not infinite)", async () => {
  let attempts = 0;
  const fetchImpl = async () => {
    attempts += 1;
    return {
      status: 503,
      async text() {
        return "unavailable";
      },
    };
  };

  await expect(
    smokeRemote({
      baseUrl: "https://paperpilot.pages.dev",
      expectedSha: SHA,
      fetchImpl,
      retries: 2,
      sleep: noSleep,
    }),
  ).rejects.toThrow(/HTTP 503/);
  expect(attempts).toBe(3);
});

it("smokeRemote times out a hung fetch instead of waiting forever", async () => {
  const fetchImpl = (_url: string, init?: { signal?: AbortSignal }) =>
    new Promise<{ status: number; text(): Promise<string> }>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      // Never resolves on its own — only the timeout's abort ends this.
    });

  await expect(
    smokeRemote({
      baseUrl: "https://paperpilot.pages.dev",
      expectedSha: SHA,
      fetchImpl,
      timeoutMs: 10,
      retries: 0,
      sleep: noSleep,
    }),
  ).rejects.toThrow(/timed out/);
});

// ---- p5-plan.md §2 A4: requiredArtifactsFor / validateBundle ----

it("requiredArtifactsFor: legacy mode never includes the marker, build mode or not", () => {
  expect(requiredArtifactsFor("legacy")).not.toContain(DEPLOYMENT_MARKER_FILENAME);
  expect(requiredArtifactsFor("legacy", { buildMode: true })).not.toContain(
    DEPLOYMENT_MARKER_FILENAME,
  );
});

it("requiredArtifactsFor: p5 mode includes the marker only in build mode", () => {
  expect(requiredArtifactsFor("p5")).not.toContain(DEPLOYMENT_MARKER_FILENAME);
  expect(requiredArtifactsFor("p5", { buildMode: true })).toContain(DEPLOYMENT_MARKER_FILENAME);
});

it("DEFAULT_REQUIRED_ARTIFACTS equals requiredArtifactsFor()'s default (current LAYOUT_MODE, non-build)", () => {
  expect(DEFAULT_REQUIRED_ARTIFACTS).toEqual(requiredArtifactsFor());
});

it("validateBundle passes a well-formed bundle with no SHA/HEAD check at all", () => {
  writeValidBundle();
  expect(() => validateBundle({ docsRoot: docs })).not.toThrow();
});

it("validateBundle rejects a missing required artifact", () => {
  writeValidBundle();
  rmSync(join(docs, "404.html"));
  expect(() => validateBundle({ docsRoot: docs })).toThrow(/missing Pages artifact: 404.html/);
});

it("validateBundle rejects a docsRoot that does not exist", () => {
  expect(() => validateBundle({ docsRoot: join(docs, "nope") })).toThrow(
    /docs root does not exist/,
  );
});

it("validateBundle honours an explicit requiredArtifacts override", () => {
  writeValidBundle();
  expect(() =>
    validateBundle({ docsRoot: docs, requiredArtifacts: ["index.html", "nonexistent.json"] }),
  ).toThrow(/missing Pages artifact: nonexistent.json/);
});

// ---- p5-plan.md §2 A4: smoke extensions (--wait-marker, --expect-bytes, --expect-404, --expect-redirect, CSP header) ----

interface FakeRoute {
  status: number;
  body?: string | Buffer;
  headers?: Record<string, string>;
}

function fakeFetchFull(routes: Record<string, FakeRoute>) {
  return async (url: string, _init?: { redirect?: "manual" | "follow" }) => {
    const path = url.replace(/^https?:\/\/[^/]+/, "");
    const route = routes[path];
    if (route === undefined) {
      return {
        status: 404,
        async text() {
          return "not found";
        },
        async arrayBuffer() {
          return new ArrayBuffer(0);
        },
        headers: { get: () => null },
      };
    }
    const bodyBuffer =
      typeof route.body === "string"
        ? Buffer.from(route.body, "utf-8")
        : (route.body ?? Buffer.alloc(0));
    return {
      status: route.status,
      async text() {
        return bodyBuffer.toString("utf-8");
      },
      async arrayBuffer() {
        return new Uint8Array(bodyBuffer).buffer as ArrayBuffer;
      },
      headers: {
        get(name: string) {
          return route.headers?.[name.toLowerCase()] ?? null;
        },
      },
    };
  };
}

function toFakeRoutes(routes: Record<string, string>): Record<string, FakeRoute> {
  const out: Record<string, FakeRoute> = {};
  for (const [path, body] of Object.entries(routes)) {
    out[path] = { status: 200, body };
  }
  return out;
}

function fakeNow(startMs: number, stepMs: number): () => number {
  let t = startMs;
  return () => {
    const value = t;
    t += stepMs;
    return value;
  };
}

it("smokeRemote --wait-marker polls until the marker reports the expected SHA", async () => {
  const routes = validSmokeRoutes(SHA);
  let markerCalls = 0;
  const fetchImpl = async (url: string) => {
    const path = url.replace(/^https?:\/\/[^/]+/, "");
    if (path === `/${DEPLOYMENT_MARKER_FILENAME}`) {
      markerCalls += 1;
      const sha = markerCalls < 2 ? "b".repeat(40) : SHA;
      return {
        status: 200,
        async text() {
          return JSON.stringify({ source_sha: sha });
        },
      };
    }
    const body = routes[path];
    return {
      status: body === undefined ? 404 : 200,
      async text() {
        return body ?? "not found";
      },
    };
  };

  const result = await smokeRemote({
    baseUrl: "https://paperpilot.pages.dev",
    expectedSha: SHA,
    fetchImpl,
    waitMarkerSeconds: 10,
    now: fakeNow(0, 1),
    sleep: noSleep,
    checkCspHeader: false, // not what this test is about; its fetchImpl returns no headers
  });
  expect(markerCalls).toBeGreaterThanOrEqual(2);
  expect(result.routes.length).toBeGreaterThan(0);
});

// L11 (P5 tier-A review): the two tests above don't actually PIN the
// SHA compare inside `waitForMarker` (validateRelease.ts's internal
// `if (marker.source_sha === expectedSha) return;`). `smokeRemote`
// re-fetches and re-compares the marker ONE MORE TIME after
// `waitForMarker` returns (the ":706" backstop) -- so an inverted
// compare (`!==`) that makes the wait loop exit "successfully" on the
// very FIRST mismatch still produces the exact same thrown error
// message via that backstop, and the "polls until expected" test's own
// `markerCalls >= 2` assertion happens to still pass too (the backstop
// fetch IS the 2nd call). Verified empirically: flipping `===` to
// `!==` left the whole existing suite green. This test closes that gap
// by counting marker-route fetches and sleep calls DIRECTLY, which can
// only reach the asserted counts if the wait loop itself genuinely
// polled across multiple (mismatching) attempts before giving up --
// the inverted/short-circuited mutation gives exactly 1 wait-loop
// fetch + 1 backstop fetch = 2 total and 0 sleeps, which fails both
// assertions below.
it("smokeRemote --wait-marker genuinely polls multiple times on a persistent mismatch (pins the internal SHA compare, L11)", async () => {
  const routes = validSmokeRoutes(SHA);
  let markerCalls = 0;
  const sleepCalls: number[] = [];
  const fetchImpl = async (url: string) => {
    const path = url.replace(/^https?:\/\/[^/]+/, "");
    if (path === `/${DEPLOYMENT_MARKER_FILENAME}`) {
      markerCalls += 1;
      // Always mismatched: a correct implementation can only ever
      // learn this by polling repeatedly until the deadline, then
      // throwing from INSIDE waitForMarker -- it never reaches the
      // backstop fetch at all.
      return {
        status: 200,
        async text() {
          return JSON.stringify({ source_sha: "b".repeat(40) });
        },
      };
    }
    const body = routes[path];
    return {
      status: body === undefined ? 404 : 200,
      async text() {
        return body ?? "not found";
      },
    };
  };
  const recordingSleep = (ms: number): Promise<void> => {
    sleepCalls.push(ms);
    return Promise.resolve();
  };

  await expect(
    smokeRemote({
      baseUrl: "https://paperpilot.pages.dev",
      expectedSha: SHA,
      fetchImpl,
      waitMarkerSeconds: 10,
      now: fakeNow(0, 3000),
      sleep: recordingSleep,
    }),
  ).rejects.toThrow(/does not match/);

  // A correct implementation polls (fetch, check now() < deadline,
  // sleep) in a loop and ONLY throws once the deadline is exceeded, so
  // it accumulates several marker fetches and several sleeps -- never
  // falls through to a separate backstop fetch afterwards (the error
  // is thrown from inside waitForMarker itself). The inverted/
  // short-circuited mutation described above instead produces exactly
  // 2 marker fetches (1 in the loop + 1 backstop) and 0 sleeps.
  expect(markerCalls).toBeGreaterThan(2);
  expect(sleepCalls.length).toBeGreaterThan(1);
});

it("smokeRemote --wait-marker gives up once the deadline passes, surfacing the mismatch", async () => {
  const routes = validSmokeRoutes(SHA);
  routes[`/${DEPLOYMENT_MARKER_FILENAME}`] = JSON.stringify({ source_sha: "b".repeat(40) });
  await expect(
    smokeRemote({
      baseUrl: "https://paperpilot.pages.dev",
      expectedSha: SHA,
      fetchImpl: fakeFetch(routes),
      waitMarkerSeconds: 1,
      now: fakeNow(0, 2000),
      sleep: noSleep,
    }),
  ).rejects.toThrow(/does not match/);
});

function expectBytesBaseRoutes(): Record<string, FakeRoute> {
  return {
    [`/${DEPLOYMENT_MARKER_FILENAME}`]: { status: 200, body: JSON.stringify({ source_sha: SHA }) },
    "/conferences.json": { status: 200, body: JSON.stringify([{ name: "iclr-2026" }]) },
    "/search-index-v2.json": {
      status: 200,
      body: JSON.stringify([["T", "iclr-2026", 0, [], [], 2026, "Oral"]]),
    },
    "/lineage-quality-v1.json": { status: 200, body: JSON.stringify({ collections: [] }) },
  };
}

it("smokeRemote --expect-bytes passes when served bytes are byte-identical to the local build output", async () => {
  const dir = mkdtempSync(join(tmpdir(), "paperpilot-expect-bytes-"));
  try {
    writeFileSync(join(dir, "index.html"), "<!doctype html><html>A</html>");
    writeFileSync(join(dir, "404.html"), "<!doctype html><html>404</html>");
    mkdirSync(join(dir, "iclr-2026"), { recursive: true });
    writeFileSync(join(dir, "iclr-2026", "index.html"), "<!doctype html><html>conf</html>");

    const routes = expectBytesBaseRoutes();
    routes["/"] = { status: 200, body: readFileSync(join(dir, "index.html")) };
    routes["/404.html"] = { status: 200, body: readFileSync(join(dir, "404.html")) };
    routes["/iclr-2026/"] = {
      status: 200,
      body: readFileSync(join(dir, "iclr-2026", "index.html")),
    };

    await expect(
      smokeRemote({
        baseUrl: "https://paperpilot.pages.dev",
        expectedSha: SHA,
        fetchImpl: fakeFetchFull(routes),
        expectBytesDir: dir,
        checkCspHeader: false, // not what this test is about; its routes carry no CSP header
      }),
    ).resolves.toBeDefined();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it("smokeRemote --expect-bytes rejects a byte mismatch", async () => {
  const dir = mkdtempSync(join(tmpdir(), "paperpilot-expect-bytes-mismatch-"));
  try {
    writeFileSync(join(dir, "index.html"), "<!doctype html><html>A</html>");
    writeFileSync(join(dir, "404.html"), "<!doctype html><html>404</html>");
    mkdirSync(join(dir, "iclr-2026"), { recursive: true });
    writeFileSync(join(dir, "iclr-2026", "index.html"), "<!doctype html><html>conf</html>");

    const routes = expectBytesBaseRoutes();
    routes["/"] = { status: 200, body: "<!doctype html><html>DIFFERENT BYTES</html>" };
    routes["/404.html"] = { status: 200, body: readFileSync(join(dir, "404.html")) };
    routes["/iclr-2026/"] = {
      status: 200,
      body: readFileSync(join(dir, "iclr-2026", "index.html")),
    };

    await expect(
      smokeRemote({
        baseUrl: "https://paperpilot.pages.dev",
        expectedSha: SHA,
        fetchImpl: fakeFetchFull(routes),
        expectBytesDir: dir,
        checkCspHeader: false, // not what this test is about; its routes carry no CSP header
      }),
    ).rejects.toThrow(/does not byte-match/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it("smokeRemote --expect-404 passes when the path truly 404s", async () => {
  const routes = validSmokeRoutes(SHA);
  await expect(
    smokeRemote({
      baseUrl: "https://paperpilot.pages.dev",
      expectedSha: SHA,
      fetchImpl: fakeFetch(routes),
      expect404Paths: ["/__pp_smoke_missing__/"],
      checkCspHeader: false, // not what this test is about; fakeFetch returns no headers
    }),
  ).resolves.toBeDefined();
});

it("smokeRemote --expect-404 fails when the path actually resolves", async () => {
  const routes = validSmokeRoutes(SHA);
  routes["/__pp_smoke_missing__/"] = "<!doctype html><html>oops, exists</html>";
  await expect(
    smokeRemote({
      baseUrl: "https://paperpilot.pages.dev",
      expectedSha: SHA,
      fetchImpl: fakeFetch(routes),
      expect404Paths: ["/__pp_smoke_missing__/"],
    }),
  ).rejects.toThrow(/expected HTTP 404/);
});

it("smokeRemote --expect-redirect passes on a 301 with a relative Location", async () => {
  const routes = toFakeRoutes(validSmokeRoutes(SHA));
  routes["/iclr-2026/lineage.html"] = { status: 301, headers: { location: "/iclr-2026/lineage/" } };
  await expect(
    smokeRemote({
      baseUrl: "https://paperpilot.pages.dev",
      expectedSha: SHA,
      fetchImpl: fakeFetchFull(routes),
      expectRedirects: [{ from: "/iclr-2026/lineage.html", to: "/iclr-2026/lineage/" }],
      checkCspHeader: false, // not what this test is about; its routes carry no CSP header
    }),
  ).resolves.toBeDefined();
});

it("smokeRemote --expect-redirect passes on a 301 with an absolute Location (R21, unverified which form Cloudflare sends)", async () => {
  const routes = toFakeRoutes(validSmokeRoutes(SHA));
  routes["/iclr-2026/lineage.html"] = {
    status: 301,
    headers: { location: "https://paperpilot.pages.dev/iclr-2026/lineage/" },
  };
  await expect(
    smokeRemote({
      baseUrl: "https://paperpilot.pages.dev",
      expectedSha: SHA,
      fetchImpl: fakeFetchFull(routes),
      expectRedirects: [{ from: "/iclr-2026/lineage.html", to: "/iclr-2026/lineage/" }],
      checkCspHeader: false, // not what this test is about; its routes carry no CSP header
    }),
  ).resolves.toBeDefined();
});

it("smokeRemote --expect-redirect fails on a non-301 status", async () => {
  const routes = toFakeRoutes(validSmokeRoutes(SHA));
  routes["/x.html"] = { status: 200, body: "<!doctype html>" };
  await expect(
    smokeRemote({
      baseUrl: "https://paperpilot.pages.dev",
      expectedSha: SHA,
      fetchImpl: fakeFetchFull(routes),
      expectRedirects: [{ from: "/x.html", to: "/x/" }],
    }),
  ).rejects.toThrow(/expected HTTP 301/);
});

it("smokeRemote --expect-redirect fails when Location points somewhere else", async () => {
  const routes = toFakeRoutes(validSmokeRoutes(SHA));
  routes["/x.html"] = { status: 301, headers: { location: "/somewhere-else/" } };
  await expect(
    smokeRemote({
      baseUrl: "https://paperpilot.pages.dev",
      expectedSha: SHA,
      fetchImpl: fakeFetchFull(routes),
      expectRedirects: [{ from: "/x.html", to: "/x/" }],
    }),
  ).rejects.toThrow(/Location resolved to/);
});

it("smokeRemote checkCspHeader:true passes when the header equals exactly \"frame-ancestors 'self'\"", async () => {
  const routes = toFakeRoutes(validSmokeRoutes(SHA));
  routes["/"] = {
    status: 200,
    body: "<!doctype html><html></html>",
    headers: { "content-security-policy": "frame-ancestors 'self'" },
  };
  await expect(
    smokeRemote({
      baseUrl: "https://paperpilot.pages.dev",
      expectedSha: SHA,
      fetchImpl: fakeFetchFull(routes),
      checkCspHeader: true,
    }),
  ).resolves.toBeDefined();
});

it("smokeRemote checkCspHeader:true fails when the header is missing or different", async () => {
  const routes = toFakeRoutes(validSmokeRoutes(SHA));
  await expect(
    smokeRemote({
      baseUrl: "https://paperpilot.pages.dev",
      expectedSha: SHA,
      fetchImpl: fakeFetchFull(routes),
      checkCspHeader: true,
    }),
  ).rejects.toThrow(/Content-Security-Policy header/);
});

// This test is literally about `smokeRemote`'s own
// `shouldCheckCspHeader = options.checkCspHeader ?? LAYOUT_MODE === "p5"`
// default (p5-plan.md §2 A4: no HTTP CSP header existed pre-P5, only the
// meta tag), so branching its fixture/assertion on `LAYOUT_MODE` here is
// the test's actual subject, not a workaround.
it("smokeRemote's default CSP header check follows the current LAYOUT_MODE", async () => {
  const routes = toFakeRoutes(validSmokeRoutes(SHA));
  if (LAYOUT_MODE === "p5") {
    // Under p5 the default is to check, so the fixture must actually
    // carry the header for this to resolve.
    routes["/"] = {
      status: 200,
      body: "<!doctype html><html></html>",
      headers: { "content-security-policy": "frame-ancestors 'self'" },
    };
  }
  // Under legacy the default is to NOT check, so routes["/"] carrying no
  // header at all must still resolve.
  await expect(
    smokeRemote({
      baseUrl: "https://paperpilot.pages.dev",
      expectedSha: SHA,
      fetchImpl: fakeFetchFull(routes),
    }),
  ).resolves.toBeDefined();
});

// ---- #540: CDN propagation lag on the production alias (run 43898231044) ----
//
// The production alias can serve the new marker from one edge and the old
// deployment from the next request a second later. `--wait-marker` must
// treat the marker wait plus every later check as ONE attempt and retry the
// attempt within the same deadline, instead of failing the first time a
// lagging edge answers after the marker matched once. Persistent mismatches
// still fail (only later), and a call without `--wait-marker` still checks
// exactly once.

/** Per-path response sequences: each call takes the next entry; the last entry repeats. */
function sequenceFetch(routes: Record<string, FakeRoute | FakeRoute[]>) {
  const calls: Record<string, number> = {};
  const fetchImpl = async (url: string, init?: { redirect?: "manual" | "follow" }) => {
    const path = url.replace(/^https?:\/\/[^/]+/, "");
    const entry = routes[path];
    const n = calls[path] ?? 0;
    calls[path] = n + 1;
    const route = Array.isArray(entry) ? entry[Math.min(n, entry.length - 1)] : entry;
    return fakeFetchFull(route === undefined ? {} : { [path]: route })(url, init);
  };
  return { fetchImpl, calls };
}

/** A clock that only advances when the code under test sleeps. */
function sleepClock() {
  const state = { t: 0, sleeps: 0 };
  return {
    state,
    now: () => state.t,
    sleep: async (ms: number) => {
      state.sleeps += 1;
      state.t += ms;
      // Yield a macrotask so a loop that ignored the deadline would hit
      // vitest's test timeout instead of spinning on microtasks forever.
      await new Promise((resolve) => setImmediate(resolve));
    },
  };
}

const OLD_SHA = "b".repeat(40);
const markerRoute = (sha: string): FakeRoute => ({
  status: 200,
  body: JSON.stringify({ source_sha: sha }),
});

function propagationBundle(): { dir: string; routes: Record<string, FakeRoute | FakeRoute[]> } {
  const dir = mkdtempSync(join(tmpdir(), "paperpilot-smoke-propagation-"));
  writeFileSync(join(dir, "index.html"), "<!doctype html><html>NEW</html>");
  writeFileSync(join(dir, "404.html"), "<!doctype html><html>404</html>");
  mkdirSync(join(dir, "iclr-2026"), { recursive: true });
  writeFileSync(join(dir, "iclr-2026", "index.html"), "<!doctype html><html>conf</html>");
  const routes: Record<string, FakeRoute | FakeRoute[]> = {
    ...toFakeRoutes(validSmokeRoutes(SHA)),
    "/": { status: 200, body: readFileSync(join(dir, "index.html")) },
    "/404.html": { status: 200, body: readFileSync(join(dir, "404.html")) },
    "/iclr-2026/": { status: 200, body: readFileSync(join(dir, "iclr-2026", "index.html")) },
  };
  return { dir, routes };
}

it("#540 (i) --wait-marker survives a marker that flips match -> stale -> match", async () => {
  const { dir, routes } = propagationBundle();
  try {
    routes[`/${DEPLOYMENT_MARKER_FILENAME}`] = [
      markerRoute(SHA),
      markerRoute(OLD_SHA),
      markerRoute(SHA),
    ];
    const clock = sleepClock();
    const { fetchImpl } = sequenceFetch(routes);
    await expect(
      smokeRemote({
        baseUrl: "https://paperpilot.pages.dev",
        expectedSha: SHA,
        fetchImpl,
        waitMarkerSeconds: 300,
        now: clock.now,
        sleep: clock.sleep,
        expectBytesDir: dir,
        checkCspHeader: false,
      }),
    ).resolves.toBeDefined();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it("#540 (ii-a) --wait-marker survives index.html serving the old bytes once after the marker matched", async () => {
  const { dir, routes } = propagationBundle();
  try {
    const fresh = routes["/"] as FakeRoute;
    // 1st fetch = the root HTML check (fresh), 2nd = the --expect-bytes
    // compare (a lagging edge serves the old page), then fresh again.
    routes["/"] = [fresh, { status: 200, body: "<!doctype html><html>OLD</html>" }, fresh];
    const clock = sleepClock();
    const { fetchImpl } = sequenceFetch(routes);
    await expect(
      smokeRemote({
        baseUrl: "https://paperpilot.pages.dev",
        expectedSha: SHA,
        fetchImpl,
        waitMarkerSeconds: 300,
        now: clock.now,
        sleep: clock.sleep,
        expectBytesDir: dir,
        checkCspHeader: false,
      }),
    ).resolves.toBeDefined();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it("#540 (ii-b) --wait-marker survives conferences.json serving the old list once after the marker matched", async () => {
  const { dir, routes } = propagationBundle();
  try {
    const fresh = routes["/conferences.json"] as FakeRoute;
    // The old deployment's first conference is not in the new build output.
    routes["/conferences.json"] = [
      { status: 200, body: JSON.stringify([{ name: "old-conf-2025" }]) },
      fresh,
    ];
    routes["/old-conf-2025/"] = { status: 200, body: "<!doctype html><html>old</html>" };
    const clock = sleepClock();
    const { fetchImpl } = sequenceFetch(routes);
    await expect(
      smokeRemote({
        baseUrl: "https://paperpilot.pages.dev",
        expectedSha: SHA,
        fetchImpl,
        waitMarkerSeconds: 300,
        now: clock.now,
        sleep: clock.sleep,
        expectBytesDir: dir,
        checkCspHeader: false,
      }),
    ).resolves.toBeDefined();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it("#540 (iii) --wait-marker still fails when the marker stays stale for the whole wait", async () => {
  const { dir, routes } = propagationBundle();
  try {
    routes[`/${DEPLOYMENT_MARKER_FILENAME}`] = markerRoute(OLD_SHA);
    const clock = sleepClock();
    const { fetchImpl, calls } = sequenceFetch(routes);
    await expect(
      smokeRemote({
        baseUrl: "https://paperpilot.pages.dev",
        expectedSha: SHA,
        fetchImpl,
        waitMarkerSeconds: 300,
        now: clock.now,
        sleep: clock.sleep,
        expectBytesDir: dir,
        checkCspHeader: false,
      }),
    ).rejects.toThrow(/does not match requested source SHA/);
    // It waited out the deadline (300 s), polling, and never ran later checks.
    expect(clock.state.t).toBeGreaterThanOrEqual(300_000);
    expect(calls[`/${DEPLOYMENT_MARKER_FILENAME}`]).toBeGreaterThan(2);
    expect(calls["/conferences.json"] ?? 0).toBe(0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it("#540 (iv-a) --wait-marker still fails when --expect-bytes never matches within the wait", async () => {
  const { dir, routes } = propagationBundle();
  try {
    routes["/"] = { status: 200, body: "<!doctype html><html>OLD</html>" };
    const clock = sleepClock();
    const { fetchImpl } = sequenceFetch(routes);
    await expect(
      smokeRemote({
        baseUrl: "https://paperpilot.pages.dev",
        expectedSha: SHA,
        fetchImpl,
        waitMarkerSeconds: 300,
        now: clock.now,
        sleep: clock.sleep,
        expectBytesDir: dir,
        checkCspHeader: false,
      }),
    ).rejects.toThrow(/deployed \/ does not byte-match local index\.html/);
    // Bounded by the same deadline: no attempt starts after 300 s.
    expect(clock.state.t).toBeLessThanOrEqual(300_000 + 2_000);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it("#540 (iv-b) --wait-marker still fails when conferences.json stays empty within the wait", async () => {
  const { dir, routes } = propagationBundle();
  try {
    routes["/conferences.json"] = { status: 200, body: "[]" };
    const clock = sleepClock();
    const { fetchImpl } = sequenceFetch(routes);
    await expect(
      smokeRemote({
        baseUrl: "https://paperpilot.pages.dev",
        expectedSha: SHA,
        fetchImpl,
        waitMarkerSeconds: 300,
        now: clock.now,
        sleep: clock.sleep,
        expectBytesDir: dir,
        checkCspHeader: false,
      }),
    ).rejects.toThrow(/deployed conferences\.json is empty/);
    expect(clock.state.t).toBeLessThanOrEqual(300_000 + 2_000);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it("#540 (v) without --wait-marker a stale answer still fails at once, checking each route a single time", async () => {
  const { dir, routes } = propagationBundle();
  try {
    routes["/conferences.json"] = [
      { status: 200, body: JSON.stringify([{ name: "old-conf-2025" }]) },
      routes["/conferences.json"] as FakeRoute,
    ];
    routes["/old-conf-2025/"] = { status: 200, body: "<!doctype html><html>old</html>" };
    const clock = sleepClock();
    const { fetchImpl, calls } = sequenceFetch(routes);
    await expect(
      smokeRemote({
        baseUrl: "https://paperpilot.pages.dev",
        expectedSha: SHA,
        fetchImpl,
        now: clock.now,
        sleep: clock.sleep,
        expectBytesDir: dir,
        checkCspHeader: false,
      }),
    ).rejects.toThrow(/cannot read local old-conf-2025\/index\.html/);
    expect(calls[`/${DEPLOYMENT_MARKER_FILENAME}`]).toBe(1);
    expect(calls["/conferences.json"]).toBe(1);
    expect(clock.state.sleeps).toBe(0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it("#540 (v) without --wait-marker a marker that is stale on the only fetch fails without polling", async () => {
  const routes: Record<string, FakeRoute | FakeRoute[]> = toFakeRoutes(validSmokeRoutes(SHA));
  routes[`/${DEPLOYMENT_MARKER_FILENAME}`] = [markerRoute(OLD_SHA), markerRoute(SHA)];
  const clock = sleepClock();
  const { fetchImpl, calls } = sequenceFetch(routes);
  await expect(
    smokeRemote({
      baseUrl: "https://paperpilot.pages.dev",
      expectedSha: SHA,
      fetchImpl,
      now: clock.now,
      sleep: clock.sleep,
      checkCspHeader: false,
    }),
  ).rejects.toThrow(/does not match requested source SHA/);
  expect(calls[`/${DEPLOYMENT_MARKER_FILENAME}`]).toBe(1);
  expect(clock.state.sleeps).toBe(0);
});
