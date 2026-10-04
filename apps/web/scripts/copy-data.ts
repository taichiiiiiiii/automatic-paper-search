#!/usr/bin/env -S npx tsx
/**
 * Prebuild step: copies the published JSON data files from the current
 * docs/ (still the data's source of truth pre-P5 -- design doc §7.3)
 * into apps/web/public/, so pages can fetch them at runtime from the
 * same paths as today (e.g. /cvpr-2026/papers.json, /conferences.json).
 *
 * docs/ is READ-ONLY from apps/web's perspective: this script only ever
 * reads under docs/ and only ever writes under apps/web/public/.
 * public/ is gitignored (apps/web/.gitignore) -- its contents are build
 * artifacts this script regenerates, not something to commit.
 *
 * Only *.json files are copied, plus a short list of head-metadata
 * assets (favicon/OG image -- see HEAD_ASSET_FILES) pages need at
 * request time. Everything else the current docs/ site contains --
 * *.html, the rest of docs/assets/** (css/js), docs/design/**,
 * docs/research/**, docs/migration/**, and any `*_IMPLEMENTER.md` -- is
 * excluded (design doc §4.3 "公開対象": design/research/implementer/
 * migration-planning docs are never published, and this app only needs
 * the JSON a page fetches plus those few head assets).
 *
 * `public/` is wiped and recreated on every run before copying (not
 * merely overwritten): it is a pure build artifact (see the gitignore
 * note above), so a file removed from -- or renamed in -- `docs/` since
 * the last run must not linger here as stale, no-longer-published data.
 */
import { copyFile, mkdir, readdir, rm } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const DOCS_DIR = join(SCRIPT_DIR, "..", "..", "..", "docs");
const PUBLIC_DIR = join(SCRIPT_DIR, "..", "public");

const EXCLUDED_TOP_LEVEL_DIRS = new Set(["design", "research", "migration"]);

/** Non-JSON `docs/assets/` files pages' head metadata reference
 * (apps/web/lib/metadata.ts, apps/web/app/layout.tsx): the favicon and
 * the site-wide Open Graph / Twitter Card image, at the same
 * `/assets/<name>` path the current docs/ site serves them from. */
const HEAD_ASSET_FILES = ["favicon.svg", "favicon-32.png", "og-image.png"];

/** Decides whether one docs/-relative path (POSIX-style, e.g.
 * "cvpr-2026/papers.json") should be copied into public/. */
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

async function listFiles(dir: string, base: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFiles(full, base)));
    } else if (entry.isFile()) {
      // Normalize to "/" so shouldCopy's split("/") is platform-independent.
      files.push(relative(base, full).split(sep).join("/"));
    }
  }
  return files;
}

async function main(): Promise<void> {
  // Clean dir first (see the doc comment above): a stale file from a
  // removed/renamed docs/ entry must not survive into this run's public/.
  await rm(PUBLIC_DIR, { recursive: true, force: true });
  await mkdir(PUBLIC_DIR, { recursive: true });

  const allFiles = await listFiles(DOCS_DIR, DOCS_DIR);
  const toCopy = allFiles.filter(shouldCopy);
  for (const rel of toCopy) {
    const src = join(DOCS_DIR, rel);
    const dest = join(PUBLIC_DIR, rel);
    await mkdir(dirname(dest), { recursive: true });
    await copyFile(src, dest);
  }

  for (const name of HEAD_ASSET_FILES) {
    const src = join(DOCS_DIR, "assets", name);
    const dest = join(PUBLIC_DIR, "assets", name);
    await mkdir(dirname(dest), { recursive: true });
    await copyFile(src, dest);
  }

  console.log(
    `copy-data: copied ${toCopy.length} JSON file(s) + ${HEAD_ASSET_FILES.length} head asset(s) from ${DOCS_DIR} to ${PUBLIC_DIR}`,
  );
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
