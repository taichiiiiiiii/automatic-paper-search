/**
 * Port of `paperpilot/tests/test_collect_openreview.py` (CNF-01, CNF-02).
 */
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildRows, decision, value } from "../../../src/conference/openreview/buildRows.js";
import { fetchNotes, type OpenReviewNote } from "../../../src/conference/openreview/fetchNotes.js";
import { runOpenreviewMain } from "../../../src/conference/openreview/main.js";
import { CliUsageError } from "../../../src/conference/shared/cliArgs.js";

function note(
  title: string,
  decisionWord: string,
  nid: string,
  opts: { venueid?: string; authors?: string[] } = {},
): OpenReviewNote {
  const venueid = opts.venueid ?? "ICLR.cc/2025/Conference";
  const authors = opts.authors ?? ["Alice", "Bob"];
  const label = `ICLR 2025 ${decisionWord}`.trim();
  return {
    id: nid,
    content: {
      title: { value: title },
      abstract: { value: "an abstract about representation learning" },
      authors: { value: authors },
      venue: { value: label },
      venueid: { value: venueid },
    },
  };
}

describe("value (v2 content unwrap)", () => {
  it("unwraps v2 and passes through plain fields", () => {
    expect(value({ k: { value: "x" } }, "k")).toBe("x");
    expect(value({ k: "plain" }, "k")).toBe("plain");
    expect(value({}, "missing", "dft")).toBe("dft");
  });

  it("a null value returns the default, not null/None", () => {
    expect(value({ abstract: { value: null } }, "abstract", "")).toBe("");
    expect(value({ abstract: null }, "abstract", "")).toBe("");
  });
});

describe("decision", () => {
  it("parses case-insensitively", () => {
    expect(decision("ICLR 2025 Oral")).toBe("Oral");
    expect(decision("NeurIPS 2024 spotlight")).toBe("Spotlight");
    expect(decision("ICLR 2025 Poster")).toBe("Poster");
    expect(decision("Accept")).toBe("");
  });

  it("handles the ICML compound 'spotlightposter'", () => {
    expect(decision("ICML 2025 spotlightposter")).toBe("Spotlight");
  });
});

describe("buildRows", () => {
  it("maps fields and highlights Oral + Spotlight", () => {
    const notes = [
      note("Oral paper", "Oral", "aaa"),
      note("Spotlight paper", "Spotlight", "bbb"),
      note("Poster paper", "Poster", "ccc"),
    ];
    const { rows, highlighted } = buildRows(notes, "ICLR", "ICLR.cc/2025/Conference");
    expect(new Set(rows.map((r) => r.title))).toEqual(
      new Set(["Oral paper", "Spotlight paper", "Poster paper"]),
    );
    expect(rows.every((r) => r.venue === "ICLR" && r.venue_tier === 1)).toBe(true);
    expect(rows.every((r) => r.citation_count === 0 && r.github_stars === 0)).toBe(true);
    const oral = rows.find((r) => r.title === "Oral paper")!;
    expect(oral.url).toBe("https://openreview.net/forum?id=aaa");
    expect(oral.pdf_url).toBe("https://openreview.net/pdf?id=aaa");
    expect(oral.comment).toBe("ICLR 2025 Oral");
    expect(new Set(highlighted)).toEqual(new Set(["Oral paper", "Spotlight paper"]));
  });

  it("joins authors with semicolons", () => {
    const { rows } = buildRows(
      [note("P", "Poster", "x", { authors: ["A", "B", "C"] })],
      "ICLR",
      "ICLR.cc/2025/Conference",
    );
    expect(rows[0]!.authors).toBe("A; B; C");
  });

  it("dedups by note id, keeping the first", () => {
    const notes = [note("First", "Poster", "dup"), note("Second same id", "Poster", "dup")];
    const { rows } = buildRows(notes, "ICLR", "ICLR.cc/2025/Conference");
    expect(rows.length).toBe(1);
    expect(rows[0]!.title).toBe("First");
  });

  it("skips notes with no title or no id", () => {
    const notes: OpenReviewNote[] = [
      note("", "Poster", "has-id"),
      { id: "", content: { title: { value: "no id" } } },
    ];
    const { rows } = buildRows(notes, "ICLR", "ICLR.cc/2025/Conference");
    expect(rows).toEqual([]);
  });

  it("drops notes whose venueid does not match (withdrawn/rejected)", () => {
    const notes = [
      note("Accepted", "Poster", "ok", { venueid: "ICLR.cc/2025/Conference" }),
      note("Withdrawn", "", "wd", { venueid: "ICLR.cc/2025/Conference/Withdrawn_Submission" }),
    ];
    const { rows } = buildRows(notes, "ICLR", "ICLR.cc/2025/Conference");
    expect(rows.map((r) => r.title)).toEqual(["Accepted"]);
  });

  it("a null abstract becomes empty, not the string 'None'", () => {
    const n: OpenReviewNote = {
      id: "n1",
      content: {
        title: { value: "Has null abstract" },
        abstract: { value: null },
        venue: { value: "ICLR 2025 Poster" },
        venueid: { value: "ICLR.cc/2025/Conference" },
        authors: { value: ["A"] },
      },
    };
    const { rows } = buildRows([n], "ICLR", "ICLR.cc/2025/Conference");
    expect(rows[0]!.abstract).toBe("");
  });
});

function pageOf(notes: OpenReviewNote[]) {
  return { status: 200, json: async () => ({ notes }) };
}

describe("fetchNotes (CNF-01)", () => {
  it("paginates until a short page, reporting complete=true", async () => {
    const page1 = Array.from({ length: 1000 }, (_, i) => note(`p${i}`, "Poster", `id${i}`));
    const page2 = [note("last", "Poster", "idlast")];
    const offsets: number[] = [];
    const fetchImpl = vi.fn(async (url: string) => {
      const offset = Number(new URL(url).searchParams.get("offset"));
      offsets.push(offset);
      return pageOf(offset === 0 ? page1 : page2);
    });
    const { notes, complete } = await fetchNotes(
      "ICLR.cc/2025/Conference",
      { fetchImpl },
      { pageSize: 1000 },
    );
    expect(notes.length).toBe(1001);
    expect(complete).toBe(true);
    expect(offsets).toEqual([0, 1000]);
  });

  it("fail-safe on a total request failure: notes=[], complete=false", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("boom");
    });
    const { notes, complete } = await fetchNotes("ICLR.cc/2025/Conference", { fetchImpl });
    expect(notes).toEqual([]);
    expect(complete).toBe(false);
  });

  it("returns the partial set on a mid-run failure (page 1 ok, page 2 fails)", async () => {
    const page1 = Array.from({ length: 1000 }, (_, i) => note(`p${i}`, "Poster", `id${i}`));
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls++;
      return calls === 1 ? pageOf(page1) : { status: 500, json: async () => ({}) };
    });
    const { notes, complete } = await fetchNotes(
      "ICLR.cc/2025/Conference",
      { fetchImpl, sleep: async () => {} },
      { pageSize: 1000 },
    );
    expect(notes.length).toBe(1000);
    expect(complete).toBe(false);
  });

  it("fail-safe on a non-JSON body: complete=false", async () => {
    const fetchImpl = vi.fn(async () => ({
      status: 200,
      json: async () => {
        throw new Error("no json");
      },
    }));
    const { notes, complete } = await fetchNotes("ICLR.cc/2025/Conference", { fetchImpl });
    expect(notes).toEqual([]);
    expect(complete).toBe(false);
  });

  it("treats a malformed-but-valid-JSON body (missing/null/non-array notes) as incomplete", async () => {
    const page1 = Array.from({ length: 1000 }, (_, i) => note(`p${i}`, "Poster", `id${i}`));
    for (const malformed of [{}, { notes: null }, { notes: "not-a-list" }, ["not", "a", "dict"]]) {
      let calls = 0;
      const fetchImpl = vi.fn(async () => {
        calls++;
        return calls === 1 ? pageOf(page1) : { status: 200, json: async () => malformed };
      });
      const { notes, complete } = await fetchNotes(
        "ICLR.cc/2025/Conference",
        { fetchImpl },
        { pageSize: 1000 },
      );
      expect(notes.length).toBe(1000);
      expect(complete).toBe(false);
    }
  });

  it("stops at maxPages without ever seeing a short page: complete=false", async () => {
    const full = [note("p0", "Poster", "id0"), note("p1", "Poster", "id1")];
    const fetchImpl = vi.fn(async () => pageOf(full));
    const { notes, complete } = await fetchNotes(
      "ICLR.cc/2025/Conference",
      { fetchImpl },
      { pageSize: 2, maxPages: 3 },
    );
    expect(notes.length).toBe(6);
    expect(complete).toBe(false);
  });
});

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "openreview-main-"));
});

describe("runOpenreviewMain (CNF-01 / CNF-02)", () => {
  it("CNF-01: refuses to write a partial catalog when pagination fails mid-run", async () => {
    const page1 = Array.from({ length: 1000 }, (_, i) => note(`p${i}`, "Poster", `id${i}`));
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls++;
      return calls === 1 ? pageOf(page1) : { status: 500, json: async () => ({}) };
    });
    const rc = await runOpenreviewMain(
      ["--conference", "iclr-2025", "--venue", "ICLR", "--venueid", "ICLR.cc/2025/Conference"],
      { outputRoot: tmp, request: { fetchImpl, sleep: async () => {} }, print: () => {} },
    );
    expect(rc).toBe(1);
    expect(existsSync(join(tmp, "iclr-2025"))).toBe(false);
  });

  it("has no --allow-partial escape hatch", async () => {
    await expect(
      runOpenreviewMain(
        [
          "--conference",
          "iclr-2025",
          "--venue",
          "ICLR",
          "--venueid",
          "ICLR.cc/2025/Conference",
          "--allow-partial",
        ],
        { outputRoot: tmp, request: { fetchImpl: vi.fn() }, print: () => {} },
      ),
    ).rejects.toThrow(CliUsageError);
    expect(existsSync(join(tmp, "iclr-2025"))).toBe(false);
  });

  it("CNF-02: refuses to write a header-only CSV for 0 accepted papers", async () => {
    const fetchImpl = vi.fn(async () => pageOf([]));
    const rc = await runOpenreviewMain(
      ["--conference", "iclr-2025", "--venue", "ICLR", "--venueid", "ICLR.cc/2025/BogusVenueId"],
      { outputRoot: tmp, request: { fetchImpl }, print: () => {} },
    );
    expect(rc).toBe(1);
    expect(existsSync(join(tmp, "iclr-2025"))).toBe(false);
  });

  it("writes the catalog end-to-end on success and passes --clear-oral through", async () => {
    const notes = [note("Oral one", "Oral", "z1"), note("Poster two", "Poster", "z2")];
    const fetchImpl = vi.fn(async () => pageOf(notes));
    const rc = await runOpenreviewMain(
      ["--conference", "iclr-2025", "--venue", "ICLR", "--venueid", "ICLR.cc/2025/Conference"],
      {
        outputRoot: tmp,
        request: { fetchImpl },
        now: () => new Date("2026-06-28"),
        print: () => {},
      },
    );
    expect(rc).toBe(0);
    const csv = readFileSync(join(tmp, "iclr-2025", "papers_2026-06-28.csv"), "utf-8");
    expect(csv).toContain("openreview");
    const md = readFileSync(join(tmp, "iclr-2025", "oral_summaries_ja.md"), "utf-8");
    expect(md).toContain("## 1. Oral one");
    expect(md).not.toContain("Poster two");
  });

  it("an empty highlighted set keeps the published oral_summaries_ja.md", async () => {
    const { mkdirSync, writeFileSync } = await import("node:fs");
    const confDir = join(tmp, "iclr-2025");
    mkdirSync(confDir, { recursive: true });
    writeFileSync(join(confDir, "oral_summaries_ja.md"), "# old\n## 1. Oral one\n", "utf-8");

    const notes = [
      { id: "n1", content: { title: { value: "Poster only" }, venue: { value: "" } } },
    ];
    const fetchImpl = vi.fn(async () => pageOf(notes));
    const rc = await runOpenreviewMain(
      ["--conference", "iclr-2025", "--venue", "ICLR", "--venueid", "ICLR.cc/2025/Conference"],
      {
        outputRoot: tmp,
        request: { fetchImpl },
        now: () => new Date("2026-06-28"),
        print: () => {},
      },
    );
    expect(rc).toBe(0);
    expect(readFileSync(join(confDir, "oral_summaries_ja.md"), "utf-8")).toBe(
      "# old\n## 1. Oral one\n",
    );
  });
});
