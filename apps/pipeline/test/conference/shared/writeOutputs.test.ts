/**
 * Port of the `write_outputs` / CSV-schema / oral-md parts of
 * `paperpilot/tests/test_collect_conference.py` (CNF-15..19 of
 * docs/migration/safety-contracts.md).
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IdentityError } from "@paperpilot/core/identity";
import { InvalidConferenceSlugError } from "@paperpilot/core/slug";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { type ConferenceRow, CSV_COLUMNS } from "../../../src/conference/shared/csvColumns.js";
import { writeOutputs } from "../../../src/conference/shared/writeOutputs.js";

// CNF-19 "atomic write" mutant check: wraps the real `atomicWriteText` so
// the file still actually gets written (every other test's assertions
// stay valid), but records every call — the mutant this guards against is
// `writeOutputs` switching to a direct `fs.writeFileSync` (which would
// never call this wrapper at all, so `atomicWriteCalls` would stay empty).
const atomicWriteCalls: string[] = [];
vi.mock("../../../src/collect/state/atomic.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../../src/collect/state/atomic.js")>();
  return {
    ...real,
    atomicWriteText: (path: string, text: string, options?: unknown) => {
      atomicWriteCalls.push(path);
      return real.atomicWriteText(path, text, options as never);
    },
  };
});

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "write-outputs-"));
  atomicWriteCalls.length = 0;
});

/** Minimal CSV parser for test assertions (no quoted-comma fields in these fixtures). */
function parseCsv(text: string): Record<string, string>[] {
  const body = text.replace(/^﻿/, "");
  const lines = body.split("\r\n").filter((l) => l.length > 0);
  const header = lines[0]!.split(",");
  return lines.slice(1).map((line) => {
    const cells = splitCsvLine(line);
    const row: Record<string, string> = {};
    for (const [i, h] of header.entries()) row[h] = cells[i] ?? "";
    return row;
  });
}

function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i <= line.length) {
    if (line[i] === '"') {
      let j = i + 1;
      let s = "";
      while (j < line.length) {
        if (line[j] === '"' && line[j + 1] === '"') {
          s += '"';
          j += 2;
        } else if (line[j] === '"') {
          j++;
          break;
        } else {
          s += line[j];
          j++;
        }
      }
      out.push(s);
      i = j + 1; // skip comma
    } else {
      const comma = line.indexOf(",", i);
      if (comma === -1) {
        out.push(line.slice(i));
        i = line.length + 1;
      } else {
        out.push(line.slice(i, comma));
        i = comma + 1;
      }
    }
  }
  return out;
}

function openreviewRow(overrides: Partial<ConferenceRow> = {}): ConferenceRow {
  return {
    title: "P",
    authors: "",
    venue: "ICLR",
    venue_tier: 1,
    citation_count: 0,
    github_stars: 0,
    arxiv_id: "",
    abstract: "",
    url: "https://openreview.net/forum?id=abc123",
    pdf_url: "https://openreview.net/pdf?id=abc123",
    comment: "",
    ...overrides,
  };
}

describe("writeOutputs: schema + CSV bytes", () => {
  it("writes the shared CSV schema with the identity projection filled in", () => {
    const csvPath = writeOutputs("iclr-2025", [openreviewRow()], [], {
      outputRoot: tmp,
      date: "2026-06-28",
    });
    expect(csvPath).toBe(join(tmp, "iclr-2025", "papers_2026-06-28.csv"));
    const rows = parseCsv(readFileSync(csvPath, "utf-8"));
    expect(Object.keys(rows[0]!)).toEqual([...CSV_COLUMNS]);
    expect(rows[0]!.source).toBe("openreview");
    expect(rows[0]!.source_id).toBe("abc123");
  });

  it("writes a UTF-8-sig BOM", () => {
    const csvPath = writeOutputs("iclr-2025", [openreviewRow()], [], {
      outputRoot: tmp,
      date: "2026-06-28",
    });
    const raw = readFileSync(csvPath);
    expect(raw[0]).toBe(0xef);
    expect(raw[1]).toBe(0xbb);
    expect(raw[2]).toBe(0xbf);
  });

  it("restval='' for a row missing most of the shared columns", () => {
    const sparse: ConferenceRow = {
      title: "P",
      authors: "",
      abstract: "",
      url: "https://openreview.net/forum?id=abc123",
    };
    const csvPath = writeOutputs("iclr-2025", [sparse], [], {
      outputRoot: tmp,
      date: "2026-06-28",
    });
    const rows = parseCsv(readFileSync(csvPath, "utf-8"));
    expect(rows[0]!.venue_tier).toBe("");
    expect(rows[0]!.citation_count).toBe("");
  });
});

describe("writeOutputs: oral_summaries_ja.md (CNF-15 / CNF-16)", () => {
  it("writes the markdown in the exact Python-equivalent layout", () => {
    writeOutputs("iclr-2025", [openreviewRow()], ["Oral one", "Oral two"], {
      outputRoot: tmp,
      date: "2026-06-28",
    });
    const md = readFileSync(join(tmp, "iclr-2025", "oral_summaries_ja.md"), "utf-8");
    expect(md).toBe(
      "# iclr-2025 Oral / Highlight\n\n*Oral / Highlight と判定された採択論文*\n\n## 1. Oral one\n## 2. Oral two\n",
    );
  });

  it("CNF-15: an empty oral list keeps an existing published oral_summaries_ja.md", () => {
    const confDir = join(tmp, "iclr-2025");
    mkdirSync(confDir, { recursive: true });
    const oralMd = join(confDir, "oral_summaries_ja.md");
    writeFileSync(oralMd, "# old\n## 1. Some Old Oral Title\n", "utf-8");

    writeOutputs("iclr-2025", [openreviewRow()], [], { outputRoot: tmp, date: "2026-06-28" });

    expect(readFileSync(oralMd, "utf-8")).toBe("# old\n## 1. Some Old Oral Title\n");
  });

  it("CNF-16: --clear-oral deletes an existing oral_summaries_ja.md when the list is empty", () => {
    const confDir = join(tmp, "iclr-2025");
    mkdirSync(confDir, { recursive: true });
    const oralMd = join(confDir, "oral_summaries_ja.md");
    writeFileSync(oralMd, "# old\n## 1. Some Old Oral Title\n", "utf-8");

    writeOutputs("iclr-2025", [openreviewRow()], [], {
      outputRoot: tmp,
      date: "2026-06-28",
      clearOral: true,
    });

    expect(existsSync(oralMd)).toBe(false);
  });

  it("a non-empty oral list is written even when clearOral is also set", () => {
    writeOutputs("iclr-2025", [openreviewRow()], ["Fresh Oral"], {
      outputRoot: tmp,
      date: "2026-06-28",
      clearOral: true,
    });
    const md = readFileSync(join(tmp, "iclr-2025", "oral_summaries_ja.md"), "utf-8");
    expect(md).toContain("## 1. Fresh Oral");
  });
});

describe("writeOutputs: CNF-17 path traversal / slug validation", () => {
  it("rejects a malicious --conference value and writes nothing", () => {
    for (const bad of ["../../etc/passwd", "..", "/etc/passwd", "cvpr/../../escape", ""]) {
      expect(() =>
        writeOutputs(bad, [openreviewRow()], [], { outputRoot: tmp, date: "2026-06-28" }),
      ).toThrow(InvalidConferenceSlugError);
    }
    expect(existsSync(join(tmp, "..", "etc"))).toBe(false);
  });

  it("rejects uppercase/space/underscore slugs", () => {
    for (const bad of ["CVPR-2026", "cvpr 2026", "cvpr_2026", "-cvpr-2026", "cvpr-2026-"]) {
      expect(() =>
        writeOutputs(bad, [openreviewRow()], [], { outputRoot: tmp, date: "2026-06-28" }),
      ).toThrow(InvalidConferenceSlugError);
    }
  });

  it("LOW: rejects a slug-shaped conference dir that is actually a symlink escaping outputRoot", () => {
    // The slug itself is perfectly valid ("escaped-conf" passes
    // validateConferenceSlug), so this is NOT the regex-level traversal
    // case above — it's a symlink planted at the join()'d path itself.
    // A purely lexical path.resolve()-based containment check cannot see
    // this: it never touches the filesystem, so it sees
    // "<tmp>/escaped-conf" as textually "within" <tmp> regardless of what
    // that path actually resolves to on disk.
    const outside = mkdtempSync(join(tmpdir(), "write-outputs-outside-"));
    symlinkSync(outside, join(tmp, "escaped-conf"));
    expect(() =>
      writeOutputs("escaped-conf", [openreviewRow()], [], { outputRoot: tmp, date: "2026-06-28" }),
    ).toThrow(/escapes/);
    // Nothing was written into the symlink target either.
    expect(existsSync(join(outside, "papers_2026-06-28.csv"))).toBe(false);
  });
});

describe("writeOutputs: CNF-18 identity consistency", () => {
  it("throws IdentityError when source is declared without source_id", () => {
    const row = openreviewRow({ source: "openreview" }); // source_id missing
    expect(() => writeOutputs("iclr-2025", [row], [], { outputRoot: tmp })).toThrow(IdentityError);
  });

  it("CNF-18: throws IdentityError when source_id is declared without source (the OTHER half of the pair check)", () => {
    const row = openreviewRow({ source_id: "abc123" }); // source missing
    expect(() => writeOutputs("iclr-2025", [row], [], { outputRoot: tmp })).toThrow(IdentityError);
  });

  it("throws IdentityError when declared source/source_id mismatches the native URL", () => {
    const row = openreviewRow({ source: "arxiv", source_id: "2604.00001" });
    expect(() => writeOutputs("iclr-2025", [row], [], { outputRoot: tmp })).toThrow(IdentityError);
  });

  it("leaves an (empty) conference directory behind on an IdentityError (mkdir precedes projection)", () => {
    const row = openreviewRow({ source: "openreview" });
    expect(() => writeOutputs("iclr-2025", [row], [], { outputRoot: tmp })).toThrow(IdentityError);
    expect(existsSync(join(tmp, "iclr-2025"))).toBe(true);
    expect(readdirSync(join(tmp, "iclr-2025"))).toEqual([]);
  });
});

describe("writeOutputs: CNF-19 atomic write + formula neutralization", () => {
  it("neutralizes a spreadsheet formula payload in title/abstract but leaves a plain URL alone", () => {
    const row: ConferenceRow = {
      title: '=HYPERLINK("http://evil.example","click")',
      authors: "A; B",
      abstract: "@SUM(1+1)*cmd",
      url: "https://openreview.net/forum?id=zzz1",
      source: "openreview",
      source_id: "zzz1",
    };
    const csvPath = writeOutputs("cvpr-2026", [row], [], { outputRoot: tmp, date: "2026-09-26" });
    const rows = parseCsv(readFileSync(csvPath, "utf-8"));
    expect(rows[0]!.title!.startsWith("'=HYPERLINK")).toBe(true);
    expect(rows[0]!.abstract!.startsWith("'@SUM")).toBe(true);
    expect(rows[0]!.url).toBe("https://openreview.net/forum?id=zzz1");
  });

  it("leaves ordinary text untouched", () => {
    const row: ConferenceRow = {
      title: "Retrieval-Augmented Generation for Knowledge Tasks",
      authors: "A; B",
      abstract: "We propose a method.",
      url: "https://openreview.net/forum?id=zzz2",
      source: "openreview",
      source_id: "zzz2",
    };
    const csvPath = writeOutputs("cvpr-2026", [row], [], { outputRoot: tmp, date: "2026-09-26" });
    const rows = parseCsv(readFileSync(csvPath, "utf-8"));
    expect(rows[0]!.title).toBe("Retrieval-Augmented Generation for Knowledge Tasks");
    expect(rows[0]!.abstract).toBe("We propose a method.");
  });

  it("CNF-19: both the CSV and the oral md go through atomicWriteText, not a direct writeFileSync", () => {
    const csvPath = writeOutputs("cvpr-2026", [openreviewRow()], ["Some Oral"], {
      outputRoot: tmp,
      date: "2026-09-26",
    });
    const oralMdPath = join(tmp, "cvpr-2026", "oral_summaries_ja.md");
    expect(atomicWriteCalls).toContain(csvPath);
    expect(atomicWriteCalls).toContain(oralMdPath);
    expect(atomicWriteCalls.length).toBe(2);
  });
});

describe("writeOutputs: default date from injected clock", () => {
  it("uses deps.now() when date is omitted", () => {
    const csvPath = writeOutputs(
      "iclr-2025",
      [openreviewRow()],
      [],
      { outputRoot: tmp },
      { now: () => new Date("2026-07-04T00:00:00Z") },
    );
    expect(csvPath).toBe(join(tmp, "iclr-2025", "papers_2026-07-04.csv"));
  });
});
