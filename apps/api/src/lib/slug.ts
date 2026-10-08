// TS port of worker/slug.js (plain-JS port of
// paperpilot/scripts/_common.theme_slug()). Kept as a 1:1 behavioural copy —
// see worker/slug.js for the full rationale comments this intentionally
// preserves.
//
// TODO(packages/core): this belongs in packages/core/slug/theme.ts per
// docs/migration/safety-contracts.md API-08 (single definition shared by
// apps/web, apps/api, and the Python parity test). Left local to apps/api
// for P3 because another agent is editing packages/core concurrently; move
// it there (and delete this copy) in a follow-up once that lands.

const SLUG_MAX_LEN = 64;
// biome-ignore lint/suspicious/noControlCharactersInRegex: intentional ASCII-range strip, mirrors worker/slug.js exactly (parity-critical)
const NON_ASCII = /[^\x00-\x7F]/g;
const SLUG_COLLAPSE = /[^a-z0-9]+/g;
const SLUG_TRIM = /^-+|-+$/g;
const TRAILING_HYPHEN = /-+$/g;

export function themeSlug(label: string): string {
  if (!label || !label.trim()) {
    throw new Error("theme_slug: label must be non-empty");
  }
  const ascii = label.normalize("NFKD").replace(NON_ASCII, "");
  let slug = ascii.toLowerCase().replace(SLUG_COLLAPSE, "-").replace(SLUG_TRIM, "");
  if (slug.length > SLUG_MAX_LEN) {
    slug = slug.slice(0, SLUG_MAX_LEN).replace(TRAILING_HYPHEN, "");
  }
  if (!slug) {
    throw new Error(`theme_slug: derived slug is empty for input: ${label}`);
  }
  return slug;
}

export const THEME_INPUT_PATTERN = /^[A-Za-z0-9 _-]{2,80}$/;
export const SLUG_RE = /^[a-z0-9-]+$/;
