/**
 * Test data read from the built site (apps/web/out), so the suite follows
 * whatever is published instead of hard-coding theme/conference lists.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "out");

function readJson<T>(rel: string): T {
  const file = join(OUT_DIR, rel);
  if (!existsSync(file)) {
    throw new Error(`${file} missing: build apps/web first (pnpm --filter @paperpilot/web build)`);
  }
  return JSON.parse(readFileSync(file, "utf8")) as T;
}

export interface PublishedTheme {
  slug: string;
  theme: string;
  paper_count: number;
}

interface QualityRow {
  kind: string;
  slug: string;
  publication_tier: string;
  availability: string;
}

/** Themes listed in the manifest whose quality row is publishable
 * (audited/unaudited and ready) -- the ones /themes/ actually renders. */
export function publishedThemes(): PublishedTheme[] {
  const manifest = readJson<PublishedTheme[]>("themes/themes-manifest.json");
  const quality = readJson<{ collections: QualityRow[] }>("lineage-quality-v1.json");
  const ok = new Set(
    quality.collections
      .filter(
        (c) =>
          c.kind === "theme" &&
          c.availability === "ready" &&
          (c.publication_tier === "audited" || c.publication_tier === "unaudited"),
      )
      .map((c) => c.slug),
  );
  return manifest.filter((t) => ok.has(t.slug));
}

export interface ConferenceSummary {
  name: string;
  papers: number;
}

export function conferences(): ConferenceSummary[] {
  return readJson<ConferenceSummary[]>("conferences.json");
}

export function conferencePaperCount(conf: string): number {
  const c = conferences().find((x) => x.name === conf);
  if (!c) throw new Error(`conference ${conf} not in conferences.json`);
  return c.papers;
}

/** `/<conf>/paper-links/<n>/` pages present in the build (n >= 2). */
export function paperLinksPages(conf: string): number[] {
  const pages = [1];
  for (let n = 2; existsSync(join(OUT_DIR, conf, "paper-links", String(n), "index.html")); n++) {
    pages.push(n);
  }
  return pages;
}

export function themeHasFeed(slug: string): boolean {
  return existsSync(join(OUT_DIR, "themes", slug, "feed.xml"));
}
