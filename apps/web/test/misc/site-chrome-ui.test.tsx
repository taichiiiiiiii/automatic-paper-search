// @vitest-environment jsdom
//
// User-level tests for the shared chrome and static pages touched by the UX
// audit (design 53, トップ・共通): header nav (current page, targets),
// footer links, the 404 page's way back, and the 仕組み page's overview and
// breadcrumb. Roles + accessible names only, shared with apps/web/e2e.
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

let pathname = "/";
vi.mock("next/navigation", () => ({
  usePathname: () => pathname,
}));

import HowItWorksPage from "../../app/how-it-works/page";
import NotFound from "../../app/not-found";
import { SiteFooter } from "../../components/site-footer";
import { SiteHeader } from "../../components/site-header";
import { PRIVATE_REPORT_URL, REPO_URL } from "../../lib/site-links";

/** Next's <Link> drops the trailing slash under plain vitest (the
 * `trailingSlash` setting lives in next.config.ts), so compare paths
 * without it; plain <a> hrefs are compared the same way. */
function path(href: string | null): string | null {
  if (href === null || href === "/") return href;
  return href.replace(/\/(?=$|#)/, "");
}

function linkPairs(container: HTMLElement): Array<[string | null, string | null]> {
  return within(container)
    .getAllByRole("link")
    .map((a) => [a.textContent, path(a.getAttribute("href"))]);
}

function expectedPairs(pairs: Array<[string, string]>): Array<[string, string | null]> {
  return pairs.map(([label, href]) => [label, path(href)]);
}

afterEach(() => {
  cleanup();
  pathname = "/";
});

function navLinks() {
  const nav = screen.getByRole("navigation", { name: "グローバル" });
  return within(nav).getAllByRole("link");
}

describe("SiteHeader", () => {
  it("is a banner landmark with the brand and four nav links", () => {
    render(<SiteHeader />);
    const banner = screen.getByRole("banner");
    expect(within(banner).getByRole("link", { name: "PaperPilot" }).getAttribute("href")).toBe("/");
    expect(linkPairs(screen.getByRole("navigation", { name: "グローバル" }))).toEqual(
      expectedPairs([
        ["探す", "/"],
        ["学会", "/#s0-confs"],
        ["系譜", "/themes/"],
        ["仕組み", "/how-it-works/"],
      ]),
    );
  });

  it.each([
    ["/", "探す"],
    ["/cvpr-2026/", "学会"],
    ["/themes/", "系譜"],
    ["/how-it-works/", "仕組み"],
  ])("on %s marks only %s as the current page", (path, label) => {
    pathname = path;
    render(<SiteHeader />);
    const current = navLinks().filter((a) => a.getAttribute("aria-current") === "page");
    expect(current.map((a) => a.textContent)).toEqual([label]);
  });

  it("marks nothing on an unknown path", () => {
    pathname = "/missing/";
    render(<SiteHeader />);
    expect(navLinks().some((a) => a.hasAttribute("aria-current"))).toBe(false);
  });

  it("nav links are keyboard-focusable in order", () => {
    render(<SiteHeader />);
    const links = navLinks();
    for (const link of links) {
      link.focus();
      expect(document.activeElement).toBe(link);
    }
    // Every link carries the 44px target class.
    for (const link of links) expect(link.className).toContain("min-h-11");
  });
});

describe("SiteFooter", () => {
  it("links site info, the private removal route and every data source", () => {
    render(<SiteFooter />);
    const footer = screen.getByRole("contentinfo");
    const info = within(footer).getByRole("navigation", { name: "サイト情報" });
    expect(linkPairs(info)).toEqual(
      expectedPairs([
        ["仕組み", "/how-it-works/"],
        ["出典とライセンス", "/how-it-works/#credits"],
        ["プライバシー", "/how-it-works/#privacy"],
        ["削除依頼", PRIVATE_REPORT_URL],
        ["GitHub", REPO_URL],
      ]),
    );
    for (const name of [
      "arXiv",
      "Semantic Scholar",
      "OpenAlex",
      "OpenReview",
      "ACL Anthology",
      "CVF Open Access",
    ]) {
      expect(within(footer).getByRole("link", { name }).getAttribute("rel")).toBe("noopener");
    }
    expect(
      within(footer).getByText("PaperPilot は個人が運営する非営利のサイトです。"),
    ).toBeTruthy();
  });
});

describe("404 page", () => {
  it("offers links back to search, the catalogs and the themes", () => {
    render(<NotFound />);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toContain("404");
    const main = screen.getByRole("main");
    expect(linkPairs(main)).toEqual(
      expectedPairs([
        ["トップページ（論文を検索）", "/"],
        ["学会カタログの一覧", "/#s0-confs"],
        ["テーマ別の系譜", "/themes/"],
      ]),
    );
  });
});

describe("仕組み page", () => {
  it("opens with a site overview linking the three entry points", () => {
    render(<HowItWorksPage />);
    const overview = screen.getByRole("region", { name: "PaperPilot でできること" });
    expect(linkPairs(overview)).toEqual(
      expectedPairs([
        ["論文を探す", "/"],
        ["学会カタログ", "/#s0-confs"],
        ["テーマ別の系譜", "/themes/"],
      ]),
    );
    const crumbs = screen.getByRole("navigation", { name: "パンくずリスト" });
    expect(within(crumbs).getByRole("link", { name: "PaperPilot" }).getAttribute("href")).toBe("/");
  });

  it("has h3 subheads under どう判定しているか and a 公開中の系譜を見る link", () => {
    render(<HowItWorksPage />);
    const h3s = screen.getAllByRole("heading", { level: 3 }).map((h) => h.textContent);
    expect(h3s).toEqual([
      "根拠の見方",
      "本流（主経路）",
      "論文の土台と発展",
      "誤りの報告と書き出し",
      "公開の基準",
    ]);
    const cta = screen.getByRole("link", { name: /公開中の系譜を見る/ });
    expect(path(cta.getAttribute("href"))).toBe("/themes");
  });
});
