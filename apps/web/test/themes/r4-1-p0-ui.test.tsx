// @vitest-environment jsdom
//
// Design doc 48 P0-1 / P0-2 / P0-3 on the theme viewer: the main path
// (本流) is drawn thicker with a 3-way toggle, every relation has a
// "誤りを報告" link to a prefilled GitHub issue, and the toolbar offers
// BibTeX / CSV export and a copy-URL button.
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LineageTree } from "../../components/themes/LineageTree";
import { ARTIFACT_VERSION } from "../../lib/lineage/core";
import type { LineageArtifact, LineageEdge } from "../../lib/themes-quality";

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(""),
}));

function prov(method: string): LineageEdge["provenance"] {
  return {
    producer: { name: "test", version: "1" },
    evidence: { source: "semantic_scholar", kind: "citation-context", sha256: "a".repeat(64) },
    classification: {
      method,
      provider: null,
      model: null,
      prompt_version: null,
      schema_version: "relation-classification-v1",
    },
  };
}

function e(src: string, dst: string, relation: string, confidence = 0.8): LineageEdge {
  return {
    src,
    dst,
    relation,
    confidence,
    rationale: `${dst} cites ${src}`,
    provenance: prov("s2_context_rule"),
  } as LineageEdge;
}

// a → b → d is the strong branch (extends, supersedes); a → c → d is
// background only, so the main path is a → b → d.
const ARTIFACT: LineageArtifact = {
  schema_version: ARTIFACT_VERSION,
  root: null,
  nodes: [
    { id: "a", is_focus: true, title: "Alpha", year: 2018, authors: ["Ann Lee"] },
    { id: "b", is_focus: false, title: "Beta", year: 2019, arxiv_id: "1901.00001" },
    { id: "c", is_focus: false, title: "Gamma", year: 2019 },
    { id: "d", is_focus: false, title: "Delta", year: 2020 },
  ],
  edges: [
    e("a", "b", "extends"),
    e("b", "d", "supersedes"),
    e("a", "c", "baseline_only"),
    e("c", "d", "baseline_only"),
  ],
  clusters: [],
  meta: { generated_at: "2026-10-11T00:00:00Z" },
};

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem("pp.theme.onboarded", "1");
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.restoreAllMocks();
});

function mainPathGroups(): Element[] {
  return [...document.querySelectorAll('g[data-main-path="1"]')];
}
function edgeButtons(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>('line[role="button"]')];
}

describe("main path (P0-1)", () => {
  it("highlights the strong branch by default and can show only it or turn it off", () => {
    render(<LineageTree artifact={ARTIFACT} slug="t" themeName="Test" />);
    const groups = mainPathGroups();
    expect(groups).toHaveLength(2);
    const labels = groups.map((g) =>
      g.querySelector('line[role="button"]')?.getAttribute("aria-label"),
    );
    expect(labels.every((l) => l?.startsWith("本流・"))).toBe(true);
    // Main-path strokes are thicker than the rest.
    const widths = groups.map((g) => Number(g.querySelector("line")?.getAttribute("stroke-width")));
    expect(Math.min(...widths)).toBeGreaterThanOrEqual(5);
    // The main-path cards carry a 本流 badge (a, b, d).
    expect(screen.getAllByRole("img", { name: "本流（主経路）上の論文" })).toHaveLength(3);

    const toggle = document.querySelector("[data-main-path-toggle]") as HTMLElement;
    expect(toggle.textContent).toContain("2 本の線");
    fireEvent.click(within(toggle).getByRole("button", { name: "本流だけ" }));
    expect(edgeButtons()).toHaveLength(2);
    fireEvent.click(within(toggle).getByRole("button", { name: "切" }));
    expect(edgeButtons()).toHaveLength(4);
    expect(mainPathGroups()).toHaveLength(0);
    expect(window.location.search).toContain("main=off");
  });
});

describe("error report link (P0-2)", () => {
  it("adds a prefilled GitHub issue link to every relation and to the evidence panel", () => {
    render(<LineageTree artifact={ARTIFACT} slug="t" themeName="Test" />);
    const list = screen.getByTestId("edge-relation-list");
    const links = [...list.querySelectorAll<HTMLAnchorElement>("a[data-report-edge]")];
    expect(links).toHaveLength(4);
    for (const a of links) {
      const url = new URL(a.href);
      expect(url.pathname).toBe("/taichiiiiiiii/automatic-paper-search/issues/new");
      expect(url.searchParams.get("template")).toBe("lineage-feedback.yml");
      expect(url.searchParams.get("theme")).toBe("Test (t)");
      expect(a.getAttribute("rel")).toContain("noopener");
    }
    expect(list.querySelectorAll("[data-main-path-edge]")).toHaveLength(2);

    const first = edgeButtons().find((l) => l.getAttribute("aria-label")?.includes("b cites a"));
    fireEvent.click(first as HTMLElement);
    const panel = screen.getByTestId("edge-evidence-panel");
    const report = panel.querySelector<HTMLAnchorElement>("a[data-report-edge]");
    const q = new URL(report?.href ?? "").searchParams;
    expect(q.get("older")).toBe("a — Alpha (2018)");
    expect(q.get("newer")).toBe("b — Beta (2019)");
    expect(q.get("relation")).toBe("拡張（extends）");
    expect(q.get("page")).toContain("/themes/?theme=t&node=b");
    expect(panel.textContent).toContain("本流（主経路）に入っています");
  });

  it("shows no report link without a theme slug", () => {
    render(<LineageTree artifact={ARTIFACT} />);
    expect(document.querySelectorAll("a[data-report-edge]")).toHaveLength(0);
  });
});

describe("export and share (P0-3)", () => {
  it("downloads BibTeX / CSV of the visible papers and copies the URL", async () => {
    const created: Blob[] = [];
    const createObjectURL = vi.fn((b: Blob) => {
      created.push(b);
      return "blob:x";
    });
    Object.assign(URL, { createObjectURL, revokeObjectURL: vi.fn() });
    const clicks: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      clicks.push(this.download);
    });
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });

    render(<LineageTree artifact={ARTIFACT} slug="t" themeName="Test" />);
    fireEvent.click(document.querySelector('[data-export="bibtex"]') as HTMLElement);
    fireEvent.click(document.querySelector('[data-export="nodes-csv"]') as HTMLElement);
    fireEvent.click(document.querySelector('[data-export="edges-csv"]') as HTMLElement);
    expect(clicks).toHaveLength(3);
    expect(clicks[0]).toMatch(/^t-papers-\d{4}-\d{2}-\d{2}\.bib$/);
    expect(clicks[2]).toMatch(/^t-relations-\d{4}-\d{2}-\d{2}\.csv$/);
    const bib = await created[0]?.text();
    expect(bib?.match(/^@misc\{/gm)).toHaveLength(4);
    expect(bib).toContain("eprint = {1901.00001}");
    const edgesCsv = await created[2]?.text();
    expect(edgesCsv?.split("\r\n").filter((l) => l.endsWith(",yes"))).toHaveLength(2);

    fireEvent.click(document.querySelector("[data-share-url]") as HTMLElement);
    await waitFor(() => expect(screen.getByText("URL をコピーしました")).toBeTruthy());
    expect(writeText).toHaveBeenCalledWith(window.location.href);
  });
});
