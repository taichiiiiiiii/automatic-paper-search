/**
 * Theme input sanitisation + slug derivation — TS port of
 * `paperpilot/scripts/build_theme_lineage.py::sanitize_theme` and
 * `paperpilot/scripts/_common.py::theme_slug`.
 *
 * Per CLAUDE.md absolute rule §14 / safety contract LIN-19: this script
 * is the sole writer of `docs/themes/<slug>/lineage.json`; the slug is
 * the ONLY thing spliced into the output path, and the raw `--theme`
 * string must never reach a path join. `themeLineagePath` is the one
 * function that performs that join, and re-validates its input is
 * already slug-shaped (defense in depth: `themeSlug`'s own output
 * already satisfies this, but a caller could in principle pass an
 * operator-supplied `--output` override's slug segment through here
 * too).
 *
 * `themeSlug`'s algorithm matches `worker/slug.js`'s `themeSlug()`
 * exactly (3-way parity with the Python original and the CF Worker is
 * pinned by `paperpilot/tests/test_worker_slug_parity.py` on the Python
 * side) — this is a third, independent transcription rather than an
 * import of `worker/slug.js` because this task's edit scope is limited
 * to `apps/pipeline/src/lineage/theme/**`; keep all three in sync by
 * hand if the algorithm ever changes.
 */

const SLUG_MAX_LEN = 64;
const THEME_MAX_LEN = 500;

/** Matches Python's `unicodedata.category(c)[0] != "C"` filter, i.e.
 * drops every Unicode "Other" general-category code point (Cc control,
 * Cf format, Cs surrogate, Co private-use, Cn unassigned). JS's `\p{C}`
 * Unicode property escape covers the same grouping. Subject to the same
 * Unicode-Character-Database-version caveat as `packages/core`'s
 * `wordRegex.ts` (Node/V8's bundled UCD vs CPython's) — not expected to
 * matter in practice. */
const UNICODE_CATEGORY_C_RE = /\p{C}/gu;

/** Strip control characters, trim whitespace, validate length.
 *
 * `--theme` is free-form text that flows into the (future) LLM prompt,
 * the S2/OpenAlex query string, and — after slug derivation — the
 * filesystem path / URL param. Control chars enable prompt-injection
 * tricks like fake instruction breaks; very long inputs trigger slow /
 * rejected upstream queries with noisy retries.
 *
 * @throws {RangeError} input is empty/whitespace-only after stripping
 * control characters, or exceeds `THEME_MAX_LEN`.
 */
export function sanitizeTheme(theme: string): string {
  if (!theme) {
    throw new RangeError("theme must be non-empty");
  }
  const cleaned = theme.replace(UNICODE_CATEGORY_C_RE, "").trim();
  if (!cleaned) {
    throw new RangeError("theme is empty after stripping control chars / whitespace");
  }
  if (cleaned.length > THEME_MAX_LEN) {
    throw new RangeError(`theme exceeds ${THEME_MAX_LEN} chars (got ${cleaned.length})`);
  }
  return cleaned;
}

const SLUG_ALLOWED_RE = /[^a-z0-9]+/g;
const SLUG_TRIM_RE = /^-+|-+$/g;

/** Normalise a free-text theme label into a URL- and filesystem-safe
 * slug.
 *
 * Algorithm:
 *  1. NFKD-normalise, drop anything outside ASCII — strips combining
 *     marks and rejects characters with no ASCII fallback (e.g. CJK).
 *  2. Lowercase, replace any run of non-`[a-z0-9]` with a single hyphen.
 *  3. Trim leading/trailing hyphens.
 *  4. Cap to 64 characters; trim a trailing hyphen left by the cut.
 *
 * @throws {RangeError} input is empty/whitespace-only, OR collapses to
 * an empty slug after normalisation.
 */
export function themeSlug(label: string): string {
  if (!label || !label.trim()) {
    throw new RangeError("theme_slug: label must be non-empty");
  }
  // Python: unicodedata.normalize("NFKD", label).encode("ascii", "ignore").decode()
  // biome-ignore lint/suspicious/noControlCharactersInRegex: intentional — strips every non-ASCII code point (including control chars), mirroring Python's `.encode("ascii", "ignore")`.
  const normalised = label.normalize("NFKD").replace(/[^\x00-\x7f]/g, "");
  let slug = normalised.toLowerCase().replace(SLUG_ALLOWED_RE, "-").replace(SLUG_TRIM_RE, "");
  if (slug.length > SLUG_MAX_LEN) {
    slug = slug.slice(0, SLUG_MAX_LEN).replace(/-+$/, "");
  }
  if (!slug) {
    throw new RangeError(`theme_slug: derived slug is empty for input: ${JSON.stringify(label)}`);
  }
  return slug;
}

const SLUG_SHAPE_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** Join `docsRoot`/themes/`slug`/lineage.json, re-validating that `slug`
 * is already slug-shaped before the join — the one path-traversal gate
 * (absolute rule §14) between any theme-derived value and the
 * filesystem. Never pass a raw `--theme` string here; pass only
 * `themeSlug(sanitizeTheme(theme))`'s return value. */
export function themeLineagePath(docsRoot: string, slug: string): string {
  if (!SLUG_SHAPE_RE.test(slug) || slug.length > SLUG_MAX_LEN) {
    throw new RangeError(`themeLineagePath: ${JSON.stringify(slug)} is not a valid theme slug`);
  }
  // Intentionally not using node:path.join's own ".."-collapsing as the
  // safety mechanism — the regex above already rejects anything other
  // than lowercase alnum segments joined by single hyphens, so a ".."
  // or "/" component can never reach this point.
  return `${docsRoot}/themes/${slug}/lineage.json`;
}
