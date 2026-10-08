/**
 * pyWordRegexClass — a JS regex character-class source equivalent to Python
 * 3's `\w` for `str` patterns.
 *
 * Python's `re` module matches `\w` against `str` patterns in Unicode mode
 * by default (this cannot be disabled short of `re.ASCII`, which is not
 * what the ported code uses). JS regex `\w` is ALWAYS `[A-Za-z0-9_]` only —
 * ASCII-only — even with the `u` (Unicode) flag; the `u` flag changes how
 * the regex engine parses the pattern (surrogate pairs, `\p{...}` escapes)
 * but does not change what `\w` itself means. So `\w` cannot be used
 * directly; this module exports an equivalent *Unicode property class*.
 *
 * ## Definition (verified against real CPython `re`, not guessed)
 *
 * CPython's `\w` for a Unicode `str` pattern matches a code point `ch` iff
 * `Py_UNICODE_ISALNUM(ch) || ch == '_'`, where `ISALNUM` is
 * `ISALPHA || ISDECIMAL || ISDIGIT || ISNUMERIC`. Empirically (see the
 * generator script) this is exactly the set of code points in Unicode
 * general categories `L*` (Lu/Ll/Lt/Lm/Lo) or `N*` (Nd/Nl/No), plus `_`:
 *
 * `PY_WORD_CLASS_SOURCE = "[\\p{L}\\p{N}_]"` (use with the `u` regex flag).
 *
 * This was checked against a battery of specifically tricky code points,
 * each independently confirmed against CPython's own `re.fullmatch(r'\w', ch)`
 * (see packages/core/test/pycompat/fixtures/gen.py `gen_word_regex_cases`,
 * and packages/core/test/pycompat/wordRegex.test.ts for ~200+ generated
 * cases sampled across many Unicode blocks):
 *
 * - `"²"` (U+00B2 SUPERSCRIPT TWO, category `No`) — **matches** `\w` in
 *   Python (`"²".isnumeric()` is `True`) and is covered here by `\p{No}`
 *   (part of `\p{N}`).
 * - `"٣"` (U+0663 ARABIC-INDIC DIGIT THREE, category `Nd`) — **matches**,
 *   covered by `\p{Nd}`.
 * - `"ß"` (U+00DF LATIN SMALL LETTER SHARP S, category `Ll`) — **matches**,
 *   covered by `\p{L}`.
 * - Combining marks (category `M*`, e.g. U+0301 COMBINING ACUTE ACCENT, or
 *   U+093E DEVANAGARI VOWEL SIGN AA) — these do **NOT** match Python's `\w`
 *   (confirmed: `Py_UNICODE_ISALNUM` is category-`L`/`N` based, not the
 *   broader Unicode `Alphabetic` derived property, which *would* wrongly
 *   include some `Mc`/`Mn` marks that have `Other_Alphabetic = Yes`). This
 *   is why `\p{M}` is deliberately **excluded** from this class, even though
 *   a first guess (e.g. using `\p{Alphabetic}` instead of `\p{L}`) would
 *   wrongly include some marks. Do not "fix" this by adding `\p{M}`.
 *
 * ## Known scope limits
 *
 * - This targets `str` patterns only (Python `bytes` patterns' `\w` is
 *   ASCII-only and different; out of scope — no byte-pattern call sites were
 *   found in `paperpilot/`).
 * - Like `nfkc()` (see text.ts), this depends on the regex engine's bundled
 *   Unicode Character Database version (Node/V8's vs CPython 3.12's); a
 *   code point whose general category changed between those two database
 *   versions could in principle disagree. Not expected to matter in
 *   practice (general-category reassignment is rare and essentially never
 *   happens to already-assigned code points), and not fixable without
 *   vendoring a specific Unicode Character Database (a new dependency).
 *
 * Verified against real CPython `re` output; see
 * packages/core/test/pycompat/wordRegex.test.ts and
 * packages/core/test/pycompat/fixtures/gen.py.
 */
export const PY_WORD_CLASS_SOURCE = "[\\p{L}\\p{N}_]";

/**
 * Build a RegExp matching a single Python-`\w`-equivalent character.
 * `flags` may include any normal regex flags; the `u` flag (required for
 * `\p{...}` escapes to work) is added automatically if not already present.
 */
export function pyWordCharRegex(flags = ""): RegExp {
  return new RegExp(PY_WORD_CLASS_SOURCE, flags.includes("u") ? flags : `${flags}u`);
}

/** Convenience: does this single code point match Python's `\w`? */
export function isPyWordChar(char: string): boolean {
  return pyWordCharRegex().test(char);
}
