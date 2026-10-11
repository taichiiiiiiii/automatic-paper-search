/** R2-26 (design 51 §4, D1=A): licence-safe catalog abstracts. */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makePaperId } from "@paperpilot/core/identity";
import { beforeEach, describe, expect, it } from "vitest";
import {
  ABSTRACT_REPLACEMENTS_FILENAME,
  type AbstractReplacement,
  applyAbstractPolicy,
  authorOverlap,
  collectionAbstractPolicy,
  judgeArxivMatch,
  normalizeTitle,
  parseAbstractReplacements,
  serializeAbstractReplacements,
  titleScore,
} from "../../src/catalog/abstractReplacements.js";
import {
  buildConference,
  type CatalogRoots,
  loadSummaryWithDetails,
} from "../../src/catalog/buildPages.js";
import { writeDictCsv } from "../../src/catalog/csv.js";
import {
  arxivRecordsFromFeed,
  arxivTitleQuery,
  bestArxivMatch,
  PacedClient,
  pairWithS2,
  resolveAbstractReplacements,
} from "../../src/catalog/resolveAbstractReplacementsCli.js";
import {
  parseSourceLicense,
  type SourceLicense,
} from "../../src/conference/proceedings/sourceLicense.js";

const CVF_URL =
  "https://openaccess.thecvf.com/content/CVPR2025/html/Held_3D_Convex_Splatting_CVPR_2025_paper.html";
const CVF_ID = "Held_3D_Convex_Splatting_CVPR_2025_paper";
const CVF_PAPER_ID = makePaperId("cvf", CVF_ID);
const CVF_TEXT = "CVF abstract text that carries no licence and must never be published.";

const SUMMARY_FIELDS = [
  "title",
  "type",
  "tags",
  "venue",
  "authors",
  "arxiv_url",
  "pdf_url",
  "abstract",
  "arxiv_id",
  "citation_count",
  "venue_tier",
  "github_stars",
  "source",
  "source_id",
] as const;

function writeSummary(dir: string, rows: Array<Record<string, string>>): void {
  mkdirSync(dir, { recursive: true });
  const full = rows.map((r) => ({
    type: "Poster",
    tags: "",
    venue: "",
    authors: "",
    pdf_url: "",
    abstract: "",
    arxiv_id: "",
    citation_count: "",
    venue_tier: "",
    github_stars: "",
    source: "",
    source_id: "",
    ...r,
  }));
  writeFileSync(join(dir, "summary.csv"), writeDictCsv(SUMMARY_FIELDS, full), "utf-8");
}

function cvfRow(): Record<string, string> {
  return {
    title: "3D Convex Splatting: Radiance Field Rendering with 3D Smooth Convexes",
    authors: "Jan Held; Renaud Vandeghen; Abdullah Hamdi",
    arxiv_url: CVF_URL,
    abstract: CVF_TEXT,
  };
}

function writeReplacements(dir: string, rows: AbstractReplacement[]): void {
  writeFileSync(
    join(dir, ABSTRACT_REPLACEMENTS_FILENAME),
    serializeAbstractReplacements("cvpr-2025", "2026-10-11T00:00:00.000Z", rows),
  );
}

describe("title / author matching", () => {
  it("normalises punctuation, case and diacritics", () => {
    expect(normalizeTitle("3D-GSW: Gaussian  Splatting!")).toBe("3d gsw gaussian splatting");
    expect(normalizeTitle("Café Ünïcode")).toBe("cafe unicode");
    expect(
      titleScore(
        "PhD: A ChatGPT-Prompted Visual Hallucination",
        "PhD: A ChatGPT-Prompted Visual hallucination",
      ),
    ).toBe(1);
  });

  it("measures author overlap by surname over the shorter list", () => {
    expect(
      authorOverlap(["Jan Held", "Renaud Vandeghen"], ["J. Held", "R. Vandeghen", "X Y"]),
    ).toBe(1);
    expect(authorOverlap(["Jan Held"], ["Someone Else"])).toBe(0);
    expect(authorOverlap([], ["A B"])).toBe(0);
  });

  it("is conservative: title search needs a near-identical title AND authors", () => {
    const row = { title: "Structure from Collision", authors: ["Takuhiro Kaneko"] };
    expect(
      judgeArxivMatch(
        row,
        { title: "Structure from Collision", authors: ["Takuhiro Kaneko"] },
        "arxiv_title_search",
      ).ok,
    ).toBe(true);
    // same title, different people -> another paper
    expect(
      judgeArxivMatch(
        row,
        { title: "Structure from Collision", authors: ["Ann Other"] },
        "arxiv_title_search",
      ).ok,
    ).toBe(false);
    // retitled arXiv version: only acceptable when S2 linked the two records
    const retitled = {
      title: "Structure from Collision: Learning Object Shape",
      authors: ["Takuhiro Kaneko"],
    };
    expect(judgeArxivMatch(row, retitled, "arxiv_title_search").ok).toBe(false);
    expect(judgeArxivMatch(row, retitled, "s2_external_id").ok).toBe(true);
  });

  it("builds a batched arXiv phrase query and picks the best match", () => {
    expect(arxivTitleQuery(["A: B", "C-D"])).toBe('ti:"a b" OR ti:"c d"');
    const recs = [
      { arxiv_id: "2411.00001", title: "Other", authors: ["Jan Held"], abstract: "x" },
      {
        arxiv_id: "2411.14974",
        title: cvfRow().title as string,
        authors: ["Jan Held", "Abdullah Hamdi"],
        abstract: "y",
      },
    ];
    const m = bestArxivMatch(
      {
        title: cvfRow().title as string,
        authors: ["Jan Held", "Renaud Vandeghen", "Abdullah Hamdi"],
      },
      recs,
      "arxiv_title_search",
    );
    expect(m?.record.arxiv_id).toBe("2411.14974");
  });

  it("pairs catalog rows with S2 records by exact title and authors", () => {
    const rows = [{ paper_id: CVF_PAPER_ID, title: "Foo: Bar", authors: ["A Smith"] }];
    const pairs = pairWithS2(rows, [
      { paperId: "s2a", title: "foo bar", authors: ["Zed Other"], arxivId: null },
      { paperId: "s2b", title: "Foo - Bar", authors: ["Alice Smith"], arxivId: "2401.00001" },
    ]);
    expect(pairs.get(CVF_PAPER_ID)?.paperId).toBe("s2b");
  });
});

describe("applyAbstractPolicy", () => {
  it("keeps licensed native abstracts with their licence", () => {
    expect(applyAbstractPolicy("arxiv", "a", undefined)).toEqual({
      abstract: "a",
      abstract_source: "arxiv",
      abstract_license: "CC0-1.0",
    });
    expect(applyAbstractPolicy("openreview", "o", undefined).abstract_license).toBe("CC0-1.0");
    expect(applyAbstractPolicy("acl_anthology", "c", undefined).abstract_license).toBe("CC-BY-4.0");
  });

  it("never publishes a CVF abstract: arXiv > TLDR > none", () => {
    const base = { paper_id: CVF_PAPER_ID, title: "t" };
    expect(applyAbstractPolicy("cvf", CVF_TEXT, undefined)).toEqual({
      abstract: "",
      abstract_source: "none",
      abstract_license: "",
    });
    expect(
      applyAbstractPolicy("cvf", CVF_TEXT, {
        ...base,
        kind: "arxiv",
        arxiv_id: "2411.14974",
        text: "arXiv abs",
      }),
    ).toEqual({
      abstract: "arXiv abs",
      abstract_source: "arxiv",
      abstract_license: "CC0-1.0",
      arxiv_id: "2411.14974",
    });
    expect(
      applyAbstractPolicy("cvf", CVF_TEXT, { ...base, kind: "s2_tldr", text: "tl;dr" }),
    ).toEqual({
      abstract: "tl;dr",
      abstract_source: "s2_tldr",
      abstract_license: "ODC-BY-1.0",
    });
    expect(applyAbstractPolicy("cvf", CVF_TEXT, { ...base, kind: "none" }).abstract).toBe("");
    // unknown sources fail closed too
    expect(applyAbstractPolicy("somewhere", "x", undefined).abstract_source).toBe("none");
  });

  it("rejects a malformed replacements file", () => {
    expect(() => parseAbstractReplacements({ schema_version: "x", papers: [] })).toThrow();
    expect(() =>
      parseAbstractReplacements({
        schema_version: "abstract-replacements-v1",
        papers: [{ paper_id: CVF_PAPER_ID, kind: "arxiv", arxiv_id: "nope" }],
      }),
    ).toThrow(/arxiv_id/);
  });
});

describe("catalog build with the licence policy", () => {
  let tmp: string;
  let roots: CatalogRoots;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "abs-policy-"));
    roots = { outputRoot: join(tmp, "inputs"), docsRoot: join(tmp, "published") };
  });

  it("withholds CVF abstracts when no replacement is cached (preview and detail)", () => {
    const conf = join(roots.outputRoot, "cvpr-2025");
    writeSummary(conf, [cvfRow()]);
    const { papers, details } = loadSummaryWithDetails(join(conf, "summary.csv"));
    expect(papers[0]?.abstract).toBe("");
    expect(papers[0]?.abstract_source).toBe("none");
    expect(details.get(CVF_PAPER_ID)).toBe("");
  });

  it("publishes the cached arXiv abstract and arXiv id instead", () => {
    const conf = join(roots.outputRoot, "cvpr-2025");
    writeSummary(conf, [cvfRow()]);
    writeReplacements(conf, [
      {
        paper_id: CVF_PAPER_ID,
        title: "t",
        kind: "arxiv",
        arxiv_id: "2411.14974",
        text: "The arXiv abstract.",
      },
    ]);
    const { papers, details } = loadSummaryWithDetails(join(conf, "summary.csv"));
    expect(papers[0]).toMatchObject({
      abstract: "The arXiv abstract.",
      abstract_source: "arxiv",
      abstract_license: "CC0-1.0",
      arxiv_id: "2411.14974",
      source: "cvf",
    });
    expect(details.get(CVF_PAPER_ID)).toBe("The arXiv abstract.");
  });

  it("lets a previously published CVF abstract be withdrawn without --allow-shrink", () => {
    const conf = join(roots.outputRoot, "cvpr-2025");
    writeSummary(conf, [cvfRow()]);
    const out = join(roots.docsRoot, "cvpr-2025");
    mkdirSync(out, { recursive: true });
    writeFileSync(
      join(out, "papers.json"),
      JSON.stringify([
        { paper_id: CVF_PAPER_ID, abstract: CVF_TEXT, authors: ["Jan Held"], type: "Poster" },
      ]),
    );
    buildConference("cvpr-2025", roots);
    const published = readFileSync(join(out, "papers.json"), "utf-8");
    expect(published).not.toContain("carries no licence");
    expect(JSON.parse(published)[0].abstract_source).toBe("none");
  });

  it("still refuses an empty abstract on a licensed source (scrape failure)", () => {
    const conf = join(roots.outputRoot, "iclr-2026");
    writeSummary(conf, [
      { title: "P", arxiv_url: "https://arxiv.org/abs/2404.00001", authors: "A B", abstract: "" },
    ]);
    const out = join(roots.docsRoot, "iclr-2026");
    mkdirSync(out, { recursive: true });
    writeFileSync(
      join(out, "papers.json"),
      JSON.stringify([
        {
          paper_id: makePaperId("arxiv", "2404.00001"),
          abstract: "had text",
          authors: ["A B"],
          type: "Poster",
        },
      ]),
    );
    expect(() => buildConference("iclr-2026", roots)).toThrow(/lost their 'abstract'/);
  });
});

// R3-3: the collector's source_license.json, not the row URL, names the
// abstract's source and licence (PMLR rows carry an OpenReview URL).
const OR_ID = "0COq6zy5kN";
const OR_PAPER_ID = makePaperId("openreview", OR_ID);
const PMLR_PAGE = "https://proceedings.mlr.press/v306/ghiglino26a.html";

function sourceLicense(overrides: Partial<SourceLicense> = {}): SourceLicense {
  return {
    schema_version: "conference-source-license-v1",
    conference: "icml-2026",
    source: "pmlr",
    collection: "PMLR Volume 306",
    collection_url: "https://proceedings.mlr.press/v306/",
    license: "CC-BY-4.0",
    license_url: "https://creativecommons.org/licenses/by/4.0/",
    attribution: "© the authors, PMLR v306, CC BY 4.0",
    abstracts: "included",
    abstract_basis: "PMLR license agreement",
    paper_count: 1,
    landing_urls: { [OR_ID]: PMLR_PAGE },
    ...overrides,
  };
}

function pmlrRow(): Record<string, string> {
  return {
    title: "Do Diffusion Models Dream of Electric Planes?",
    authors: "Aurelien Ghiglino; Daniel Elenius",
    arxiv_url: `https://openreview.net/forum?id=${OR_ID}`,
    abstract: "The PMLR abstract.",
    source: "openreview",
    source_id: OR_ID,
  };
}

describe("R3-3 collection licence from source_license.json", () => {
  let tmp: string;
  let roots: CatalogRoots;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "abs-coll-"));
    roots = { outputRoot: join(tmp, "inputs"), docsRoot: join(tmp, "published") };
  });
  const writeLicense = (dir: string, lic: unknown) =>
    writeFileSync(join(dir, "source_license.json"), JSON.stringify(lic));

  it("labels PMLR rows PMLR / CC BY 4.0 with their PMLR page, not OpenReview / CC0", () => {
    const conf = join(roots.outputRoot, "icml-2026");
    writeSummary(conf, [pmlrRow()]);
    writeLicense(conf, sourceLicense());
    buildConference("icml-2026", roots);
    const [row] = JSON.parse(
      readFileSync(join(roots.docsRoot, "icml-2026", "papers.json"), "utf-8"),
    );
    expect(row).toMatchObject({
      source: "openreview",
      paper_id: OR_PAPER_ID,
      abstract: "The PMLR abstract.",
      abstract_source: "pmlr",
      abstract_license: "CC-BY-4.0",
      abstract_url: PMLR_PAGE,
    });
  });

  it("keeps the URL-inferred label when there is no sidecar (OpenReview ICML editions)", () => {
    const conf = join(roots.outputRoot, "icml-2025");
    writeSummary(conf, [pmlrRow()]);
    const { papers } = loadSummaryWithDetails(join(conf, "summary.csv"));
    expect(papers[0]).toMatchObject({ abstract_source: "openreview", abstract_license: "CC0-1.0" });
    expect(papers[0]).not.toHaveProperty("abstract_url");
  });

  it("ACL sidecar keeps acl_anthology / CC BY 4.0 and adds no abstract_url", () => {
    const conf = join(roots.outputRoot, "acl-2026");
    writeSummary(conf, [
      {
        title: "Good NLP",
        authors: "Ann Lee",
        arxiv_url: "https://aclanthology.org/2026.acl-long.1/",
        abstract: "ACL text.",
      },
    ]);
    writeLicense(
      conf,
      sourceLicense({ conference: "acl-2026", source: "acl_anthology", landing_urls: undefined }),
    );
    const { papers } = loadSummaryWithDetails(join(conf, "summary.csv"));
    expect(papers[0]).toMatchObject({
      abstract_source: "acl_anthology",
      abstract_license: "CC-BY-4.0",
    });
    expect(papers[0]).not.toHaveProperty("abstract_url");
  });

  it("fails closed: a collector without a licence withholds even URL-licensed text", () => {
    const conf = join(roots.outputRoot, "icml-2026");
    writeSummary(conf, [pmlrRow()]);
    writeLicense(conf, sourceLicense({ license: null, license_url: null }));
    const { papers, details } = loadSummaryWithDetails(join(conf, "summary.csv"));
    expect(papers[0]).toMatchObject({
      abstract: "",
      abstract_source: "none",
      abstract_license: "",
    });
    expect(details.get(OR_PAPER_ID)).toBe("");
  });

  it("ignores a sidecar that kept no abstracts (CVF --listing-only)", () => {
    expect(collectionAbstractPolicy(sourceLicense({ abstracts: "omitted" }))).toBeNull();
    expect(collectionAbstractPolicy(null)).toBeNull();
  });

  it("refuses unknown licensed collectors, licence mismatches and the wrong conference", () => {
    expect(() =>
      collectionAbstractPolicy(sourceLicense({ source: "neurips_proceedings" })),
    ).toThrow(/no abstract source/);
    expect(() => collectionAbstractPolicy(sourceLicense({ license: "CC0-1.0" }))).toThrow(
      /expects CC-BY-4.0/,
    );
    const conf = join(roots.outputRoot, "icml-2026");
    writeSummary(conf, [pmlrRow()]);
    writeLicense(conf, sourceLicense({ conference: "icml-2025" }));
    expect(() => loadSummaryWithDetails(join(conf, "summary.csv"))).toThrow(
      /for conference icml-2025/,
    );
  });

  it("rejects a malformed sidecar instead of guessing from the URL", () => {
    expect(() => parseSourceLicense({ ...sourceLicense(), schema_version: "x" })).toThrow(
      /schema_version/,
    );
    expect(() => parseSourceLicense({ ...sourceLicense(), source: "somewhere" })).toThrow(
      /unknown source/,
    );
    expect(() =>
      parseSourceLicense({ ...sourceLicense(), landing_urls: { [OR_ID]: "javascript:x" } }),
    ).toThrow(/https/);
    expect(parseSourceLicense(sourceLicense()).source).toBe("pmlr");
  });

  it("applyAbstractPolicy: collection overrides the URL-inferred source", () => {
    const pmlr = collectionAbstractPolicy(sourceLicense());
    expect(applyAbstractPolicy("openreview", "t", undefined, pmlr)).toEqual({
      abstract: "t",
      abstract_source: "pmlr",
      abstract_license: "CC-BY-4.0",
    });
    // CVF rows stay on the replacement path whatever the sidecar says.
    expect(applyAbstractPolicy("cvf", CVF_TEXT, undefined, pmlr).abstract_source).toBe("none");
  });
});

describe("resolver (offline, mocked HTTP)", () => {
  it("resolves by arXiv title search, then S2 TLDR, then none — and caches", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "abs-resolve-"));
    const conf = join(tmp, "cvpr-2025");
    const second = {
      title: "Unpublished Method for Things",
      authors: "Ann Lee; Bo Chen",
      arxiv_url:
        "https://openaccess.thecvf.com/content/CVPR2025/html/Lee_Unpublished_CVPR_2025_paper.html",
      abstract: CVF_TEXT,
    };
    const third = {
      title: "Nowhere To Be Found",
      authors: "Cy Doe",
      arxiv_url:
        "https://openaccess.thecvf.com/content/CVPR2025/html/Doe_Nowhere_CVPR_2025_paper.html",
      abstract: CVF_TEXT,
    };
    writeSummary(conf, [cvfRow(), second, third]);
    const feed = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/" xmlns:arxiv="http://arxiv.org/schemas/atom">
<opensearch:totalResults>1</opensearch:totalResults><opensearch:startIndex>0</opensearch:startIndex><opensearch:itemsPerPage>100</opensearch:itemsPerPage>
<entry><id>http://arxiv.org/abs/2411.14974v3</id><updated>2024-11-22T00:00:00Z</updated><published>2024-11-22T00:00:00Z</published>
<title>3D Convex Splatting: Radiance Field Rendering with 3D Smooth Convexes</title>
<summary>  Recent advances in radiance field reconstruction.  </summary>
<author><name>Jan Held</name></author><author><name>Abdullah Hamdi</name></author>
<arxiv:primary_category term="cs.CV"/><category term="cs.CV"/>
<link href="http://arxiv.org/abs/2411.14974v3" rel="alternate" type="text/html"/></entry></feed>`;
    const calls: string[] = [];
    const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      calls.push(`${init?.method ?? "GET"} ${u.split("?")[0]}`);
      if (u.startsWith("https://export.arxiv.org")) return new Response(feed, { status: 200 });
      if (u.includes("/paper/search/bulk")) {
        return Response.json({
          total: 1,
          token: null,
          data: [
            {
              paperId: "s2second",
              title: second.title,
              authors: [{ name: "Ann Lee" }],
              externalIds: {},
            },
          ],
        });
      }
      if (u.includes("/paper/batch")) return Response.json([{ tldr: { text: "A TLDR." } }]);
      return new Response("", { status: 404 });
    }) as typeof fetch;
    const res = await resolveAbstractReplacements({
      conference: "cvpr-2025",
      inputsRoot: tmp,
      s2Venue: "Computer Vision and Pattern Recognition",
      year: 2025,
      retryNone: false,
      s2Match: false,
      limit: null,
      client: new PacedClient(fetchFn, async () => {}),
      log: () => {},
      now: () => new Date("2026-10-11T00:00:00Z"),
    });
    expect(res.counts).toEqual({ arxiv: 1, s2_tldr: 1, none: 1 });
    const cached = parseAbstractReplacements(JSON.parse(readFileSync(res.path, "utf-8")));
    expect(cached.get(CVF_PAPER_ID)).toMatchObject({
      kind: "arxiv",
      arxiv_id: "2411.14974",
      text: "Recent advances in radiance field reconstruction.",
    });
    // A second run has nothing left to resolve: no network calls.
    calls.length = 0;
    await resolveAbstractReplacements({
      conference: "cvpr-2025",
      inputsRoot: tmp,
      s2Venue: null,
      year: null,
      retryNone: false,
      s2Match: false,
      limit: null,
      client: new PacedClient(fetchFn, async () => {}),
      log: () => {},
      now: () => new Date("2026-10-11T00:00:00Z"),
    });
    expect(calls).toEqual([]);
  });

  it("parses an unusable arXiv page as null", () => {
    expect(arxivRecordsFromFeed("not xml")).toBeNull();
  });
});
