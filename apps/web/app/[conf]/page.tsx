import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { CatalogApp } from "../../components/catalog/catalog-app";
import { selectCatalogConferences } from "../../lib/catalog-conferences";
import { getCatalogCopy } from "../../lib/catalog-copy";
import { buildMetadata } from "../../lib/metadata";
import { assertConferenceHasPapersJson } from "./paper-links/build-guard";

/**
 * The conference catalog route (docs/<conf>/index.html, one per row of
 * conferences.json -- design doc §8 P2). A server component so
 * `generateStaticParams`/`generateMetadata` can read conferences.json at
 * build time with plain `node:fs`; the actual papers.json fetch stays
 * client-side at runtime (lib/catalog-data.ts), same as today -- no
 * paper data is embedded into this page's HTML.
 *
 * Reads from `public/conferences.json`, not `docs/`: by the time `next
 * build` runs this, `scripts/copy-data.ts` (the `prebuild` hook) has
 * already copied it there. That keeps exactly one reader of `docs/`
 * (copy-data.ts) and lets this file read the same bytes the browser
 * will fetch at runtime.
 */

interface ConferencesRow {
  name: string;
  generated: string;
}

function readConferencesJson(): ConferencesRow[] {
  const path = join(process.cwd(), "public", "conferences.json");
  const raw = JSON.parse(readFileSync(path, "utf8"));
  return selectCatalogConferences(raw);
}

export function generateStaticParams(): Array<{ conf: string }> {
  const rows = readConferencesJson();
  // See paper-links/build-guard.ts: a static export has no server to
  // 404 a missing papers.json at request time, so a conference listed
  // in conferences.json without one must fail the build here, loudly,
  // rather than silently 404-ing the live route later.
  for (const row of rows) {
    assertConferenceHasPapersJson(row.name);
  }
  return rows.map((row) => ({ conf: row.name }));
}

// Static export: every valid path is enumerated above. An unknown
// `/<conf>/` must 404 at build/serve time, not be treated as a dynamic
// path Next could try to render on demand (which does not exist in
// `output: "export"` anyway) -- this just makes that explicit.
export const dynamicParams = false;

function findConferenceRow(conf: string): ConferencesRow | null {
  return readConferencesJson().find((row) => row.name === conf) ?? null;
}

// Next.js 15: a dynamic segment's `params` is a Promise (must be
// awaited) in both `generateMetadata` and the page component.
export async function generateMetadata({
  params,
}: {
  params: Promise<{ conf: string }>;
}): Promise<Metadata> {
  const { conf } = await params;
  const row = findConferenceRow(conf);
  if (!row) notFound();
  const copy = getCatalogCopy(row.name);
  return buildMetadata({
    path: `/${row.name}/`,
    title: `${copy.display} — PaperPilot`,
    description: copy.description,
  });
}

export default async function ConferenceCatalogPage({
  params,
}: {
  params: Promise<{ conf: string }>;
}) {
  const { conf } = await params;
  const row = findConferenceRow(conf);
  if (!row) notFound();
  const copy = getCatalogCopy(row.name);
  return <CatalogApp conf={row.name} generated={row.generated} copy={copy} />;
}
