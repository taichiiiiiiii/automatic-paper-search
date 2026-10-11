// R2-26 (design 51 §4, D1=A): source links and abstract attribution of catalog rows.
import { describe, expect, it } from "vitest";
import {
  abstractAttribution,
  catalogLinks,
  WITHHELD_ABSTRACT_TEXT,
} from "../../lib/catalog-attribution";
import type { CatalogPaper } from "../../lib/catalog-core";

function paper(overrides: Partial<CatalogPaper>): CatalogPaper {
  return {
    paper_id: "a".repeat(40),
    title: "A Paper",
    authors: ["Ann Lee", "Bo Chen", "Cy Doe"],
    tags: [],
    abstract: "Text.",
    type: "Poster",
    ...overrides,
  };
}

describe("catalogLinks", () => {
  it("labels the paper page with its real source, never 'arXiv' for CVF/ACL/OpenReview", () => {
    const cvf = catalogLinks(
      paper({
        source: "cvf",
        arxiv_url: "https://openaccess.thecvf.com/content/CVPR2025/html/x.html",
        pdf_url: "https://openaccess.thecvf.com/content/CVPR2025/papers/x.pdf",
      }),
    );
    expect(cvf.map((l) => l.label)).toEqual(["CVF Open Access", "PDF"]);
    expect(
      catalogLinks(
        paper({ source: "acl_anthology", arxiv_url: "https://aclanthology.org/2025.acl-long.1/" }),
      )[0]?.label,
    ).toBe("ACL Anthology");
    expect(
      catalogLinks(
        paper({ source: "openreview", arxiv_url: "https://openreview.net/forum?id=abc" }),
      )[0]?.label,
    ).toBe("OpenReview");
    expect(
      catalogLinks(
        paper({
          source: "arxiv",
          arxiv_url: "https://arxiv.org/abs/2404.00001",
          arxiv_id: "2404.00001",
        }),
      ),
    ).toEqual([{ label: "arXiv", url: "https://arxiv.org/abs/2404.00001" }]);
  });

  it("adds a separate arXiv link for a matched arXiv version", () => {
    const links = catalogLinks(
      paper({
        source: "cvf",
        arxiv_url: "https://openaccess.thecvf.com/x.html",
        arxiv_id: "2411.14974",
      }),
    );
    expect(links).toEqual([
      { label: "CVF Open Access", url: "https://openaccess.thecvf.com/x.html" },
      { label: "arXiv", url: "https://arxiv.org/abs/2411.14974" },
    ]);
  });

  it("R3-3: links a PMLR abstract's PMLR page (https proceedings.mlr.press only)", () => {
    const row = {
      source: "openreview",
      abstract_source: "pmlr",
      arxiv_url: "https://openreview.net/forum?id=abc",
      pdf_url: "https://raw.githubusercontent.com/mlresearch/v306/main/assets/lee26a/lee26a.pdf",
    };
    expect(
      catalogLinks(
        paper({ ...row, abstract_url: "https://proceedings.mlr.press/v306/lee26a.html" }),
      ),
    ).toEqual([
      { label: "OpenReview", url: "https://openreview.net/forum?id=abc" },
      { label: "PMLR", url: "https://proceedings.mlr.press/v306/lee26a.html" },
      { label: "PDF", url: row.pdf_url },
    ]);
    expect(
      catalogLinks(paper({ ...row, abstract_url: "javascript:alert(1)" })).map((l) => l.label),
    ).toEqual(["OpenReview", "PDF"]);
    expect(
      catalogLinks(
        paper({
          ...row,
          abstract_source: "openreview",
          abstract_url: "https://proceedings.mlr.press/v306/x.html",
        }),
      ).map((l) => l.label),
    ).toEqual(["OpenReview", "PDF"]);
  });

  it("falls back by URL host for legacy rows without `source`", () => {
    expect(catalogLinks(paper({ arxiv_url: "https://arxiv.org/abs/2404.00001" }))[0]?.label).toBe(
      "arXiv",
    );
    expect(catalogLinks(paper({ arxiv_url: "https://openreview.net/forum?id=x" }))[0]?.label).toBe(
      "論文ページ",
    );
  });
});

describe("abstractAttribution", () => {
  it("labels arXiv / OpenReview abstracts CC0", () => {
    expect(abstractAttribution(paper({ source: "arxiv", abstract_source: "arxiv" }))).toMatchObject(
      {
        withheld: false,
        kind: "要旨",
        source: "出典: arXiv",
        licenseLabel: "CC0 1.0",
        note: "",
      },
    );
    expect(
      abstractAttribution(paper({ source: "openreview", abstract_source: "openreview" })),
    ).toMatchObject({
      source: "出典: OpenReview",
      licenseLabel: "CC0 1.0",
    });
  });

  it("says a CVF row shows its arXiv version's abstract", () => {
    expect(abstractAttribution(paper({ source: "cvf", abstract_source: "arxiv" }))).toMatchObject({
      source: "出典: arXiv",
      note: "（同じ論文の arXiv 版の要旨）",
    });
  });

  it("attributes ACL Anthology abstracts per CC BY 4.0 (authors, title, licence, abridged)", () => {
    const a = abstractAttribution(
      paper({ source: "acl_anthology", abstract_source: "acl_anthology", title: "Good NLP" }),
    );
    expect(a).toMatchObject({
      withheld: false,
      source: "出典: Lee et al., “Good NLP”, ACL Anthology",
      licenseLabel: "CC BY 4.0",
      licenseUrl: "https://creativecommons.org/licenses/by/4.0/",
      note: "（一覧では冒頭のみ表示）",
    });
  });

  it("R3-3: attributes PMLR abstracts per CC BY 4.0 (authors, title, PMLR volume)", () => {
    const a = abstractAttribution(
      paper({
        source: "openreview",
        abstract_source: "pmlr",
        abstract_license: "CC-BY-4.0",
        abstract_url: "https://proceedings.mlr.press/v306/lee26a.html",
        title: "Good ML",
      }),
    );
    expect(a).toMatchObject({
      withheld: false,
      kind: "要旨",
      source: "出典: Lee et al., “Good ML”, PMLR v306",
      licenseLabel: "CC BY 4.0",
      licenseUrl: "https://creativecommons.org/licenses/by/4.0/",
    });
    // Never the OpenReview / CC0 label the row URL alone would suggest.
    expect(JSON.stringify(a)).not.toMatch(/OpenReview|CC0/);
    // Without a PMLR page the credit still names PMLR.
    expect(
      abstractAttribution(paper({ source: "openreview", abstract_source: "pmlr", title: "T" })),
    ).toMatchObject({ source: "出典: Lee et al., “T”, PMLR" });
  });

  it("marks a Semantic Scholar TLDR as a machine summary under ODC-BY", () => {
    expect(abstractAttribution(paper({ source: "cvf", abstract_source: "s2_tldr" }))).toMatchObject(
      {
        kind: "要約",
        licenseLabel: "ODC-BY 1.0",
        note: "（著者による要旨ではありません）",
      },
    );
  });

  it("explains a withheld abstract and leaves legacy rows unlabelled", () => {
    expect(
      abstractAttribution(paper({ source: "cvf", abstract_source: "none", abstract: "" })),
    ).toEqual({
      withheld: true,
      text: WITHHELD_ABSTRACT_TEXT,
    });
    expect(abstractAttribution(paper({}))).toBeNull();
  });
});
