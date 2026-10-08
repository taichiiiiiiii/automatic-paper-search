/**
 * Theme input / theme slug validation regexes — the ONE definition
 * shared by apps/web (browser-side validation), apps/api (the Worker's
 * request-input gate) and the pipeline's workflow contract test
 * (docs/migration/safety-contracts.md API-08).
 *
 * These used to be written out three times: `apps/api/src/lib/slug.ts`,
 * `apps/web/lib/themes-slug.ts`, and (as the text-extraction target of)
 * `apps/pipeline/test/workflows/constants-and-regex.test.ts`. Both apps
 * now re-export these under the same names, and the workflow test
 * compares the workflows' `THEME_RE` env literal against
 * `THEME_INPUT_PATTERN.source` directly.
 *
 * Pure regex literals, no imports — browser- and Workers-safe.
 * `packages/core/test/slug/patterns.test.ts` pins the exact `.source`
 * strings, so any change here is deliberate and also forces the
 * workflows' `THEME_RE` env to move in the same changeset.
 */

/** Free-text theme name accepted from a user/workflow request
 * (`--theme`, the request form, `POST /api/themes`): 2–80 chars of
 * ASCII letters, digits, space, `_` and `-`. Rejects shell
 * metacharacters, path separators and non-ASCII before anything else
 * runs. */
export const THEME_INPUT_PATTERN: RegExp = /^[A-Za-z0-9 _-]{2,80}$/;

/** Shape of a theme slug as produced by {@link themeSlug} (and of the
 * legacy Python `theme_slug()` / `worker/slug.js` output). Validates
 * slugs read from `?theme=` or echoed back by the API — never the raw
 * free-text theme name. */
export const SLUG_RE: RegExp = /^[a-z0-9-]+$/;
