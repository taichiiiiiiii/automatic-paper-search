/**
 * Theme slug helpers for apps/web — the one place web code imports
 * anything "theme slug" shaped from.
 *
 * Nothing is defined here: `SLUG_RE`, `THEME_INPUT_PATTERN` and
 * `themeSlug` are re-exported from the single consolidated definition in
 * `@paperpilot/core/slug` (packages/core/src/slug/{patterns,theme}.ts),
 * per docs/migration/safety-contracts.md API-08 — the same objects
 * apps/api validates requests with, so browser and server can't drift.
 * That module has no imports at all, so it is browser-safe.
 *
 * - `SLUG_RE` validates slugs read from `?theme=` and slugs echoed back
 *   by the API — never the raw free-text theme name.
 * - `THEME_INPUT_PATTERN` is the server-side request gate, checked
 *   client-side too so the bad-input message can be styled and localised
 *   before the round-trip.
 * - `themeSlug()` (NFKD derivation of a slug from free text) is
 *   server-side authority; the browser only validates slugs it already
 *   has.
 *
 * test/themes/slug-parity.test.ts pins the behaviour against the frozen
 * worker/slug.js fixture.
 */

export { SLUG_RE, THEME_INPUT_PATTERN, themeSlug } from "@paperpilot/core/slug";
