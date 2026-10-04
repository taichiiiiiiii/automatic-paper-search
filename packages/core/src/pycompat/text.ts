/**
 * pyLower / pyCasefold / nfkc — reproduce Python's `str.lower()`,
 * `str.casefold()`, and `unicodedata.normalize("NFKC", s)`.
 *
 * ## pyLower
 *
 * `String.prototype.toLowerCase()` already implements the Unicode default
 * case conversion algorithm (the same one `str.lower()` uses), so this is a
 * thin, exact wrapper for every case the Unicode Character Database assigns
 * a `Lowercase_Mapping` to — both come from the same underlying Unicode
 * data, just packaged differently (Python's `unicodedata`/`PyUnicode_ToLower`
 * vs the JS engine's ICU-less built-in case tables, Node 20 ships no ICU
 * default-case tables separate from V8's own — both should agree for
 * standard mappings). Note that *neither* language's `.lower()` is
 * locale-sensitive here (e.g. Turkish dotless-ı rules are NOT applied by
 * either `str.lower()` or `toLowerCase()` without an explicit locale), so
 * this is consistent with the Python side being ported.
 *
 * ## pyCasefold — NOT a complete port, documented gap
 *
 * Python's `str.casefold()` implements *full* Unicode case folding per
 * `CaseFolding.txt`, which includes "full" mappings where a single character
 * folds to **multiple** characters (e.g. `"ß".casefold() == "ss"`,
 * `"ﬁ".casefold() == "fi"`). `String.prototype.toLowerCase()` only ever does
 * simple (length-preserving-ish, one-to-one/one-to-zero) case mapping, so it
 * does NOT fold `"ß"` (`toLowerCase()` leaves it as `"ß"`, matching
 * `str.lower()`, but not `str.casefold()`).
 *
 * There is no Unicode-complete case-folding table available without a new
 * dependency (CaseFolding.txt is ~1600 entries), so `pyCasefold` here is a
 * **best-effort approximation**: `toLowerCase()` plus a small, explicitly
 * listed table of the one-to-many foldings most likely to actually occur in
 * `paperpilot/` input text (German `ß`/`ẞ`, the common Latin ligatures). Any
 * character outside that table whose *full* casefold differs from its
 * *simple* lowercase (there are a few dozen across all of Unicode, mostly
 * obscure historic/mathematical letters) will NOT match CPython's
 * `str.casefold()` exactly. This divergence is called out explicitly here
 * (rather than silently) per docs/design/39-typescript-cloudflare-migration.md
 * §7.2's requirement to document language-difference gaps as unit tests.
 *
 * ## nfkc
 *
 * `String.prototype.normalize("NFKC")` and Python's
 * `unicodedata.normalize("NFKC", s)` both implement the same standard
 * Unicode Normalization Form KC algorithm, but each is backed by whatever
 * version of the Unicode Character Database its runtime ships (Python 3.12
 * bundles Unicode (see `unicodedata.unidata_version`, captured per-test-run
 * in the fixtures); Node's V8/ICU bundles its own, independently-updated,
 * version). For any code point whose decomposition or combining-class data
 * changed between those two Unicode versions (rare, and only ever affects
 * newly-assigned or newly-recategorized code points), `nfkc()` here and
 * Python's `normalize("NFKC", ...)` could disagree. This is inherent to
 * depending on two different runtimes' bundled Unicode data and cannot be
 * fixed without vendoring a specific Unicode Character Database version
 * (a new dependency, out of scope here).
 *
 * Verified against real CPython output (`str.lower`, `str.casefold`,
 * `unicodedata.normalize`); see packages/core/test/pycompat/text.test.ts and
 * packages/core/test/pycompat/fixtures/gen.py (which also records the
 * generating interpreter's `unicodedata.unidata_version` for reference).
 */

/**
 * A small, explicit subset of Unicode "full" case foldings (one character
 * folding to multiple) that `toLowerCase()` alone does not perform. Applied
 * AFTER `toLowerCase()`, so each key here is already in its lowercase form
 * (e.g. the capital `"ẞ"` is not listed separately: `toLowerCase()` already
 * turns it into `"ß"`, which this table then folds to `"ss"`).
 */
const CASEFOLD_EXTRA: ReadonlyArray<readonly [string, string]> = [
  ["ß", "ss"],
  ["ﬀ", "ff"],
  ["ﬁ", "fi"],
  ["ﬂ", "fl"],
  ["ﬃ", "ffi"],
  ["ﬄ", "ffl"],
  ["ﬅ", "st"],
  ["ﬆ", "st"],
  ["ŉ", "ʼn"],
];

export function pyLower(s: string): string {
  return s.toLowerCase();
}

export function pyCasefold(s: string): string {
  let out = s.toLowerCase();
  for (const [from, to] of CASEFOLD_EXTRA) {
    if (out.includes(from)) out = out.split(from).join(to);
  }
  return out;
}

export function nfkc(s: string): string {
  return s.normalize("NFKC");
}
