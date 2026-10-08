/**
 * Theme slug constants, ported from docs/assets/theme.js (client-side
 * validation) and kept in lockstep with worker/slug.js's `SLUG_RE` /
 * `THEME_INPUT_PATTERN` (API-08 / SCR-31 / OUT-53 — three-way parity
 * between Python `_common.theme_slug()`, the CF Worker, and the
 * browser). test/themes/slug-parity.test.ts reads worker/slug.js's
 * source text and asserts these regex literals are byte-identical to
 * it, so this file must never redefine them with "equivalent but not
 * identical" patterns.
 *
 * The two regexes are the browser's OWN validation — `themeSlug()` (the
 * NFKD normalisation that *derives* a slug from free text) is
 * server-side authority only; the browser never derives its own slug,
 * it only validates one it already has (a `?theme=` URL param or a slug
 * the Worker echoed back in a JSON response). `themeSlug` is re-exported
 * below anyway, from the single consolidated `@paperpilot/core/slug`
 * implementation (docs/migration/p4-followups.md #25, TS side only), so
 * this file stays the one place web code imports anything "theme slug"
 * shaped from, and so this package's own parity test
 * (test/themes/slug-parity.test.ts) can extend to cover it directly.
 */

export { themeSlug } from "@paperpilot/core/slug";

/** Mirror of paperpilot/scripts/_common._SLUG_ALLOWED_RE / theme_slug()
 * output, and of worker/slug.js's `SLUG_RE`. Validates slugs read from
 * `?theme=` and slugs echoed back by the Worker — never the raw
 * free-text theme name. */
export const SLUG_RE: RegExp = /^[a-z0-9-]+$/;

/** Same pattern worker/slug.js's `THEME_INPUT_PATTERN` enforces
 * server-side. Validated client-side too so the bad-input message can
 * be styled and localised before the round-trip. */
export const THEME_INPUT_PATTERN: RegExp = /^[A-Za-z0-9 _-]{2,80}$/;
