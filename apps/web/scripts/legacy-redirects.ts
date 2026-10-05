#!/usr/bin/env -S npx tsx
/**
 * Generator for the GitHub Pages redirect site that replaces the
 * legacy static site after the Cloudflare Pages cutover (design doc
 * §5.4 / docs/migration/p5-plan.md §5.4, changeset A8).
 *
 * The legacy site lives at `docs/` today (LAYOUT_MODE "legacy") and
 * moves to `legacy/gh-pages-site/` once the data move (A9) lands, so
 * both the source directory and the output directory are CLI
 * arguments rather than hard-coded -- this file must keep working
 * unchanged across that move. Only `*.html` pages are mirrored (plus a
 * generated `404.html` catch-all, `.nojekyll`, and a copy of
 * `legacy/redirect/redirect.js`); every `*.json` / other data file
 * under the source directory is left alone -- this script never reads
 * their contents and never writes one.
 *
 * This generator, and every file it writes, is INERT while
 * LAYOUT_MODE is "legacy" (CLAUDE.md "TypeScript 移行中の開発ルール"):
 * nothing here runs as part of `predev`/`prebuild`/`postbuild`, it
 * writes only inside a gitignored output directory, and it is wired to
 * a real GitHub Pages deploy only by the (separate, not-yet-created)
 * `legacy-redirects.yml` workflow, dispatch-only until the runbook's
 * cutover step 10.
 */
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalUrl, LEGACY_GITHUB_PAGES_BASE_PATH, PUBLIC_ORIGIN } from "@paperpilot/core/site";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "..", "..", "..");

/** Default source: today's legacy site. After the A9 data move this
 * becomes `legacy/gh-pages-site`; callers pass `--source` to point at
 * the new location without editing this file. */
export const DEFAULT_SOURCE_DIR = join(REPO_ROOT, "docs");

/** Default output: a gitignored build artifact under apps/web, never
 * committed (see apps/web/.gitignore). */
export const DEFAULT_OUT_DIR = join(SCRIPT_DIR, "..", "legacy-out");

/** The hand-written redirect script this generator copies into every
 * output tree, with its NEW_ORIGIN placeholder substituted. */
const REDIRECT_JS_SOURCE = join(REPO_ROOT, "legacy", "redirect", "redirect.js");
const REDIRECT_JS_PLACEHOLDER = "%%NEW_ORIGIN%%";

/** The old GH Pages site's custom 404 page is treated specially: its
 * on-disk content (if any) is never copied -- the generated catch-all
 * always redirects to the new site's root. */
const CATCH_ALL_NAME = "404.html";

export interface LegacyRedirectOptions {
  readonly sourceDir: string;
  readonly outDir: string;
}

/**
 * Maps one legacy site-relative path (leading "/", GitHub Pages prefix
 * already stripped) to the new Cloudflare Pages path. Mirrors
 * `legacy/redirect/redirect.js`'s `mapPath` (same rules, independently
 * written) and must keep agreeing with the Cloudflare `_redirects`
 * rules in apps/web/scripts/redirects.ts's `LEGACY_HTML_RULES` for
 * every path shape they both handle -- pinned by
 * apps/web/test/legacy-redirects/cloudflare-parity.test.ts.
 */
export function mapLegacyPath(path: string): string {
  const fileMatch = /^\/([^/]+)\/(lineage|deep|paper-links)\.html$/.exec(path);
  if (fileMatch) {
    return `/${fileMatch[1]}/${fileMatch[2]}/`;
  }
  const indexMatch = /^\/([^/]+)\/index\.html$/.exec(path);
  if (indexMatch) {
    return `/${indexMatch[1]}/`;
  }
  if (path === "/index.html") {
    return "/";
  }
  return path;
}

/** Builds one redirect-stub page: CSP meta (no inline script allowed
 * or needed), a no-JS `<meta http-equiv="refresh">` fallback, a
 * canonical link equal to the mapped target, `noindex`, the external
 * redirect script, and a visible link for anyone who lands here with
 * both JS and the refresh disabled. */
export function buildRedirectPageHtml(targetUrl: string): string {
  const scriptSrc = `${LEGACY_GITHUB_PAGES_BASE_PATH}/redirect.js`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self'">
<meta http-equiv="refresh" content="0; url=${targetUrl}">
<meta name="robots" content="noindex">
<link rel="canonical" href="${targetUrl}">
<title>Moved</title>
<script src="${scriptSrc}"></script>
</head>
<body>
<p>This page has moved to <a href="${targetUrl}">${targetUrl}</a>.</p>
</body>
</html>
`;
}

/** Recursively lists every `*.html` file under `dir`, as POSIX
 * relative paths (no leading "/"). */
async function listHtmlFiles(dir: string, base: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listHtmlFiles(full, base)));
    } else if (entry.isFile() && entry.name.endsWith(".html")) {
      files.push(relative(base, full).split(sep).join("/"));
    }
  }
  return files;
}

async function writeRedirectJs(outDir: string): Promise<void> {
  const template = await readFile(REDIRECT_JS_SOURCE, "utf8");
  if (!template.includes(REDIRECT_JS_PLACEHOLDER)) {
    throw new Error(
      `legacy-redirects: ${REDIRECT_JS_SOURCE} no longer contains the ${REDIRECT_JS_PLACEHOLDER} placeholder`,
    );
  }
  const substituted = template.split(REDIRECT_JS_PLACEHOLDER).join(PUBLIC_ORIGIN);
  await writeFile(join(outDir, "redirect.js"), substituted, "utf8");
}

/**
 * Generates the full redirect site into `options.outDir`: a stub page
 * for every `*.html` file under `options.sourceDir` (at the identical
 * relative path, so the old URL still resolves to a real file), a
 * `404.html` catch-all redirecting to the new site's root, `.nojekyll`
 * (this is a plain static tree, not a Jekyll one), and `redirect.js`
 * with its origin placeholder filled in. No `sitemap.xml` is written.
 *
 * Returns the site-relative (POSIX, leading "/") paths written, for
 * tests and for the (not yet created) workflow's own logging.
 */
export async function generateLegacyRedirectSite(
  options: LegacyRedirectOptions,
): Promise<{ written: string[] }> {
  const { sourceDir, outDir } = options;
  await mkdir(outDir, { recursive: true });

  const htmlFiles = await listHtmlFiles(sourceDir, sourceDir);
  const written: string[] = [];

  for (const relPath of htmlFiles) {
    if (relPath === CATCH_ALL_NAME) {
      // Handled separately below, regardless of source content.
      continue;
    }
    const legacyPath = `/${relPath}`;
    const targetUrl = canonicalUrl(mapLegacyPath(legacyPath));
    const destPath = join(outDir, relPath);
    await mkdir(dirname(destPath), { recursive: true });
    await writeFile(destPath, buildRedirectPageHtml(targetUrl), "utf8");
    written.push(legacyPath);
  }

  const catchAllTarget = canonicalUrl("/");
  await writeFile(join(outDir, CATCH_ALL_NAME), buildRedirectPageHtml(catchAllTarget), "utf8");
  written.push(`/${CATCH_ALL_NAME}`);

  await writeFile(join(outDir, ".nojekyll"), "", "utf8");
  await writeRedirectJs(outDir);

  return { written };
}

export function parseArgs(
  argv: readonly string[],
  defaults: LegacyRedirectOptions,
): LegacyRedirectOptions {
  let sourceDir = defaults.sourceDir;
  let outDir = defaults.outDir;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--source") {
      const value = argv[i + 1];
      if (value !== undefined) {
        sourceDir = resolve(value);
        i++;
      }
    } else if (arg === "--out") {
      const value = argv[i + 1];
      if (value !== undefined) {
        outDir = resolve(value);
        i++;
      }
    }
  }
  return { sourceDir, outDir };
}

function invokedAsScript(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && resolve(entry) === fileURLToPath(import.meta.url);
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2), {
    sourceDir: DEFAULT_SOURCE_DIR,
    outDir: DEFAULT_OUT_DIR,
  });
  const { written } = await generateLegacyRedirectSite(options);
  console.log(
    `legacy-redirects: wrote ${written.length} page(s) + redirect.js + .nojekyll from ${options.sourceDir} to ${options.outDir}`,
  );
}

if (invokedAsScript()) {
  main().catch((err: unknown) => {
    console.error(err);
    process.exitCode = 1;
  });
}
