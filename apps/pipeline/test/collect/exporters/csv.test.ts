/**
 * Port of the CSV-exporter cases of `paperpilot/tests/test_exporters.py`.
 */

import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CSVExporter } from "../../../src/collect/exporters/csv.js";
import * as csvSafety from "../../../src/collect/exporters/csvSafety.js";
import { createPaper, type Paper } from "../../../src/collect/model/paper.js";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual };
});
vi.mock("../../../src/collect/exporters/csvSafety.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../src/collect/exporters/csvSafety.js")>();
  return { ...actual };
});

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "csv-exporter-test-"));
});
afterEach(() => {
  vi.restoreAllMocks();
});

function samplePapers(): Paper[] {
  return [
    createPaper({
      title: "T1",
      authors: ["A"],
      abstract: "abs",
      url: "http://x/1",
      publishedDate: "2026-04-01",
      source: "arxiv",
      arxivId: "2604.001",
      totalScore: 100.0,
      venue: "ICLR",
      venueTier: 1,
      venueScore: 100.0,
      githubStars: 500,
      githubScore: 73.0,
    }),
    createPaper({
      title: "T2",
      authors: ["B", "C"],
      abstract: "abs2",
      url: "http://x/2",
      publishedDate: "2026-04-01",
      source: "s2",
      arxivId: "2604.002",
      totalScore: 50.0,
    }),
  ];
}

function readCsvRows(path: string): { header: string[]; rows: Record<string, string>[] } {
  const raw = readFileSync(path);
  const text = raw.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))
    ? raw.subarray(3).toString("utf-8")
    : raw.toString("utf-8");
  const lines = text.split("\r\n").filter((l) => l.length > 0);
  const header = parseCsvLine(lines[0] as string);
  const rows = lines.slice(1).map((line) => {
    const values = parseCsvLine(line);
    const row: Record<string, string> = {};
    header.forEach((h, i) => {
      row[h] = values[i] as string;
    });
    return row;
  });
  return { header, rows };
}

function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

it("test_csv_writes_header_and_rows", async () => {
  const exp = new CSVExporter({ enabled: true, dir, encoding: "utf-8" });
  const path = await exp.export(samplePapers());
  expect(path).not.toBeNull();
  const { rows } = readCsvRows(path as string);
  expect(rows.length).toBe(2);
  expect(rows[0]?.rank).toBe("1");
  expect(rows[0]?.title).toBe("T1");
  expect(rows[0]?.venue).toBe("ICLR");
  expect(rows[0]?.venue_tier).toBe("1");
});

it("test_csv_no_papers_returns_none", async () => {
  const exp = new CSVExporter({ enabled: true, dir, encoding: "utf-8" });
  expect(await exp.export([])).toBeNull();
});

const CSV_LEGACY_HEADER = [
  "rank",
  "total_score",
  "llm_relevance",
  "llm_summary_ja",
  "llm_reason",
  "llm_tags",
  "follow_score",
  "follow_reason",
  "title",
  "authors",
  "affiliations",
  "venue",
  "venue_tier",
  "venue_score",
  "citation_count",
  "influential_citations",
  "citation_velocity",
  "citation_score",
  "author_h_index",
  "author_score",
  "embedding_similarity",
  "github_stars",
  "github_score",
  "has_code",
  "is_official_repo",
  "keyword_match_count",
  "keyword_score",
  "matched_keywords",
  "categories",
  "published_date",
  "url",
  "pdf_url",
  "github_url",
  "arxiv_id",
  "source",
  "abstract",
];

function identityPapers(): Paper[] {
  return [
    createPaper({
      title: "Fictional Marker Retrieval Study Alpha",
      authors: ["Yamada Testonly"],
      abstract: "Synthetic abstract alpha.",
      url: "https://example.invalid/alpha",
      publishedDate: "2026-04-01",
      source: "s2",
      doi: "10.5555/testonly.alpha.0001",
      totalScore: 88.5,
    }),
    createPaper({
      title: "Fictional Marker Lineage Beta",
      authors: ["Sato Testonly", "Tanaka Testonly"],
      abstract: "Synthetic abstract beta.",
      url: "https://example.invalid/beta",
      publishedDate: "2026-04-02",
      source: "arxiv",
      arxivId: "2604.99999",
      doi: "10.5555/testonly.beta.0002",
      pdfUrl: "https://example.invalid/beta.pdf",
      totalScore: 77.25,
    }),
    createPaper({
      title: "Fictional Marker Survey Gamma",
      authors: ["Nazuna Testonly"],
      abstract: "Synthetic abstract gamma.",
      url: "https://example.invalid/gamma",
      publishedDate: "2026-04-03",
      source: "openalex",
      totalScore: 10.0,
    }),
    createPaper({
      title: "Fictional Marker Retrieval Study Alpha",
      authors: ["Doi Testonly"],
      abstract: "Synthetic abstract delta.",
      url: "https://example.invalid/delta",
      publishedDate: "2026-04-04",
      source: "s2",
      doi: "10.5555/testonly.delta.0004",
      totalScore: 5.0,
    }),
  ];
}

it("test_csv_appends_uid_and_doi_columns", async () => {
  const exp = new CSVExporter({ enabled: true, dir, encoding: "utf-8" });
  const path = await exp.export(identityPapers());
  const { header, rows } = readCsvRows(path as string);
  expect(header.slice(0, CSV_LEGACY_HEADER.length)).toEqual(CSV_LEGACY_HEADER);
  expect(header.slice(CSV_LEGACY_HEADER.length)).toEqual(["uid", "doi"]);
  expect(rows.map((r) => r.uid)).toEqual([
    "doi:10.5555/testonly.alpha.0001",
    "arxiv:2604.99999",
    "url:https://example.invalid/gamma",
    "doi:10.5555/testonly.delta.0004",
  ]);
  expect(rows.map((r) => r.doi)).toEqual([
    "10.5555/testonly.alpha.0001",
    "10.5555/testonly.beta.0002",
    "",
    "10.5555/testonly.delta.0004",
  ]);
  expect(rows[1]?.published_date).toBe("2026-04-02");
  expect(rows[1]?.pdf_url).toBe("https://example.invalid/beta.pdf");
});

it("test_csv_identity_output_is_deterministic", async () => {
  const exp = new CSVExporter({ enabled: true, dir, encoding: "utf-8" });
  const first = (await exp.export(identityPapers())) as string;
  const firstRows = readCsvRows(first);
  const second = (await exp.export(identityPapers())) as string;
  const secondRows = readCsvRows(second);
  expect(firstRows).toEqual(secondRows);
});

it("test_csv_does_not_mutate_input_papers", async () => {
  const papers = identityPapers();
  const before = JSON.stringify(papers);
  const exp = new CSVExporter({ enabled: true, dir, encoding: "utf-8" });
  await exp.export(papers);
  expect(JSON.stringify(papers)).toBe(before);
});

it("test_csv_neutralizes_spreadsheet_formula_payloads", async () => {
  const papers = samplePapers();
  (papers[0] as Paper).title = '=HYPERLINK("http://evil.example","click")';
  (papers[0] as Paper).abstract = "@SUM(1+1)*cmd";
  const exp = new CSVExporter({ enabled: true, dir, encoding: "utf-8" });
  const path = (await exp.export(papers)) as string;
  const { rows } = readCsvRows(path);
  expect((rows[0]?.title ?? "").startsWith("'=HYPERLINK")).toBe(true);
  expect((rows[0]?.abstract ?? "").startsWith("'@SUM")).toBe(true);
});

it("test_csv_leaves_ordinary_text_untouched", async () => {
  const papers = samplePapers();
  (papers[0] as Paper).title = "Retrieval-Augmented Generation for Knowledge Tasks";
  (papers[0] as Paper).abstract = "We propose a method.";
  const exp = new CSVExporter({ enabled: true, dir, encoding: "utf-8" });
  const path = (await exp.export(papers)) as string;
  const { rows } = readCsvRows(path);
  expect(rows[0]?.title).toBe("Retrieval-Augmented Generation for Knowledge Tasks");
  expect(rows[0]?.abstract).toBe("We propose a method.");
});

it("test_csv_export_failure_leaves_the_existing_file_untouched", async () => {
  const exp = new CSVExporter({ enabled: true, dir, encoding: "utf-8" });
  const path = (await exp.export(samplePapers())) as string;
  const originalBytes = readFileSync(path);

  vi.spyOn(csvSafety, "neutralize").mockImplementation(() => {
    throw new Error("row build failed");
  });
  await expect(exp.export(samplePapers())).rejects.toThrow("row build failed");

  expect(readFileSync(path)).toEqual(originalBytes);
  expect(readdirSync(dir)).toEqual([path.split("/").pop()]);
});

it("test_csv_first_export_of_the_day_uses_the_plain_name", async () => {
  const now = new Date();
  const exp = new CSVExporter({ enabled: true, dir, encoding: "utf-8" }, { now: () => now });
  const path = (await exp.export(samplePapers())) as string;
  const pad = (n: number) => String(n).padStart(2, "0");
  const today = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  expect(path.split("/").pop()).toBe(`papers_${today}.csv`);
});

it("test_csv_second_same_day_export_with_disjoint_papers_keeps_both_files", async () => {
  const now = new Date();
  const exp = new CSVExporter({ enabled: true, dir, encoding: "utf-8" }, { now: () => now });
  const titled = (title: string) => [
    createPaper({
      title,
      authors: ["A"],
      abstract: "abs",
      url: `http://x/${title}`,
      publishedDate: "2026-04-01",
      source: "arxiv",
      arxivId: `2604.${title}`,
      totalScore: 1,
    }),
  ];
  const first = (await exp.export(titled("H1"))) as string;
  const second = (await exp.export(titled("H2"))) as string;
  expect(first).not.toBe(second);
  expect(readCsvRows(first).rows.map((r) => r.title)).toEqual(["H1"]);
  expect(readCsvRows(second).rows.map((r) => r.title)).toEqual(["H2"]);
});

it("test_csv_third_same_day_export_does_not_clobber_the_second", async () => {
  const fixedNow = new Date(2026, 0, 1, 12, 0, 0);
  const exp = new CSVExporter({ enabled: true, dir, encoding: "utf-8" }, { now: () => fixedNow });
  const titled = (title: string) => [
    createPaper({
      title,
      authors: ["A"],
      abstract: "abs",
      url: `http://x/${title}`,
      publishedDate: "2026-04-01",
      source: "arxiv",
      arxivId: `2604.${title}`,
      totalScore: 1,
    }),
  ];
  const first = (await exp.export(titled("H1"))) as string;
  const second = (await exp.export(titled("H2"))) as string;
  const third = (await exp.export(titled("H3"))) as string;
  expect(new Set([first, second, third]).size).toBe(3);
  expect(first.split("/").pop()).toBe("papers_2026-01-01.csv");
  expect(second.split("/").pop()).toBe("papers_2026-01-01-120000.csv");
  expect(third.split("/").pop()).toBe("papers_2026-01-01-120000-2.csv");
});

it("test_csv_export_keeps_the_utf8_sig_bom", async () => {
  const exp = new CSVExporter({ enabled: true, dir });
  const path = (await exp.export(samplePapers())) as string;
  const raw = readFileSync(path);
  expect(raw.subarray(0, 3)).toEqual(Buffer.from([0xef, 0xbb, 0xbf]));
  expect(raw.subarray(raw.length - 2)).toEqual(Buffer.from("\r\n"));
  const lines = raw.subarray(3).toString("utf-8").split("\r\n");
  expect(lines[0]?.startsWith("rank,total_score,")).toBe(true);
  expect(lines[1]?.startsWith("1,100.0,")).toBe(true);
});
