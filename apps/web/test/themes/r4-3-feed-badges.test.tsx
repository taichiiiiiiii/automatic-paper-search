// @vitest-environment jsdom
//
// R4-3 (design 48 P1-1 / P1-2): the theme page's 「新着」 section (with the
// Atom feed link), the 「コードとモデル」 section and the node-card badges.
// The side-file parsers drop anything unsafe (non-https / foreign-host
// URLs) so a bad file can never inject a link.
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LineageTree } from "../../components/themes/LineageTree";
import {
  ThemeCodeLinksSection,
  ThemeNewPapersSection,
} from "../../components/themes/ThemeFeedSections";
import { ARTIFACT_VERSION } from "../../lib/lineage/core";
import {
  compactCount,
  parseThemeCodeLinks,
  parseThemeNewPapers,
  safeItemUrl,
} from "../../lib/themes-feed";
import type { LineageArtifact } from "../../lib/themes-quality";

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(""),
}));

afterEach(() => cleanup());

const NODES = [
  {
    id: "openalex:W1",
    is_focus: true,
    title: "FlashAttention",
    year: 2022,
    arxiv_id: "2205.14135",
  },
  { id: "openalex:W2", is_focus: false, title: "FlashAttention-2", year: 2023 },
  { id: "openalex:W3", is_focus: false, title: "Sparse Transformers", year: 2019 },
];

const NEW_PAPERS_RAW = {
  schema_version: "theme-new-papers-v1",
  kind: "theme-new-papers",
  generated_at: "2026-10-11T12:00:00Z",
  window: { from: "2026-09-12", to: "2026-10-11", days: 30 },
  min_lineage_cites: 2,
  items: [
    {
      id: "openalex:W9",
      title: "FlashAttention-4 on New GPUs",
      publication_date: "2026-10-02",
      authors: ["A. Author", "B. Author"],
      authors_truncated: true,
      venue: "arXiv",
      url: "https://arxiv.org/abs/2610.00001",
      cites_lineage: ["openalex:W1", "openalex:W2"],
    },
    {
      id: "openalex:W10",
      title: "Injected",
      publication_date: "2026-10-02",
      url: "javascript:alert(1)",
      cites_lineage: ["openalex:W1", "openalex:W2"],
    },
    {
      id: "openalex:W11",
      title: "No lineage citation",
      publication_date: "2026-10-02",
      url: "https://doi.org/10.1/x",
      cites_lineage: [],
    },
  ],
};

const CODE_LINKS_RAW = {
  schema_version: "theme-code-links-v1",
  nodes: {
    "openalex:W1": {
      arxiv_id: "2205.14135",
      code: {
        url: "https://github.com/Dao-AILab/flash-attention",
        stars: 15234,
        source: "paper_repos",
      },
      hf: {
        url: "https://huggingface.co/papers/2205.14135",
        upvotes: 16,
        models: 338,
        datasets: 2,
        spaces: 2268,
      },
    },
    "openalex:W2": {
      arxiv_id: "2307.08691",
      code: { url: "https://evil.example/x/y", stars: 1, source: "huggingface-papers" },
      hf: {
        url: "https://huggingface.co/papers/../../evil",
        upvotes: 1,
        models: 1,
        datasets: 0,
        spaces: 0,
      },
    },
  },
};

describe("side-file parsers", () => {
  it("keeps only safe new-paper items", () => {
    const parsed = parseThemeNewPapers(NEW_PAPERS_RAW);
    expect(parsed?.items.map((i) => i.id)).toEqual(["openalex:W9"]);
    expect(parseThemeNewPapers({ schema_version: "other", items: [] })).toBeNull();
    expect(parseThemeNewPapers(null)).toBeNull();
    expect(safeItemUrl("http://arxiv.org/abs/1")).toBeNull();
    expect(safeItemUrl("https://example.com/x")).toBeNull();
  });

  it("drops code / HF links on unexpected hosts", () => {
    const parsed = parseThemeCodeLinks(CODE_LINKS_RAW);
    expect(Object.keys(parsed ?? {})).toEqual(["openalex:W1"]);
    expect(compactCount(15234)).toBe("15k");
    expect(compactCount(1234)).toBe("1.2k");
    expect(compactCount(999)).toBe("999");
  });
});

describe("新着 section", () => {
  it("lists the items, the cited lineage papers and the Atom feed link", () => {
    render(
      <ThemeNewPapersSection
        slug="flash-attention"
        data={parseThemeNewPapers(NEW_PAPERS_RAW)}
        nodes={NODES}
      />,
    );
    const section = screen.getByRole("region", { name: /新着/ });
    const link = within(section).getByRole("link", { name: "FlashAttention-4 on New GPUs" });
    expect(link.getAttribute("href")).toBe("https://arxiv.org/abs/2610.00001");
    expect(link.getAttribute("rel")).toContain("noopener");
    expect(section.textContent).toContain("系譜の 2 本を引用: FlashAttention、FlashAttention-2");
    expect(section.textContent).toContain("A. Author, B. Author ほか");
    expect(within(section).getByText("Atom フィード").getAttribute("href")).toBe(
      "/themes/flash-attention/feed.xml",
    );
  });

  it("says so when the window has no new paper, and renders nothing without a file", () => {
    const empty = parseThemeNewPapers({ ...NEW_PAPERS_RAW, items: [] });
    const { container, rerender } = render(
      <ThemeNewPapersSection slug="flash-attention" data={empty} nodes={NODES} />,
    );
    expect(container.textContent).toContain("この期間の新着はありません");
    rerender(<ThemeNewPapersSection slug="flash-attention" data={null} nodes={NODES} />);
    expect(container.textContent).toBe("");
  });
});

describe("コードとモデル", () => {
  it("links the repository and the HF paper page with attribution", () => {
    render(<ThemeCodeLinksSection links={parseThemeCodeLinks(CODE_LINKS_RAW)} nodes={NODES} />);
    const section = screen.getByRole("region", { name: "コードとモデル" });
    expect(
      within(section)
        .getByRole("link", { name: /コード（GitHub ★15k）/ })
        .getAttribute("href"),
    ).toBe("https://github.com/Dao-AILab/flash-attention");
    expect(
      within(section)
        .getByRole("link", { name: /HF（モデル 338/ })
        .getAttribute("href"),
    ).toBe("https://huggingface.co/papers/2205.14135");
    expect(section.textContent).toContain("Hugging Face Papers");
    expect(section.textContent).toContain("自動要約は使っていません");
  });

  it("shows コード / HF badges on the node card", () => {
    const artifact: LineageArtifact = {
      schema_version: ARTIFACT_VERSION,
      root: null,
      nodes: NODES,
      // Orphans are hidden by default: connect every node.
      edges: [
        ["openalex:W3", "openalex:W1"],
        ["openalex:W1", "openalex:W2"],
      ].map(([src, dst]) => ({
        src,
        dst,
        relation: "extends",
        confidence: 0.8,
        rationale: "r",
        provenance: {
          producer: { name: "test", version: "1" },
          evidence: {
            source: "semantic_scholar",
            kind: "citation-context",
            sha256: "a".repeat(64),
          },
          classification: {
            method: "s2_context_rule",
            provider: null,
            model: null,
            prompt_version: null,
            schema_version: "relation-classification-v1",
          },
        },
      })),
      clusters: [],
      meta: { generated_at: "2026-10-11T00:00:00Z" },
    } as unknown as LineageArtifact;
    const { container } = render(
      <LineageTree
        artifact={artifact}
        slug="flash-attention"
        themeName="Flash Attention"
        codeLinks={parseThemeCodeLinks(CODE_LINKS_RAW)}
      />,
    );
    const card = container.querySelector('[data-node-id="openalex:W1"]');
    expect(card?.querySelector('[data-badge="code"]')?.textContent).toBe("コード ★15k");
    expect(card?.querySelector('[data-badge="hf"]')?.textContent).toBe("HF");
    expect(container.querySelector('[data-node-id="openalex:W2"] [data-badge]')).toBeNull();
  });
});
