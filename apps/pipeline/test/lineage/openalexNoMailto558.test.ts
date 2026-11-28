/**
 * #558 item 4: OpenAlex retired the `mailto` polite pool and ignores the
 * parameter, so every OpenAlex request goes out WITHOUT the contact e-mail
 * (sending it bought nothing and only leaked the address). The six request
 * paths below each get an e-mail in their deps/arguments and must still
 * produce a request URL with no `mailto` and no trace of the address.
 *
 * The disk cache keys must not move: the main lineage path never put the
 * e-mail into a key, and the eval tool `apiRelationsCli` still derives its
 * key from the historical `…&mailto=<addr>` URL so old entries keep hitting.
 * No test here reaches the network (injected fetch / stubbed global fetch).
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HttpResponseLike } from "../../src/collect/http/requestWithRetry.js";
import { OpenAlexSource } from "../../src/collect/sources/openalex.js";
import { resolveOral } from "../../src/lineage/conference/buildConferenceLineage.js";
import { openalexReferenced } from "../../src/lineage/eval/apiRelationsCli.js";
import { cachedGet } from "../../src/lineage/theme/eval/collectRelevanceCandidates.js";
import { discoverSeedsViaOpenalex } from "../../src/lineage/theme/openalexFetch.js";
import type { ThemePaper } from "../../src/lineage/theme/openalexWork.js";
import { mapS2PapersToOpenalex } from "../../src/lineage/theme/s2Expansion.js";

const EMAIL = "contact-558@example.org";
const ENCODED = encodeURIComponent(EMAIL);

function expectNoEmail(urls: readonly string[]): void {
  expect(urls.length).toBeGreaterThan(0);
  for (const url of urls) {
    expect(url).toContain("api.openalex.org");
    expect(new URL(url).searchParams.has("mailto")).toBe(false);
    expect(url).not.toContain("mailto");
    expect(url).not.toContain(EMAIL);
    expect(url).not.toContain(ENCODED);
  }
}

function recorder(body: unknown = { results: [] }) {
  const urls: string[] = [];
  const fetchImpl = async (url: string): Promise<HttpResponseLike> => {
    urls.push(url);
    return { status: 200, json: async () => body };
  };
  return { urls, fetchImpl };
}

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "oa-mailto-558-"));
  dirs.push(d);
  return d;
}

afterEach(() => {
  vi.unstubAllGlobals();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function stubGlobalFetch(body: unknown = { results: [] }): string[] {
  const urls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      urls.push(String(url));
      return new Response(JSON.stringify(body), { status: 200 });
    }),
  );
  return urls;
}

describe("#558 OpenAlex requests carry no mailto", () => {
  it("collect: OpenAlexSource.search (email configured)", async () => {
    const { urls, fetchImpl } = recorder();
    const source = new OpenAlexSource(
      { delaySeconds: 0 },
      { fetchImpl, email: EMAIL, sleep: async () => {} },
    );
    await source.fetch({ keywords: ["x"], categories: [], sinceDate: "2026-06-01", maxResults: 5 });
    expectNoEmail(urls);
  });

  it("conference lineage: get() via resolveOral (email option)", async () => {
    const { urls, fetchImpl } = recorder();
    const aliases = new Set(["arxiv:2601.00001"]) as unknown as Parameters<typeof resolveOral>[1];
    await resolveOral(
      "Oral Paper One",
      aliases,
      { email: EMAIL },
      {
        fetchImpl,
        sleep: async () => {},
      },
    );
    expectNoEmail(urls);
  });

  it("theme: openalexFetch (discoverSeedsViaOpenalex, deps.email)", async () => {
    const { urls, fetchImpl } = recorder();
    await discoverSeedsViaOpenalex(
      { query: "Prompt Tuning", topN: 5, sinceYear: 2018 },
      { fetchImpl, sleep: async () => {}, email: EMAIL, logger: { warn: () => {} } },
    );
    expectNoEmail(urls);
  });

  it("theme: s2Expansion.mapS2PapersToOpenalex (deps.email)", async () => {
    const { urls, fetchImpl } = recorder();
    const paper: ThemePaper = {
      paperId: "a".repeat(40),
      title: "Some Paper",
      year: 2021,
      venue: "",
      citationCount: 1,
      abstract: "",
      authors: [],
      externalIds: { DOI: "10.1000/xyz", ArXiv: "2101.00001" },
    };
    const out = await mapS2PapersToOpenalex([paper], {
      fetchImpl,
      sleep: async () => {},
      email: EMAIL,
    });
    expect(out).not.toBeNull();
    expectNoEmail(urls);
    expect(decodeURIComponent(urls[0] as string)).toContain("filter=doi:");
  });

  it("eval: collectRelevanceCandidates.cachedGet (args.mailto)", async () => {
    const urls = stubGlobalFetch({ id: "https://openalex.org/W1" });
    await cachedGet("https://api.openalex.org/works/W1?select=id", {
      cacheDir: tmp(),
      mailto: EMAIL,
      out: "unused.json",
      cites: 16,
    });
    expectNoEmail(urls);
  });

  it("eval: apiRelationsCli.openalexReferenced (mailto argument)", async () => {
    const urls = stubGlobalFetch({ results: [] });
    await openalexReferenced(["openalex:W1", "openalex:W2"], tmp(), EMAIL);
    expectNoEmail(urls);
  });
});

describe("#558 cache keys are unchanged", () => {
  /** The key apiRelationsCli used before #558: the request URL with mailto. */
  function legacyKey(ids: string[], mailto: string): string {
    const url = `https://api.openalex.org/works?filter=openalex_id:${ids.join("|")}&select=id,referenced_works&per_page=50&mailto=${encodeURIComponent(mailto)}`;
    return createHash("sha256").update(`GET ${url} `).digest("hex");
  }

  it("apiRelationsCli writes its entry under the pre-#558 key", async () => {
    stubGlobalFetch({ results: [] });
    const dir = tmp();
    await openalexReferenced(["openalex:W1", "openalex:W2"], dir, EMAIL);
    expect(existsSync(join(dir, "http", `${legacyKey(["W1", "W2"], EMAIL)}.json`))).toBe(true);
  });

  it("apiRelationsCli hits an entry stored under the pre-#558 key without fetching", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const dir = tmp();
    mkdirSync(join(dir, "http"), { recursive: true });
    writeFileSync(
      join(dir, "http", `${legacyKey(["W7"], EMAIL)}.json`),
      JSON.stringify({
        url: "legacy",
        status: 200,
        body: { results: [{ id: "https://openalex.org/W7", referenced_works: ["W8"] }] },
      }),
    );
    const out = await openalexReferenced(["openalex:W7"], dir, EMAIL);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect([...(out.get("openalex:W7") ?? [])]).toEqual(["openalex:W8"]);
  });

  it("collectRelevanceCandidates keys on the URL without mailto (as before)", async () => {
    stubGlobalFetch({ id: "https://openalex.org/W1" });
    const dir = tmp();
    const url = "https://api.openalex.org/works/W1?select=id";
    await cachedGet(url, { cacheDir: dir, mailto: EMAIL, out: "unused.json", cites: 16 });
    const key = createHash("sha1").update(url).digest("hex");
    expect(existsSync(join(dir, `${key}.json`))).toBe(true);
  });
});
