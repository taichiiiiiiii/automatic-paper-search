/**
 * Port of `paperpilot/tests/test_compact_classifications.py`.
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  cacheEndpoints,
  collectLivePaperIds,
  compact,
} from "../../../src/lineage/classify/compact.js";

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "compact-"));
}

function seedCache(dir: string, entries: Record<string, unknown>): string {
  const cachePath = join(dir, "cache", "classifications.json");
  mkdirSync(join(dir, "cache"), { recursive: true });
  writeFileSync(cachePath, JSON.stringify(entries));
  return cachePath;
}

describe("cacheEndpoints", () => {
  it("test_cache_endpoints_supports_legacy_and_opaque_v2_keys", () => {
    expect(cacheEndpoints("a->b", {})).toEqual(["a", "b"]);
    expect(cacheEndpoints(`v2:${"f".repeat(64)}`, { src: "a", dst: "b" })).toEqual(["a", "b"]);
  });

  it("test_cache_endpoints_rejects_malformed_v2_values", () => {
    expect(cacheEndpoints(`v2:${"f".repeat(64)}`, {})).toBeNull();
    expect(cacheEndpoints("not-a-pair", {})).toBeNull();
  });

  it("test_cache_endpoints_reads_theme_entries_nested_identity", () => {
    const themeEntry = {
      status: "success",
      expires_at: "2099-01-01T00:00:00Z",
      cache_identity: { version: 2, src: "a", dst: "b" },
      classification: { relation: "extends", confidence: 0.8, rationale: "r" },
    };
    expect(cacheEndpoints(`v2:${"f".repeat(64)}`, themeEntry)).toEqual(["a", "b"]);
  });

  it("test_cache_endpoints_prefers_top_level_endpoints", () => {
    const entry = { src: "top-a", dst: "top-b", cache_identity: { src: "x", dst: "y" } };
    expect(cacheEndpoints(`v2:${"f".repeat(64)}`, entry)).toEqual(["top-a", "top-b"]);
  });

  it("test_cache_endpoints_still_rejects_an_identity_without_endpoints", () => {
    expect(cacheEndpoints(`v2:${"f".repeat(64)}`, { cache_identity: { version: 2 } })).toBeNull();
  });
});

describe("compact — refuses to delete on an incomplete survey", () => {
  it("test_compact_refuses_when_a_lineage_artifact_is_unreadable", async () => {
    const dir = tmpDir();
    const docsDir = join(dir, "docs");
    mkdirSync(join(docsDir, "good"), { recursive: true });
    writeFileSync(
      join(docsDir, "good", "lineage.json"),
      JSON.stringify({ nodes: [{ id: "a" }, { id: "b" }] }),
    );
    mkdirSync(join(docsDir, "bad"), { recursive: true });
    writeFileSync(join(docsDir, "bad", "lineage.json"), '{"nodes": [{"id": "c"');

    const cachePath = seedCache(dir, { "a->b": {}, "c->a": {} });
    const errors: string[] = [];
    const rc = await compact({ cachePath, docsDir, errorLog: (l) => errors.push(l) });
    expect(rc).toBe(1);
    expect(errors.join("\n")).toContain("refusing to compact");
    expect(JSON.parse(readFileSync(cachePath, "utf-8"))).toEqual({ "a->b": {}, "c->a": {} });
  });

  it("test_compact_carries_over_entries_written_during_the_survey", async () => {
    // The docs survey runs OUTSIDE the lock, so a build can add a
    // classification after the snapshot compact() read for the drop
    // decision. Judging it against a survey that predates it would erase
    // it; it must be carried over instead (mirrors Python's
    // `monkeypatch.setattr(cc, "_collect_live_paper_ids", collect_then_concurrent_write)`).
    const dir = tmpDir();
    const docsDir = join(dir, "docs");
    mkdirSync(join(docsDir, "conf"), { recursive: true });
    writeFileSync(
      join(docsDir, "conf", "lineage.json"),
      JSON.stringify({ nodes: [{ id: "a" }, { id: "b" }] }),
    );
    const cachePath = seedCache(dir, { "a->b": { keep: 1 }, "x->y": { orphan: 1 } });

    const collectThenConcurrentWrite = (d: string) => {
      const result = collectLivePaperIds(d);
      const current = JSON.parse(readFileSync(cachePath, "utf-8"));
      current["p->q"] = { written: "after the survey" };
      writeFileSync(cachePath, JSON.stringify(current));
      return result;
    };

    const rc = await compact({
      cachePath,
      docsDir,
      collectLivePaperIdsFn: collectThenConcurrentWrite,
    });
    expect(rc).toBe(0);
    const final = JSON.parse(readFileSync(cachePath, "utf-8"));
    expect(final["a->b"]).toEqual({ keep: 1 }); // surveyed and live -> kept
    expect("x->y" in final).toBe(false); // surveyed and orphaned -> dropped
    expect(final["p->q"]).toEqual({ written: "after the survey" }); // unsurveyed -> carried over
  });

  it.each([
    ["non-list", "broken"],
    ["empty-element", [{ id: "c" }, {}]],
    ["non-mapping-element", [{ id: "c" }, "x"]],
    ["non-string-id", [{ id: 7 }]],
    ["empty-id", [{ id: "" }]],
  ] as const)(
    "test_compact_refuses_when_a_lineage_nodes_block_is_structurally_broken (%s)",
    async (_name, nodes) => {
      const dir = tmpDir();
      const docsDir = join(dir, "docs");
      mkdirSync(join(docsDir, "good"), { recursive: true });
      writeFileSync(
        join(docsDir, "good", "lineage.json"),
        JSON.stringify({ nodes: [{ id: "a" }, { id: "b" }] }),
      );
      mkdirSync(join(docsDir, "bad"), { recursive: true });
      writeFileSync(join(docsDir, "bad", "lineage.json"), JSON.stringify({ nodes }));

      const cachePath = seedCache(dir, { "a->b": {}, "c->a": {} });
      const errors: string[] = [];
      const rc = await compact({ cachePath, docsDir, errorLog: (l) => errors.push(l) });
      expect(rc).toBe(1);
      expect(errors.join("\n")).toContain("refusing to compact");
      expect(JSON.parse(readFileSync(cachePath, "utf-8"))).toEqual({ "a->b": {}, "c->a": {} });
    },
  );

  it("test_compact_accepts_an_artifact_with_no_nodes_at_all", async () => {
    const dir = tmpDir();
    const docsDir = join(dir, "docs");
    mkdirSync(join(docsDir, "empty"), { recursive: true });
    writeFileSync(join(docsDir, "empty", "lineage.json"), JSON.stringify({ nodes: [] }));
    const cachePath = seedCache(dir, { "a->b": {} });

    const rc = await compact({ cachePath, docsDir });
    expect(rc).toBe(0);
    expect(JSON.parse(readFileSync(cachePath, "utf-8"))).toEqual({});
  });

  it("test_compact_refuses_when_a_lineage_artifact_has_no_nodes_key", async () => {
    const dir = tmpDir();
    const docsDir = join(dir, "docs");
    mkdirSync(join(docsDir, "good"), { recursive: true });
    writeFileSync(
      join(docsDir, "good", "lineage.json"),
      JSON.stringify({ nodes: [{ id: "a" }, { id: "b" }] }),
    );
    mkdirSync(join(docsDir, "bad"), { recursive: true });
    writeFileSync(
      join(docsDir, "bad", "lineage.json"),
      JSON.stringify({ meta: { source: "something else" } }),
    );

    const cachePath = seedCache(dir, { "a->b": {}, "c->a": {} });
    const errors: string[] = [];
    const rc = await compact({ cachePath, docsDir, errorLog: (l) => errors.push(l) });
    expect(rc).toBe(1);
    expect(errors.join("\n")).toContain("refusing to compact");
    expect(JSON.parse(readFileSync(cachePath, "utf-8"))).toEqual({ "a->b": {}, "c->a": {} });
  });

  // H1 leftover (#review): `compact()` used a plain `JSON.parse` to read
  // the classifications cache at three sites (the initial snapshot, and
  // the re-read under the lock) — a cache containing a bare NaN/Infinity
  // confidence (which `pyJsonDumps` itself writes, same as Python's
  // `json.dump`) would throw there and be reported as "cache unreadable"
  // instead of being compacted. Switched to the same NaN-tolerant reader
  // `cache.ts`'s own loader uses.
  it("H1: tolerates a bare NaN confidence in the on-disk cache instead of reporting it as unreadable", async () => {
    const dir = tmpDir();
    const docsDir = join(dir, "docs");
    mkdirSync(join(docsDir, "conf"), { recursive: true });
    writeFileSync(
      join(docsDir, "conf", "lineage.json"),
      JSON.stringify({ nodes: [{ id: "a" }, { id: "b" }] }),
    );
    const cachePath = join(dir, "cache", "classifications.json");
    mkdirSync(join(dir, "cache"), { recursive: true });
    writeFileSync(
      cachePath,
      '{"a->b": {"relation": "extends", "confidence": NaN, "rationale": "r"}, ' +
        '"x->y": {"relation": "extends", "confidence": 0.5, "rationale": "r2"}}',
    );
    const errors: string[] = [];
    const rc = await compact({ cachePath, docsDir, errorLog: (l) => errors.push(l) });
    expect(errors).toEqual([]);
    expect(rc).toBe(0);
    // "a->b" is live (both endpoints appear in the surveyed lineage), so
    // it must be kept — and reading it back required tolerating the bare
    // NaN rather than failing the whole parse.
    const onDisk = readFileSync(cachePath, "utf-8");
    expect(onDisk).toContain("a->b");
    expect(onDisk).not.toContain("x->y"); // orphaned -> dropped
  });

  // H1 leftover (#review, compact.ts:70): the docs-survey side (`absorb()`)
  // also used a plain `JSON.parse`. A lineage artifact carrying a bare NaN
  // elsewhere in its JSON (not in `nodes`, which this function never reads
  // beyond `.id`) must not make the whole file read as "unreadable" and
  // block the compaction.
  it("H1 (compact.ts:70): tolerates a bare NaN present elsewhere in a surveyed lineage.json", async () => {
    const dir = tmpDir();
    const docsDir = join(dir, "docs");
    mkdirSync(join(docsDir, "conf"), { recursive: true });
    writeFileSync(
      join(docsDir, "conf", "lineage.json"),
      '{"nodes": [{"id": "a"}, {"id": "b"}], ' +
        '"edges": [{"src": "a", "dst": "b", "confidence": NaN}]}',
    );
    const cachePath = seedCache(dir, { "a->b": {}, "c->a": {} });
    const errors: string[] = [];
    const rc = await compact({ cachePath, docsDir, errorLog: (l) => errors.push(l) });
    expect(errors).toEqual([]);
    expect(rc).toBe(0);
    expect(JSON.parse(readFileSync(cachePath, "utf-8"))).toEqual({ "a->b": {} });
  });

  // pyFloat write-site (p4-followups #24, compact.ts:232): the final
  // write wraps `confidence` so an exactly-1.0 value serializes as the
  // Python float literal "1.0", not the int-looking "1" — `JSON.parse`
  // can't tell those apart, so the assertion has to be on the raw bytes.
  it('writes an exactly-1.0 confidence as the Python float literal "1.0", not "1" (p4-followups #24)', async () => {
    const dir = tmpDir();
    const docsDir = join(dir, "docs");
    mkdirSync(join(docsDir, "conf"), { recursive: true });
    writeFileSync(
      join(docsDir, "conf", "lineage.json"),
      JSON.stringify({ nodes: [{ id: "a" }, { id: "b" }] }),
    );
    const cachePath = seedCache(dir, {
      "a->b": { relation: "extends", confidence: 1, rationale: "exact confidence" },
    });
    const rc = await compact({ cachePath, docsDir });
    expect(rc).toBe(0);
    const raw = readFileSync(cachePath, "utf-8");
    expect(raw).toContain('"confidence": 1.0');
    expect(raw).not.toMatch(/"confidence": 1,/);
    expect(raw).not.toMatch(/"confidence": 1\}/);
  });
});
