/**
 * Theme label -> slug derivation — TS port of
 * `paperpilot/scripts/_common.py::theme_slug`.
 *
 * Why: themes come from CLI free text (`--theme "Mixture of Experts"`) and
 * flow into both filesystem paths (`docs/themes/<slug>/lineage.json`) and
 * URL params (`?theme=<slug>`). The slug is the only sanitisation gate.
 * Path traversal probes (`../../etc/passwd`), unicode shenanigans, and
 * over-long inputs all collapse to a safe ASCII identifier or throw.
 *
 * Algorithm:
 *   1. NFKD-normalise, drop anything outside ASCII — strips combining
 *      marks and rejects characters with no ASCII fallback (e.g. CJK).
 *   2. Lowercase, replace any run of non-`[a-z0-9]` with a single hyphen.
 *   3. Trim leading/trailing hyphens.
 *   4. Cap to 64 characters; trim a trailing hyphen left by the cut.
 *
 * Consolidated into `packages/core` per docs/migration/p4-followups.md
 * #25 (TS side only): this algorithm used to be independently
 * transcribed in `apps/pipeline/src/lineage/theme/slug.ts` because that
 * P4d task's edit scope excluded `packages/core`. `worker/slug.js` (the
 * Cloudflare Worker's own copy) is deliberately left untouched — it is
 * production code until P5 replaces it, and the 3-way parity pin
 * (`paperpilot/tests/test_worker_slug_parity.py`) still compares Python
 * <-> `worker/slug.js` <-> `docs/assets/theme.js` directly. This module
 * adds a FOURTH leg: `packages/core/test/slug/theme.test.ts` compares
 * this implementation's OUTPUT against both `worker/slug.js`'s
 * `themeSlug()` and the Python original on the same probe battery.
 *
 * Pure string/regex logic (no `node:fs`/`node:crypto`) — browser-safe,
 * used by both `apps/pipeline/src/lineage/theme/slug.ts` and
 * `apps/web/lib/themes-slug.ts`.
 */

const SLUG_MAX_LEN = 64;

/** Matches Python's `unicodedata.category(c)[0] != "C"` filter, i.e.
 * drops every Unicode "Other" general-category code point (Cc control,
 * Cf format, Cs surrogate, Co private-use, Cn unassigned). JS's `\p{C}`
 * Unicode property escape covers the same grouping. Subject to the same
 * Unicode-Character-Database-version caveat as `packages/core`'s
 * `wordRegex.ts` (Node/V8's bundled UCD vs CPython's) — not expected to
 * matter in practice. */
const SLUG_ALLOWED_RE = /[^a-z0-9]+/g;
const SLUG_TRIM_RE = /^-+|-+$/g;

/** Normalise a free-text theme label into a URL- and filesystem-safe
 * slug.
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
