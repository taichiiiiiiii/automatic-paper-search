/**
 * LOW: parity's file-tree walker must not silently drop a dangling symlink
 * or a symlink-to-a-directory from both the file list AND any diagnostic —
 * and the JSON comparison path must not let Node's `fs.readFile(path,
 * "utf8")` quietly replace invalid UTF-8 bytes with U+FFFD (which could
 * make two differently-corrupt files compare as falsely "equal").
 */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { compareTrees } from "../../src/parity/compare-trees.js";
import { listFiles, readFileText } from "../../src/parity/fs-tree.js";

let base: string;
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "paperpilot-fs-tree-test-"));
});
afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

it("listFiles reports a dangling symlink as skipped, not silently absent", async () => {
  const root = join(base, "root");
  mkdirSync(root, { recursive: true });
  symlinkSync(join(root, "does-not-exist.json"), join(root, "dangling.json"));

  const result = await listFiles(root);
  expect(result.files).toEqual([]);
  expect(result.skipped).toEqual([{ path: "dangling.json", reason: "dangling-symlink" }]);
});

it("listFiles reports a symlink-to-directory as skipped, not silently absent", async () => {
  const root = join(base, "root");
  const realDir = join(base, "elsewhere");
  mkdirSync(join(realDir, "inner"), { recursive: true });
  writeFileSync(join(realDir, "inner", "a.json"), "{}\n");
  mkdirSync(root, { recursive: true });
  symlinkSync(realDir, join(root, "link-to-dir"));

  const result = await listFiles(root);
  // The symlinked directory's CONTENTS are not walked, and the symlink
  // itself is reported rather than silently excluded from both files and
  // skipped.
  expect(result.files).toEqual([]);
  expect(result.skipped).toEqual([{ path: "link-to-dir", reason: "symlink-to-directory" }]);
});

it("compareTrees fails (not passes) when either side has a skipped symlink", async () => {
  const expectedRoot = join(base, "expected");
  const actualRoot = join(base, "actual");
  mkdirSync(expectedRoot, { recursive: true });
  mkdirSync(actualRoot, { recursive: true });
  writeFileSync(join(expectedRoot, "a.json"), "{}\n");
  writeFileSync(join(actualRoot, "a.json"), "{}\n");
  symlinkSync(join(actualRoot, "missing.json"), join(actualRoot, "dangling.json"));

  const report = await compareTrees({ expectedRoot, actualRoot });
  expect(report.equal).toBe(false);
  expect(report.skippedEntries).toEqual([
    { side: "actual", path: "dangling.json", reason: "dangling-symlink" },
  ]);
});

it("readFileText throws a clear error on invalid UTF-8 instead of silently decoding to U+FFFD", async () => {
  const path = join(base, "invalid-utf8.json");
  // 0xFF is never valid as a UTF-8 lead byte.
  writeFileSync(path, Buffer.from([0x7b, 0xff, 0x7d]));
  await expect(readFileText(path)).rejects.toThrow(/invalid UTF-8/);
});

it("compareTrees reports a parse error (not a false 'equal') for invalid UTF-8 JSON", async () => {
  const expectedRoot = join(base, "expected");
  const actualRoot = join(base, "actual");
  mkdirSync(expectedRoot, { recursive: true });
  mkdirSync(actualRoot, { recursive: true });
  // Two DIFFERENT invalid byte sequences — under a lossy utf8 decode both
  // could collapse to the same U+FFFD text and falsely compare as equal.
  writeFileSync(join(expectedRoot, "a.json"), Buffer.from([0x7b, 0xff, 0x7d]));
  writeFileSync(join(actualRoot, "a.json"), Buffer.from([0x7b, 0xfe, 0x7d]));

  const report = await compareTrees({ expectedRoot, actualRoot });
  expect(report.equal).toBe(false);
  expect(report.fileResults[0]?.equal).toBe(false);
  expect(report.fileResults[0]?.parseError).toMatch(/invalid UTF-8/);
});
