/**
 * Build-time-only reader for the per-slug operator copy
 * `apps/pipeline/src/conference/scaffold/cli.ts` writes to
 * `<layout.config>/conference-copy/<slug>.json` (p5-plan.md §2 A2,
 * follow-up #17). Reads with plain `node:fs` -- same convention as
 * `lib/lineage/server-fs.ts`: import this ONLY from a server component
 * / build-time module, never a `"use client"` component.
 *
 * A MISSING file returns `null` -- `getCatalogCopy` (`catalog-copy.ts`)
 * falls back to its generic copy in that case, same as a well-formed
 * file with an empty/missing `display`/`lede`.
 *
 * A file that EXISTS but contains malformed JSON throws instead (L6 of
 * the P5 tier-A review): silently falling back there would mean a
 * corrupted operator-supplied copy file publishes generic placeholder
 * text with no error anywhere, for a conference whose scaffold step
 * (`conference/scaffold/cli.ts`) already successfully wrote a file --
 * the corruption would have to happen AFTER a successful write, which
 * is exactly the kind of silent data-loss a build should fail loudly
 * on instead of papering over.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { conferenceCopyDir, layoutFor } from "@paperpilot/core/layout";

const HERE = dirname(fileURLToPath(import.meta.url));
// This file lives at apps/web/lib/catalog-copy-reader.ts -- three
// segments below the repo root (apps, web, lib), so three ".." reach it
// -- same depth as lib/lineage/server-fs.ts.
const REPO_ROOT = resolve(HERE, "..", "..", "..");

export interface ConferenceCopyFileEntry {
  display: string;
  lede: string;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

export class ConferenceCopyFileError extends Error {}

/**
 * Reads `<layout.config>/conference-copy/<slug>.json`. Returns `null`
 * when the file doesn't exist, isn't a JSON object, or is missing a
 * non-empty string `display`/`lede`. Throws {@link ConferenceCopyFileError}
 * when the file EXISTS but fails to parse as JSON at all (L6) -- this
 * one case is deliberately NOT folded into the `null` fallback.
 */
export function readConferenceCopyFile(
  slug: string,
  repoRoot: string = REPO_ROOT,
): ConferenceCopyFileEntry | null {
  const path = join(conferenceCopyDir(layoutFor(repoRoot)), `${slug}.json`);
  if (!existsSync(path)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf-8"));
  } catch (exc) {
    throw new ConferenceCopyFileError(
      `malformed JSON in conference copy file ${path}: ${(exc as Error).message}`,
    );
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const { display, lede } = parsed as Record<string, unknown>;
  if (!isNonEmptyString(display) || !isNonEmptyString(lede)) return null;
  return { display, lede };
}
