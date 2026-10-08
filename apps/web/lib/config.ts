/**
 * Site-wide configuration constants, re-exported from the single source
 * of truth in @paperpilot/core (see
 * docs/design/39-typescript-cloudflare-migration.md §4.1-4.4).
 *
 * apps/web code should import from here (or directly from
 * @paperpilot/core -- both resolve to the same values) rather than
 * hard-coding the origin, path prefix, or API host anywhere else. This
 * file exists so app code has a short, local import path; it must never
 * redeclare any of these values itself (that would be exactly the drift
 * this module exists to prevent).
 */
export {
  API_BASE,
  BASE_PATH,
  buildCspContent,
  buildNonScriptCspDirectives,
  canonicalUrl,
  LEGACY_GITHUB_PAGES_BASE_PATH,
  legacyGithubPagesUrl,
  PUBLIC_ORIGIN,
} from "@paperpilot/core/site";
