// @vitest-environment jsdom
/**
 * The no-JS paper-links page markup (design doc 53): display-name
 * heading, a link back to the JS catalog, and a pager with 前へ / 次へ and
 * numbered links (the current page is `aria-current`, not a link).
 * Rendered with RTL; with JavaScript disabled these are plain links, so
 * "interaction" is following hrefs -- asserted here, clicked in the E2E
 * suite.
 */
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { PaperLinksPage } from "../../app/[conf]/paper-links/logic";
import { PaperLinksView } from "../../app/[conf]/paper-links/view";

afterEach(() => {
  cleanup();
});

function page(n: number, rows: number): PaperLinksPage {
  return {
    page: n,
    firstRow: (n - 1) * 2 + 1,
    lastRow: (n - 1) * 2 + rows,
    rows: Array.from({ length: rows }, (_, i) => ({
      paperId: `${n}${i}`.padEnd(40, "0"),
      title: `Paper ${n}-${i}`,
      href: i === 0 ? `https://example.org/${n}-${i}` : null,
    })),
  };
}

const PAGES = [page(1, 2), page(2, 2), page(3, 1)];

describe("PaperLinksView", () => {
  it("uses the conference display name and links back to the JS catalog", () => {
    render(<PaperLinksView conf="icml-2026" pages={PAGES} pageNumber={1} total={5} />);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("ICML 2026 論文リンク一覧");
    expect(screen.getByRole("link", { name: "ICML 2026 の通常版" }).getAttribute("href")).toMatch(
      /^\/icml-2026\/?$/,
    );
  });

  it("middle page: 前へ / 次へ, numbered links, current page not a link", () => {
    render(<PaperLinksView conf="icml-2026" pages={PAGES} pageNumber={2} total={5} />);
    const [top] = screen.getAllByRole("navigation", { name: "ページ" });
    const nav = within(top as HTMLElement);
    expect(nav.getByRole("link", { name: "← 前へ" }).getAttribute("href")).toBe(
      "/icml-2026/paper-links/",
    );
    expect(nav.getByRole("link", { name: "次へ →" }).getAttribute("href")).toBe(
      "/icml-2026/paper-links/3/",
    );
    expect(nav.getByRole("link", { name: "3 ページ目" }).getAttribute("rel")).toBeNull();
    expect(nav.queryByRole("link", { name: "2 ページ目" })).toBeNull();
    expect(nav.getByText("2").getAttribute("aria-current")).toBe("page");
    expect(nav.getByText(/全 5 本中 3–\s*4 本目/)).toBeTruthy();
  });

  it("first and last pages omit the missing direction", () => {
    const { unmount } = render(
      <PaperLinksView conf="icml-2026" pages={PAGES} pageNumber={1} total={5} />,
    );
    expect(screen.queryAllByRole("link", { name: "← 前へ" })).toHaveLength(0);
    expect(screen.getAllByRole("link", { name: "次へ →" })).toHaveLength(2);
    unmount();
    render(<PaperLinksView conf="icml-2026" pages={PAGES} pageNumber={3} total={5} />);
    expect(screen.queryAllByRole("link", { name: "次へ →" })).toHaveLength(0);
  });

  it("rows: titled links open the paper in a new tab; link-less rows say so", () => {
    render(<PaperLinksView conf="icml-2026" pages={PAGES} pageNumber={1} total={5} />);
    const link = screen.getByRole("link", { name: "Paper 1-0" });
    expect(link.getAttribute("target")).toBe("_blank");
    expect(screen.getByText("原論文リンクを利用できません。")).toBeTruthy();
  });

  it("a single-page conference renders no pager", () => {
    render(<PaperLinksView conf="eccv-2024" pages={[page(1, 2)]} pageNumber={1} total={2} />);
    expect(screen.queryByRole("navigation", { name: "ページ" })).toBeNull();
  });
});
