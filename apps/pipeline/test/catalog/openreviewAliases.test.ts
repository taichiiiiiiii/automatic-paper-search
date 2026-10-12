/** R3-6: OpenReview forum ids of conference_site rows become identity aliases. */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadSummaryWithDetails } from "../../src/catalog/buildPages.js";
import { writeDictCsv } from "../../src/catalog/csv.js";
import { loadOpenreviewIds } from "../../src/catalog/externalIds.js";
import { projectCatalogs } from "../../src/release/derived/identityLite.js";

const HASH = "000eba875068854d5ff003b1fa534cd6";
const URL = `https://proceedings.iclr.cc/paper_files/paper/2025/hash/${HASH}-Abstract-Conference.html`;

function setup(externalIds: unknown | null): string {
  const conf = join(mkdtempSync(join(tmpdir(), "or-alias-")), "iclr-2025");
  mkdirSync(conf, { recursive: true });
  const header = [
    "title",
    "authors",
    "venue",
    "venue_tier",
    "citation_count",
    "github_stars",
    "arxiv_id",
    "abstract",
    "arxiv_url",
    "pdf_url",
    "comment",
    "source",
    "source_id",
  ];
  writeFileSync(
    join(conf, "summary.csv"),
    writeDictCsv(header, [
      {
        title: "A Paper",
        authors: "Ann Lee; Bo Chen",
        venue: "ICLR",
        venue_tier: "1",
        citation_count: "0",
        github_stars: "0",
        arxiv_id: "",
        abstract: "",
        arxiv_url: URL,
        pdf_url: "",
        comment: "",
        source: "conference_site",
        source_id: `iclr-2025-hash-${HASH}`,
      },
    ]),
    "utf-8",
  );
  if (externalIds !== null) {
    writeFileSync(join(conf, "external_ids.json"), JSON.stringify(externalIds), "utf-8");
  }
  return join(conf, "summary.csv");
}

function ext(papers: unknown[]): unknown {
  return { schema_version: "conference-external-ids-v1", papers };
}

describe("openreview_id on catalog rows", () => {
  it("is added from external_ids.json and keeps the paper id and native source", () => {
    const csv = setup(ext([]));
    const base = loadSummaryWithDetails(csv).papers[0];
    expect(base?.openreview_id).toBeUndefined();
    const id = base?.paper_id as string;
    const withIds = loadSummaryWithDetails(
      setup(ext([{ paper_id: id, dblp_key: "conf/iclr/X25", openreview_id: "AbC_123-x" }])),
    ).papers[0];
    expect(withIds).toMatchObject({
      paper_id: id,
      source: "conference_site",
      openreview_id: "AbC_123-x",
    });
  });

  it("is absent without a file, and a bad file fails closed", () => {
    expect(loadSummaryWithDetails(setup(null)).papers[0]?.openreview_id).toBeUndefined();
    expect(() => loadOpenreviewIds(setup({ schema_version: "x", papers: [] }))).toThrow(/schema/);
    expect(() =>
      loadOpenreviewIds(
        setup(ext([{ paper_id: "a".repeat(40), dblp_key: "k", openreview_id: "bad id!" }])),
      ),
    ).toThrow(/invalid OpenReview/);
    expect(() =>
      loadOpenreviewIds(
        setup(
          ext([
            { paper_id: "a".repeat(40), dblp_key: "k1", openreview_id: "same" },
            { paper_id: "b".repeat(40), dblp_key: "k2", openreview_id: "same" },
          ]),
        ),
      ),
    ).toThrow(/claimed by two/);
    // a link without an OpenReview id is skipped, not an error
    expect(loadOpenreviewIds(setup(ext([{ paper_id: "a".repeat(40), dblp_key: "k" }]))).size).toBe(
      0,
    );
  });
});

describe("identity aliases from openreview_id", () => {
  function docsWith(rows: unknown[]): string {
    const docs = mkdtempSync(join(tmpdir(), "or-alias-docs-"));
    mkdirSync(join(docs, "iclr-2025"));
    writeFileSync(join(docs, "iclr-2025", "papers.json"), JSON.stringify(rows), "utf-8");
    return docs;
  }

  it("adds an openreview alias to the conference_site paper id and a conflict is reported", () => {
    const row = (title: string, h: string, or?: unknown) => ({
      title,
      arxiv_url: `https://proceedings.iclr.cc/paper_files/paper/2025/hash/${h}-Abstract-Conference.html`,
      ...(or === undefined ? {} : { openreview_id: or }),
    });
    const h1 = "a".repeat(32);
    const h2 = "b".repeat(32);
    const ok = projectCatalogs(
      docsWith([row("A", h1, "forumA"), row("B", h2)]),
      ["iclr-2025"],
      "2026-10-12T00:00:00Z",
    );
    expect(ok.coverage.valid).toBe(true);
    const a = ok.catalogs["iclr-2025"]?.[0] as Record<string, unknown>;
    expect(a.source).toBe("conference_site");
    expect(ok.aliases).toContainEqual(["openreview", "forumA", a.paper_id]);
    expect(ok.aliases.filter((x) => x[0] === "openreview")).toHaveLength(1);

    const dup = projectCatalogs(
      docsWith([row("A", h1, "forumA"), row("B", h2, "forumA")]),
      ["iclr-2025"],
      "2026-10-12T00:00:00Z",
    );
    expect(dup.coverage.valid).toBe(false);
    expect(dup.coverage.alias_conflicts).toBe(1);

    const bad = projectCatalogs(
      docsWith([row("A", h1, "not a forum id")]),
      ["iclr-2025"],
      "2026-10-12T00:00:00Z",
    );
    expect(bad.coverage.valid).toBe(false);
  });

  it("joins an ICLR 2025 conference_site row to a native OpenReview row of another edition", () => {
    const docs = docsWith([
      {
        title: "A",
        arxiv_url: `https://proceedings.iclr.cc/paper_files/paper/2025/hash/${"c".repeat(32)}-Abstract-Conference.html`,
        openreview_id: "shared1",
      },
    ]);
    mkdirSync(join(docs, "iclr-2026"));
    writeFileSync(
      join(docs, "iclr-2026", "papers.json"),
      JSON.stringify([{ title: "A", arxiv_url: "https://openreview.net/forum?id=shared1" }]),
      "utf-8",
    );
    const r = projectCatalogs(docs, ["iclr-2025", "iclr-2026"], "2026-10-12T00:00:00Z");
    // same forum id, two paper ids (the conference_site hash vs the native one): reported, not merged
    expect(r.coverage.alias_conflicts).toBe(1);
  });
});
