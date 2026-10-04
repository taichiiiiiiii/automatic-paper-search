/**
 * Port of `paperpilot/tests/test_dedup.py`.
 *
 * `test_merge_seen_ids_serializes_overlapping_writers` is ADAPTED: Python
 * holds a real `fcntl.flock` on an externally-opened file descriptor; this
 * port's lock is "the sibling `<path>.lock` file exists" (see
 * `state/seenIds.ts`'s module doc), so the test below simulates a holder by
 * creating that file directly with the same `wx` (O_EXCL) flag the
 * implementation uses, rather than flocking an fd.
 */
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPaper, type Paper } from "../../../src/collect/model/paper.js";
import {
  dedupPapers,
  filterUnseen,
  loadSeenIds,
  markSeen,
  mergeSeenIds,
  purgeSeenIds,
  saveSeenIds,
} from "../../../src/collect/state/seenIds.js";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual };
});

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "seen-ids-test-"));
});

afterEach(() => {
  vi.restoreAllMocks();
});

function paper(overrides: Partial<Parameters<typeof createPaper>[0]> = {}): Paper {
  return createPaper({
    title: "T",
    authors: ["A"],
    abstract: "",
    url: `http://x/${randomUUID()}`,
    publishedDate: "2026-01-01",
    source: "arxiv",
    ...overrides,
  });
}

function papersBatch(): Paper[] {
  return Array.from({ length: 5 }, (_, i) =>
    paper({
      title: `Paper ${i + 1}`,
      authors: [`Author ${i + 1}`],
      abstract: `Abstract for paper ${i + 1}`,
      url: `https://arxiv.org/abs/2604.000${i + 1}`,
      publishedDate: "2026-01-01",
      arxivId: `2604.000${i + 1}`,
      categories: ["cs.LG"],
    }),
  );
}

// ---- dedup ----

it("test_dedup_preserves_first", () => {
  const batch = papersBatch();
  const doubled = [...batch, ...batch];
  const result = dedupPapers(doubled);
  expect(result.length).toBe(batch.length);
});

it("test_dedup_merges_arxiv_plus_doi_record_with_doi_only_record", () => {
  const rich = paper({ arxivId: "2604.00001", doi: "10.1/abc", abstract: "Full abstract" });
  const thin = paper({ doi: "10.1/abc", abstract: "" });
  const result = dedupPapers([rich, thin]);
  expect(result.length).toBe(1);
  expect(result[0]?.arxivId).toBe("2604.00001");
});

it("test_dedup_alias_merge_backfills_missing_metadata_from_thinner_record", () => {
  const thinFirst = paper({
    arxivId: "2604.00002",
    doi: "10.1/xyz",
    abstract: "",
    pdfUrl: null,
    authors: [],
  });
  const richSecond = paper({
    doi: "10.1/xyz",
    abstract: "Rich abstract from the other source",
    pdfUrl: "http://pdf/2",
    authors: ["Real Author"],
  });
  const result = dedupPapers([thinFirst, richSecond]);
  expect(result.length).toBe(1);
  const kept = result[0] as Paper;
  expect(kept.arxivId).toBe("2604.00002");
  expect(kept.doi).toBe("10.1/xyz");
  expect(kept.abstract).toBe("Rich abstract from the other source");
  expect(kept.pdfUrl).toBe("http://pdf/2");
  expect(kept.authors).toEqual(["Real Author"]);
});

it("test_dedup_alias_merge_never_links_papers_with_no_shared_identifier", () => {
  const urlOnly = paper({ url: "http://example.com/paper-x", abstract: "" });
  const unrelatedWithDoi = paper({
    url: "http://example.com/paper-y",
    doi: "10.1/unrelated",
    abstract: "",
  });
  expect(dedupPapers([urlOnly, unrelatedWithDoi]).length).toBe(2);
});

it("test_dedup_alias_merge_does_not_falsely_link_whitespace_only_identifiers", () => {
  const a = paper({ url: "http://example.com/a", doi: " ", abstract: "A's abstract" });
  const b = paper({ url: "http://example.com/b", doi: "   ", abstract: "B's abstract" });
  expect(dedupPapers([a, b]).length).toBe(2);
});

it("test_dedup_alias_merge_normalizes_arxiv_id_case_and_whitespace", () => {
  const a = paper({ arxivId: "2604.00010", abstract: "" });
  const b = paper({ arxivId: " 2604.00010 ", abstract: "from B" });
  const result = dedupPapers([a, b]);
  expect(result.length).toBe(1);
  expect(result[0]?.arxivId).toBe("2604.00010");
  expect(result[0]?.abstract).toBe("from B");
});

it("test_dedup_alias_merge_groups_more_than_two_records_sharing_one_doi", () => {
  const a = paper({ arxivId: "2604.00003", doi: "10.1/shared" });
  const b = paper({ arxivId: "2604.00004", doi: "10.1/shared", abstract: "from B" });
  const c = paper({ doi: "10.1/shared", pdfUrl: "http://pdf/c" });
  const result = dedupPapers([a, b, c]);
  expect(result.length).toBe(1);
  const kept = result[0] as Paper;
  expect(kept.abstract).toBe("from B");
  expect(kept.pdfUrl).toBe("http://pdf/c");
});

it("test_dedup_alias_merge_does_not_merge_unrelated_papers", () => {
  const p1 = paper({ arxivId: "2604.00004", title: "Same Title" });
  const p2 = paper({ arxivId: "2604.00005", title: "Same Title" });
  expect(dedupPapers([p1, p2]).length).toBe(2);
});

it("test_filter_unseen_drops_known", () => {
  const batch = papersBatch();
  const seen = { [`arxiv:${batch[0]?.arxivId}`]: new Date().toISOString() };
  const result = filterUnseen(batch, seen);
  expect(result.length).toBe(batch.length - 1);
});

it("test_mark_seen_adds_all", () => {
  const batch = papersBatch();
  const seen: Record<string, string> = {};
  markSeen(batch, seen);
  for (const p of batch) expect(seen[`arxiv:${p.arxivId}`]).toBeDefined();
});

it("test_purge_drops_old_entries", () => {
  const now = () => new Date("2026-06-01T00:00:00Z");
  const old = new Date("2026-05-02T00:00:00Z").toISOString();
  const fresh = new Date("2026-05-31T00:00:00Z").toISOString();
  const seen = { "arxiv:old": old, "arxiv:new": fresh };
  const kept = purgeSeenIds(seen, 14, now);
  expect(kept["arxiv:old"]).toBeUndefined();
  expect(kept["arxiv:new"]).toBe(fresh);
});

it("test_purge_handles_bad_timestamps", () => {
  const seen = { "arxiv:good": new Date().toISOString(), "arxiv:bad": "garbage" };
  const kept = purgeSeenIds(seen, 14);
  expect(kept["arxiv:good"]).toBeDefined();
  expect(kept["arxiv:bad"]).toBeUndefined();
});

// ---- load_seen_ids: an existing-but-unreadable file must not look like a fresh start ----

it("test_load_seen_ids_moves_a_broken_file_aside_and_warns", () => {
  const path = join(dir, "seen_ids.json");
  writeFileSync(path, '{"arxiv:1": "2026-01-01T00:00:00",');
  const damaged = readFileSync(path);
  const warnings: string[] = [];

  expect(loadSeenIds(path, { logger: { warn: (m) => warnings.push(m) } })).toEqual({});

  expect(fs.existsSync(path)).toBe(false);
  const quarantined = fs.readdirSync(dir).filter((n) => n.startsWith("seen_ids.json.corrupt-"));
  expect(quarantined.length).toBe(1);
  expect(readFileSync(join(dir, quarantined[0] as string))).toEqual(damaged);

  expect(warnings.length).toBeGreaterThan(0);
  const text = warnings.join(" ");
  expect(text).toContain("seen_ids.json");
  expect(text).toContain("unseen");
});

it("test_load_seen_ids_missing_file_stays_silent", () => {
  const path = join(dir, "seen_ids.json");
  const warnings: string[] = [];
  expect(loadSeenIds(path, { logger: { warn: (m) => warnings.push(m) } })).toEqual({});
  expect(warnings).toEqual([]);
  expect(fs.readdirSync(dir)).toEqual([]);
});

it("test_load_seen_ids_quarantine_does_not_overwrite_an_earlier_one", () => {
  const frozen = () => new Date("2026-10-03T01:02:03Z");
  const path = join(dir, "seen_ids.json");
  const earlier = join(dir, "seen_ids.json.corrupt-20261003T010203");
  writeFileSync(earlier, "first damage");
  writeFileSync(path, "{ truncated");

  expect(loadSeenIds(path, { now: frozen })).toEqual({});

  expect(readFileSync(earlier, "utf-8")).toBe("first damage");
  const moved = join(dir, "seen_ids.json.corrupt-20261003T010203.1");
  expect(readFileSync(moved, "utf-8")).toBe("{ truncated");
});

it("test_load_seen_ids_quarantines_a_file_that_is_not_utf8", () => {
  const path = join(dir, "seen_ids.json");
  const damaged = Buffer.from([0x7b, 0x22, 0x61, 0xff, 0xfe, 0x00, 0x22, 0x7d]);
  writeFileSync(path, damaged);

  expect(loadSeenIds(path)).toEqual({});

  expect(fs.existsSync(path)).toBe(false);
  const quarantined = fs.readdirSync(dir).filter((n) => n.includes(".corrupt-"));
  expect(quarantined.length).toBe(1);
  expect(readFileSync(join(dir, quarantined[0] as string))).toEqual(damaged);
});

it("test_load_seen_ids_reports_the_quarantine_to_a_caller_that_asks", () => {
  const path = join(dir, "seen_ids.json");
  const notes: string[] = [];
  expect(loadSeenIds(path, { quarantineNotes: notes })).toEqual({});
  expect(notes).toEqual([]);

  writeFileSync(path, '{"arxiv:1": "2026-01-01T00:00:00"}');
  expect(loadSeenIds(path, { quarantineNotes: notes })).toEqual({
    "arxiv:1": "2026-01-01T00:00:00",
  });
  expect(notes).toEqual([]);

  writeFileSync(path, "{ truncated");
  expect(loadSeenIds(path, { quarantineNotes: notes })).toEqual({});
  expect(notes.length).toBe(1);
  expect(notes[0]).toMatch(/^unreadable file quarantined to /);
  expect(notes[0]).toContain(".corrupt-");
});

it("test_load_seen_ids_reports_a_json_file_of_the_wrong_shape", () => {
  const path = join(dir, "seen_ids.json");
  writeFileSync(path, '"not a map"');
  const notes: string[] = [];
  expect(loadSeenIds(path, { quarantineNotes: notes })).toEqual({});
  expect(notes.length).toBe(1);
  expect(notes[0]).toMatch(/^unreadable file quarantined to /);
});

it("test_load_seen_ids_reports_a_file_it_could_not_move_aside", () => {
  const path = join(dir, "seen_ids.json");
  writeFileSync(path, "{ truncated");
  vi.spyOn(fs, "renameSync").mockImplementation(() => {
    throw new Error("permission denied");
  });
  const notes: string[] = [];

  expect(loadSeenIds(path, { quarantineNotes: notes })).toEqual({});

  expect(fs.existsSync(path)).toBe(true);
  expect(notes.length).toBe(1);
  expect(notes[0]).toMatch(/^unreadable file could not be moved aside/);
});

// ---- save ----

it("test_save_seen_ids_round_trips", () => {
  const path = join(dir, "seen_ids.json");
  const seen = { "arxiv:1": new Date().toISOString() };
  saveSeenIds(path, seen);
  expect(loadSeenIds(path)).toEqual(seen);
});

it("test_save_seen_ids_leaves_no_tmp_file_behind", () => {
  const path = join(dir, "seen_ids.json");
  saveSeenIds(path, { "arxiv:1": new Date().toISOString() });
  expect(fs.readdirSync(dir)).toEqual(["seen_ids.json"]);
});

it("test_save_seen_ids_temp_name_is_not_pid_based", () => {
  const path = join(dir, "seen_ids.json");
  const recorded: string[] = [];
  const real = fs.renameSync;
  vi.spyOn(fs, "renameSync").mockImplementation((src, dst) => {
    recorded.push(String(src));
    return real(src, dst);
  });

  saveSeenIds(path, { "arxiv:1": "2026-01-01T00:00:00" });
  saveSeenIds(path, { "arxiv:2": "2026-01-01T00:00:00" });

  expect(recorded.length).toBe(2);
  expect(recorded[0]).not.toBe(recorded[1]);
  expect(loadSeenIds(path)).toEqual({ "arxiv:2": "2026-01-01T00:00:00" });
});

it("test_save_seen_ids_does_not_truncate_existing_file_if_write_fails", () => {
  const path = join(dir, "seen_ids.json");
  const original = { "arxiv:1": new Date().toISOString() };
  saveSeenIds(path, original);
  const originalBytes = readFileSync(path);

  vi.spyOn(fs, "writeSync").mockImplementation(() => {
    throw new Error("disk full");
  });

  expect(() => saveSeenIds(path, { "arxiv:2": new Date().toISOString() })).toThrow("disk full");
  expect(readFileSync(path)).toEqual(originalBytes);
  expect(fs.readdirSync(dir)).toEqual(["seen_ids.json"]);
});

it("test_save_seen_ids_survives_os_replace_failure", () => {
  const path = join(dir, "seen_ids.json");
  const original = { "arxiv:1": new Date().toISOString() };
  saveSeenIds(path, original);
  const originalBytes = readFileSync(path);

  vi.spyOn(fs, "renameSync").mockImplementation(() => {
    throw new Error("rename failed");
  });

  expect(() => saveSeenIds(path, { "arxiv:2": new Date().toISOString() })).toThrow("rename failed");
  expect(readFileSync(path)).toEqual(originalBytes);
  expect(fs.readdirSync(dir)).toEqual(["seen_ids.json"]);
});

// ---- merge_seen_ids: locked read-merge-write (concurrent runs) ----

it("test_merge_seen_ids_keeps_a_concurrent_run_contribution", async () => {
  const path = join(dir, "seen_ids.json");
  saveSeenIds(path, { "arxiv:other-run": new Date().toISOString() });

  const batch = papersBatch();
  const merged = await mergeSeenIds(path, batch.slice(0, 2), { maxAgeDays: 14 });

  expect(merged["arxiv:other-run"]).toBeDefined();
  for (const p of batch.slice(0, 2)) expect(merged[`arxiv:${p.arxivId}`]).toBeDefined();
  expect(JSON.parse(readFileSync(path, "utf-8"))).toEqual(merged);
});

it("test_merge_seen_ids_does_not_resurrect_purged_entries", async () => {
  const path = join(dir, "seen_ids.json");
  const now = () => new Date("2026-06-01T00:00:00Z");
  const stale = new Date("2026-01-01T00:00:00Z").toISOString();
  saveSeenIds(path, { "arxiv:ancient": stale });

  const batch = papersBatch();
  const merged = await mergeSeenIds(path, batch.slice(0, 1), { maxAgeDays: 14, now });

  expect(merged["arxiv:ancient"]).toBeUndefined();
  expect(merged[`arxiv:${batch[0]?.arxivId}`]).toBeDefined();
});

describe("test_merge_seen_ids_serializes_overlapping_writers (adapted — see module header)", () => {
  it("blocks while the sibling .lock file exists, proceeds once it is removed", async () => {
    const path = join(dir, "seen_ids.json");
    saveSeenIds(path, { "arxiv:pre-existing": new Date().toISOString() });
    const lockPath = `${path}.lock`;

    // Simulate an external holder the same way the implementation itself
    // acquires the lock: O_EXCL create.
    const fd = fs.openSync(lockPath, "wx");

    const batch = papersBatch();
    let done = false;
    const mergePromise = mergeSeenIds(path, batch.slice(0, 1), { maxAgeDays: 14 }).then((r) => {
      done = true;
      return r;
    });

    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(done).toBe(false);
    expect(JSON.parse(readFileSync(path, "utf-8"))).toEqual({
      "arxiv:pre-existing": expect.any(String),
    });

    fs.closeSync(fd);
    fs.unlinkSync(lockPath);

    const final = await mergePromise;
    expect(done).toBe(true);
    expect(final["arxiv:pre-existing"]).toBeDefined();
    expect(final[`arxiv:${batch[0]?.arxivId}`]).toBeDefined();
  });
});

// ---- timestamp FORMAT: must match Python's naive isoformat, not Date.toISOString() ----
//
// Follow-up fix: seen_ids.json is persisted state inherited across the
// Python -> TS cutover (absolute rule §8), so writing `Date.toISOString()`
// (`...000Z`) instead of Python's naive `datetime.now().isoformat()`
// (`YYYY-MM-DDTHH:MM:SS[.ffffff]`, no offset) would mix two formats in one
// file and risk wrong purge behaviour. These tests pin the write format
// directly and prove a Python-written file round-trips through TS
// load -> merge -> save without rewriting its existing values.

describe("seen_ids timestamp VALUE format (Python naive isoformat, not Date.toISOString)", () => {
  it("markSeen writes no fractional part when the clock lands on a whole second", () => {
    const fixed = () => new Date(2026, 3, 10, 12, 0, 0); // 2026-04-10T12:00:00, ms=0
    const seen = markSeen([paper({ arxivId: "2604.00001" })], {}, fixed);
    // Exactly Python's `datetime(2026, 4, 10, 12, 0, 0).isoformat()`: no
    // ".000000" suffix, no "Z", no "+00:00" offset.
    expect(seen["arxiv:2604.00001"]).toBe("2026-04-10T12:00:00");
  });

  it("markSeen writes a 6-digit, millisecond-granular fractional part when ms !== 0", () => {
    const fixed = () => new Date(2026, 3, 10, 12, 0, 0, 69); // .069 seconds
    const seen = markSeen([paper({ arxivId: "2604.00001" })], {}, fixed);
    // JS has only millisecond resolution, so this is the closest
    // byte-shape match to Python's 6-digit microsecond field (real
    // committed files have sub-millisecond jitter Node cannot produce —
    // documented in `pyNaiveIsoformat`'s doc comment as an accepted,
    // inherent precision-limit difference with no behavioral effect).
    expect(seen["arxiv:2604.00001"]).toBe("2026-04-10T12:00:00.069000");
  });

  it("load_seen_ids legacy-list fallback also writes the naive-isoformat shape", () => {
    const path = join(dir, "seen_ids.json");
    writeFileSync(path, JSON.stringify(["arxiv:legacy"]));
    const fixed = () => new Date(2026, 3, 10, 12, 0, 0);
    const out = loadSeenIds(path, { now: fixed });
    expect(out["arxiv:legacy"]).toBe("2026-04-10T12:00:00");
  });

  it("round-trips a REAL Python-written seen_ids file (with microseconds) without reformatting existing entries", async () => {
    // Byte-for-byte the shape found in the committed
    // paperpilot/data/seen_ids.json / seen_ids.daily.json (checked
    // directly): naive local isoformat, 6-digit microseconds, no offset.
    const path = join(dir, "seen_ids.json");
    const pythonWritten = {
      "arxiv:2605.21822": "2026-05-24T10:27:25.069350",
      "doi:10.5281/zenodo.19536190": "2026-05-31T23:06:08.814096",
    };
    writeFileSync(path, JSON.stringify(pythonWritten, null, 2));

    const newPaper = paper({ arxivId: "2604.09999" });
    const fixed = () => new Date(2026, 5, 1, 0, 0, 0); // 2026-06-01T00:00:00
    const merged = await mergeSeenIds(path, [newPaper], { maxAgeDays: 365, now: fixed });

    // Existing entries: EXACT same string, not just the same instant —
    // load -> merge -> save must never touch a value it didn't write.
    expect(merged["arxiv:2605.21822"]).toBe("2026-05-24T10:27:25.069350");
    expect(merged["doi:10.5281/zenodo.19536190"]).toBe("2026-05-31T23:06:08.814096");
    // The new paper gets this run's (fixed-clock, whole-second) timestamp.
    expect(merged["arxiv:2604.09999"]).toBe("2026-06-01T00:00:00");

    // And on disk, after the atomic save — not just in the returned map.
    const onDisk = JSON.parse(readFileSync(path, "utf-8"));
    expect(onDisk).toEqual(merged);
  });
});

describe("purge boundary at max_age_days matches Python for both timestamp shapes", () => {
  // Python: `datetime.fromisoformat(ts) > cutoff` where
  // `cutoff = datetime.now() - timedelta(days=max_age_days)` — strictly
  // greater-than, so an entry exactly AT the cutoff instant is dropped,
  // and one even one second younger survives. Checked for the Python
  // naive-microseconds shape and, defensively, the `...Z` shape a
  // pre-fix build of this port could have left on disk.
  const NOW = new Date(2026, 5, 15, 0, 0, 0); // 2026-06-15T00:00:00 local
  const MAX_AGE_DAYS = 14;
  const CUTOFF_MS = NOW.getTime() - MAX_AGE_DAYS * 86_400_000; // 2026-06-01T00:00:00

  it("Python-naive-isoformat: exactly at cutoff is dropped, one second younger survives", () => {
    const atCutoff = pyIsoformatLocal(new Date(CUTOFF_MS));
    const oneSecYounger = pyIsoformatLocal(new Date(CUTOFF_MS + 1000));
    const kept = purgeSeenIds(
      { "arxiv:at": atCutoff, "arxiv:young": oneSecYounger },
      MAX_AGE_DAYS,
      () => NOW,
    );
    expect(kept).toEqual({ "arxiv:young": oneSecYounger });
  });

  it("ISO-with-Z (defensive legacy shape): same boundary as the Python shape", () => {
    const atCutoff = new Date(CUTOFF_MS).toISOString();
    const oneSecYounger = new Date(CUTOFF_MS + 1000).toISOString();
    const kept = purgeSeenIds(
      { "arxiv:at": atCutoff, "arxiv:young": oneSecYounger },
      MAX_AGE_DAYS,
      () => NOW,
    );
    expect(kept).toEqual({ "arxiv:young": oneSecYounger });
  });

  it("the two shapes agree on the SAME instant (format must not shift the boundary)", () => {
    const instant = CUTOFF_MS + 5000; // 5s younger than cutoff — must survive either way
    const naive = pyIsoformatLocal(new Date(instant));
    const withZ = new Date(instant).toISOString();
    const keptNaive = purgeSeenIds({ "arxiv:x": naive }, MAX_AGE_DAYS, () => NOW);
    const keptZ = purgeSeenIds({ "arxiv:x": withZ }, MAX_AGE_DAYS, () => NOW);
    expect(Object.keys(keptNaive)).toEqual(["arxiv:x"]);
    expect(Object.keys(keptZ)).toEqual(["arxiv:x"]);
  });
});

/** Test-local helper: Python naive isoformat for an arbitrary (not just "now") local instant. */
function pyIsoformatLocal(d: Date): string {
  const pad2 = (n: number) => String(n).padStart(2, "0");
  const base = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
  return d.getMilliseconds() === 0
    ? base
    : `${base}.${String(d.getMilliseconds() * 1000).padStart(6, "0")}`;
}
