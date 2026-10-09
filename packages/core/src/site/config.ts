/**
 * Site-wide configuration: the single source of truth for the public
 * origin, path prefix, API host, the canonical-URL builder, and the CSP
 * directives that must be byte-identical across every page.
 *
 * See docs/design/39-typescript-cloudflare-migration.md:
 *   - §4.1-4.2 for the origin / path-prefix change (GitHub Pages ->
 *     Cloudflare Pages, prefix dropped).
 *   - §4.4 for "script the hash aside, every other directive is one
 *     value, generated from packages/core".
 *
 * apps/web/lib/config.ts and apps/web/scripts/csp-hash.ts both import
 * from here (directly, or via apps/web/lib/config.ts) so there is exactly
 * one place that knows these values -- no drift between the build-time
 * CSP injector and the app's own runtime constants.
 */

/**
 * Cloudflare Pages project origin (production). Placeholder until the
 * user creates the Direct Upload project (design doc §10-1) and reports
 * back the final `*.pages.dev` URL or custom domain -- update this one
 * constant then; nothing else in the codebase hard-codes the origin.
 */
export const PUBLIC_ORIGIN = "https://paperpilot.pages.dev";

/**
 * Cloudflare Pages project name (design doc §7.4 Phase W / P0-1;
 * docs/migration/p5-plan.md §2 A5, §4 "Workflow env constants"). Used by
 * the staged `pages-release.yml` (`--project-name="$CF_PAGES_PROJECT"`)
 * and `cf-deployment-id` / `cf-rollback`.
 *
 * The Direct Upload project `paperpilot` (domain paperpilot.pages.dev)
 * exists in the production account; a preview deploy to it passed the
 * release smoke on 2026-10-09 (docs/migration/p5-runbook.md, P2).
 */
export const PAGES_PROJECT_NAME = "paperpilot";

/**
 * Cloudflare Pages production branch name (design doc §7.4; p5-plan.md
 * §2 A5, §6.1 P0-1). `wrangler pages deploy --branch="$CF_PAGES_PRODUCTION_BRANCH"`
 * must match whatever the user configures as "production" for the Pages
 * project, or the deploy lands as a non-production preview.
 *
 * Matches the project's `production_branch` (checked via the API on
 * 2026-10-09). A mismatch would fail closed: the deploy would land as a
 * preview and `cf-deployment-id` would find no production deployment.
 */
export const PAGES_PRODUCTION_BRANCH = "production";

/**
 * Path prefix on the current production origin. Cloudflare Pages serves
 * from the domain root, so every page lives at `/<slug>/` with no prefix.
 */
export const BASE_PATH = "";

/**
 * Path prefix the site used to be served under, on GitHub Pages
 * (`https://taichiiiiiiii.github.io/automatic-paper-search/...`). Not used
 * for the current site's own links or canonical URLs -- kept only so the
 * GitHub Pages redirect pages (design doc §4.2-5) can compute the legacy
 * URL a visitor might still land on.
 */
export const LEGACY_GITHUB_PAGES_BASE_PATH = "/automatic-paper-search";

/**
 * Origin of the CF Worker that serves `/api/*` (theme submission). Must
 * stay in sync with the `connect-src` directive below -- it is the same
 * constant, not a parallel copy.
 */
export const API_BASE = "https://paperpilot-themes.puuptdbkh082.workers.dev";

/**
 * Builds the canonical absolute URL for a site-relative path on the
 * current production origin (`PUBLIC_ORIGIN` + `BASE_PATH`, not the
 * legacy GitHub Pages one).
 *
 * @param path Must start with "/" (e.g. "/", "/cvpr-2026/").
 */
export function canonicalUrl(path: string): string {
  if (!path.startsWith("/")) {
    throw new Error(`canonicalUrl: path must start with "/", got ${JSON.stringify(path)}`);
  }
  return `${PUBLIC_ORIGIN}${BASE_PATH}${path}`;
}

/**
 * Builds the legacy GitHub Pages URL for a site-relative path. Only for
 * use by the redirect pages that stay behind on GitHub Pages after the
 * Cloudflare Pages switch (design doc §4.2-5) -- current pages must use
 * `canonicalUrl`, never this.
 *
 * @param path Must start with "/" (e.g. "/", "/cvpr-2026/").
 */
export function legacyGithubPagesUrl(path: string): string {
  if (!path.startsWith("/")) {
    throw new Error(`legacyGithubPagesUrl: path must start with "/", got ${JSON.stringify(path)}`);
  }
  return `https://taichiiiiiiii.github.io${LEGACY_GITHUB_PAGES_BASE_PATH}${path}`;
}

/**
 * Every CSP directive except `script-src`, in the fixed order they are
 * joined in. By construction (design doc §4.4-1) these are the same on
 * every page; `script-src` is the only directive that varies per page
 * (per-build inline-script hashes), so it is deliberately not included
 * here -- see `buildCspContent`.
 */
const DEFAULT_SRC_DIRECTIVE = "default-src 'self'";

export function buildNonScriptCspDirectives(): string[] {
  return [
    DEFAULT_SRC_DIRECTIVE,
    `connect-src 'self' ${API_BASE}`,
    "style-src 'self'",
    "font-src 'self'",
    "img-src 'self' data:",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
  ];
}

/**
 * Assembles the full `Content-Security-Policy` meta-tag content for one
 * page: `default-src`, then the page's own `script-src` directive, then
 * every other (site-wide, identical) directive.
 *
 * @param scriptSrcDirective The complete `script-src ...` directive for
 *   this page (e.g. `script-src 'self' 'sha256-...'`), computed by
 *   apps/web/scripts/csp-hash.ts from that page's built HTML.
 */
export function buildCspContent(scriptSrcDirective: string): string {
  // slice(1), not destructuring index 0: with noUncheckedIndexedAccess,
  // indexing buildNonScriptCspDirectives()[0] would type as
  // `string | undefined` even though this array is a fixed literal.
  return [
    DEFAULT_SRC_DIRECTIVE,
    scriptSrcDirective,
    ...buildNonScriptCspDirectives().slice(1),
  ].join("; ");
}
