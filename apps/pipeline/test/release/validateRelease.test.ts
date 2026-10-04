/**
 * TS port (portable subset) of the validate-pages-release checks described
 * by `paperpilot/tests/test_pages_release_workflow.py`'s string-level
 * assertions (PUB-26..37) plus the two Cloudflare-era additions from
 * design doc §4.3/§4.4 (no design/research publishing, CSP meta present).
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import {
  DEFAULT_REQUIRED_ARTIFACTS,
  smokeRemote,
  ValidateReleaseError,
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
