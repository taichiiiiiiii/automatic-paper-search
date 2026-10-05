/**
 * Build-time-only reader for the per-slug operator copy
 * `apps/pipeline/src/conference/scaffold/cli.ts` writes to
 * `<layout.config>/conference-copy/<slug>.json` (p5-plan.md §2 A2,
 * follow-up #17). Reads with plain `node:fs` -- same convention as
 * `lib/lineage/server-fs.ts`: import this ONLY from a server component
 * / build-time module, never a `"use client"` component.
 *
 * A missing or malformed file returns `null` -- `getCatalogCopy`
 * (`catalog-copy.ts`) falls back to its generic copy in that case, it
 * never throws the build.
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

/**
 * Reads `<layout.config>/conference-copy/<slug>.json`. Returns `null`
 * when the file doesn't exist, isn't valid JSON, isn't an object, or is
 * missing a non-empty string `display`/`lede` -- never throws.
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
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const { display, lede } = parsed as Record<string, unknown>;
  if (!isNonEmptyString(display) || !isNonEmptyString(lede)) return null;
  return { display, lede };
}
