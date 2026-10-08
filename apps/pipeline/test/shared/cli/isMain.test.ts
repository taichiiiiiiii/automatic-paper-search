/**
 * M2 of the P4 review: every CLI's `import.meta.url ===
 * \`file://${process.argv[1]}\`` main guard breaks on a symlinked
 * directory, a path containing a space, or a non-ASCII path, because it
 * compares a hand-built `file://` string instead of resolved real paths.
 * `isMain` fixes that by comparing `realpathSync` of both sides. These
 * tests stub `process.argv[1]` directly (no child process needed) —
 * `isMainEntry.test.ts` covers the real symlink/space spawn case.
 */
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isMain } from "../../../src/shared/cli/isMain.js";

const THIS_FILE_URL = import.meta.url;
const THIS_FILE_PATH = fileURLToPath(THIS_FILE_URL);

let originalArgv: string[];
beforeEach(() => {
  originalArgv = [...process.argv];
});
afterEach(() => {
  process.argv = [...originalArgv];
});

describe("isMain", () => {
  it("is true when argv[1] is exactly this file's path", () => {
    process.argv[1] = THIS_FILE_PATH;
    expect(isMain(THIS_FILE_URL)).toBe(true);
  });

  it("is false when argv[1] is missing (e.g. imported, not run)", () => {
    // Simulate "no entry script" the same way argv looks inside some
    // embedders/REPLs — index 1 absent entirely.
    process.argv.length = 1;
    expect(isMain(THIS_FILE_URL)).toBe(false);
  });

  it("is false when argv[1] is the empty string", () => {
    process.argv[1] = "";
    expect(isMain(THIS_FILE_URL)).toBe(false);
  });

  it("is false when argv[1] does not resolve to a real file", () => {
    process.argv[1] = "/nonexistent/definitely/not/a/real/path.ts";
    expect(isMain(THIS_FILE_URL)).toBe(false);
  });

  it("is false when a real argv[1] names a different file than this module", () => {
    const dir = mkdtempSync(join(tmpdir(), "paperpilot-ismain-"));
    try {
      const other = join(dir, "other.ts");
      writeFileSync(other, "export {};\n");
      process.argv[1] = other;
      expect(isMain(THIS_FILE_URL)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("is true through a symlink: a symlinked invocation path resolves to the same real file", () => {
    const dir = mkdtempSync(join(tmpdir(), "paperpilot-ismain-symlink-"));
    try {
      const target = join(dir, "target.ts");
      writeFileSync(target, "export {};\n");
      const link = join(dir, "link-to-target.ts");
      symlinkSync(target, link);
      // Pretend the "real" module being tested lives at `target`, and
      // the process was invoked via the symlink — the naive
      // `file://${argv[1]}` string comparison would say `false` here
      // (different textual paths); isMain must say `true`.
      process.argv[1] = link;
      expect(isMain(`file://${target}`)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("is true through a path containing a space", () => {
    const dir = mkdtempSync(join(tmpdir(), "paperpilot ismain space "));
    try {
      const target = join(dir, "has space.ts");
      writeFileSync(target, "export {};\n");
      process.argv[1] = target;
      expect(isMain(`file://${target}`)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
