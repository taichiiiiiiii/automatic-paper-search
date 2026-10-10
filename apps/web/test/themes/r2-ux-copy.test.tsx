// @vitest-environment jsdom
//
// R2 UX review P1-3 / P1-7 / P2-9 / P2-10 / P2-12 / P3-13: gallery
// labels and default theme, Japanese counts/ages, request-form copy and
// validation, footer attribution links, and zod's jitless mode.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SiteFooter } from "../../components/site-footer";
import { ThemeGallery } from "../../components/themes/ThemeGallery";
import { ThemeRequestForm } from "../../components/themes/ThemeRequestForm";
import { formatThemeAge, pickDefaultSlug, QUALITY_TIERS } from "../../lib/themes-gallery";
import {
  failureFromRun,
  INTERNAL_TERMS_RE,
  interpretThemesPostResponse,
  POLL_TIMEOUT_FAILURE,
  POLL_TIMEOUT_MS,
  PROGRESS_STEP_LABELS,
  QUALITY_FAILED_FAILURE,
  THEME_INPUT_JAPANESE_MESSAGE,
  THEME_QUEUED_MESSAGE,
  THEME_REQUEST_HINT,
  themeInputProblem,
} from "../../lib/themes-request";
import { THEME_INPUT_PATTERN } from "../../lib/themes-slug";

vi.mock("../../lib/config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/config")>();
  return { ...actual, API_BASE: "https://api.example.test" };
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("pickDefaultSlug (R2 UX P1-7)", () => {
  const manifest = [
    { slug: "flash-attention", paper_count: 4, generated_at: "2026-10-10T11:29:05Z" },
    { slug: "graph-neural-network", paper_count: 13, generated_at: "2026-10-10T08:56:28Z" },
    { slug: "vision-transformer", paper_count: 18, generated_at: "2026-10-10T10:44:48Z" },
  ].map((e) => ({ ...e, publication_tier: "unaudited" as const }));
  const rollup = {
    "flash-attention": { edge_count: 4, template_ratio: 0 },
    "graph-neural-network": { edge_count: 40, template_ratio: 0 },
    "vision-transformer": { edge_count: 52, template_ratio: 0 },
  };

  it("picks the theme with the most relations, not the freshest", () => {
    expect(pickDefaultSlug(manifest, rollup)).toBe("vision-transformer");
  });

  it("still prefers an audited theme over a richer unaudited one", () => {
    const withAudited = manifest.map((e) =>
      e.slug === "flash-attention" ? { ...e, publication_tier: "audited" as const } : e,
    );
    expect(pickDefaultSlug(withAudited, rollup)).toBe("flash-attention");
  });

  it("ignores malformed edge counts", () => {
    const bad = { ...rollup, "flash-attention": { edge_count: 1e20 } };
    expect(pickDefaultSlug(manifest, bad)).toBe("vision-transformer");
  });
});

describe("ThemeGallery labels (R2 UX P1-3 / P2-9)", () => {
  const rollup = { t: { template_ratio: 0, template_count: 0, edge_count: 10 } };

  it("shows no quality verdict on an unaudited card and uses Japanese counts", () => {
    const { container } = render(
      <ThemeGallery
        manifest={[{ slug: "t", theme: "T", paper_count: 5, publication_tier: "unaudited" }]}
        qualityRollup={rollup}
        currentSlug="t"
      />,
    );
    expect(container.textContent).not.toContain("高品質");
    expect(container.textContent).not.toContain(QUALITY_TIERS.high.label);
    expect(container.textContent).toContain("5 論文");
    expect(container.textContent).not.toMatch(/papers|template_ratio/);
    expect(container.innerHTML).not.toContain("template_ratio");
  });

  it("an audited card shows the renamed rationale-style hint, never 高品質", () => {
    const { container } = render(
      <ThemeGallery
        manifest={[{ slug: "t", theme: "T", paper_count: 5, publication_tier: "audited" }]}
        qualityRollup={rollup}
        currentSlug="t"
      />,
    );
    expect(container.textContent).toContain("根拠: 論文ごと");
    expect(container.textContent).not.toContain("高品質");
  });

  it("formats the age in Japanese", () => {
    const now = Date.parse("2026-10-10T12:00:00Z");
    expect(formatThemeAge("2026-10-10T01:00:00Z", now)).toBe("今日");
    expect(formatThemeAge("2026-10-07T12:00:00Z", now)).toBe("3 日前");
    expect(formatThemeAge("2026-07-10T12:00:00Z", now)).toBe("3 か月前");
    expect(formatThemeAge("2024-10-01T12:00:00Z", now)).toBe("2 年前");
  });
});

describe("theme request copy (R2 UX P2-10)", () => {
  it("never shows internal stack names in progress or failure copy", () => {
    const texts = [
      ...Object.values(PROGRESS_STEP_LABELS),
      POLL_TIMEOUT_FAILURE.title,
      POLL_TIMEOUT_FAILURE.message,
      QUALITY_FAILED_FAILURE.title,
      QUALITY_FAILED_FAILURE.message,
      THEME_QUEUED_MESSAGE,
      THEME_REQUEST_HINT,
    ];
    for (const conclusion of ["failure", "cancelled", "timed_out"]) {
      const f = failureFromRun({ status: "completed", conclusion, html_url: "" });
      texts.push(f?.title ?? "", f?.message ?? "");
    }
    for (const t of texts) expect(t, t).not.toMatch(INTERNAL_TERMS_RE);
    expect(QUALITY_FAILED_FAILURE.title).toContain("自動検査");
    expect(QUALITY_FAILED_FAILURE.title).not.toContain("品質監査");
  });

  it("describes the steps in user terms and promises a realistic time", () => {
    expect(Object.values(PROGRESS_STEP_LABELS).join(" ")).toMatch(
      /受付.*論文収集.*自動検査.*未監査/,
    );
    expect(THEME_REQUEST_HINT).toContain("_");
    expect(THEME_REQUEST_HINT).toContain("英語");
    expect(THEME_REQUEST_HINT).toContain("15 分");
    expect(POLL_TIMEOUT_MS).toBe(15 * 60 * 1000);
    expect(POLL_TIMEOUT_FAILURE.title).toContain("15 分");
    expect(THEME_QUEUED_MESSAGE).toContain("未監査");
  });

  it("asks for English when the input contains Japanese", () => {
    expect(themeInputProblem("視覚トランスフォーマー", THEME_INPUT_PATTERN)).toBe(
      THEME_INPUT_JAPANESE_MESSAGE,
    );
    expect(themeInputProblem("x", THEME_INPUT_PATTERN)).toMatch(/英語/);
    expect(themeInputProblem("Vision_Transformer", THEME_INPUT_PATTERN)).toBeNull();
  });

  it("the form shows the hint, sets a custom validity message, and rejects Japanese input", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    render(<ThemeRequestForm onReady={() => {}} />);
    expect(screen.getByText(THEME_REQUEST_HINT)).toBeTruthy();
    const input = screen.getByLabelText(/テーマを自分で生成/) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "視覚トランスフォーマー" } });
    expect(input.validationMessage).toBe(THEME_INPUT_JAPANESE_MESSAGE);
    fireEvent.click(screen.getByRole("button", { name: "生成する" }));
    expect(screen.getByText(/英語で入力してください/)).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: "Vision Transformer" } });
    expect(input.validationMessage).toBe("");
  });

  it("an accepted-but-unpollable request says it will appear as 未監査", () => {
    expect(interpretThemesPostResponse(200, { ok: true, status: "queued" })).toEqual({
      kind: "queued_unusable",
    });
    expect(THEME_QUEUED_MESSAGE).toContain("「未監査（自動生成）」");
  });
});

describe("SiteFooter attribution (R2 compliance)", () => {
  it("links each data source and the 出典とライセンス section", () => {
    render(<SiteFooter />);
    const href = (name: string) => screen.getByRole("link", { name }).getAttribute("href");
    expect(href("arXiv")).toBe("https://arxiv.org/");
    expect(href("Semantic Scholar")).toBe("https://www.semanticscholar.org/");
    expect(href("OpenAlex")).toBe("https://openalex.org/");
    // next/link drops the trailing slash under jsdom; the static export
    // (trailingSlash: true) emits /how-it-works/#credits.
    expect(href("出典とライセンス")).toMatch(/^\/how-it-works\/?#credits$/);
  });
});

describe("zod jitless (R2 UX P3-13)", () => {
  it("lib/data.ts switches zod to jitless so no eval probe hits the CSP", async () => {
    await import("../../lib/data");
    const { z } = await import("@paperpilot/core/site");
    expect(z.config().jitless).toBe(true);
  });
});
