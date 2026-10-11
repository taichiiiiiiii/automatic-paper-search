/**
 * Built-output checks for design doc 48 P0-5 / P1-3 / P1-5 (R4-2). Each
 * test reads the static export and skips when `apps/web/out` is missing
 * (same pattern as r4-1-site-p0-built.test.ts); CI builds before testing.
 *
 * The panel, path, timeline and "系譜での位置" are client components, so
 * their copy lives in the JS chunks, not the static HTML.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const OUT = join(TEST_DIR, "..", "..", "out");
const HOW = join(OUT, "how-it-works", "index.html");
const THEMES = join(OUT, "themes", "index.html");
const CHUNKS = join(OUT, "_next", "static", "chunks");

function allChunks(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...allChunks(p));
    else if (name.endsWith(".js")) out.push(p);
  }
  return out;
}

/** Chunks referenced by one built page (its <script src> list). */
function pageChunks(htmlPath: string): string {
  const html = readFileSync(htmlPath, "utf8");
  const srcs = [...html.matchAll(/<script[^>]+src="([^"]+\.js)"/g)].map((m) => m[1] as string);
  return srcs
    .map((src) => join(OUT, decodeURIComponent(src.replace(/^.*?\/_next\//, "_next/"))))
    .filter((p) => existsSync(p))
    .map((p) => readFileSync(p, "utf8"))
    .join("\n");
}

function firstCatalogPage(): string | null {
  if (!existsSync(OUT)) return null;
  for (const name of readdirSync(OUT).sort()) {
    if (!/^[a-z]+-\d{4}$/.test(name)) continue;
    const p = join(OUT, name, "index.html");
    if (existsSync(p)) return p;
  }
  return null;
}

describe("built output: R4-2 paper views", () => {
  it.skipIf(!existsSync(HOW))(
    "the 仕組み page explains 土台・発展, the path and the timeline",
    () => {
      const html = readFileSync(HOW, "utf8");
      expect(html).toContain('id="paper-neighbors"');
      expect(html).toContain("2 本をつなぐ経路");
      expect(html).toContain("年×被引用");
      expect(html).toContain("系譜での位置");
    },
  );

  it.skipIf(!existsSync(THEMES))(
    "the theme page ships the Prior / Derivative panel, path and timeline",
    () => {
      const js = pageChunks(THEMES);
      // `toBe(true)` keeps a failure message short (the chunks are large).
      // "年×被引用" is not checked verbatim: the minifier escapes "×".
      for (const s of [
        "論文ごとの土台と発展",
        "2 本をつなぐ経路",
        "data-view-toggle",
        "data-theme-timeline",
        "data-prior-derivative",
      ]) {
        expect(js.includes(s), s).toBe(true);
      }
      // No inline style attribute was introduced in the static HTML (CSP).
      expect(readFileSync(THEMES, "utf8")).not.toMatch(/\sstyle="/);
    },
  );

  const catalog = firstCatalogPage();
  it.skipIf(catalog === null)("catalog pages ship the 系譜での位置 section", () => {
    const js = pageChunks(catalog as string);
    expect(js.includes("系譜での位置")).toBe(true);
    expect(js.includes("data-theme-position-link")).toBe(true);
  });

  it.skipIf(allChunks(CHUNKS).length === 0)(
    "the 4 MB identity-aliases file is never fetched by the client",
    () => {
      for (const p of allChunks(CHUNKS)) {
        expect(readFileSync(p, "utf8").includes("identity-aliases-v1.json"), p).toBe(false);
      }
    },
  );
});
