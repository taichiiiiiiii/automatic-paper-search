/**
 * `lib/catalog-copy-reader.ts` -- p5-plan.md §2 A2 follow-up #17:
 * build-time reader for the per-slug file
 * `apps/pipeline/src/conference/scaffold/cli.ts` writes to
 * `<layout.config>/conference-copy/<slug>.json`. Same "positive path,
 * unmocked (for the missing case) / injected repoRoot (for the present
 * case)" convention as `lib/lineage/server-fs.test.ts`.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { conferenceCopyDir, layoutFor } from "@paperpilot/core/layout";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConferenceCopyFileError, readConferenceCopyFile } from "../../lib/catalog-copy-reader";

let repoRoot: string;

beforeEach(() => {
  repoRoot = mkdtempSync(join(tmpdir(), "catalog-copy-reader-"));
});
afterEach(() => {
  rmSync(repoRoot, { recursive: true, force: true });
});

function writeCopyFile(slug: string, body: unknown): void {
  const dir = conferenceCopyDir(layoutFor(repoRoot));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${slug}.json`), JSON.stringify(body), "utf-8");
}

describe("readConferenceCopyFile", () => {
  it("returns the entry for a slug that has a copy file", () => {
    writeCopyFile("neurips-2026", { display: "NeurIPS 2026", lede: "A lede." });
    expect(readConferenceCopyFile("neurips-2026", repoRoot)).toEqual({
      display: "NeurIPS 2026",
      lede: "A lede.",
    });
  });

  it("returns null when no copy file exists for the slug", () => {
    expect(readConferenceCopyFile("no-such-slug", repoRoot)).toBeNull();
  });

  // L6 (P5 tier-A review): a file that EXISTS but fails to parse as JSON
  // at all must fail the build loudly, not silently fall back to generic
  // copy -- unlike the "missing" / "wrong shape" cases below, which are
  // still a soft `null` fallback.
  it("throws ConferenceCopyFileError for malformed JSON (a broken copy file must fail the build)", () => {
    const dir = conferenceCopyDir(layoutFor(repoRoot));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "broken.json"), "{not json", "utf-8");
    expect(() => readConferenceCopyFile("broken", repoRoot)).toThrow(ConferenceCopyFileError);
  });

  it("returns null when display/lede are missing or not strings", () => {
    writeCopyFile("bad-shape", { display: "", lede: "ok" });
    expect(readConferenceCopyFile("bad-shape", repoRoot)).toBeNull();
    writeCopyFile("bad-shape-2", { display: "ok" });
    expect(readConferenceCopyFile("bad-shape-2", repoRoot)).toBeNull();
    writeCopyFile("bad-shape-3", { display: 1, lede: "ok" });
    expect(readConferenceCopyFile("bad-shape-3", repoRoot)).toBeNull();
  });

  it("the real repo (unmocked) has no copy file for a known static-map slug", () => {
    // Positive-path sanity check against the real repo, same convention
    // as lib/lineage/server-fs.test.ts: nothing writes under
    // layout.config/conference-copy/ yet (tier A is inert), so this must
    // be null, not throw.
    expect(readConferenceCopyFile("iclr-2026")).toBeNull();
  });
});
