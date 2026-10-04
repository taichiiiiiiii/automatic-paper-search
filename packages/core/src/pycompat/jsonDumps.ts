/**
 * pyJsonDumps — byte-identical reproduction of Python's `json.dumps` for the
 * option combinations this repository actually uses.
 *
 * ## Real call sites (grepped `json.dump(` / `json.dumps(` across `paperpilot/`,
 * excluding tests; see docs/design/39-typescript-cloudflare-migration.md §7.2)
 *
 * The settings below are every distinct `(ensure_ascii, indent, sort_keys,
 * separators)` combination found grep-ing `paperpilot/` (220 call sites
 * total; most repeat one of these shapes):
 *
 * | Settings | Where (representative) |
 * |---|---|
 * | `ensure_ascii=False, indent=2` | `exporters/json_exporter.py`, `scripts/build_lineage.py`, `scripts/build_deep_lineage.py`, `scripts/generate_deep_manifest.py`, `scripts/build_lineage_quality.py` (manifest), `scripts/sync_asset_versions.py` |
 * | `ensure_ascii=False, indent=2, sort_keys=True` | `scripts/compact_classifications.py` |
 * | `ensure_ascii=False, separators=(",", ":")` (no indent) | `scripts/build_search_index.py` |
 * | `ensure_ascii=False, sort_keys=True, separators=(",", ":")` | `replay/canonical.py` (`canonical_json_bytes`, plus `allow_nan=False`, not modeled here — see below), `scripts/_lineage_contract.py`, `scripts/build_lineage_quality.py` (`_canonical_json`), `scripts/prepare_lineage_review.py` printed summary |
 * | `sort_keys=True, separators=(",", ":")` with **default** `ensure_ascii` (`True`) | `scripts/ingest_lineage_review.py` printed summary |
 * | `ensure_ascii=False, indent=0` | `scripts/build_pages.py` (`papers_json`), `scripts/build_conference_lineage.py` |
 * | default (`ensure_ascii=True` implicit, no `indent`, no `sort_keys`) | `utils/dedup.py` (one JSON object per line) |
 *
 * Trailing newlines after the JSON text (`+ "\n"`, or passing through
 * `atomic_write_text`) are added by the *callers*, not by `json.dumps`
 * itself, and are likewise NOT added by `pyJsonDumps` — add them at the call
 * site, matching the Python code being ported line-for-line.
 *
 * `replay/canonical.py` additionally passes `allow_nan=False`, i.e. it
 * raises rather than emitting `NaN`/`Infinity` — that validation is a
 * caller-side input-rejection concern, not part of what `json.dumps` writes,
 * so it's intentionally out of scope for `pyJsonDumps` (reject non-finite
 * floats before calling it, if porting that call site).
 *
 * ## The int-vs-float gap (exact parity is impossible without a marker)
 *
 * Python has distinct `int` and `float` *types*: `json.dumps(2)` writes
 * `"2"`, but `json.dumps(2.0)` writes `"2.0"` — same mathematical value,
 * different JSON text, purely because of the source value's static type.
 * JS has only one `number` type; `2` and `2.0` are the identical value with
 * no way to ask "was this meant as a float". **This is a case where exact
 * parity is impossible without extra information from the caller.**
 * `pyJsonDumps`'s default behavior (matching the overwhelmingly common case)
 * is: an integer-valued plain JS number serializes WITHOUT a decimal point
 * (`"2"`), like a Python `int`. When porting code where the Python side is
 * known to hold a `float` that happens to be integer-valued (so it must
 * serialize as `"2.0"`, not `"2"`), wrap it with {@link pyFloat}, e.g.
 * `pyFloat(2.0)` → always serializes via {@link pyFloatRepr} regardless of
 * integrality. Non-integer numbers already serialize via `pyFloatRepr`
 * automatically and need no wrapping.
 *
 * ## The object-key-ordering gap (use `Map`, not a plain object, when it matters)
 *
 * Python `dict`s (and hence JSON objects built from them) preserve pure
 * insertion order, always. Plain JS objects do **NOT**: `Object.keys()` /
 * `Object.entries()` iterate any keys that look like non-negative integer
 * array indices (`"0"`, `"2"`, `"10"`, ...) FIRST, in ascending *numeric*
 * order, before any other string keys in their original insertion order —
 * regardless of when they were actually inserted. E.g.
 * `Object.keys({b: 1, a: 2, "10": 3, "2": 4})` is `["2", "10", "b", "a"]` in
 * JS, not `["b", "a", "10", "2"]` as Python's dict would preserve. **This is
 * a real, unavoidable JS language gap** (not a bug in this module) whenever
 * a dict with purely-numeric-looking string keys is serialized without
 * `sortKeys`. `pyJsonDumps` accepts a `Map<string, unknown>` for object
 * values specifically so ported code that needs guaranteed insertion order
 * can get it exactly; a plain object is also accepted for convenience but
 * inherits the reordering caveat above verbatim. When `sortKeys` is `true`
 * this gap doesn't matter (order is always rederived by sorting).
 *
 * `sortKeys` sorts by {@link codepointCompare} (Python code-point string
 * order), not JS's default UTF-16-code-unit order — see sort.ts.
 *
 * ## Separators and indent, exactly as `json.dumps` computes its defaults
 *
 * - No `indent`: default separators are `item=", "`, `key=": "` (one-line output).
 * - `indent` given (including `0`): default separators are `item=","`
 *   (no trailing space — the following newline + indentation already
 *   separates items), `key=": "` (unchanged). `indent: 0` means "newlines,
 *   but no indentation spaces" (`json.dumps(x, indent=0)` — distinct from
 *   omitting `indent`, which means no newlines at all).
 * - `separators` (an explicit `[itemSeparator, keySeparator]` pair, matching
 *   Python's `(item_separator, key_separator)` tuple order) always overrides
 *   the computed default, exactly like `json.dumps(..., separators=...)`.
 *
 * ## String escaping
 *
 * - `ensureAscii` (default `true`, matching Python's default): every code
 *   unit `>= 0x7f`, plus the mandatory escapes (`"`, `\`, and control
 *   characters `< 0x20` via their short form — `\n \t \r \b \f` — or
 *   `\u00XX` otherwise) is escaped as `\uXXXX`. Because this iterates JS
 *   *UTF-16 code units* directly, a character outside the BMP is
 *   automatically escaped as its surrogate pair's two separate `\uXXXX`
 *   escapes, exactly matching Python's own behaviour of escaping each UTF-16
 *   surrogate of a non-BMP character independently (verified: both emit
 *   `"😀"` for `"😀"`).
 * - `ensureAscii: false`: only the mandatory escapes above (`"`, `\`,
 *   control chars `< 0x20`) are escaped; everything else — including
 *   `0x7f` (DEL) and `U+2028`/`U+2029` — is written out literally, matching
 *   Python (`json.encoder.py_encode_basestring`, not the `_ascii` variant).
 * - `/` (forward slash) is **never** escaped, matching Python (some other
 *   JSON encoders escape it; Python's does not).
 *
 * Verified against real CPython `json.dumps` output; see
 * packages/core/test/pycompat/jsonDumps.test.ts and
 * packages/core/test/pycompat/fixtures/gen.py.
 */

import { pyFloatRepr } from "./floatRepr.js";
import { codepointCompare } from "./sort.js";

/** Wrap a number to force float-style formatting (e.g. `"2.0"` not `"2"`) even when it is integer-valued. See the module doc comment's "int-vs-float gap". */
export class PyFloat {
  constructor(public readonly value: number) {}
}

export function pyFloat(value: number): PyFloat {
  return new PyFloat(value);
}

export interface PyJsonDumpsOptions {
  /** Matches `json.dumps(indent=...)`. Omit entirely for compact single-line output; `0` still adds newlines, just no indentation spaces. */
  indent?: number;
  /** Matches `json.dumps(ensure_ascii=...)`. Default `true`, matching Python's own default. */
  ensureAscii?: boolean;
  /** Matches `json.dumps(sort_keys=...)`. Default `false`. */
  sortKeys?: boolean;
  /** Matches `json.dumps(separators=(item_separator, key_separator))`. */
  separators?: readonly [string, string];
}

const SHORT_ESCAPES: Readonly<Record<string, string>> = {
  "\\": "\\\\",
  '"': '\\"',
  "\b": "\\b",
  "\f": "\\f",
  "\n": "\\n",
  "\r": "\\r",
  "\t": "\\t",
};

function escapeString(s: string, ensureAscii: boolean): string {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const ch = s.charAt(i);
    const code = s.charCodeAt(i);
    const short = SHORT_ESCAPES[ch];
    if (short !== undefined) {
      out += short;
    } else if (code < 0x20) {
      out += `\\u${code.toString(16).padStart(4, "0")}`;
    } else if (ensureAscii && code > 0x7e) {
      out += `\\u${code.toString(16).padStart(4, "0")}`;
    } else {
      out += ch;
    }
  }
  return out;
}

function entriesOf(value: object): Array<[string, unknown]> {
  if (value instanceof Map) {
    return Array.from(value.entries()) as Array<[string, unknown]>;
  }
  // Plain object fallback: see the module doc comment's "object-key-ordering
  // gap" for why Object.entries() order can diverge from the original
  // Python dict's insertion order when keys look like array indices.
  return Object.entries(value);
}

export function pyJsonDumps(value: unknown, options: PyJsonDumpsOptions = {}): string {
  const ensureAscii = options.ensureAscii ?? true;
  const sortKeys = options.sortKeys ?? false;
  const hasIndent = options.indent !== undefined;
  const indentSize = hasIndent ? Math.max(0, options.indent!) : 0;
  const [itemSep, keySep] = options.separators ?? (hasIndent ? [",", ": "] : [", ", ": "]);

  function pad(level: number): string {
    return " ".repeat(indentSize * level);
  }

  function encodeNumber(n: number): string {
    if (Number.isInteger(n) && Number.isFinite(n)) {
      return String(n);
    }
    return pyFloatRepr(n);
  }

  function encode(v: unknown, level: number): string {
    if (v === null || v === undefined) return "null";
    if (v instanceof PyFloat) return pyFloatRepr(v.value);
    if (typeof v === "boolean") return v ? "true" : "false";
    if (typeof v === "number") return encodeNumber(v);
    if (typeof v === "string") return `"${escapeString(v, ensureAscii)}"`;

    if (Array.isArray(v)) {
      if (v.length === 0) return "[]";
      const items = v.map((item) => encode(item, level + 1));
      if (hasIndent) {
        const inner = items.map((it) => pad(level + 1) + it).join(`${itemSep}\n`);
        return `[\n${inner}\n${pad(level)}]`;
      }
      return `[${items.join(itemSep)}]`;
    }

    if (typeof v === "object") {
      let entries = entriesOf(v);
      if (entries.length === 0) return "{}";
      if (sortKeys) {
        entries = entries.slice().sort((a, b) => codepointCompare(a[0], b[0]));
      }
      const items = entries.map(
        ([k, val]) => `"${escapeString(k, ensureAscii)}"${keySep}${encode(val, level + 1)}`,
      );
      if (hasIndent) {
        const inner = items.map((it) => pad(level + 1) + it).join(`${itemSep}\n`);
        return `{\n${inner}\n${pad(level)}}`;
      }
      return `{${items.join(itemSep)}}`;
    }

    throw new TypeError(`pyJsonDumps: unsupported value of type ${typeof v}`);
  }

  return encode(value, 0);
}
