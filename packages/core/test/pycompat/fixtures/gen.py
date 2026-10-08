"""Generate expected-output fixtures for packages/core/src/pycompat from a real
Python interpreter.

Run with: uv run --extra dev python packages/core/test/pycompat/fixtures/gen.py

The output (cases.json, committed) is consumed by the vitest suites under
packages/core/test/pycompat/*.test.ts. Every expected value here comes from
actually executing the Python stdlib (round(), repr(), json.dumps(), sorted(),
str.lower/casefold, unicodedata.normalize, re with \\w) — never hand-typed —
so the TS ports can be checked byte-for-byte / value-for-value against the
real Python 3 semantics described in docs/design/39-typescript-cloudflare-migration.md §7.2.

Floats are round-tripped through their exact big-endian IEEE-754 bit pattern
(hex of struct.pack('>d', x)) instead of JSON numbers, so there is zero risk
of the fixture file itself introducing decimal round-off that would mask a
real bug (or hide one) in the TS implementation.
"""

from __future__ import annotations

import json
import math
import random
import re
import struct
import sys
import unicodedata
from datetime import datetime, timedelta, timezone

random.seed(20261004)


def f2hex(x: float) -> str:
    return struct.pack(">d", x).hex()


def round_case(x: float, ndigits):
    rec = {"xHex": f2hex(x), "x_debug": repr(x), "ndigits": ndigits}
    try:
        if ndigits is None:
            result = round(x)
            rec["expectedKind"] = "int"
            rec["expectedInt"] = result
        else:
            result = round(x, ndigits)
            rec["expectedKind"] = "float"
            rec["expectedHex"] = f2hex(result)
            rec["expected_debug"] = repr(result)
    except (ValueError, OverflowError) as exc:
        rec["expectedKind"] = "exception"
        rec["exception"] = type(exc).__name__
    return rec


def gen_round_cases():
    cases = []
    # Exact round-half-to-even ties on exactly-representable binary values.
    for x in [0.5, 1.5, 2.5, 3.5, -0.5, -1.5, -2.5, -3.5, 0.25, 0.75, 1.25, 1.75, -1.25]:
        cases.append(round_case(x, None))
        cases.append(round_case(x, 0))
    # Classic "banker's rounding looks wrong because the decimal literal isn't
    # exactly representable" cases (the whole reason pyRound exists).
    for x, nd in [
        (2.675, 2),
        (-2.675, 2),
        (1.005, 2),
        (1.015, 2),
        (2.665, 2),
        (2.005, 2),
        (0.1, 1),
        (0.15, 1),
        (0.125, 2),
        (0.135, 2),
        (1.4499999999999999, 1),
        (8.005, 2),
        (23.5, 0),
        (23.5, -1),
    ]:
        cases.append(round_case(x, nd))
    # ndigits ranges, positive/negative/zero, including None.
    for x in [3.14159265, 123.456, -123.456, 9999.9995, 0.0004999, 1234567.891]:
        for nd in [None, 0, 1, 2, 3, -1, -2, -3]:
            cases.append(round_case(x, nd))
    # Negative zero handling: round(-0.5) -> int 0 (no sign), round(-0.5, 0) -> -0.0 (float, signed).
    cases.append(round_case(-0.0, None))
    cases.append(round_case(-0.0, 0))
    cases.append(round_case(-0.0, 3))
    cases.append(round_case(0.0, None))
    cases.append(round_case(0.0, 2))
    # Magnitudes.
    cases.append(round_case(1e16, 2))
    cases.append(round_case(1e-300, 2))
    cases.append(round_case(5e-324, 2))
    cases.append(round_case(1.7976931348623157e308, 2))
    # Exceptions: nan/inf with ndigits=None raise; with ndigits given, pass through.
    cases.append(round_case(float("nan"), None))
    cases.append(round_case(float("nan"), 2))
    cases.append(round_case(float("inf"), None))
    cases.append(round_case(float("inf"), 2))
    cases.append(round_case(float("-inf"), None))
    cases.append(round_case(float("-inf"), 2))
    # A bundle of random doubles for broad coverage.
    for _ in range(25):
        exp = random.uniform(-20, 20)
        x = random.uniform(-1, 1) * (10 ** exp)
        nd = random.choice([None, 0, 1, 2, 3, 4, -1, -2])
        cases.append(round_case(x, nd))
    return cases


def float_repr_case(x: float):
    return {
        "xHex": f2hex(x),
        "x_debug": repr(x),
        # json.dumps() of a bare float yields exactly the float token text
        # pyFloatRepr must produce (Infinity/-Infinity/NaN instead of
        # repr()'s lowercase inf/-inf/nan -- see module doc comment).
        "expected": json.dumps(x),
        "expected_plain_repr": repr(x),
    }


def gen_float_repr_cases():
    cases = []
    values = [
        1.0, -1.0, 0.0, -0.0, 100.0, 0.1, 0.1 + 0.2, 2.675, 1e16,
        9999999999999998.0, 1000000000000000.0, 123456789012345.6,
        1234567890123456.0, 12345678901234567.0, 1e-4, 1e-5, 0.0001, 0.00001,
        1e100, 1e-100, 5e-324, 1.7976931348623157e308, 1e21, 1e20, 1e15,
        3.14159265358979, -2.5, 2.0, 10.0, 0.3, 123.0, -123.456, 1e1, 1e-1,
        1e-308, 2.2250738585072014e-308, float("inf"), float("-inf"),
        float("nan"), 1.1, 2.2, 3.3, 1234.5678, -0.0001, -1e16, -1e-5,
    ]
    for x in values:
        cases.append(float_repr_case(x))
    for _ in range(20):
        exp = random.uniform(-25, 25)
        x = random.uniform(-1, 1) * (10 ** exp)
        cases.append(float_repr_case(x))
    return cases


# --- json dumps -------------------------------------------------------------

class PyFloat(float):
    """Marker so gen.py can tell the TS side 'force float formatting' even
    when the value is numerically an integer (e.g. 2.0 must dump as "2.0",
    not "2"), mirroring Python's static int/float type distinction that
    JS numbers don't have."""


def to_wire(value):
    """Convert a Python value (possibly containing PyFloat markers) into a
    JSON-safe 'value' field that the TS test can reconstruct, tagging floats
    explicitly so the TS side can wrap integer-valued floats via pyFloat().

    Dicts are encoded as {"__pydict__": [[k, v], ...]} (a list of pairs, NOT
    a plain JSON object) specifically so insertion order survives being
    written to and re-parsed from cases.json: a plain JS/JSON object would
    silently reorder any array-index-like keys (e.g. "10", "2") on its own
    JSON.parse, which is exactly the Python-vs-JS ordering gap pyJsonDumps
    documents -- the *fixture* must stay order-faithful regardless of that
    gap so the test can check pyJsonDumps's Map-based input path precisely.
    """
    if isinstance(value, bool) or value is None or isinstance(value, str):
        return value
    if isinstance(value, PyFloat):
        return {"__pyfloat__": repr(float(value))}
    if isinstance(value, float):
        return {"__pyfloat__": repr(value)}
    if isinstance(value, int):
        return value
    if isinstance(value, list):
        return [to_wire(v) for v in value]
    if isinstance(value, dict):
        return {"__pydict__": [[k, to_wire(v)] for k, v in value.items()]}
    raise TypeError(f"unsupported type in to_wire: {type(value)}")


def json_dumps_case(value, *, ensure_ascii=True, indent=None, sort_keys=False, separators=None, label=""):
    kwargs = {"ensure_ascii": ensure_ascii, "sort_keys": sort_keys}
    if indent is not None:
        kwargs["indent"] = indent
    if separators is not None:
        kwargs["separators"] = tuple(separators)
    expected = json.dumps(value, **kwargs)
    return {
        "label": label,
        "value": to_wire(value),
        "options": {
            "ensureAscii": ensure_ascii,
            "indent": indent,
            "sortKeys": sort_keys,
            "separators": list(separators) if separators is not None else None,
        },
        "expected": expected,
    }


def gen_json_dumps_cases():
    cases = []
    simple = {"b": 1, "a": [1, 2, PyFloat(2.0)], "c": None, "d": True, "e": "héllo wörld 😀"}
    nested = {
        "z": {"nested": [1, 2, {"k": "v", "arr": []}], "empty_obj": {}},
        "unicode": "日本語テスト\t\n\"quote\"\\backslash/slash\u0001\u007f",
        "num": PyFloat(3.0),
        "float": 3.14159,
        "neg_zero": PyFloat(-0.0),
    }
    # The real settings grepped from paperpilot/ (see pycompat doc comment):
    #  - ensure_ascii=False, indent=2                         (exporters/json_exporter.py, build_pages.py index)
    #  - ensure_ascii=False, indent=2, sort_keys=True          (compact_classifications.py)
    #  - ensure_ascii=False, separators=(",", ":")            (build_search_index.py)
    #  - ensure_ascii=False, sort_keys=True, separators=(",", ":")  (_lineage_contract.py, build_lineage_quality.py canonical payload)
    #  - sort_keys=True, separators=(",", ":") [ensure_ascii default True]  (prepare_lineage_review.py, ingest_lineage_review.py)
    #  - ensure_ascii=False, indent=0                          (build_pages.py papers_json, build_conference_lineage.py)
    #  - default (ensure_ascii=True implicit, no indent)       (fallback/ad hoc prints)
    combos = [
        dict(ensure_ascii=True, indent=None, sort_keys=False, separators=None, label="default"),
        dict(ensure_ascii=False, indent=2, sort_keys=False, separators=None, label="pretty2-noascii"),
        dict(ensure_ascii=False, indent=2, sort_keys=True, separators=None, label="pretty2-sorted"),
        dict(ensure_ascii=False, indent=None, sort_keys=False, separators=(",", ":"), label="compact-noascii"),
        dict(ensure_ascii=False, indent=None, sort_keys=True, separators=(",", ":"), label="canonical-noascii"),
        dict(ensure_ascii=True, indent=None, sort_keys=True, separators=(",", ":"), label="canonical-ascii"),
        dict(ensure_ascii=False, indent=0, sort_keys=False, separators=None, label="indent0"),
        dict(ensure_ascii=True, indent=2, sort_keys=False, separators=None, label="pretty2-ascii"),
    ]
    for value in (simple, nested, [], {}, [1, 2, 3], "top-level-string", PyFloat(1.0), 42, None, True, False):
        for combo in combos:
            cases.append(json_dumps_case(value, **combo))
    # sort_keys ordering must use codepoint order, not UTF-16 code unit order.
    tricky_keys = {"b": 1, "a": 2, "10": 3, "2": 4, "\uffff": 5, "\U0001f600": 6, "A": 7, "_": 8}
    for combo in combos:
        cases.append(json_dumps_case(tricky_keys, **combo, ))
    # control char / escaping coverage.
    control_value = {"s": "\u0000\u0001\u001f\u007f\u2028\u2029\t\n\r\"\\/" + chr(0x10FFFF - 0xFFFF + 0xFFFF) }
    for combo in combos:
        cases.append(json_dumps_case(control_value, **combo))
    return cases


# --- codepoint sort ----------------------------------------------------------

def gen_codepoint_sort_cases():
    cases = []
    pairs = [
        ("a", "b"), ("b", "a"), ("a", "a"), ("", "a"), ("a", ""), ("", ""),
        ("Z", "a"), ("10", "2"), ("abc", "abd"), ("abc", "ab"),
        ("\uffff", "\U00010000"),  # BMP max vs supplementary plane min: codepoint order differs from UTF-16 unit order
        ("\ue000", "\U0001f600"),
        ("\U0001f600", "\ue000"),
        ("\ud7ff", "\ue000"),
        ("café", "cafe"),
        ("café", "cafz"),
        ("日本語", "日本"),
        ("日本", "日本語"),
        ("Apple", "apple"),
        ("apple", "Apple"),
        ("ß", "ss"),
        ("\U0001f600\U0001f601", "\U0001f600"),
        ("a\U0001f600", "a\ue000"),
    ]
    # Random string pairs across a mix of BMP + supplementary-plane chars.
    pool = [chr(c) for c in list(range(0x30, 0x7A)) + list(range(0xE000, 0xE010)) + list(range(0xFFF0, 0xFFFF))]
    pool_supp = [chr(c) for c in range(0x1F600, 0x1F60F)]
    for _ in range(15):
        a = "".join(random.choice(pool + pool_supp) for _ in range(random.randint(1, 5)))
        b = "".join(random.choice(pool + pool_supp) for _ in range(random.randint(1, 5)))
        pairs.append((a, b))
    for a, b in pairs:
        expected = -1 if a < b else (1 if a > b else 0)
        cases.append({"a": a, "b": b, "expectedSign": expected})
    # sorted() list case too.
    words = ["banana", "Apple", "\uffff", "\U00010000", "apple", "10", "2", "日本語", "日本"]
    cases.append({"sortList": words, "expectedSorted": sorted(words)})
    return cases


# --- isoformat ---------------------------------------------------------------

def gen_isoformat_cases():
    cases = []
    samples = [
        (2026, 6, 27, 12, 10, 56, 718401),
        (2026, 1, 1, 0, 0, 0, 0),
        (1999, 12, 31, 23, 59, 59, 999999),
        (2000, 2, 29, 0, 0, 0, 1),  # leap day
        (1, 1, 1, 0, 0, 0, 0),
        (9999, 12, 31, 23, 59, 59, 0),
        (2024, 2, 29, 13, 45, 0, 123456),
        (2026, 10, 4, 9, 5, 3, 500000),
        (2026, 10, 4, 9, 5, 3, 1),
        (2026, 10, 4, 9, 5, 3, 100000),
    ]
    for _ in range(20):
        year = random.randint(1, 9999)
        month = random.randint(1, 12)
        day = random.randint(1, 28)
        hour = random.randint(0, 23)
        minute = random.randint(0, 59)
        second = random.randint(0, 59)
        micro = random.randint(0, 999999)
        samples.append((year, month, day, hour, minute, second, micro))
    for (y, mo, d, h, mi, s, us) in samples:
        dt = datetime(y, mo, d, h, mi, s, us, tzinfo=timezone.utc)
        cases.append({
            "year": y, "month": mo, "day": d, "hour": h, "minute": mi,
            "second": s, "microsecond": us,
            "expected": dt.isoformat(),
        })
    return cases


# --- text case / normalization ------------------------------------------------

def gen_text_cases():
    cases = []
    samples = [
        "Hello World", "HELLO", "hello", "İstanbul", "ẞeta", "STRASSE", "straße",
        "Σ", "σ", "ς", "İ", "ı", "ﬁancé", "FIANCÉ", "ǅungla", "DŽUNGLA",
        "héllo wörld", "ＡＢＣ", "①②③", "Ⅷ", "ｶﾀｶﾅ", "日本語ＡＢＣ123",
        "café", "CAFÉ", "Straße", "GROSSE STRASSE", "²³", "㎏", "ﷰ",
        "", "  spaced  ", "MiXeD CaSe 123", "Ⓐⓑⓒ", "\u00c5ngström",
        "Ｈｅｌｌｏ", "ﹰﹱ", "Ω", "ω", "ΑΒΓ", "αβγ",
    ]
    for _ in range(10):
        n = random.randint(1, 8)
        s = "".join(chr(random.choice([
            random.randint(0x41, 0x5A), random.randint(0x61, 0x7A),
            random.randint(0xC0, 0x24F), random.randint(0x370, 0x3FF),
            random.randint(0xFF00, 0xFFEF), random.randint(0x1F100, 0x1F1FF),
        ])) for _ in range(n))
        samples.append(s)
    for s in samples:
        cases.append({
            "input": s,
            "lower": s.lower(),
            "casefold": s.casefold(),
            "nfkc": unicodedata.normalize("NFKC", s),
            "unicodedata_version": unicodedata.unidata_version,
        })
    return cases


# --- \w regex class ------------------------------------------------------------

WORD_RE = re.compile(r"\w", re.UNICODE)


def gen_word_regex_cases():
    cases = []
    curated = [
        "a", "Z", "1", "_", "²", "٣", "ß", "\u0301", "\u093E", "\u00AA",
        "\u02B0", "\u2160", "-", "\u200D", "µ", "\u01C5", "\u0F20", "\u3007",
        "¹", "¼", " ", "\t", "\n", ".", ",", "!", "@", "#", "$", "%",
        "日", "本", "語", "字", "😀", "\u3040", "\u30A0", "\uAC00", "\u0600",
        "\u0660", "\u06F0", "\u0E50", "\u0966",
    ]
    pool_ranges = [
        (0x0000, 0x007F), (0x0080, 0x00FF), (0x0370, 0x03FF), (0x0590, 0x05FF),
        (0x0600, 0x06FF), (0x0900, 0x097F), (0x2000, 0x206F), (0x2070, 0x209F),
        (0x2150, 0x218F), (0x2460, 0x24FF), (0x3000, 0x303F), (0x3040, 0x30FF),
        (0x4E00, 0x4E20), (0xFF00, 0xFFEF), (0x1F300, 0x1F320),
    ]
    sampled = set()
    for lo, hi in pool_ranges:
        for _ in range(12):
            cp = random.randint(lo, hi)
            if 0xD800 <= cp <= 0xDFFF:
                continue
            sampled.add(cp)
    chars = list(curated) + [chr(cp) for cp in sorted(sampled)]
    for ch in chars:
        m = WORD_RE.fullmatch(ch)
        cases.append({
            "char": ch,
            "codepoint": ord(ch),
            "category": unicodedata.category(ch),
            "isWord": bool(m),
        })
    return cases


# --- str.strip()/lstrip()/rstrip()/split() (no-arg whitespace forms) --------

# CPython's exact `str.isspace()` set, computed once (not hand-transcribed)
# so a transcription slip can't silently narrow or widen the TS port's idea
# of "Python whitespace". See packages/core/src/pycompat/whitespace.ts.
_PY_WHITESPACE_CODEPOINTS = [cp for cp in range(0x110000) if chr(cp).isspace()]


def gen_strip_split_cases():
    # A dedicated local RNG (not the module-level `random` used by the other
    # generators above) so adding this generator can never perturb the
    # already-committed values of any other fixture section, regardless of
    # where this function is called from in main().
    rng = random.Random(20261004)
    ws_chars = [chr(cp) for cp in _PY_WHITESPACE_CODEPOINTS]
    samples = [
        "",
        "   ",
        "hello",
        "  hello  ",
        "hello world",
        "  hello   world  ",
        "\thello\tworld\n",
        "a\tb\nc\r\nd",
        # Python-only whitespace JS's \s/.trim() misses: U+001C-U+001F, U+0085.
        "\x1chello\x1d",
        "hello\x1cworld",
        "\x85hello\x85world\x85",
        "a\x1cb\x1dc\x1ed\x1fe",
        # JS-only whitespace Python's str.strip() does NOT treat as space:
        # U+FEFF (BOM/ZWNBSP) must survive a pyStrip()/pySplit() round trip.
        "﻿hello",
        "hello﻿",
        "﻿hello﻿ world﻿",
        # U+200B (ZERO WIDTH SPACE) is also NOT Python whitespace (category Cf).
        "​hello​ world",
        # Every individual Python whitespace code point, alone and padding a word.
        *ws_chars,
        *[f"{ch}word{ch}" for ch in ws_chars],
        *[f"word{ch}word" for ch in ws_chars],
        # Every whitespace code point, doubled, to exercise run-collapsing.
        *[ch * 3 for ch in ws_chars],
        # A run that mixes several distinct whitespace code points.
        "".join(ws_chars),
        "x" + "".join(ws_chars) + "y",
        # NBSP / fullwidth space / line separator mid-string (both strip+split).
        "hello world",
        "hello　world",
        "hello world !",
    ]
    for _ in range(12):
        n = rng.randint(1, 6)
        parts = ["".join(chr(rng.randint(0x41, 0x7A)) for _ in range(rng.randint(1, 4))) for _ in range(n)]
        sep_pool = ws_chars
        s = rng.choice(sep_pool) if rng.random() < 0.5 else ""
        for part in parts:
            s += part + rng.choice(sep_pool) * rng.randint(1, 3)
        samples.append(s)

    cases = []
    for s in samples:
        cases.append({
            "input": s,
            "strip": s.strip(),
            "lstrip": s.lstrip(),
            "rstrip": s.rstrip(),
            "split": s.split(),
        })
    return cases


def main():
    data = {
        "pythonVersion": sys.version,
        "unicodedataVersion": unicodedata.unidata_version,
        "round": gen_round_cases(),
        "floatRepr": gen_float_repr_cases(),
        "jsonDumps": gen_json_dumps_cases(),
        "codepointSort": gen_codepoint_sort_cases(),
        "isoformat": gen_isoformat_cases(),
        "text": gen_text_cases(),
        "wordRegex": gen_word_regex_cases(),
        "stripSplit": gen_strip_split_cases(),
    }
    out_path = __file__.rsplit("/", 1)[0] + "/cases.json"
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
        f.write("\n")
    counts = {k: len(v) for k, v in data.items() if isinstance(v, list)}
    print("wrote", out_path, file=sys.stderr)
    print(json.dumps(counts, indent=2), file=sys.stderr)


if __name__ == "__main__":
    main()
