// @vitest-environment jsdom
/**
 * Interaction tests for the catalog's presentational components touched by
 * the UX audit (design doc 53 「学会の論文一覧」): CatalogFilters,
 * CatalogHero, CatalogPaperCard. Queried by role + accessible name, the
 * same handles the Playwright E2E suite (apps/web/e2e) uses.
 */
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import styles from "../../components/catalog/catalog.module.css";
import { CatalogFilters } from "../../components/catalog/catalog-filters";
import { CatalogHero } from "../../components/catalog/catalog-hero";
import { CatalogPaperCard } from "../../components/catalog/catalog-paper-card";
import type { CatalogCopy } from "../../lib/catalog-copy";
import type { CatalogPaper } from "../../lib/catalog-core";
import type { ThemePosition } from "../../lib/lineage/theme-position";

afterEach(() => {
  cleanup();
});

const COPY: CatalogCopy = {
  display: "Test Conf",
  description: "desc",
  tagline: "tagline",
  lede: "the lede",
  source: "source",
};

function filtersProps(overrides: Partial<Parameters<typeof CatalogFilters>[0]> = {}) {
  return {
    search: "",
    onSearchChange: vi.fn(),
    typeChips: [
      { value: "all" as const, label: "すべて", count: 3 },
      { value: "Oral" as const, label: "Oral", count: 1 },
      { value: "Poster" as const, label: "Poster", count: 2 },
    ],
    activeType: "all" as const,
    onTypeChange: vi.fn(),
    tagHead: [{ tag: "LLM", count: 1200 }],
    tagTail: [
      { tag: "Robotics", count: 5 },
      { tag: "Audio", count: 4 },
    ],
    tagTailExpanded: false,
    onToggleTagTail: vi.fn(),
    activeTags: new Set<string>(),
    onToggleTag: vi.fn(),
    abstractToggle: { active: false, count: 2, onToggle: vi.fn() },
    ...overrides,
  };
}

describe("CatalogFilters", () => {
  it("reports typing in the labelled search box", () => {
    const props = filtersProps();
    render(<CatalogFilters {...props} />);
    const box = screen.getByRole("searchbox", { name: /論文をタイトル・著者・要旨で検索/ });
    fireEvent.change(box, { target: { value: "diffusion" } });
    expect(props.onSearchChange).toHaveBeenCalledWith("diffusion");
  });

  it("type chips and 要旨あり are toggle buttons with aria-pressed", () => {
    const props = filtersProps({ activeType: "Oral" });
    render(<CatalogFilters {...props} />);
    expect(screen.getByRole("button", { name: /^Oral/ }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: /^Poster/ }));
    expect(props.onTypeChange).toHaveBeenCalledWith("Poster");
    const abs = screen.getByRole("button", { name: /^要旨あり/ });
    expect(abs.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(abs);
    expect(props.abstractToggle?.onToggle).toHaveBeenCalled();
  });

  it("hides the type group entirely when given no chips and no abstract toggle", () => {
    render(<CatalogFilters {...filtersProps({ typeChips: [], abstractToggle: null })} />);
    expect(screen.queryByRole("group", { name: /採択形式/ })).toBeNull();
  });

  it("formats chip counts and toggles a tag", () => {
    const props = filtersProps();
    render(<CatalogFilters {...props} />);
    const llm = screen.getByRole("button", { name: /^LLM/ });
    expect(llm.textContent).toContain("1,200");
    fireEvent.click(llm);
    expect(props.onToggleTag).toHaveBeenCalledWith("LLM");
  });

  it("collapsed tail: one '+N タグ' toggle wired to the tail by aria-controls", () => {
    const props = filtersProps();
    render(<CatalogFilters {...props} />);
    expect(screen.queryByRole("button", { name: /^Robotics/ })).toBeNull();
    const more = screen.getByRole("button", { name: "+2 タグ" });
    expect(more.getAttribute("aria-expanded")).toBe("false");
    const controlled = document.getElementById(more.getAttribute("aria-controls") ?? "");
    expect(controlled).not.toBeNull();
    fireEvent.click(more);
    expect(props.onToggleTagTail).toHaveBeenCalled();
  });

  it("expanded tail shows every tag and a 'タグをたたむ' toggle", () => {
    render(<CatalogFilters {...filtersProps({ tagTailExpanded: true })} />);
    expect(screen.getByRole("button", { name: /^Robotics/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /^Audio/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: "タグをたたむ" }).getAttribute("aria-expanded")).toBe(
      "true",
    );
  });

  it("collapsed tail still shows an ACTIVE tail tag (a URL filter is never invisible)", () => {
    render(<CatalogFilters {...filtersProps({ activeTags: new Set(["Audio"]) })} />);
    expect(screen.getByRole("button", { name: /^Audio/ }).getAttribute("aria-pressed")).toBe(
      "true",
    );
    expect(screen.queryByRole("button", { name: /^Robotics/ })).toBeNull();
    expect(screen.getByRole("button", { name: "+1 タグ" })).toBeTruthy();
  });
});

describe("CatalogHero", () => {
  const conferences = [
    { slug: "test-conf", display: "Test Conf" },
    { slug: "other-2026", display: "Other 2026" },
  ];

  it("shows the build-time paper count before papers.json arrives", () => {
    render(
      <CatalogHero
        copy={COPY}
        generated="2026-01-01"
        total={6552}
        oralCount={null}
        tagCount={null}
      />,
    );
    expect(screen.getByText("6,552")).toBeTruthy();
  });

  it("hides '0 Oral' and shows 要旨あり only when some rows lack one", () => {
    const { rerender } = render(
      <CatalogHero
        copy={COPY}
        generated="2026-01-01"
        total={10}
        oralCount={0}
        tagCount={3}
        abstractCount={8}
      />,
    );
    expect(screen.queryByText("Oral")).toBeNull();
    expect(screen.getByText("要旨あり")).toBeTruthy();
    rerender(
      <CatalogHero
        copy={COPY}
        generated="2026-01-01"
        total={10}
        oralCount={2}
        tagCount={3}
        abstractCount={10}
      />,
    );
    expect(screen.getByText(/Oral/)).toBeTruthy();
    expect(screen.queryByText("要旨あり")).toBeNull();
  });

  it("'詳細' toggles the lede with aria-expanded", () => {
    render(<CatalogHero copy={COPY} generated="" total={1} oralCount={0} tagCount={0} />);
    const toggle = screen.getByRole("button", { name: "詳細: この学会の説明を開閉" });
    const lede = screen.getByText("the lede").parentElement as HTMLElement;
    expect(lede.hidden).toBe(true);
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(lede.hidden).toBe(false);
  });

  it("the switcher (他の学会を見る) links every other conference and marks the current one", () => {
    render(
      <CatalogHero
        copy={COPY}
        generated=""
        total={1}
        oralCount={0}
        tagCount={0}
        conf="test-conf"
        conferences={conferences}
      />,
    );
    const summary = screen.getByText("他の学会を見る");
    const details = summary.closest("details") as HTMLDetailsElement;
    expect(details.open).toBe(false);
    fireEvent.click(summary);
    const nav = screen.getByRole("navigation", { name: "学会を切り替え", hidden: true });
    expect(
      within(nav).getByRole("link", { name: "Other 2026", hidden: true }).getAttribute("href"),
    ).toBe("/other-2026/");
    expect(within(nav).queryByRole("link", { name: "Test Conf", hidden: true })).toBeNull();
  });
});

const LONG = `${"word ".repeat(60)}end.`;
const PAPER: CatalogPaper = {
  paper_id: "c".repeat(40),
  title: "A Paper About Diffusion",
  authors: ["A One", "B Two", "C Three", "D Four", "E Five", "F Six"],
  tags: ["LLM", "Diffusion"],
  abstract: LONG,
  type: "Oral",
  arxiv_url: "https://arxiv.org/abs/2501.00001",
  pdf_url: "https://arxiv.org/pdf/2501.00001",
  abstract_source: "arxiv",
} as CatalogPaper;

function cardProps(overrides: Partial<Parameters<typeof CatalogPaperCard>[0]> = {}) {
  return {
    paper: PAPER,
    isSelected: false,
    searchQuery: "",
    activeTags: new Set<string>(),
    onAddTagFromCard: vi.fn(),
    onSelect: vi.fn(),
    onClose: vi.fn(),
    fullAbstract: undefined,
    pilotLineage: undefined,
    pilotLineageHref: "/lineage/?paper=x",
    revealIndex: null,
    ...overrides,
  };
}

function renderCard(overrides: Partial<Parameters<typeof CatalogPaperCard>[0]> = {}) {
  const props = cardProps(overrides);
  render(
    <ul>
      <CatalogPaperCard {...props} />
    </ul>,
  );
  return props;
}

describe("CatalogPaperCard", () => {
  it("'要旨をもっと見る' widens the preview in place (aria-expanded + aria-controls)", () => {
    renderCard();
    const toggle = screen.getByRole("button", { name: "要旨をもっと見る" });
    const abstract = document.getElementById(toggle.getAttribute("aria-controls") ?? "");
    expect(abstract?.className).toContain("line-clamp-2");
    fireEvent.click(toggle);
    expect(screen.getByRole("button", { name: "要旨をたたむ" }).getAttribute("aria-expanded")).toBe(
      "true",
    );
    expect(abstract?.className).not.toContain("line-clamp-2");
  });

  it("'詳細を開く' is described by the paper title and selects the paper", () => {
    const props = renderCard();
    const open = screen.getByRole("button", { name: "詳細を開く" });
    expect(document.getElementById(open.getAttribute("aria-describedby") ?? "")?.textContent).toBe(
      PAPER.title,
    );
    fireEvent.click(open);
    expect(props.onSelect).toHaveBeenCalledWith(PAPER.paper_id);
  });

  it("the title links to the paper; a card tag adds a tag filter", () => {
    const props = renderCard();
    expect(screen.getByRole("link", { name: PAPER.title }).getAttribute("href")).toBe(
      "https://arxiv.org/abs/2501.00001",
    );
    fireEvent.click(screen.getByRole("button", { name: "LLM" }));
    expect(props.onAddTagFromCard).toHaveBeenCalledWith("LLM");
  });

  it("selected: full authors, full abstract, Esc-labelled close button, no preview toggle", () => {
    const props = renderCard({
      isSelected: true,
      fullAbstract: { status: "ready", text: "The full abstract text." },
      pilotLineage: "unavailable",
    });
    expect(screen.getByText(PAPER.authors.join(", "))).toBeTruthy();
    expect(screen.getByText("The full abstract text.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "要旨をもっと見る" })).toBeNull();
    const close = screen.getByRole("button", { name: "詳細を閉じる" });
    expect(close.getAttribute("aria-keyshortcuts")).toBe("Escape");
    fireEvent.click(close);
    expect(props.onClose).toHaveBeenCalled();
    // Links on the selected (surface-2) card use the 7:1 accent-strong.
    expect(screen.getByRole("link", { name: "PDF" }).className).toContain(styles.strongLink);
  });

  it("selected + in a published theme: 系譜での位置 links to the focused theme node", () => {
    const position: ThemePosition = {
      slug: "graph-neural-networks",
      theme: "Graph Neural Networks",
      tier: "audited",
      nodeId: "n1",
      title: PAPER.title,
      year: 2025,
      derivedBy: { extends: 2 },
      buildsOn: {},
      derivativeCount: 2,
      priorCount: 0,
      strongDerivativeCount: 2,
      onMainPath: true,
    };
    renderCard({ isSelected: true, themePositions: [position], pilotLineage: "ready" });
    const section = screen.getByRole("region", { name: "系譜での位置" });
    const link = within(section).getByRole("link", { name: /Graph Neural Networks の系譜で見る/ });
    expect(link.getAttribute("href")).toContain("graph-neural-networks");
    expect(
      screen.getByRole("link", { name: /監査済みの研究系譜を開く/ }).getAttribute("href"),
    ).toBe("/lineage/?paper=x");
  });
});
