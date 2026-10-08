/**
 * codepointCompare — reproduce Python's default string ordering, which is a
 * per-code-point lexicographic comparison (`sorted()` on `str` compares the
 * `ord()` of each character, i.e. its Unicode *code point*).
 *
 * JS's default `String` comparison (`<`, `>`, `Array.prototype.sort()` with
 * no comparator) instead compares by **UTF-16 code unit**. These agree for
 * every character in the Basic Multilingual Plane (BMP, code points up to
 * `U+FFFF`), but disagree for any string containing a character outside the
 * BMP (code points `>= U+10000`, encoded in JS as a surrogate pair): a
 * supplementary-plane character compares as *less than* `U+E000`..`U+FFFF`
 * under UTF-16-unit comparison (because its leading surrogate is in the
 * `0xD800`-`0xDBFF` range, numerically below `0xE000`), but Python correctly
 * places it *after* `U+FFFF` since its code point is numerically larger.
 * Example: `"" < "\u{1f600}"` is `true` in Python but the naive JS
 * `"" < "\u{1f600}"` is `false` (compares the lone BMP code unit
 * `0xe000` against the leading surrogate `0xd83d`).
 *
 * This matters wherever ported code sorts strings (`sorted(ids)`,
 * `sort_keys=True` in JSON, etc. — see docs/design/39-typescript-cloudflare-migration.md
 * §7.2) and the result must byte-match Python's.
 *
 * ## Implementation
 *
 * JS strings are iterable by *code point* (the default `[Symbol.iterator]`,
 * used by `for...of` / spread / `Array.from`, yields whole code points,
 * combining surrogate pairs) — unlike index-based access (`s[i]`,
 * `s.length`), which is UTF-16-code-unit based. We walk both strings with
 * that code-point iterator and compare `codePointAt(0)` at each step, so the
 * comparison is a true code-point comparison with no surrogate-pair special
 * casing needed by hand.
 *
 * A shorter string that is a strict prefix of a longer one sorts first,
 * matching both Python and JS's shared "shorter prefix sorts first" rule.
 *
 * Verified against real CPython `sorted()` output; see
 * packages/core/test/pycompat/sort.test.ts and
 * packages/core/test/pycompat/fixtures/gen.py.
 */
export function codepointCompare(a: string, b: string): number {
  const ai = a[Symbol.iterator]();
  const bi = b[Symbol.iterator]();
  for (;;) {
    const an = ai.next();
    const bn = bi.next();
    if (an.done && bn.done) return 0;
    if (an.done) return -1;
    if (bn.done) return 1;
    const ac = an.value.codePointAt(0)!;
    const bc = bn.value.codePointAt(0)!;
    if (ac !== bc) return ac < bc ? -1 : 1;
  }
}

/** Convenience: `Array.prototype.slice().sort()` using {@link codepointCompare}, matching Python's `sorted(list_of_str)`. */
export function pySortedStrings(values: readonly string[]): string[] {
  return values.slice().sort(codepointCompare);
}
