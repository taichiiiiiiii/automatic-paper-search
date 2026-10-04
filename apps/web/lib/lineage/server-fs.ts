/**
 * Build-time-only helpers for `generateStaticParams` (design doc §P2
 * step 4: output: "export" needs every dynamic route enumerated at
 * build time). These read `docs/` directly with `node:fs` -- `docs/`
 * is the data's source of truth pre-P5 (design doc §7.3) and this is a
 * READ, same as apps/web/scripts/copy-data.ts.
 *
 * Import this ONLY from a server component (a route's `layout.tsx`,
 * never a `"use client"` `page.tsx`) -- `node:fs` is not available in
 * the browser bundle, and Next would fail the build if a client
 * component pulled it in.
 */
import { readdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// This file lives at apps/web/lib/lineage/server-fs.ts -- four segments
// below the repo root (apps, web, lib, lineage), so four ".." reach it.
const HERE = dirname(fileURLToPath(import.meta.url));
const DOCS_DIR = join(HERE, "..", "..", "..", "..", "docs");

const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;

/**
 * Lists every top-level `docs/<slug>/` directory (a conference) that
 * also contains `<fileName>`, sorted. Used so `generateStaticParams`
 * only emits routes for conferences that actually have the artifact
 * this route reads (e.g. `lineage.json` for `/[conf]/lineage/`,
 * `deep-manifest.json` for `/[conf]/deep/`) -- matching which
 * conferences ship a `lineage.html`/`deep.html` today.
 */
export async function listConferenceSlugsWithFile(fileName: string): Promise<string[]> {
  let names: string[];
  try {
    names = await readdir(DOCS_DIR);
  } catch {
    return [];
  }
  const slugs: string[] = [];
  for (const name of names) {
    if (!SLUG_RE.test(name)) continue;
    try {
      const target = join(DOCS_DIR, name, fileName);
      const info = await stat(target);
      if (info.isFile()) slugs.push(name);
    } catch {
      // No such file for this conference -- not a build error, just excluded.
    }
  }
  return slugs.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}
