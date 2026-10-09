#!/usr/bin/env -S npx tsx
/**
 * Generator for the GitHub Pages redirect site that replaces the
 * legacy static site after the Cloudflare Pages cutover (design doc
 * §5.4 / docs/migration/p5-plan.md §5.4, changeset A8).
 *
 * The old site's own tree (`legacy/gh-pages-site/`) was deleted in
 * Tier C (p5-plan.md §6.3). Before that, the list of every `*.html`
 * page it served (plus `404.html`) was frozen into
 * `legacy/redirect/paths.json`; this generator reads only that list and
 * never walks a site directory. It writes a stub page per listed path
 * (plus a generated `404.html` catch-all, `.nojekyll`, and a copy of
 * `legacy/redirect/redirect.js`) into a gitignored output directory.
 *
 * Wired to a real GitHub Pages deploy only by `legacy-redirects.yml`
 * (dispatch-only, runbook cutover step 10).
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalUrl, LEGACY_GITHUB_PAGES_BASE_PATH, PUBLIC_ORIGIN } from "@paperpilot/core/site";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "..", "..", "..");

/**
 * Default path list: the frozen `legacy/redirect/paths.json`, resolved
 * from this script's own location (never the caller's cwd -- `pnpm
 * --filter @paperpilot/web run` chdirs into apps/web; see
 * generator.cwd.spawn.test.ts).
 */
export const DEFAULT_PATHS_FILE = join(REPO_ROOT, "legacy", "redirect", "paths.json");

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
  /** Site-relative POSIX paths (no leading "/"), e.g. `iclr-2026/lineage.html`. */
  readonly paths: readonly string[];
  readonly outDir: string;
}

export interface LegacyRedirectCliOptions {
  readonly pathsFile: string;
  readonly outDir: string;
}

/** One safe site-relative `*.html` path: no leading "/", no "." / ".."
 * / empty segment, no backslash -- so a stub can never be written
 * outside `outDir`. */
const SAFE_HTML_PATH = /^(?!.*(?:^|\/)\.{1,2}(?:\/|$))[^/\\]+(?:\/[^/\\]+)*\.html$/;

/**
 * Reads and validates a frozen path list (`legacy/redirect/paths.json`
 * shape: `{ "paths": string[] }`). Throws on a missing/invalid file, a
 * non-string or unsafe entry, or a duplicate, rather than silently
 * publishing a partial redirect site.
 */
export async function readFrozenPaths(file: string): Promise<string[]> {
  const parsed = JSON.parse(await readFile(file, "utf8")) as unknown;
  const paths = (parsed as { paths?: unknown } | null)?.paths;
  if (!Array.isArray(paths)) {
    throw new Error(`legacy-redirects: ${file} has no "paths" array`);
  }
  const seen = new Set<string>();
  for (const entry of paths) {
    if (typeof entry !== "string" || !SAFE_HTML_PATH.test(entry)) {
      throw new Error(
        `legacy-redirects: ${file} has an invalid path entry ${JSON.stringify(entry)}`,
      );
    }
    if (seen.has(entry)) {
      throw new Error(`legacy-redirects: ${file} lists ${JSON.stringify(entry)} twice`);
    }
    seen.add(entry);
  }
  return paths as string[];
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
 * for every entry of `options.paths` (at the identical relative path, so
 * the old URL still resolves to a real file), a
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
  const { paths, outDir } = options;
  await mkdir(outDir, { recursive: true });

  const written: string[] = [];

  for (const relPath of paths) {
    if (!SAFE_HTML_PATH.test(relPath)) {
      throw new Error(`legacy-redirects: refusing unsafe path ${JSON.stringify(relPath)}`);
    }
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
  defaults: LegacyRedirectCliOptions,
): LegacyRedirectCliOptions {
  let pathsFile = defaults.pathsFile;
  let outDir = defaults.outDir;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--paths") {
      const value = argv[i + 1];
      if (value !== undefined) {
        pathsFile = resolve(value);
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
  return { pathsFile, outDir };
}

function invokedAsScript(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && resolve(entry) === fileURLToPath(import.meta.url);
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2), {
    pathsFile: DEFAULT_PATHS_FILE,
    outDir: DEFAULT_OUT_DIR,
  });
  const paths = await readFrozenPaths(options.pathsFile);
  const { written } = await generateLegacyRedirectSite({ paths, outDir: options.outDir });
  console.log(
    `legacy-redirects: wrote ${written.length} page(s) + redirect.js + .nojekyll from ${options.pathsFile} to ${options.outDir}`,
  );
}

if (invokedAsScript()) {
  main().catch((err: unknown) => {
    console.error(err);
    process.exitCode = 1;
  });
}
