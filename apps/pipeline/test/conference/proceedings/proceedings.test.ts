/**
 * Official-proceedings adapters (R3-1, user decision D5=A) on recorded
 * excerpts of the live sources (fetched 2026-10-11; see
 * `../fixtures/proceedings/README.md`).
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parsePapers, runCollectAclMain } from "../../../src/conference/acl/anthology.js";
import { parseListingEntries } from "../../../src/conference/cvf/listing.js";
import { runCvfMain } from "../../../src/conference/cvf/main.js";
import { runNeuripsReconcile } from "../../../src/conference/neurips/cli.js";
import {
  parseNeuripsListing,
  reconcileWithCatalog,
  titleKey,
} from "../../../src/conference/neurips/listing.js";
import { runPmlrMain } from "../../../src/conference/pmlr/main.js";
import {
  cleanBibText,
  parseBibAbstracts,
  parseVolumeHtml,
} from "../../../src/conference/pmlr/volume.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const fx = (name: string) => readFileSync(join(HERE, "../fixtures/proceedings", name), "utf-8");

const PMLR_HTML = fx("pmlr_v306_volume_excerpt.html");
const PMLR_BIB = fx("pmlr_v306_bibliography_excerpt.bib");
const ACL_XML = fx("acl_2026_anthology_excerpt.xml");
const CVF_HTML = fx("cvf_cvpr2026_listing_excerpt.html");
const NIPS_2024 = fx("neurips_2024_listing_excerpt.html");
const NIPS_2025 = fx("neurips_2025_listing_excerpt.html");

const ok = (body: string) => ({ status: 200, text: async () => body });
const notFound = () => ({ status: 404, text: async () => "" });
const fixedNow = () => new Date("2026-10-11T00:00:00Z");

function readCsv(dir: string): string {
  const f = readdirSync(dir).find((n) => n.startsWith("papers_"));
  if (!f) throw new Error("no csv");
  return readFileSync(join(dir, f), "utf-8");
}

// ---------------------------------------------------------------------------
// PMLR
// ---------------------------------------------------------------------------

describe("PMLR volume page", () => {
  it("parses title, authors, landing, PDF, OpenReview id and citation", () => {
    const { entries, blockCount, malformed } = parseVolumeHtml(PMLR_HTML, 306);
    expect(blockCount).toBe(3);
    expect(malformed).toBe(0);
    expect(entries[0]).toEqual({
      key: "abas26a",
      title: "TUR-DPO: Topology- and Uncertainty-Aware Direct Preference Optimization",
      authors: ["Abdulhady Abas", "Fatemeh Daneshfar", "Seyedali Mirjalili", "Mourad Oussalah"],
      landingUrl: "https://proceedings.mlr.press/v306/abas26a.html",
      pdfUrl: "https://raw.githubusercontent.com/mlresearch/v306/main/assets/abas26a/abas26a.pdf",
      openreviewId: "YDztzMJynP",
      citation: "PMLR 306:1-21",
    });
    expect(entries.every((e) => e.openreviewId !== null)).toBe(true);
  });

  it("a block for another volume counts as malformed", () => {
    expect(parseVolumeHtml(PMLR_HTML, 267).malformed).toBe(3);
  });
});

describe("PMLR bibliography", () => {
  it("extracts every abstract by paper key, unwrapping case-protection braces", () => {
    const abs = parseBibAbstracts(PMLR_BIB, 306);
    expect([...abs.keys()].sort()).toEqual(["abas26a", "abbadi26a", "abbasi26a"]);
    expect(abs.get("abas26a")).toMatch(/^Aligning large language models \(LLMs\) with human/);
    expect(abs.get("abas26a")).not.toMatch(/[{}]/);
  });

  it("keeps LaTeX commands and math verbatim", () => {
    expect(cleanBibText("A {BERT} model with $O(n^{2})$ cost and \\{x\\}")).toBe(
      "A BERT model with $O(n^2)$ cost and \\{x\\}",
    );
  });
});

describe("runPmlrMain", () => {
  const argv = ["--conference", "icml-2026", "--venue", "ICML", "--volume", "306"];

  it("writes OpenReview-keyed rows with PMLR PDFs/abstracts and a CC BY 4.0 sidecar", async () => {
    const out = mkdtempSync(join(tmpdir(), "pmlr-"));
    const urls: string[] = [];
    const rc = await runPmlrMain(argv, {
      outputRoot: out,
      now: fixedNow,
      print: () => {},
      fetchText: async (url) => {
        urls.push(url);
        return url.endsWith(".bib") ? ok(PMLR_BIB) : ok(PMLR_HTML);
      },
    });
    expect(rc).toBe(0);
    expect(urls).toEqual([
      "https://proceedings.mlr.press/v306/",
      "https://proceedings.mlr.press/v306/assets/bib/bibliography.bib",
    ]);
    const csv = readCsv(join(out, "icml-2026"));
    expect(csv).toContain("https://openreview.net/forum?id=YDztzMJynP");
    expect(csv).toContain(",openreview,YDztzMJynP");
    expect(csv).toContain("Aligning large language models");
    const lic = JSON.parse(readFileSync(join(out, "icml-2026", "source_license.json"), "utf-8"));
    expect(lic).toMatchObject({
      source: "pmlr",
      license: "CC-BY-4.0",
      abstracts: "included",
      paper_count: 3,
    });
    expect(lic.landing_urls.YDztzMJynP).toBe("https://proceedings.mlr.press/v306/abas26a.html");
  });

  it("--no-abstract skips the bibliography and leaves abstracts empty", async () => {
    const out = mkdtempSync(join(tmpdir(), "pmlr-"));
    const urls: string[] = [];
    const rc = await runPmlrMain([...argv, "--no-abstract"], {
      outputRoot: out,
      now: fixedNow,
      print: () => {},
      fetchText: async (url) => {
        urls.push(url);
        return ok(PMLR_HTML);
      },
    });
    expect(rc).toBe(0);
    expect(urls).toHaveLength(1);
    expect(readCsv(join(out, "icml-2026"))).not.toContain("Aligning large language models");
  });

  it("refuses a volume where a paper has no OpenReview link", async () => {
    const out = mkdtempSync(join(tmpdir(), "pmlr-"));
    const html = PMLR_HTML.replace(
      /href="https:\/\/openreview\.net\/forum\?id=YDztzMJynP"/,
      'href="#"',
    );
    const rc = await runPmlrMain(argv, {
      outputRoot: out,
      print: () => {},
      fetchText: async (url) => (url.endsWith(".bib") ? ok(PMLR_BIB) : ok(html)),
    });
    expect(rc).toBe(1);
    expect(existsSync(join(out, "icml-2026"))).toBe(false);
  });

  it("refuses when a paper block no longer parses (layout change)", async () => {
    const out = mkdtempSync(join(tmpdir(), "pmlr-"));
    const html = PMLR_HTML.replace('<span class="authors">', '<span class="writers">');
    const rc = await runPmlrMain(argv, {
      outputRoot: out,
      print: () => {},
      fetchText: async (url) => (url.endsWith(".bib") ? ok(PMLR_BIB) : ok(html)),
    });
    expect(rc).toBe(1);
    expect(existsSync(join(out, "icml-2026"))).toBe(false);
  });

  it("refuses when the volume page is missing", async () => {
    const out = mkdtempSync(join(tmpdir(), "pmlr-"));
    const rc = await runPmlrMain(argv, {
      outputRoot: out,
      print: () => {},
      fetchText: async () => notFound(),
    });
    expect(rc).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// ACL Anthology (2026 XML excerpt)
// ---------------------------------------------------------------------------

describe("ACL Anthology 2026 excerpt", () => {
  it("keeps main-track (long/short) papers only, with Anthology links", () => {
    const rows = parsePapers(ACL_XML, "acl");
    expect(rows).toHaveLength(3);
    expect(rows[0]?.title).toBe(
      "OctoTools: A Multi-Agent Framework with Extensible Tools for Complex Reasoning",
    );
    expect(rows[0]?.url).toBe("https://aclanthology.org/2026.acl-long.1/");
    expect(rows.every((r) => String(r.url).match(/2026\.acl-(long|short)\./))).toBe(true);
  });

  it("writes a CC BY 4.0 attribution sidecar next to the CSV", async () => {
    const out = mkdtempSync(join(tmpdir(), "acl-"));
    const rc = await runCollectAclMain(
      ["--conference", "acl-2026", "--venue", "acl", "--xml-id", "2026.acl"],
      { outputRoot: out, now: fixedNow, print: () => {}, fetchXmlText: async () => ok(ACL_XML) },
    );
    expect(rc).toBe(0);
    const lic = JSON.parse(readFileSync(join(out, "acl-2026", "source_license.json"), "utf-8"));
    expect(lic).toMatchObject({
      source: "acl_anthology",
      license: "CC-BY-4.0",
      license_url: "https://creativecommons.org/licenses/by/4.0/",
      abstracts: "included",
      paper_count: 3,
    });
    expect(lic.attribution).toMatch(/ACL Anthology/);
  });
});

// ---------------------------------------------------------------------------
// CVF listing-only
// ---------------------------------------------------------------------------

describe("CVF listing-only", () => {
  it("parses titles, authors and PDF paths from the year listing", () => {
    const { entries, blockCount, malformed } = parseListingEntries(CVF_HTML, "CVPR2026");
    expect(blockCount).toBe(3);
    expect(malformed).toBe(0);
    expect(entries[0]?.title).toBe(
      "Generalizable Structure-Aware Keypoint Correspondence for Category-Unified 3D Single Object Tracking",
    );
    expect(entries[0]?.authors.slice(0, 2)).toEqual(["Jie Xiao", "Yinchao Ma"]);
    expect(entries[0]?.pdfPath).toMatch(/^\/content\/CVPR2026\/papers\/.+\.pdf$/);
  });

  it("--listing-only makes one request, stores no abstracts and records 'no licence'", async () => {
    const out = mkdtempSync(join(tmpdir(), "cvf-"));
    const urls: string[] = [];
    const rc = await runCvfMain(
      ["--conference", "cvpr-2026", "--venue", "CVPR", "--cvf-id", "CVPR2026", "--listing-only"],
      {
        outputRoot: out,
        now: fixedNow,
        print: () => {},
        logger: { warn: () => {} },
        arxiv: { fetchText: async () => ok("") },
        cvf: {
          fetchImpl: async (url: string) => {
            urls.push(url);
            return { status: 200, text: async () => CVF_HTML, json: async () => ({}) };
          },
        },
      },
    );
    expect(rc).toBe(0);
    expect(urls).toEqual(["https://openaccess.thecvf.com/CVPR2026?day=all"]);
    const csv = readCsv(join(out, "cvpr-2026"));
    const lines = csv.trim().split(/\r\n/);
    expect(lines).toHaveLength(4);
    const lic = JSON.parse(readFileSync(join(out, "cvpr-2026", "source_license.json"), "utf-8"));
    expect(lic).toMatchObject({ source: "cvf_open_access", license: null, abstracts: "omitted" });
  });

  it("--listing-only refuses a listing whose entries stop parsing", async () => {
    const out = mkdtempSync(join(tmpdir(), "cvf-"));
    const broken = CVF_HTML.replaceAll('name="query_author"', 'name="author"');
    const rc = await runCvfMain(
      ["--conference", "cvpr-2026", "--venue", "CVPR", "--cvf-id", "CVPR2026", "--listing-only"],
      {
        outputRoot: out,
        print: () => {},
        logger: { warn: () => {} },
        arxiv: { fetchText: async () => ok("") },
        cvf: {
          fetchImpl: async () => ({
            status: 200,
            text: async () => broken,
            json: async () => ({}),
          }),
        },
      },
    );
    expect(rc).toBe(1);
    expect(existsSync(join(out, "cvpr-2026"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// NeurIPS proceedings (reconcile only)
// ---------------------------------------------------------------------------

describe("NeurIPS proceedings listing", () => {
  it("parses main-track and D&B entries with their track and hash", () => {
    const { entries, malformed } = parseNeuripsListing(NIPS_2024, 2024);
    expect(malformed).toBe(0);
    expect(entries.map((e) => e.track)).toEqual([
      "conference",
      "conference",
      "datasets_and_benchmarks_track",
    ]);
    expect(entries[0]).toMatchObject({
      title:
        "MicroAdam: Accurate Adaptive Optimization with Low Space Overhead and Provable Convergence",
      hash: "000f947dcaff8fbffcc3f53a1314f358",
    });
    expect(entries[0]?.authors[0]).toBe("Ionut-Vlad Modoranu");
  });

  it("reconciles titles against a catalog, ignoring case and punctuation", () => {
    const { entries } = parseNeuripsListing(NIPS_2024, 2024);
    const title0 = entries[0]?.title as string;
    const report = reconcileWithCatalog(
      entries,
      [title0.toUpperCase(), "Some Other Paper"],
      2024,
      new Set(["conference"]),
    );
    expect(report).toMatchObject({
      proceedings_count: 2,
      catalog_count: 2,
      matched: 1,
      only_in_proceedings: 1,
      only_in_catalog: 1,
    });
    expect(titleKey("A-B: c")).toBe("abc");
  });

  it("CLI exits 1 when the year has no main-track papers yet (2025 = Creative AI only)", async () => {
    const lines: string[] = [];
    const rc = await runNeuripsReconcile(["--year", "2025", "--catalog", "c.json"], {
      fetchText: async () => ok(NIPS_2025),
      readFile: () => JSON.stringify([{ title: "x" }]),
      print: (l) => lines.push(l),
    });
    expect(rc).toBe(1);
    expect(lines.at(-1)).toMatch(/creative_ai_track/);
  });
});
