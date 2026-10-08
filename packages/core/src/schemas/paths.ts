/**
 * Why: §3 of docs/design/39-typescript-cloudflare-migration.md keeps
 * `schemas/*.schema.json` (23 files) at the repo root as the one source of
 * truth and says packages/core must read them "from the repo `schemas/`
 * dir at runtime ... no copying". Pre-P5 the repo layout is still the
 * legacy one (`docs/`, `paperpilot/data/`, `schemas/` at the root; the
 * `data/` move happens once, in P5 -- see design doc §1 and §7.3), so this
 * helper locates `schemas/` and the repo root by walking up from this
 * module's own location instead of hard-coding a relative depth that
 * would silently break when the repo is restructured.
 */

import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SCHEMA_FILE_SUFFIX = ".schema.json";
const MAX_WALK_UP = 12;

function containsSchemaFiles(dir: string): boolean {
  try {
    return readdirSync(dir).some((name) => name.endsWith(SCHEMA_FILE_SUFFIX));
  } catch {
    return false;
  }
}

function findSchemaDir(startDir: string): string {
  let dir = startDir;
  for (let i = 0; i < MAX_WALK_UP; i += 1) {
    const candidate = join(dir, "schemas");
    if (existsSync(candidate) && containsSchemaFiles(candidate)) {
      return candidate;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(
    `could not locate a repo "schemas/" directory containing *${SCHEMA_FILE_SUFFIX} files ` +
      `by walking up from ${startDir}. See docs/design/39-typescript-cloudflare-migration.md §3.`,
  );
}

let cachedSchemaDir: string | undefined;

/** Absolute path to the repo's `schemas/` directory (the 23 *.schema.json files). */
export function getSchemaDir(): string {
  if (cachedSchemaDir === undefined) {
    cachedSchemaDir = findSchemaDir(dirname(fileURLToPath(import.meta.url)));
  }
  return cachedSchemaDir;
}

/** Absolute path to the monorepo root (parent of `schemas/`). */
export function getRepoRoot(): string {
  return dirname(getSchemaDir());
}

/** Sorted list of `*.schema.json` file names found in the repo `schemas/` directory. */
export function listSchemaFiles(): string[] {
  return readdirSync(getSchemaDir())
    .filter((name) => name.endsWith(SCHEMA_FILE_SUFFIX))
    .sort();
}

/** Strips the `.schema.json` suffix, e.g. `lineage-artifact-v1.schema.json` -> `lineage-artifact-v1`. */
export function schemaNameFromFile(fileName: string): string {
  return fileName.slice(0, -SCHEMA_FILE_SUFFIX.length);
}
