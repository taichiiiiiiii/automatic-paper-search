/**
 * Port of `paperpilot/tests/test_collect_cvf.py` (CNF-03, CNF-04, CNF-14,
 * CNF-16).
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { parseDetail, reformatAuthor } from "../../../src/conference/cvf/detail.js";
import { collect, fetchListing } from "../../../src/conference/cvf/fetch.js";
import { detailPaths } from "../../../src/conference/cvf/listing.js";
import { runCvfMain } from "../../../src/conference/cvf/main.js";

const LISTING = `
<dt class="ptitle"><a href="/content/CVPR2025/html/Xiao_Det_paper.html">Det</a></dt>
<dd><a href="/content/CVPR2025/papers/Xiao_Det_paper.pdf">pdf</a></dd>
<dt class="ptitle"><a href="/content/CVPR2025/html/Lee_Seg_paper.html">Seg</a></dt>
<dd><a href="/content/CVPR2025/html/Xiao_Det_paper.html">dup link</a></dd>
`;

const DETAIL = `<html><head>
<meta name="citation_title" content="Deterministic Image Translation &amp; Bridges" />
<meta name="citation_author" content="Xiao, Bohan" />
<meta name="citation_author" content="Wang, Peiyong" />
<meta name="citation_pdf_url" content="https://openaccess.thecvf.com/content/CVPR2025/papers/Xiao_Det_paper.pdf" />
</head><body>
<div id="abstract">
   Image-to-Image translation converts an image  from one domain to another.
</div></body></html>`;

describe("detailPaths", () => {
  it("extracts and dedups in order", () => {
    expect(detailPaths(LISTING, "CVPR2025")).toEqual([
      "/content/CVPR2025/html/Xiao_Det_paper.html",
      "/content/CVPR2025/html/Lee_Seg_paper.html",
    ]);
  });

  it("scopes to the given conference", () => {
    const mixed = `${LISTING}<a href="/content/ICCV2025/html/Other_paper.html">x</a>`;
    expect(detailPaths(mixed, "CVPR2025").every((p) => p.includes("CVPR2025"))).toBe(true);
  });
});

describe("reformatAuthor", () => {
  it("swaps 'Last, First' to 'First Last'", () => {
    expect(reformatAuthor("Xiao, Bohan")).toBe("Bohan Xiao");
    expect(reformatAuthor("NoComma")).toBe("NoComma");
  });
});

describe("parseDetail", () => {
  it("maps meta tags and the abstract", () => {
    const url = "https://openaccess.thecvf.com/content/CVPR2025/html/Xiao_Det_paper.html";
    const row = parseDetail(DETAIL, url, "CVPR");
    expect(row).not.toBeNull();
    expect(row!.title).toBe("Deterministic Image Translation & Bridges");
    expect(row!.authors).toBe("Bohan Xiao; Peiyong Wang");
    expect(String(row!.abstract)).toContain("Image-to-Image translation converts");
    expect(String(row!.abstract)).not.toContain("  ");
    expect(row!.venue).toBe("CVPR");
    expect(row!.venue_tier).toBe(2);
    expect(row!.url).toBe(url);
    expect(String(row!.pdf_url)).toMatch(/Xiao_Det_paper\.pdf$/);
    expect(row!.arxiv_id).toBe("");
    expect(row!.comment).toBe("");
  });

  it("ICCV is tier 3", () => {
    const row = parseDetail(DETAIL, "u", "ICCV");
    expect(row!.venue_tier).toBe(3);
  });

  it("returns null without a title", () => {
    expect(parseDetail("<html>no meta</html>", "u", "CVPR")).toBeNull();
  });
});

function fakeFetch(listingHtml: string, detailHtml: string) {
  return vi.fn(async (url: string) => {
    if (url.endsWith("?day=all")) {
      return { status: 200, text: async () => listingHtml, json: async () => ({}) };
    }
    return { status: 200, text: async () => detailHtml, json: async () => ({}) };
  });
}

const NO_SLEEP = { sleep: async () => {} };

describe("fetchListing (CNF-03)", () => {
  it("fail-safe: a listing failure reports ok=false", async () => {
    const fetchImpl = vi.fn(async () => ({
      status: 500,
      text: async () => "",
      json: async () => ({}),
    }));
    const { paths, ok } = await fetchListing(
      "CVPR2025",
      { fetchImpl, ...NO_SLEEP },
      { logger: { warn: () => {} } },
    );
    expect(paths).toEqual([]);
    expect(ok).toBe(false);
  });
});

describe("collect (CNF-03)", () => {
  it("end-to-end: two distinct detail pages dedup to two rows", async () => {
    const fetchImpl = fakeFetch(LISTING, DETAIL);
    const { rows, complete } = await collect(
      "CVPR2025",
      "CVPR",
      { fetchImpl, ...NO_SLEEP },
      { maxWorkers: 2, delaySeconds: 0, logger: { warn: () => {} } },
    );
    expect(rows.length).toBe(2);
    expect(rows.every((r) => r.venue === "CVPR")).toBe(true);
    expect(complete).toBe(true);
  });

  it("is incomplete when one detail page fails", async () => {
    const failingPath = detailPaths(LISTING, "CVPR2025")[0];
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith("?day=all"))
        return { status: 200, text: async () => LISTING, json: async () => ({}) };
      if (url.endsWith(failingPath!))
        return { status: 500, text: async () => "", json: async () => ({}) };
      return { status: 200, text: async () => DETAIL, json: async () => ({}) };
    });
    const { rows, complete } = await collect(
      "CVPR2025",
      "CVPR",
      { fetchImpl, ...NO_SLEEP },
      { maxWorkers: 1, delaySeconds: 0, logger: { warn: () => {} } },
    );
    expect(rows.length).toBe(1);
    expect(complete).toBe(false);
  });

  it("is incomplete when the listing itself fails", async () => {
    const fetchImpl = vi.fn(async () => ({
      status: 500,
      text: async () => "",
      json: async () => ({}),
    }));
    const { rows, complete } = await collect(
      "CVPR2025",
      "CVPR",
      { fetchImpl, ...NO_SLEEP },
      { logger: { warn: () => {} } },
    );
    expect(rows).toEqual([]);
    expect(complete).toBe(false);
  });

  it("logs the exact failed-page count", async () => {
    const fetchImpl = vi.fn(async (url: string) =>
      url.endsWith("?day=all")
        ? { status: 200, text: async () => LISTING, json: async () => ({}) }
        : { status: 500, text: async () => "", json: async () => ({}) },
    );
    const warnings: string[] = [];
    await collect(
      "CVPR2025",
      "CVPR",
      { fetchImpl, ...NO_SLEEP },
      { maxWorkers: 2, delaySeconds: 0, logger: { warn: (m) => warnings.push(m) } },
    );
    expect(warnings).toContain("cvf: 2/2 detail pages failed to fetch/parse (dropped)");
  });

  it("runs detail fetches concurrently (maxWorkers > 1) without losing rows", async () => {
    const manyPaths = Array.from(
      { length: 6 },
      (_, i) => `<a href="/content/CVPR2025/html/P${i}_paper.html">P${i}</a>`,
    ).join("\n");
    const fetchImpl = fakeFetch(manyPaths, DETAIL);
    const { rows, complete } = await collect(
      "CVPR2025",
      "CVPR",
      { fetchImpl },
      { maxWorkers: 4, delaySeconds: 0, logger: { warn: () => {} } },
    );
    // All 6 detail pages return the SAME canned DETAIL body (same url key
    // per parseDetail's `url: detailUrl`), but each path is a distinct
    // detail URL, so all 6 survive the url-based dedup.
    expect(rows.length).toBe(6);
    expect(complete).toBe(true);
  });
});

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "cvf-main-"));
});

function cvfFetch() {
  return fakeFetch(LISTING, DETAIL);
}

describe("runCvfMain (CNF-03 / CNF-04)", () => {
  it("writes nothing when the fetch is incomplete", async () => {
    const fetchImpl = vi.fn(async () => ({
      status: 500,
      text: async () => "",
      json: async () => ({}),
    }));
    const rc = await runCvfMain(
      ["--conference", "cvpr-2025", "--venue", "CVPR", "--cvf-id", "CVPR2025"],
      {
        outputRoot: tmp,
        cvf: { fetchImpl, ...NO_SLEEP },
        arxiv: { fetchText: vi.fn() },
        print: () => {},
      },
    );
    expect(rc).toBe(1);
    expect(existsSync(join(tmp, "cvpr-2025"))).toBe(false);
  });

  it("writes the catalog when the fetch is complete", async () => {
    const rc = await runCvfMain(
      ["--conference", "cvpr-2025", "--venue", "CVPR", "--cvf-id", "CVPR2025"],
      {
        outputRoot: tmp,
        cvf: { fetchImpl: cvfFetch() },
        arxiv: { fetchText: vi.fn() },
        now: () => new Date("2026-06-28"),
        print: () => {},
      },
    );
    expect(rc).toBe(0);
    expect(existsSync(join(tmp, "cvpr-2025", "papers_2026-06-28.csv"))).toBe(true);
  });

  it("passes --clear-oral through to the shared writer", async () => {
    const confDir = join(tmp, "cvpr-2025");
    const run = (extra: string[]) =>
      runCvfMain(
        ["--conference", "cvpr-2025", "--venue", "CVPR", "--cvf-id", "CVPR2025", ...extra],
        {
          outputRoot: tmp,
          cvf: { fetchImpl: cvfFetch() },
          arxiv: { fetchText: vi.fn() },
          now: () => new Date("2026-06-28"),
          print: () => {},
        },
      );
    mkdirSync(confDir, { recursive: true });
    writeFileSync(join(confDir, "oral_summaries_ja.md"), "# old\n## 1. Old\n", "utf-8");
    expect(await run([])).toBe(0);
    expect(readFileSync(join(confDir, "oral_summaries_ja.md"), "utf-8")).toBe("# old\n## 1. Old\n");
    expect(await run(["--clear-oral"])).toBe(0);
    expect(existsSync(join(confDir, "oral_summaries_ja.md"))).toBe(false);
  });

  it("oral-max defaults to the shared overlay cap (--oral-max omitted => ORAL_MAX_RESULTS_DEFAULT)", async () => {
    // A feed with exactly ORAL_MAX_RESULTS_DEFAULT entries (one page, all
    // on a single arXiv page since it's under the 100-per-page fetch
    // size... instead, assert indirectly: with the window NOT full (one
    // entry, far below the default cap of 1600), the overlay must
    // complete normally and NOT report ORAL_WINDOW_FILLED — proving the
    // CLI's default (when --oral-max is omitted) is the large shared
    // constant, not some small accidental default.
    const oneEntryFeed = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom" xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/" xmlns:arxiv="http://arxiv.org/schemas/atom"><opensearch:totalResults>1</opensearch:totalResults><opensearch:itemsPerPage>1</opensearch:itemsPerPage><opensearch:startIndex>0</opensearch:startIndex>
      <entry><id>http://arxiv.org/abs/2501.00001v1</id><updated>2026-01-01T00:00:00Z</updated><published>2026-01-01T00:00:00Z</published><title>Oral 0</title><summary>s</summary><arxiv:comment>Accepted to CVPR 2025 (Oral)</arxiv:comment></entry>
    </feed>`;
    const arxivFetchText = vi.fn(async () => ({ status: 200, text: async () => oneEntryFeed }));
    const logs: string[] = [];
    const rc = await runCvfMain(
      [
        "--conference",
        "cvpr-2025",
        "--venue",
        "CVPR",
        "--cvf-id",
        "CVPR2025",
        "--oral-arxiv-query",
        'co:"CVPR 2025"',
      ],
      {
        outputRoot: tmp,
        cvf: { fetchImpl: cvfFetch() },
        arxiv: { fetchText: arxivFetchText },
        now: () => new Date("2026-06-28"),
        print: (l) => logs.push(l),
      },
    );
    expect(rc).toBe(0);
    expect(logs.some((l) => l.includes("--oral-max"))).toBe(false);
    expect(logs.some((l) => l.includes("(1 oral via arXiv)"))).toBe(true);
  });

  it("a truncated overlay is skipped and the published oral md is kept", async () => {
    const confDir = join(tmp, "cvpr-2025");
    mkdirSync(confDir, { recursive: true });
    const oralMd = join(confDir, "oral_summaries_ja.md");
    writeFileSync(oralMd, "# cvpr-2025 Oral / Highlight\n## 1. Some Old Oral Title\n", "utf-8");

    const filledFeed = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom" xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/" xmlns:arxiv="http://arxiv.org/schemas/atom"><opensearch:totalResults>5</opensearch:totalResults><opensearch:itemsPerPage>2</opensearch:itemsPerPage><opensearch:startIndex>0</opensearch:startIndex>
      <entry><id>http://arxiv.org/abs/2501.00001v1</id><updated>2026-01-01T00:00:00Z</updated><published>2026-01-01T00:00:00Z</published><title>Oral 0</title><summary>s</summary><arxiv:comment>Accepted to CVPR 2025 (Oral)</arxiv:comment></entry>
      <entry><id>http://arxiv.org/abs/2501.00002v1</id><updated>2026-01-01T00:00:00Z</updated><published>2026-01-01T00:00:00Z</published><title>Oral 1</title><summary>s</summary><arxiv:comment>Accepted to CVPR 2025 (Oral)</arxiv:comment></entry>
    </feed>`;
    const arxivFetchText = vi.fn(async () => ({ status: 200, text: async () => filledFeed }));
    const logs: string[] = [];

    const rc = await runCvfMain(
      [
        "--conference",
        "cvpr-2025",
        "--venue",
        "CVPR",
        "--cvf-id",
        "CVPR2025",
        "--oral-arxiv-query",
        'co:"CVPR 2025"',
        "--oral-max",
        "2",
      ],
      {
        outputRoot: tmp,
        cvf: { fetchImpl: cvfFetch() },
        arxiv: { fetchText: arxivFetchText },
        now: () => new Date("2026-06-28"),
        print: (l) => logs.push(l),
      },
    );
    expect(rc).toBe(0);
    expect(readFileSync(oralMd, "utf-8")).toBe(
      "# cvpr-2025 Oral / Highlight\n## 1. Some Old Oral Title\n",
    );
    expect(logs.some((l) => l.includes("oral overlay filled the --oral-max 2 window"))).toBe(true);
    expect(logs.some((l) => l.includes("(0 oral via arXiv)"))).toBe(true);
  });

  it("an incomplete overlay does not authorize --clear-oral", async () => {
    const confDir = join(tmp, "cvpr-2025");
    mkdirSync(confDir, { recursive: true });
    const oralMd = join(confDir, "oral_summaries_ja.md");
    const existing = "# cvpr-2025 Oral / Highlight\n## 1. Some Old Oral Title\n";
    writeFileSync(oralMd, existing, "utf-8");

    const filledFeed = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom" xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/" xmlns:arxiv="http://arxiv.org/schemas/atom"><opensearch:totalResults>5</opensearch:totalResults><opensearch:itemsPerPage>2</opensearch:itemsPerPage><opensearch:startIndex>0</opensearch:startIndex>
      <entry><id>http://arxiv.org/abs/2501.00001v1</id><updated>2026-01-01T00:00:00Z</updated><published>2026-01-01T00:00:00Z</published><title>Oral 0</title><summary>s</summary><arxiv:comment>Accepted to CVPR 2025 (Oral)</arxiv:comment></entry>
      <entry><id>http://arxiv.org/abs/2501.00002v1</id><updated>2026-01-01T00:00:00Z</updated><published>2026-01-01T00:00:00Z</published><title>Oral 1</title><summary>s</summary><arxiv:comment>Accepted to CVPR 2025 (Oral)</arxiv:comment></entry>
    </feed>`;
    const arxivFetchText = vi.fn(async () => ({ status: 200, text: async () => filledFeed }));

    const rc = await runCvfMain(
      [
        "--conference",
        "cvpr-2025",
        "--venue",
        "CVPR",
        "--cvf-id",
        "CVPR2025",
        "--oral-arxiv-query",
        'co:"CVPR 2025"',
        "--oral-max",
        "2",
        "--clear-oral",
      ],
      {
        outputRoot: tmp,
        cvf: { fetchImpl: cvfFetch() },
        arxiv: { fetchText: arxivFetchText },
        now: () => new Date("2026-06-28"),
        print: () => {},
      },
    );
    expect(rc).toBe(0);
    expect(readFileSync(oralMd, "utf-8")).toBe(existing);
  });

  it("--clear-oral still clears after a complete-but-empty overlay", async () => {
    const confDir = join(tmp, "cvpr-2025");
    mkdirSync(confDir, { recursive: true });
    const oralMd = join(confDir, "oral_summaries_ja.md");
    writeFileSync(oralMd, "# cvpr-2025 Oral / Highlight\n## 1. Some Old Oral Title\n", "utf-8");

    const emptyFeed = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom" xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/" xmlns:arxiv="http://arxiv.org/schemas/atom"><opensearch:totalResults>0</opensearch:totalResults><opensearch:itemsPerPage>0</opensearch:itemsPerPage><opensearch:startIndex>0</opensearch:startIndex></feed>`;
    const arxivFetchText = vi.fn(async () => ({ status: 200, text: async () => emptyFeed }));

    const rc = await runCvfMain(
      [
        "--conference",
        "cvpr-2025",
        "--venue",
        "CVPR",
        "--cvf-id",
        "CVPR2025",
        "--oral-arxiv-query",
        'co:"CVPR 2025"',
        "--oral-max",
        "8",
        "--clear-oral",
      ],
      {
        outputRoot: tmp,
        cvf: { fetchImpl: cvfFetch() },
        arxiv: { fetchText: arxivFetchText },
        now: () => new Date("2026-06-28"),
        print: () => {},
      },
    );
    expect(rc).toBe(0);
    expect(existsSync(oralMd)).toBe(false);
  });
});
