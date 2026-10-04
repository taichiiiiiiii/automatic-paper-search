/** Ported from paperpilot/tests/test_build_summary_csv.py. */
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IdentityError } from "@paperpilot/core/identity";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadSummaryWithDetails } from "../../src/catalog/buildPages.js";
import { buildSummary, findLatestCsv, loadOralTitles } from "../../src/catalog/buildSummary.js";
import { dictReader } from "../../src/catalog/csv.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "build-summary-test-"));
});

afterEach(() => {
  // best-effort cleanup only; vitest's own tmp handling tolerates leftovers.
});

interface PapersCsvRow {
  title: string;
  authors?: string;
  abstract?: string;
  url: string;
  pdf_url?: string;
  venue?: string;
  arxiv_id?: string;
  citation_count?: string;
  venue_tier?: string;
  github_stars?: string;
  source?: string;
  source_id?: string;
}

const PAPERS_CSV_FIELDS = [
  "title",
  "authors",
  "abstract",
  "url",
  "pdf_url",
  "venue",
  "arxiv_id",
  "citation_count",
  "venue_tier",
  "github_stars",
  "source",
  "source_id",
] as const;

function writePapersCsv(path: string, rows: PapersCsvRow[]): void {
  mkdirSync(join(path, ".."), { recursive: true });
  const lines = [PAPERS_CSV_FIELDS.join(",")];
  for (const row of rows) {
    lines.push(
      PAPERS_CSV_FIELDS.map(
        (f) => (row as unknown as Record<string, string | undefined>)[f] ?? "",
      ).join(","),
    );
  }
  writeFileSync(path, `﻿${lines.join("\r\n")}\r\n`, "utf-8");
}

function writeOralMd(path: string, titles: string[]): void {
  const lines = titles.map((t, i) => `## ${i + 1}. ${t}`);
  writeFileSync(path, `${lines.join("\n")}\n`, "utf-8");
}

describe("findLatestCsv", () => {
  it("picks the newest date by filename, not mtime", () => {
    const conf = join(tmpDir, "iclr-2026");
    mkdirSync(conf);
    writeFileSync(join(conf, "papers_2026-04-01.csv"), "");
    writeFileSync(join(conf, "papers_2026-04-18.csv"), "");
    writeFileSync(join(conf, "papers_2026-03-10.csv"), "");
    expect(findLatestCsv(conf).endsWith("papers_2026-04-18.csv")).toBe(true);
  });

  it("ignores non-papers files", () => {
    const conf = join(tmpDir, "iclr-2026");
    mkdirSync(conf);
    writeFileSync(join(conf, "summary.csv"), "");
    writeFileSync(join(conf, "papers_2026-04-01.csv"), "");
    writeFileSync(join(conf, "oral_summaries_ja.md"), "");
    expect(findLatestCsv(conf).endsWith("papers_2026-04-01.csv")).toBe(true);
  });

  it("throws when no dated CSV exists", () => {
    const conf = join(tmpDir, "empty");
    mkdirSync(conf);
    expect(() => findLatestCsv(conf)).toThrow(/No papers_YYYY-MM-DD\.csv/);
  });
});

describe("loadOralTitles", () => {
  it("returns an empty set when the file is absent", () => {
    expect(loadOralTitles(join(tmpDir, "missing.md")).size).toBe(0);
  });

  it("extracts titles and normalizes them", () => {
    const md = join(tmpDir, "oral_summaries_ja.md");
    writeOralMd(md, ["Scaling Language Models", "Diffusion Baseline"]);
    const titles = loadOralTitles(md);
    expect(titles.has("scaling language models")).toBe(true);
  });
});

describe("buildSummary", () => {
  it("auto-discovers the latest CSV, drops empty titles, and classifies tags", () => {
    const conf = join(tmpDir, "iclr-2026");
    writePapersCsv(join(conf, "papers_2026-04-18.csv"), [
      {
        title: "Scaling Language Models",
        authors: "Alice; Bob",
        abstract: "We train a large language model.",
        url: "http://arxiv.org/abs/2404.00001",
        pdf_url: "http://arxiv.org/pdf/2404.00001",
        venue: "ICLR 2026 Oral",
      },
      {
        title: "Diffusion Baseline",
        authors: "Carol",
        abstract: "A diffusion-based image generator.",
        url: "http://arxiv.org/abs/2404.00002",
        pdf_url: "http://arxiv.org/pdf/2404.00002",
        venue: "ICLR 2026",
      },
      { title: "", url: "" }, // must be dropped
    ]);

    const result = buildSummary({ conferenceDir: conf });
    expect(result.rowsWritten).toBe(2);
    expect(result.summaryCsv.endsWith("summary.csv")).toBe(true);

    const { rows } = dictReader(readFileSync(result.summaryCsv, "utf-8"));
    expect(rows).toHaveLength(2);
    const titles = rows.map((r) => r.title);
    expect(titles).toContain("Scaling Language Models");
    expect(titles).toContain("Diffusion Baseline");
    const llmRow = rows.find((r) => r.title === "Scaling Language Models");
    expect(llmRow?.tags).toContain("LLM");
  });

  it("labels a title Oral when it matches oral_summaries_ja.md", () => {
    const conf = join(tmpDir, "iclr-2026");
    writePapersCsv(join(conf, "papers_2026-04-18.csv"), [
      { title: "Scaling Language Models", url: "http://arxiv.org/abs/2404.00001" },
      { title: "Diffusion Baseline", url: "http://arxiv.org/abs/2404.00002" },
    ]);
    writeOralMd(join(conf, "oral_summaries_ja.md"), ["Scaling Language Models"]);

    const result = buildSummary({ conferenceDir: conf });
    expect(result.oralCount).toBe(1);
    const { rows } = dictReader(readFileSync(result.summaryCsv, "utf-8"));
    const oral = rows.find((r) => r.title === "Scaling Language Models");
    expect(oral?.type).toBe("Oral");
    const poster = rows.find((r) => r.title === "Diffusion Baseline");
    expect(poster?.type).toBe("Poster");
  });

  // Whitespace LOW: Python's str.split()/strip() use a different whitespace
  // set than JS's \s/.trim() (U+001C-U+001F, U+0085 are Python-only
  // whitespace). normalizeTitle collapses whitespace runs via
  // `" ".join(s.split())` in Python — a title differing only by one of
  // these exotic whitespace characters (or run length) must still match
  // the oral-titles set.
  it("matches an oral title despite Python-only whitespace (U+001C) and run-length differences", () => {
    const conf = join(tmpDir, "iclr-2026");
    writePapersCsv(join(conf, "papers_2026-04-18.csv"), [
      { title: "Scaling  Language\x1cModels", url: "http://arxiv.org/abs/2404.00001" },
    ]);
    writeOralMd(join(conf, "oral_summaries_ja.md"), ["Scaling Language Models"]);

    const result = buildSummary({ conferenceDir: conf });
    expect(result.oralCount).toBe(1);
  });

  it("sorts Oral rows first, then by lowercased title", () => {
    const conf = join(tmpDir, "iclr-2026");
    writePapersCsv(join(conf, "papers_2026-04-18.csv"), [
      { title: "Zebra Paper", url: "http://arxiv.org/abs/2404.00001" },
      { title: "Apple Paper", url: "http://arxiv.org/abs/2404.00002" },
      { title: "Oral Zed", url: "http://arxiv.org/abs/2404.00003" },
    ]);
    writeOralMd(join(conf, "oral_summaries_ja.md"), ["Oral Zed"]);

    const result = buildSummary({ conferenceDir: conf });
    const { rows } = dictReader(readFileSync(result.summaryCsv, "utf-8"));
    expect(rows.map((r) => r.title)).toEqual(["Oral Zed", "Apple Paper", "Zebra Paper"]);
  });

  it("round-trips the collector's formula guard without leaking it into summary.csv", () => {
    const conf = join(tmpDir, "iclr-2026");
    // The collector CSV writer neutralizes a leading "=" with a quote —
    // this writes the ALREADY-neutralized form directly, simulating that.
    writePapersCsv(join(conf, "papers_2026-04-18.csv"), [
      { title: "'=Deep Nets", url: "http://arxiv.org/abs/2404.00001" },
    ]);
    const result = buildSummary({ conferenceDir: conf });
    // summary.csv itself re-applies the guard on disk (its own cell is
    // "'=Deep Nets" again, since the writer neutralizes unconditionally)...
    const { rows } = dictReader(readFileSync(result.summaryCsv, "utf-8"));
    expect(rows[0]?.title).toBe("'=Deep Nets");
    // ...but the catalog reader (build_pages.loadSummaryWithDetails) must
    // see the title WITHOUT any guard prefix — the guard never becomes
    // published catalog text.
    const { papers } = loadSummaryWithDetails(result.summaryCsv);
    expect(papers[0]?.title).toBe("=Deep Nets");
  });

  it("throws IdentityError when declared source/source_id mismatches the native URL", () => {
    const conf = join(tmpDir, "iclr-2026");
    writePapersCsv(join(conf, "papers_2026-04-18.csv"), [
      {
        title: "Mismatched",
        url: "http://arxiv.org/abs/2404.00001",
        source: "arxiv",
        source_id: "9999.99999",
      },
    ]);
    expect(() => buildSummary({ conferenceDir: conf })).toThrow(IdentityError);
  });

  it("writes a summary.meta.json sidecar naming the source CSV, only when it lives in the conference dir", () => {
    const conf = join(tmpDir, "iclr-2026");
    writePapersCsv(join(conf, "papers_2026-04-18.csv"), [
      { title: "A", url: "http://arxiv.org/abs/2404.00001" },
    ]);
    buildSummary({ conferenceDir: conf });
    const meta = JSON.parse(readFileSync(join(conf, "summary.meta.json"), "utf-8"));
    expect(meta).toEqual({ source: "papers_2026-04-18.csv" });
  });

  it("names the explicit --input file in the sidecar, not the newest dated CSV alongside it", () => {
    const conf = join(tmpDir, "neurips-2025");
    const row: PapersCsvRow = {
      title: "A",
      authors: "X",
      abstract: "x",
      url: "https://arxiv.org/abs/2404.00008",
      pdf_url: "p",
    };
    writePapersCsv(join(conf, "papers_2025-12-01.csv"), [row]);
    writePapersCsv(join(conf, "papers_2026-01-01.csv"), [row]);

    buildSummary({ conferenceDir: conf, inputCsv: join(conf, "papers_2025-12-01.csv") });

    const meta = JSON.parse(readFileSync(join(conf, "summary.meta.json"), "utf-8"));
    expect(meta).toEqual({ source: "papers_2025-12-01.csv" });
  });

  it("removes a stale sidecar when --input points outside the conference dir", () => {
    const conf = join(tmpDir, "iclr-2026");
    writePapersCsv(join(conf, "papers_2026-04-18.csv"), [
      { title: "A", url: "http://arxiv.org/abs/2404.00001" },
    ]);
    buildSummary({ conferenceDir: conf }); // creates the sidecar
    expect(() => readFileSync(join(conf, "summary.meta.json"))).not.toThrow();

    const elsewhere = join(tmpDir, "elsewhere.csv");
    writePapersCsv(elsewhere, [{ title: "B", url: "http://arxiv.org/abs/2404.00002" }]);
    buildSummary({ conferenceDir: conf, inputCsv: elsewhere });
    expect(() => readFileSync(join(conf, "summary.meta.json"))).toThrow();
  });

  // LOW: the same-directory check must resolve symlinks (matching Python's
  // `Path.resolve()`), not just compare lexical paths — a conference
  // directory reached through a symlink to the same real location as the
  // source CSV is still "the same directory" and should still get a sidecar.
  it("writes the sidecar when --input's real directory matches conferenceDir only via a symlink", () => {
    const real = join(tmpDir, "real-iclr-2026");
    writePapersCsv(join(real, "papers_2026-04-18.csv"), [
      { title: "A", url: "http://arxiv.org/abs/2404.00001" },
    ]);
    const viaSymlink = join(tmpDir, "iclr-2026-alias");
    symlinkSync(real, viaSymlink);

    // conferenceDir is the symlink; --input is the SAME file reached by its
    // real (non-symlinked) path — lexically different strings, same
    // physical directory, so the sidecar must still be written.
    buildSummary({ conferenceDir: viaSymlink, inputCsv: join(real, "papers_2026-04-18.csv") });

    const meta = JSON.parse(readFileSync(join(real, "summary.meta.json"), "utf-8"));
    expect(meta).toEqual({ source: "papers_2026-04-18.csv" });
  });
});
