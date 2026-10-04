/**
 * Python `\b`-equivalent regex compilation, for porting
 * `paperpilot/scripts/build_summary_csv.py`'s `TOPIC_RULES` (CAT gates,
 * docs/design/39-typescript-cloudflare-migration.md §7.2 "正規表現 ...
 * slug に影響").
 *
 * Python's `re` module matches `\b` against `str` patterns using a
 * Unicode-aware definition of "word character" (same set `pyWordCharRegex`
 * in `@paperpilot/core/pycompat` already proves out against real CPython —
 * see that module's doc comment). JS's `\b` is ALWAYS ASCII-only
 * (`[A-Za-z0-9_]`), even with the `u` flag, so it disagrees with Python at
 * a boundary next to a non-ASCII letter or digit (e.g. the Python pattern
 * `\bface\b` matches inside "café face" differently than the JS one would
 * at the "é|space" boundary — not that exact case, but the general class
 * of boundary adjacent to non-ASCII word characters).
 *
 * This module does not reimplement a regex parser: it does a literal
 * textual substitution of every `\b` token in the pattern SOURCE (written
 * as a plain JS string, each `\b` surviving as the two characters
 * backslash+`b`) with an equivalent lookaround assertion built from
 * `PY_WORD_CLASS_SOURCE`, then compiles with the `u` flag (required for
 * the `\p{...}` escapes inside that class to work). The one `TOPIC_RULES`
 * pattern that also uses a literal `\w*` (the "Dataset" rule's
 * `(introduce|present|...)\w*...`) gets the same treatment: `\w` is
 * substituted for `PY_WORD_CLASS_SOURCE` itself (not the boundary), so it
 * matches the same Unicode letters/digits/underscore Python's `\w` does
 * rather than JS's ASCII-only one. None of `TOPIC_RULES`' patterns use
 * `\B`, `\W`, backreferences, or `\b`/`\w` inside a character class, so
 * this simple substitution is exact for every pattern actually ported
 * here — it is not a general-purpose Python-regex compiler.
 */

import { PY_WORD_CLASS_SOURCE } from "@paperpilot/core/pycompat";

/**
 * A zero-width assertion equivalent to Python's `\b`: true at a position
 * where exactly one of the two adjacent characters is a Python-`\w`
 * character (the boundary can be either a "word start" or a "word end").
 */
const PY_BOUNDARY_SOURCE = `(?:(?<!${PY_WORD_CLASS_SOURCE})(?=${PY_WORD_CLASS_SOURCE})|(?<=${PY_WORD_CLASS_SOURCE})(?!${PY_WORD_CLASS_SOURCE}))`;

/**
 * Compile a Python `re` pattern SOURCE (as a plain JS string, e.g.
 * `"\\bllms?\\b"`, the exact textual equivalent of the Python raw string
 * `r"\bllms?\b"`) into an equivalent JS `RegExp`, translating every `\b`
 * to the Unicode-aware boundary above. Every other regex construct used by
 * `TOPIC_RULES` (character classes, `(?:...)`, `?`, `+`, literal text) is
 * already syntax-compatible between Python `re` and JS `RegExp`.
 */
export function pyRegex(source: string, flags = ""): RegExp {
  const translated = source
    .replace(/\\b/g, PY_BOUNDARY_SOURCE)
    .replace(/\\w/g, PY_WORD_CLASS_SOURCE);
  return new RegExp(translated, flags.includes("u") ? flags : `${flags}u`);
}
