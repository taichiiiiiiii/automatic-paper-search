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
 * Only *.json files are copied. Everything else the current docs/ site
 * contains -- *.html, docs/assets/** (css/js/images), docs/design/**,
 * docs/research/**, and any `*_IMPLEMENTER.md` -- is excluded (design
 * doc §4.3 "公開対象": design/research/implementer docs are never
 * published, and this app only needs the JSON a page fetches).
 */
import { copyFile, mkdir, readdir } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const DOCS_DIR = join(SCRIPT_DIR, "..", "..", "..", "docs");
const PUBLIC_DIR = join(SCRIPT_DIR, "..", "public");

const EXCLUDED_TOP_LEVEL_DIRS = new Set(["design", "research"]);

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
  const allFiles = await listFiles(DOCS_DIR, DOCS_DIR);
  const toCopy = allFiles.filter(shouldCopy);
  for (const rel of toCopy) {
    const src = join(DOCS_DIR, rel);
    const dest = join(PUBLIC_DIR, rel);
    await mkdir(dirname(dest), { recursive: true });
    await copyFile(src, dest);
  }
  console.log(`copy-data: copied ${toCopy.length} JSON file(s) from ${DOCS_DIR} to ${PUBLIC_DIR}`);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
