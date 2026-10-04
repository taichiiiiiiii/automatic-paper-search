/**
 * Port of the `oral_titles_from_arxiv` / `build_rows` / `fetch_results_checked`
 * parts of `paperpilot/tests/test_collect_conference.py` (CNF-14 of
 * docs/migration/safety-contracts.md).
 */
import { describe, expect, it, vi } from "vitest";
import {
  type ArxivAcceptedResult,
  buildArxivRows,
  fetchArxivResultsChecked,
  ORAL_MALFORMED_FEED,
  ORAL_WINDOW_FILLED,
  oralTitlesFromArxiv,
} from "../../../src/conference/shared/arxivOral.js";

function entry(
  title: string,
  comment: string,
  aid: string,
  authors: string[] = ["Alice", "Bob"],
): ArxivAcceptedResult {
  return {
    title,
    summary: "an abstract about computer vision",
    comment,
    entryId: `http://arxiv.org/abs/${aid}v1`,
    pdfUrl: `https://arxiv.org/pdf/${aid}v1`,
    authorNames: authors,
  };
}

function feedBody(entries: ArxivAcceptedResult[], total?: number): string {
  const xml = entries
    .map(
      (e) => `<entry>
  <id>${e.entryId}</id>
  <updated>2026-01-01T00:00:00Z</updated>
  <published>2026-01-01T00:00:00Z</published>
  <title>${e.title}</title>
  <summary>${e.summary}</summary>
  <arxiv:comment>${e.comment}</arxiv:comment>
  ${e.authorNames.map((n) => `<author><name>${n}</name></author>`).join("\n")}
  <link title="pdf" href="${e.pdfUrl}" rel="related"/>
</entry>`,
    )
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/" xmlns:arxiv="http://arxiv.org/schemas/atom">
  <opensearch:totalResults>${total ?? entries.length}</opensearch:totalResults>
  <opensearch:itemsPerPage>${entries.length}</opensearch:itemsPerPage>
  <opensearch:startIndex>0</opensearch:startIndex>
  ${xml}
</feed>`;
}

function fetchTextReturning(body: string, status = 200) {
  return vi.fn(async () => ({ status, text: async () => body }));
}

describe("buildArxivRows", () => {
  it("keeps genuine acceptances only and flags oral/highlight", () => {
    const results = [
      entry("Accepted paper", "Accepted to CVPR 2026", "2604.00001"),
      entry("Highlight paper", "Accepted to CVPR 2026 (Highlight)", "2604.00002"),
      entry("Workshop paper", "CVPR 2026 FGVC Workshop", "2604.00003"),
      entry("Bare mention", "CVPR 2026", "2604.00004"),
      entry("Other venue", "Accepted to ICLR 2026", "2604.00005"),
      entry("No comment", "", "2604.00006"),
    ];
    const { rows, oralTitles } = buildArxivRows(results, "CVPR");
    expect(new Set(rows.map((r) => r.title))).toEqual(
      new Set(["Accepted paper", "Highlight paper"]),
    );
    expect(rows.every((r) => r.venue === "CVPR" && r.venue_tier === 2)).toBe(true);
    expect(oralTitles).toEqual(["Highlight paper"]);
  });

  it("dedups by arXiv id, keeping the first", () => {
    const results = [
      entry("First", "Accepted to CVPR 2026", "2604.00001"),
      entry("Duplicate same id", "Accepted to CVPR 2026", "2604.00001"),
    ];
    const { rows } = buildArxivRows(results, "CVPR");
    expect(rows.length).toBe(1);
    expect(rows[0]!.title).toBe("First");
  });

  it("drops an unparseable arXiv id", () => {
    const bad: ArxivAcceptedResult = {
      title: "No id",
      summary: "x",
      comment: "Accepted to CVPR 2026",
      entryId: "not-a-real-url",
      pdfUrl: null,
      authorNames: [],
    };
    const { rows } = buildArxivRows([bad], "CVPR");
    expect(rows).toEqual([]);
  });
});

describe("oralTitlesFromArxiv", () => {
  it("returns only the venue's oral/highlight titles", async () => {
    const results = [
      entry("Oral one", "Accepted to CVPR 2025 (Oral)", "2501.00001"),
      entry("Highlight two", "Accepted to CVPR 2025 Highlight", "2501.00002"),
      entry("Plain poster", "Accepted to CVPR 2025", "2501.00003"),
      entry("Other venue oral", "Accepted to ICLR 2025 (Oral)", "2501.00004"),
    ];
    const fetchText = fetchTextReturning(feedBody(results));
    const overlay = await oralTitlesFromArxiv('co:"CVPR 2025"', "CVPR", 1600, { fetchText });
    expect(overlay).toEqual({ titles: ["Oral one", "Highlight two"], reason: null });
  });

  it("returns null + ORAL_WINDOW_FILLED when the fetch fills the whole window", async () => {
    const results = [
      entry("Oral one", "Accepted to CVPR 2025 (Oral)", "2501.00001"),
      entry("Oral two", "Accepted to CVPR 2025 (Oral)", "2501.00002"),
      entry("Poster three", "Accepted to CVPR 2025", "2501.00003"),
    ];
    const fetchText = fetchTextReturning(feedBody(results));
    const logs: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((m: string) => void logs.push(m));
    const overlay = await oralTitlesFromArxiv('co:"CVPR 2025"', "CVPR", 3, { fetchText });
    spy.mockRestore();
    expect(overlay.titles).toBeNull();
    expect(overlay.reason).toBe(ORAL_WINDOW_FILLED);
    expect(logs.some((l) => l.includes("--oral-max") && l.includes("3"))).toBe(true);
    expect(logs.some((l) => l.includes("malformed"))).toBe(false);
  });

  it("returns titles when the result count is below the cap", async () => {
    const results = [
      entry("Oral one", "Accepted to CVPR 2025 (Oral)", "2501.00001"),
      entry("Poster two", "Accepted to CVPR 2025", "2501.00002"),
    ];
    const fetchText = fetchTextReturning(feedBody(results));
    const overlay = await oralTitlesFromArxiv('co:"CVPR 2025"', "CVPR", 3, { fetchText });
    expect(overlay).toEqual({ titles: ["Oral one"], reason: null });
  });

  it("returns null + ORAL_MALFORMED_FEED on a non-feed 200 body", async () => {
    const fetchText = fetchTextReturning("<html><body>rate limited</body></html>");
    const logs: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((m: string) => void logs.push(m));
    const overlay = await oralTitlesFromArxiv('co:"CVPR 2025"', "CVPR", 3, { fetchText });
    spy.mockRestore();
    expect(overlay.titles).toBeNull();
    expect(overlay.reason).toBe(ORAL_MALFORMED_FEED);
    expect(logs.some((l) => l.includes("malformed"))).toBe(true);
    expect(logs.some((l) => l.includes("--oral-max"))).toBe(false);
  });
});

describe("fetchArxivResultsChecked", () => {
  it("is complete when a page comes back short of pageSize", async () => {
    const results = [entry("P1", "Accepted to CVPR 2026", "2604.00001")];
    const fetchText = fetchTextReturning(feedBody(results, 1));
    const { results: got, complete } = await fetchArxivResultsChecked('co:"CVPR 2026"', 10, {
      fetchText,
    });
    expect(got.length).toBe(1);
    expect(complete).toBe(true);
  });

  it("is incomplete on a non-200 response", async () => {
    const fetchText = fetchTextReturning("", 503);
    const { results, complete } = await fetchArxivResultsChecked('co:"CVPR 2026"', 10, {
      fetchText,
    });
    expect(results).toEqual([]);
    expect(complete).toBe(false);
  });
});
