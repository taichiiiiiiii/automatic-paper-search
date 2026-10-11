/**
 * Official conference listings keyed by the `conference_site` identity
 * namespace (R3-4, design 52 §8.6): NeurIPS / ICLR proceedings, ECVA open
 * access and the (gated) virtual-site Downloads export. Recorded excerpts
 * fetched 2026-10-11 (`../fixtures/proceedings/README.md`).
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { identityFromUrl } from "@paperpilot/core/identity";
import { describe, expect, it } from "vitest";
import { CliUsageError } from "../../../src/conference/shared/cliArgs.js";
import { runSiteMain, type SiteRequestInit } from "../../../src/conference/site/main.js";
import {
  parseEcvaListing,
  parseProceedingsSiteListing,
  parseVirtualSiteExport,
  proceedingsPdfUrl,
  splitExportAuthors,
} from "../../../src/conference/site/parsers.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const fx = (name: string) => readFileSync(join(HERE, "../fixtures/proceedings", name), "utf-8");

const ICLR_2025 = fx("iclr_2025_proceedings_listing_excerpt.html");
const NIPS_2024 = fx("neurips_2024_listing_excerpt.html");
const ECVA = fx("ecva_papers_excerpt.html");
const VIRTUAL = fx("neurips_2026_virtual_downloads_excerpt.csv");

const ok = (body: string) => ({ status: 200, text: async () => body });
const fixedNow = () => new Date("2026-10-11T00:00:00Z");

function readCsv(dir: string): string {
  const f = readdirSync(dir).find((n) => n.startsWith("papers_"));
  if (!f) throw new Error("no csv");
  return readFileSync(join(dir, f), "utf-8");
}

describe("proceedings sites (papers.nips.cc / proceedings.iclr.cc)", () => {
  it("parses the ICLR listing into conference_site ids with the site's PDF link", () => {
    const r = parseProceedingsSiteListing(ICLR_2025, "iclr", 2025, new Set(["conference"]));
    expect(r.malformed).toBe(0);
    expect(r.entries).toHaveLength(3);
    const e = r.entries[0];
    expect(e?.title).toBe("Generalization and Distributed Learning of GFlowNets");
    expect(e?.authors[0]).toBe("Tiago Silva");
    expect(e?.url).toBe(
      "https://proceedings.iclr.cc/paper_files/paper/2025/hash/000eba875068854d5ff003b1fa534cd6-Abstract-Conference.html",
    );
    expect(e?.pdfUrl).toBe(
      "https://proceedings.iclr.cc/paper_files/paper/2025/file/000eba875068854d5ff003b1fa534cd6-Paper-Conference.pdf",
    );
    expect(identityFromUrl(e?.url as string).sourceId).toBe(
      "iclr-2025-hash-000eba875068854d5ff003b1fa534cd6",
    );
  });

  it("filters NeurIPS tracks and counts the rest as skipped", () => {
    const r = parseProceedingsSiteListing(NIPS_2024, "neurips", 2024, new Set(["conference"]));
    expect(r.entries).toHaveLength(2);
    expect(r.skipped).toEqual({ "track:datasets_and_benchmarks_track": 1 });
    for (const e of r.entries) expect(identityFromUrl(e.url).source).toBe("conference_site");
  });

  it("derives no PDF link from an unexpected URL", () => {
    expect(proceedingsPdfUrl("https://example.org/x")).toBe("");
  });

  it("writes a listing-only catalog (no abstracts) with its source_license.json", async () => {
    const out = mkdtempSync(join(tmpdir(), "site-"));
    const lines: string[] = [];
    const requested: string[] = [];
    const code = await runSiteMain(
      [
        "--conference",
        "iclr-2025",
        "--venue",
        "ICLR",
        "--kind",
        "proceedings",
        "--site",
        "iclr",
        "--year",
        "2025",
      ],
      {
        outputRoot: out,
        now: fixedNow,
        print: (l) => lines.push(l),
        fetch: async (url) => {
          requested.push(url);
          return ok(ICLR_2025);
        },
      },
    );
    expect(code).toBe(0);
    expect(requested).toEqual(["https://proceedings.iclr.cc/paper_files/paper/2025"]);
    const csv = readCsv(join(out, "iclr-2025"));
    expect(csv).toContain("conference_site,iclr-2025-hash-000eba875068854d5ff003b1fa534cd6");
    const lic = JSON.parse(readFileSync(join(out, "iclr-2025", "source_license.json"), "utf-8"));
    expect(lic).toMatchObject({
      source: "iclr_proceedings",
      license: null,
      abstracts: "omitted",
      paper_count: 3,
    });
  });

  it("refuses when the listing is not published yet (404) and writes nothing", async () => {
    const out = mkdtempSync(join(tmpdir(), "site-"));
    const code = await runSiteMain(
      [
        "--conference",
        "neurips-2026",
        "--venue",
        "NEURIPS",
        "--kind",
        "proceedings",
        "--site",
        "neurips",
        "--year",
        "2026",
      ],
      {
        outputRoot: out,
        print: () => {},
        fetch: async () => ({ status: 404, text: async () => "" }),
      },
    );
    expect(code).toBe(1);
    expect(existsSync(join(out, "neurips-2026"))).toBe(false);
  });
});

describe("ECVA open access (papers.php)", () => {
  it("parses the ECCV 2024 section, strips the equal-contribution stars", () => {
    const r = parseEcvaListing(ECVA, 2024);
    expect(r).not.toBeNull();
    expect(r?.malformed).toBe(0);
    expect(r?.entries).toHaveLength(3);
    expect(r?.entries[0]).toEqual({
      title:
        "Is Retain Set All You Need in Machine Unlearning? Restoring Performance of Unlearned Models with Out-Of-Distribution Images",
      authors: ["Jacopo Bonato", "Marco Cotogni", "Luigi Sabetta"],
      url: "https://www.ecva.net/papers/eccv_2024/papers_ECCV/html/4_ECCV_2024_paper.php",
      pdfUrl: "https://www.ecva.net/papers/eccv_2024/papers_ECCV/papers/00004.pdf",
    });
    expect(identityFromUrl(r?.entries[0]?.url as string).sourceId).toBe("eccv-2024-ecva-4");
  });

  it("returns null for a year with no section (ECCV 2026 on 2026-10-11)", () => {
    expect(parseEcvaListing(ECVA, 2026)).toBeNull();
  });

  it("reads another year's section only (ECCV 2022 uses the same file-name form)", () => {
    const r = parseEcvaListing(ECVA, 2022);
    expect(r?.malformed).toBe(0);
    expect(r?.entries.map((e) => identityFromUrl(e.url).sourceId)).toEqual(["eccv-2022-ecva-19"]);
  });

  it("counts an entry in an unexpected form as malformed rather than guessing", () => {
    const odd = ECVA.replace("html/19_ECCV_2022_paper.php", "html/136620266.php");
    const r = parseEcvaListing(odd, 2022);
    expect(r?.entries).toHaveLength(0);
    expect(r?.malformed).toBe(1);
  });

  it("exits 1 without writing when the year is missing", async () => {
    const out = mkdtempSync(join(tmpdir(), "site-"));
    const lines: string[] = [];
    const code = await runSiteMain(
      ["--conference", "eccv-2026", "--venue", "ECCV", "--kind", "ecva", "--year", "2026"],
      { outputRoot: out, print: (l) => lines.push(l), fetch: async () => ok(ECVA) },
    );
    expect(code).toBe(1);
    expect(lines.join("\n")).toContain('no "ECCV 2026 Papers" section');
    expect(existsSync(join(out, "eccv-2026"))).toBe(false);
  });
});

describe("virtual site Downloads export (gated, design 52 D6)", () => {
  it("keeps poster rows only, drops affiliations, never reads the abstract", () => {
    const r = parseVirtualSiteExport(VIRTUAL, "neurips", 2026);
    expect(r.malformed).toBe(0);
    expect(r.skipped).toMatchObject({ "non-poster-url": 1, repaired_affiliation_parens: 1 });
    expect(r.entries).toHaveLength(5);
    expect(r.entries[0]?.authors).toEqual([
      "Xiang Zhang",
      "Yang Zhang",
      "Lukas Mehl",
      "Karlis M Briedis",
      "Markus Gross",
      "Christopher Schroers",
    ]);
    expect(identityFromUrl(r.entries[0]?.url as string).sourceId).toBe(
      "neurips-2026-poster-154295",
    );
    expect(JSON.stringify(r.entries)).not.toContain("abstract removed");
  });

  it("splits authors around nested, stray and unclosed affiliation parentheses", () => {
    expect(splitExportAuthors("A (U (G)), B, C (X, Y)")).toEqual({
      names: ["A", "B", "C"],
      repaired: false,
    });
    expect(splitExportAuthors("A (KAIST)), B &amp; C (Z)")).toEqual({
      names: ["A", "B & C"],
      repaired: true,
    });
    expect(splitExportAuthors("A (U), B (Science（Gua")).toEqual({
      names: ["A", "B"],
      repaired: true,
    });
  });

  it("refuses without --allow-virtual-site (usage error, no request)", async () => {
    let called = false;
    await expect(
      runSiteMain(
        [
          "--conference",
          "neurips-2026",
          "--venue",
          "NEURIPS",
          "--kind",
          "virtual-export",
          "--site",
          "neurips",
          "--year",
          "2026",
        ],
        {
          outputRoot: mkdtempSync(join(tmpdir(), "site-")),
          print: () => {},
          fetch: async () => {
            called = true;
            return ok("");
          },
        },
      ),
    ).rejects.toBeInstanceOf(CliUsageError);
    expect(called).toBe(false);
  });

  it("submits the Downloads form once (CSRF token + cookie) when allowed", async () => {
    const out = mkdtempSync(join(tmpdir(), "site-"));
    const calls: Array<{ url: string; init?: SiteRequestInit }> = [];
    const code = await runSiteMain(
      [
        "--conference",
        "neurips-2026",
        "--venue",
        "NEURIPS",
        "--kind",
        "virtual-export",
        "--site",
        "neurips",
        "--year",
        "2026",
        "--allow-virtual-site",
      ],
      {
        outputRoot: out,
        now: fixedNow,
        print: () => {},
        fetch: async (url, init) => {
          calls.push({ url, init });
          if (!init?.method || init.method === "GET") {
            return {
              status: 200,
              headers: {
                get: (n: string) =>
                  n === "set-cookie" ? "csrftoken=abc; Path=/; SameSite=Lax" : null,
              },
              text: async () => '<input type="hidden" name="csrfmiddlewaretoken" value="TOKEN123">',
            };
          }
          return ok(VIRTUAL);
        },
      },
    );
    expect(code).toBe(0);
    expect(calls).toHaveLength(2);
    expect(calls[1]?.init?.method).toBe("POST");
    expect(calls[1]?.init?.headers?.Cookie).toBe("csrftoken=abc");
    expect(calls[1]?.init?.body).toContain("csrfmiddlewaretoken=TOKEN123");
    expect(calls[1]?.init?.body).toContain("posters=on");
    const lic = JSON.parse(readFileSync(join(out, "neurips-2026", "source_license.json"), "utf-8"));
    expect(lic).toMatchObject({
      source: "virtual_site_export",
      abstracts: "omitted",
      paper_count: 5,
    });
    expect(readCsv(join(out, "neurips-2026"))).not.toContain("abstract removed");
  });
});
