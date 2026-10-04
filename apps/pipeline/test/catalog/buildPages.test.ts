/** Ported from paperpilot/tests/test_build_pages.py (CAT-01..24, docs/migration/safety-contracts.md). */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  buildConference,
  buildPagesMain,
  type CatalogRoots,
  CatalogShrinkError,
  containedPath,
  loadSummaryWithDetails,
  parseBuildPagesArgs,
  prepareConference,
  publishConference,
  writeDetailShards,
  writeIndex,
} from "../../src/catalog/buildPages.js";
import { writeDictCsv } from "../../src/catalog/csv.js";
import { IdentityError } from "../../src/catalog/identity.js";

let tmpDir: string;
let roots: CatalogRoots;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "build-pages-test-"));
  roots = { outputRoot: join(tmpDir, "paperpilot", "output"), docsRoot: join(tmpDir, "docs") };
});

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

interface SummaryRowInput {
  title: string;
  type?: "Oral" | "Poster";
  tags?: string;
  venue?: string;
  authors?: string;
  arxiv_url: string;
  pdf_url?: string;
  abstract?: string;
  arxiv_id?: string;
  citation_count?: string;
  venue_tier?: string;
  github_stars?: string;
  source?: string;
  source_id?: string;
}

function writeSummaryCsv(conferenceDir: string, rows: SummaryRowInput[]): void {
  mkdirSync(conferenceDir, { recursive: true });
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
  writeFileSync(join(conferenceDir, "summary.csv"), writeDictCsv(SUMMARY_FIELDS, full), "utf-8");
}

function arxivRow(n: number, overrides: Partial<SummaryRowInput> = {}): SummaryRowInput {
  return {
    title: `Paper ${n}`,
    arxiv_url: `https://arxiv.org/abs/2404.${String(n).padStart(5, "0")}`,
    authors: "Alice; Bob",
    abstract: `Abstract for paper ${n}.`,
    ...overrides,
  };
}

describe("loadSummaryWithDetails", () => {
  it("splits tags and authors, previews the abstract, and derives a stable paper_id", () => {
    const conf = join(roots.outputRoot, "iclr-2026");
    writeSummaryCsv(conf, [
      arxivRow(1, { tags: "LLM VLM", authors: "Alice, Bob; Carol", abstract: "x".repeat(400) }),
    ]);
    const { papers } = loadSummaryWithDetails(join(conf, "summary.csv"));
    expect(papers[0]?.tags).toEqual(["LLM", "VLM"]);
    expect(papers[0]?.authors).toEqual(["Alice", "Bob", "Carol"]);
    expect(papers[0]?.abstract.length).toBeLessThan(400);
    expect(papers[0]?.abstract.endsWith("…")).toBe(true);
    expect(papers[0]?.paper_id).toMatch(/^[0-9a-f]{40}$/);
  });

  it("parses numeric fields, treating blank as null", () => {
    const conf = join(roots.outputRoot, "iclr-2026");
    writeSummaryCsv(conf, [
      arxivRow(1, { citation_count: "17.0", venue_tier: "", github_stars: "42" }),
    ]);
    const { papers } = loadSummaryWithDetails(join(conf, "summary.csv"));
    expect(papers[0]?.citation_count).toBe(17);
    expect(papers[0]?.venue_tier).toBeNull();
    expect(papers[0]?.github_stars).toBe(42);
  });

  it("throws IdentityError on conflicting abstracts for the same paper_id", () => {
    const conf = join(roots.outputRoot, "iclr-2026");
    const url = "https://arxiv.org/abs/2404.00001";
    writeSummaryCsv(conf, [
      { title: "A", arxiv_url: url, abstract: "First abstract" },
      { title: "A-dup", arxiv_url: url, abstract: "Different abstract" },
    ]);
    expect(() => loadSummaryWithDetails(join(conf, "summary.csv"))).toThrow(IdentityError);
  });
});

describe("prepareConference / buildConference — CAT-01..05 shrink gate", () => {
  it("refuses to publish a catalog with fewer rows than published (CAT-01)", () => {
    const conf = join(roots.outputRoot, "sample-conf");
    mkdirSync(join(roots.docsRoot, "sample-conf"), { recursive: true });
    writeFileSync(
      join(roots.docsRoot, "sample-conf", "papers.json"),
      JSON.stringify([{ paper_id: "a".repeat(40) }, { paper_id: "b".repeat(40) }]),
    );
    writeSummaryCsv(conf, [arxivRow(1)]);
    expect(() => buildConference("sample-conf", roots)).toThrow(CatalogShrinkError);
    expect(() => buildConference("sample-conf", roots)).toThrow(/has 2;/);
  });

  it("refuses when published Oral labels would vanish (CAT-02)", () => {
    const conf = join(roots.outputRoot, "sample-conf");
    mkdirSync(join(roots.docsRoot, "sample-conf"), { recursive: true });
    writeFileSync(
      join(roots.docsRoot, "sample-conf", "papers.json"),
      JSON.stringify([{ paper_id: "a".repeat(40), type: "Oral" }]),
    );
    writeSummaryCsv(conf, [arxivRow(1, { type: "Poster" })]);
    expect(() => buildConference("sample-conf", roots)).toThrow(/Oral/);
  });

  it("refuses when a published paper_id is missing, even at equal row count (CAT-03)", () => {
    const confName = "sample-conf";
    const conf = join(roots.outputRoot, confName);
    const docsConf = join(roots.docsRoot, confName);
    mkdirSync(docsConf, { recursive: true });
    // Publish once from a real build, to get a real paper_id.
    writeSummaryCsv(conf, [arxivRow(1)]);
    buildConference(confName, roots);
    // Now rebuild from a DIFFERENT paper at the same row count.
    writeSummaryCsv(conf, [arxivRow(2)]);
    expect(() => buildConference(confName, roots)).toThrow(/missing/);
  });

  it("refuses when a published non-empty abstract/authors field comes back empty (CAT-04)", () => {
    const confName = "sample-conf";
    const conf = join(roots.outputRoot, confName);
    writeSummaryCsv(conf, [arxivRow(1, { abstract: "Has content" })]);
    buildConference(confName, roots);
    writeSummaryCsv(conf, [arxivRow(1, { abstract: "" })]);
    expect(() => buildConference(confName, roots)).toThrow(/abstract/);
  });

  it("refuses to overwrite an uninspectable published papers.json (CAT-05)", () => {
    const confName = "sample-conf";
    const conf = join(roots.outputRoot, confName);
    const docsConf = join(roots.docsRoot, confName);
    mkdirSync(docsConf, { recursive: true });
    writeFileSync(join(docsConf, "papers.json"), "{not valid json");
    writeSummaryCsv(conf, [arxivRow(1)]);
    expect(() => buildConference(confName, roots)).toThrow(/cannot be inspected/);
  });

  it("publishes a catalog of equal size without complaint", () => {
    const confName = "sample-conf";
    const conf = join(roots.outputRoot, confName);
    writeSummaryCsv(conf, [arxivRow(1)]);
    buildConference(confName, roots);
    writeSummaryCsv(conf, [arxivRow(1, { abstract: "Updated abstract text." })]);
    expect(() => buildConference(confName, roots)).not.toThrow();
  });
});

describe("--allow-shrink / --allow-shrink-for (CAT-08..10)", () => {
  it("publishes a shrunk catalog only with allowShrink", () => {
    const confName = "sample-conf";
    const conf = join(roots.outputRoot, confName);
    writeSummaryCsv(conf, [arxivRow(1), arxivRow(2)]);
    buildConference(confName, roots);
    writeSummaryCsv(conf, [arxivRow(1)]);
    expect(() => buildConference(confName, roots)).toThrow(CatalogShrinkError);
    expect(() => buildConference(confName, roots, { allowShrink: true })).not.toThrow();
  });

  it("CAT-09: a full build acknowledging only one of two shrinking conferences still refuses", () => {
    const confA = "conf-a";
    const confB = "conf-b";
    writeSummaryCsv(join(roots.outputRoot, confA), [arxivRow(1), arxivRow(2)]);
    writeSummaryCsv(join(roots.outputRoot, confB), [arxivRow(3), arxivRow(4)]);
    buildPagesMain(parseBuildPagesArgs([]), roots);
    // Both shrink.
    writeSummaryCsv(join(roots.outputRoot, confA), [arxivRow(1)]);
    writeSummaryCsv(join(roots.outputRoot, confB), [arxivRow(3)]);
    const beforeA = readFileSync(join(roots.docsRoot, confA, "papers.json"), "utf-8");
    const beforeB = readFileSync(join(roots.docsRoot, confB, "papers.json"), "utf-8");

    const onlyA = buildPagesMain(parseBuildPagesArgs(["--allow-shrink-for", confA]), roots);
    expect(onlyA.exitCode).toBe(1);
    expect(readFileSync(join(roots.docsRoot, confA, "papers.json"), "utf-8")).toBe(beforeA);
    expect(readFileSync(join(roots.docsRoot, confB, "papers.json"), "utf-8")).toBe(beforeB);

    // Acknowledging both releases the gate for the whole run.
    const both = buildPagesMain(
      parseBuildPagesArgs(["--allow-shrink-for", confA, "--allow-shrink-for", confB]),
      roots,
    );
    expect(both.exitCode).toBe(0);
    expect(
      JSON.parse(readFileSync(join(roots.docsRoot, confA, "papers.json"), "utf-8")),
    ).toHaveLength(1);
  });

  it("CAT-10: an --allow-shrink-for value that isn't a slug aborts the run (typo guard)", () => {
    writeSummaryCsv(join(roots.outputRoot, "iclr-2026"), [arxivRow(1)]);
    const result = buildPagesMain(parseBuildPagesArgs(["--allow-shrink-for", "iclr2026!"]), roots);
    expect(result.exitCode).toBe(1);
  });

  it("CAT-10: a scoped build's --allow-shrink-for naming a DIFFERENT conference acknowledges nothing", () => {
    writeSummaryCsv(join(roots.outputRoot, "conf-a"), [arxivRow(1)]);
    writeSummaryCsv(join(roots.outputRoot, "conf-b"), [arxivRow(2)]);
    const result = buildPagesMain(
      parseBuildPagesArgs(["--conference", "conf-a", "--allow-shrink-for", "conf-b"]),
      roots,
    );
    expect(result.exitCode).toBe(1);
  });
});

describe("reserved slugs and containment (CAT-14, CAT-15)", () => {
  it("rejects the reserved conference slug before any filesystem access", () => {
    expect(() => prepareConference("daily", roots)).toThrow();
    expect(() => prepareConference("assets", roots)).toThrow();
  });

  it("rejects a path-escaping conference argument", () => {
    expect(() => prepareConference("../../etc", roots)).toThrow();
  });

  it("CAT-14 inverse: 'cvpr-2026' is reserved as a docs/ path only for scaffold's template copy, not for build_pages — it stays buildable", () => {
    // No summary.csv exists for it in this isolated tmp root, so the slug
    // validation passing is what's under test: the build gets as far as
    // "nothing to build" (null), not a reserved-path ValueError.
    expect(prepareConference("cvpr-2026", roots)).toBeNull();
  });

  it("rejects a symlink that escapes the configured root (CAT-15)", () => {
    const root = join(tmpDir, "root");
    const outside = join(tmpDir, "outside");
    mkdirSync(root, { recursive: true });
    mkdirSync(outside, { recursive: true });
    symlinkSync(outside, join(root, "safe-conf"), "dir");

    expect(() => containedPath(root, "safe-conf", "paper-links.html")).toThrow(
      /escapes configured root/,
    );
  });
});

describe("two-phase all-or-nothing publish (CAT-11, CAT-13)", () => {
  it("writes nothing when a later conference in a multi-conference build fails", () => {
    const confA = "conf-a";
    const confB = "conf-b";
    writeSummaryCsv(join(roots.outputRoot, confA), [arxivRow(1)]);
    writeSummaryCsv(join(roots.outputRoot, confB), [arxivRow(2)]);
    // Pre-publish confA so a later build without allow-shrink that DROPS a
    // row in confB fails the whole run.
    buildConference(confA, roots);
    buildConference(confB, roots);
    const beforeA = readFileSync(join(roots.docsRoot, confA, "papers.json"), "utf-8");

    // Grow confA's own input so this run's in-memory prepared bytes for
    // confA would legitimately differ from what's published (passes
    // confA's OWN shrink gate) — otherwise "unchanged" could trivially be
    // "rewritten with identical bytes" rather than "never written".
    writeSummaryCsv(join(roots.outputRoot, confA), [arxivRow(1), arxivRow(3)]);
    // Mutate confB's committed papers.json to simulate the published site
    // having more rows than the next full build will produce for confB,
    // so phase 1 refuses the whole run before phase 2 ever publishes.
    writeFileSync(
      join(roots.docsRoot, confB, "papers.json"),
      JSON.stringify([{ paper_id: "a".repeat(40) }, { paper_id: "b".repeat(40) }]),
    );

    const result = buildPagesMain(parseBuildPagesArgs([]), roots);
    expect(result.exitCode).toBe(1);
    // confA's already-published catalog must be untouched by the refused
    // run — still the OLD 1-row bytes, not the 2-row build this run
    // prepared in memory for it.
    const afterA = readFileSync(join(roots.docsRoot, confA, "papers.json"), "utf-8");
    expect(afterA).toBe(beforeA);
    expect(JSON.parse(afterA)).toHaveLength(1);
  });

  it("a scoped (--conference) build does not touch conferences.json or shards (CAT-13)", () => {
    const confName = "sample-conf";
    writeSummaryCsv(join(roots.outputRoot, confName), [arxivRow(1)]);
    mkdirSync(roots.docsRoot, { recursive: true });
    writeFileSync(join(roots.docsRoot, "conferences.json"), "[]");
    buildConference(confName, roots);
    expect(readFileSync(join(roots.docsRoot, "conferences.json"), "utf-8")).toBe("[]");
    expect(existsSync(join(roots.docsRoot, "paper-details-v1"))).toBe(false);
  });
});

describe("indexed-but-unrebuildable conference refusal (CAT-06, CAT-07)", () => {
  it("refuses a full build that would drop a conference the published index still lists", () => {
    mkdirSync(roots.docsRoot, { recursive: true });
    writeFileSync(
      join(roots.docsRoot, "conferences.json"),
      JSON.stringify([{ name: "ghost-conf" }]),
    );
    writeSummaryCsv(join(roots.outputRoot, "sample-conf"), [arxivRow(1)]);
    const result = buildPagesMain(parseBuildPagesArgs([]), roots);
    expect(result.exitCode).toBe(1);
  });

  it("refuses a full build with an uninspectable published index", () => {
    mkdirSync(roots.docsRoot, { recursive: true });
    writeFileSync(join(roots.docsRoot, "conferences.json"), "{not json");
    writeSummaryCsv(join(roots.outputRoot, "sample-conf"), [arxivRow(1)]);
    const result = buildPagesMain(parseBuildPagesArgs([]), roots);
    expect(result.exitCode).toBe(1);
  });
});

describe("CAT-12: scoped build with no summary.csv fails, not skips", () => {
  it("exits 1 for a named conference that has no summary.csv", () => {
    const result = buildPagesMain(parseBuildPagesArgs(["--conference", "ghost-conf"]), roots);
    expect(result.exitCode).toBe(1);
  });
});

describe("write_index / write_detail_shards (CAT-20, CAT-21)", () => {
  it("writes all 256 shards, sorted ascending, with a trailing newline", () => {
    const details = new Map<string, string>([
      ["ff".padEnd(40, "0"), "Last shard abstract"],
      ["00".padEnd(40, "0"), "First shard abstract"],
    ]);
    const outputs = writeDetailShards(roots.docsRoot, details);
    expect(outputs).toHaveLength(256);
    const zero = JSON.parse(
      readFileSync(join(roots.docsRoot, "paper-details-v1", "00.json"), "utf-8"),
    );
    expect(zero.schema_version).toBe("paper-details-v1");
    expect(zero.papers).toEqual([["00".padEnd(40, "0"), "First shard abstract"]]);
    const raw = readFileSync(join(roots.docsRoot, "paper-details-v1", "00.json"), "utf-8");
    expect(raw.endsWith("\n")).toBe(true);
    const empty = JSON.parse(
      readFileSync(join(roots.docsRoot, "paper-details-v1", "7a.json"), "utf-8"),
    );
    expect(empty.papers).toEqual([]);
  });

  it("throws IdentityError on a malformed paper_id", () => {
    expect(() => writeDetailShards(roots.docsRoot, new Map([["not-hex", "x"]]))).toThrow(
      IdentityError,
    );
  });

  it("writes conferences.json with indent=2 and NO trailing newline", () => {
    writeIndex(roots.docsRoot, [
      { name: "a", papers: 1, types: {}, top_tags: [], generated: null },
    ]);
    const raw = readFileSync(join(roots.docsRoot, "conferences.json"), "utf-8");
    expect(raw.endsWith("\n")).toBe(false);
    expect(raw).toContain("\n  ");
  });
});

describe("rebuild-unchanged byte identity (CAT-24)", () => {
  it("rebuilding with the same input reproduces byte-identical papers.json", () => {
    const confName = "sample-conf";
    writeSummaryCsv(join(roots.outputRoot, confName), [arxivRow(1), arxivRow(2, { type: "Oral" })]);
    const first = buildConference(confName, roots);
    expect(first).not.toBeNull();
    const before = readFileSync(join(roots.docsRoot, confName, "papers.json"), "utf-8");
    buildConference(confName, roots);
    const after = readFileSync(join(roots.docsRoot, confName, "papers.json"), "utf-8");
    expect(after).toBe(before);
    expect(before.endsWith("\n")).toBe(true);
  });
});

describe("prepareConference / publishConference split", () => {
  it("prepare does not write; publish writes exactly the prepared bytes", () => {
    const confName = "sample-conf";
    writeSummaryCsv(join(roots.outputRoot, confName), [arxivRow(1)]);
    const prepared = prepareConference(confName, roots);
    expect(prepared).not.toBeNull();
    expect(existsSync(prepared!.outJson)).toBe(false);
    publishConference(prepared!);
    expect(readFileSync(prepared!.outJson, "utf-8")).toBe(`${prepared!.papersJson}\n`);
  });
});
