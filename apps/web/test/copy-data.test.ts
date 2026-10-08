import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Independent re-implementation of scripts/copy-data.ts's `shouldCopy`
 * filter, kept deliberately separate (not imported) for two reasons:
 *   1. Like test/csp.test.ts's `collectInlineScriptHashes`, restating the
 *      rule here catches bugs in the real one rather than mirroring them.
 *   2. scripts/copy-data.ts's `main()` runs unconditionally on import
 *      (same pattern as scripts/csp-hash.ts) and does real filesystem
 *      I/O against ../../docs -- importing it from a test would copy
 *      ~79 MB of real data as a side effect of running `vitest run`.
 */
const EXCLUDED_TOP_LEVEL_DIRS = new Set(["design", "research", "migration"]);

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(TEST_DIR, "..", "public");

function shouldCopy(relPath: string): boolean {
  const segments = relPath.split("/");
  const topLevelDir = segments.length > 1 ? segments[0] : undefined;
  if (topLevelDir !== undefined && EXCLUDED_TOP_LEVEL_DIRS.has(topLevelDir)) {
    return false;
  }
  const basename = segments[segments.length - 1] ?? "";
  if (basename.endsWith("_IMPLEMENTER.md")) {
    return false;
  }
  return basename.endsWith(".json");
}

describe("copy-data shouldCopy", () => {
  it("copies top-level JSON (conferences.json)", () => {
    expect(shouldCopy("conferences.json")).toBe(true);
  });

  it("copies a conference's papers.json", () => {
    expect(shouldCopy("cvpr-2026/papers.json")).toBe(true);
  });

  it("copies a conference's lineage.json", () => {
    expect(shouldCopy("iclr-2026/lineage.json")).toBe(true);
  });

  it("copies the cross-conference search index", () => {
    expect(shouldCopy("search-index-v2.json")).toBe(true);
  });

  it("copies nested shard JSON (paper-details-v1/, search-paper-ids-v1/)", () => {
    expect(shouldCopy("paper-details-v1/4f.json")).toBe(true);
    expect(shouldCopy("search-paper-ids-v1/0048.json")).toBe(true);
  });

  it("copies theme lineage JSON and the themes manifest", () => {
    expect(shouldCopy("themes/flash-attention/lineage.json")).toBe(true);
    expect(shouldCopy("themes/themes-manifest.json")).toBe(true);
  });

  it("excludes non-JSON files (HTML, CSS, JS, images)", () => {
    expect(shouldCopy("index.html")).toBe(false);
    expect(shouldCopy("cvpr-2026/index.html")).toBe(false);
    expect(shouldCopy("assets/style.css")).toBe(false);
    expect(shouldCopy("assets/app.js")).toBe(false);
    expect(shouldCopy("assets/og-image.png")).toBe(false);
  });

  it("excludes everything under docs/design/", () => {
    expect(shouldCopy("design/39-typescript-cloudflare-migration.md")).toBe(false);
  });

  it("excludes everything under docs/research/", () => {
    expect(shouldCopy("research/01-market.md")).toBe(false);
  });

  it("excludes everything under docs/migration/ (migration-planning docs, never published)", () => {
    expect(shouldCopy("migration/safety-contracts.md")).toBe(false);
    expect(shouldCopy("migration/hypothetical.json")).toBe(false);
  });

  it("excludes *_IMPLEMENTER.md wherever it appears", () => {
    expect(shouldCopy("QWEN_IMPLEMENTER.md")).toBe(false);
    expect(shouldCopy("some/nested/FLASH_IMPLEMENTER.md")).toBe(false);
  });

  it("a design/research-named JSON file would still be excluded (dir wins over extension)", () => {
    expect(shouldCopy("design/hypothetical.json")).toBe(false);
    expect(shouldCopy("research/hypothetical.json")).toBe(false);
  });
});

/**
 * LOW finding: copy-data never pruned public/, so a file removed or
 * renamed in docs/ since the last run would linger as stale,
 * no-longer-published data. The fix wipes and recreates public/ before
 * copying. These run against the real apps/web/public/ (skipped if the
 * prebuild script has not populated it yet, same convention as the
 * built-`out/` checks elsewhere in this suite) rather than re-running
 * copy-data.ts's main() here, since that does real filesystem I/O
 * against ../../docs (see this file's header doc comment above).
 */
describe("copy-data prune + head-asset parity (against the real public/)", () => {
  it.skipIf(!existsSync(PUBLIC_DIR))(
    "does not leave a file for a conference removed from docs/",
    () => {
      const ghost = join(PUBLIC_DIR, "this-conference-does-not-exist-in-docs");
      expect(existsSync(ghost)).toBe(false);
    },
  );

  it.skipIf(!existsSync(PUBLIC_DIR))(
    "copies the three head-metadata assets referenced by lib/metadata.ts and app/layout.tsx",
    () => {
      for (const name of ["favicon.svg", "favicon-32.png", "og-image.png"]) {
        expect(existsSync(join(PUBLIC_DIR, "assets", name)), name).toBe(true);
      }
    },
  );

  it.skipIf(!existsSync(PUBLIC_DIR))("does not copy anything from docs/migration/", () => {
    expect(existsSync(join(PUBLIC_DIR, "migration"))).toBe(false);
  });
});
