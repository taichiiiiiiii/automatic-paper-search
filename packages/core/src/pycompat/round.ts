/**
 * pyRound — reproduce Python 3's built-in `round()` exactly.
 *
 * Python's `round(x)` / `round(x, ndigits)` rounds the EXACT binary value of
 * the IEEE-754 double `x` to the nearest multiple of `10**-ndigits`, breaking
 * ties to the nearest *even* digit ("round-half-to-even" / "banker's
 * rounding") — not the nearest value of the printed decimal literal. This is
 * why `round(2.675, 2) == 2.67`: the double closest to the literal `2.675` is
 * actually `2.67499999999999982236...`, which is below the halfway point, so
 * it rounds down.
 *
 * `Math.round` (always rounds half up) and `Number.prototype.toFixed`
 * (locale/engine-dependent decimal rounding, not tie-to-even, and not based
 * on the exact binary value) do not reproduce this, so a bit-exact
 * reimplementation is needed for ported code whose output depends on it
 * (scores, aggregates, etc — see docs/design/39-typescript-cloudflare-migration.md §7.2).
 *
 * ## Two distinct Python behaviours, both covered here
 *
 * - `round(x)` (no `ndigits`) returns a Python **int**. There is no such
 *   thing as a signed zero int in Python, so `round(-0.5) == 0` (not `-0`).
 *   We mirror that: `pyRound(x)` with `ndigits` omitted never returns `-0`.
 * - `round(x, ndigits)` (even `ndigits=0`) returns a Python **float**, which
 *   *does* have a signed zero, so `round(-0.5, 0) == -0.0`. We mirror that
 *   too: `pyRound(x, 0)` returns `-0` (as a JS `number`, i.e.
 *   `Object.is(pyRound(-0.5, 0), -0) === true`) whenever the true mathematical
 *   result is zero and `x`'s sign (or `x === -0`) was negative.
 *
 * ## Exceptions
 *
 * Python raises on `round(nan)` / `round(inf)` (no `ndigits`) because it
 * cannot build an `int` from them; `round(nan, n)` / `round(inf, n)` just
 * pass the value through. We mirror both: `pyRound(NaN)` / `pyRound(Infinity)`
 * throw a `RangeError` with Python's own message text; `pyRound(NaN, 2)` /
 * `pyRound(Infinity, 2)` return `NaN` / `Infinity` unchanged.
 *
 * ## How exactness is achieved
 *
 * `x` is decomposed into its exact sign/mantissa/exponent (no precision is
 * lost — every finite double is exactly `mantissa * 2**exponent`). The
 * target `|x| * 10**ndigits` is then computed as an exact BigInt fraction
 * (never as floating point), floor-divided, and the tie decided by comparing
 * `2*remainder` to the denominator — all exact integer arithmetic. The
 * final float is produced by building the exact decimal string for the
 * rounded value and parsing it with `Number(...)`, which the ECMAScript spec
 * requires to be correctly rounded (round-to-nearest, ties-to-even) — the
 * same contract CPython's own `strtod`-based float parsing provides. So the
 * *only* place where "nearest double" rounding happens is this single,
 * spec-guaranteed string→double step, exactly mirroring what CPython does
 * internally (via `_Py_dg_dtoa` / `_Py_dg_strtod`).
 *
 * Verified against the real CPython 3 `round()` builtin; see
 * packages/core/test/pycompat/round.test.ts and
 * packages/core/test/pycompat/fixtures/gen.py.
 */

interface DoubleParts {
  /** +1 or -1. For x === 0 or x === -0, still reflects the sign bit. */
  sign: 1 | -1;
  /** Exact non-negative integer mantissa such that |x| === mantissa * 2**exponent. Zero iff x is ±0. */
  mantissa: bigint;
  exponent: number;
}

function decomposeDouble(x: number): DoubleParts {
  const buf = new ArrayBuffer(8);
  const view = new DataView(buf);
  view.setFloat64(0, x);
  const hi = view.getUint32(0);
  const lo = view.getUint32(4);
  const sign: 1 | -1 = hi >>> 31 ? -1 : 1;
  const biasedExp = (hi >>> 20) & 0x7ff;
  const fraction = (BigInt(hi & 0xfffff) << 32n) | BigInt(lo);
  if (biasedExp === 0) {
    // Zero or subnormal: value = fraction * 2**-1074.
    return { sign, mantissa: fraction, exponent: -1074 };
  }
  // Normal: value = (2**52 + fraction) * 2**(biasedExp - 1075).
  return { sign, mantissa: fraction | (1n << 52n), exponent: biasedExp - 1075 };
}

/** Exact BigInt round-half-to-even floor-division-based rounding of a non-negative rational numerator/denominator. */
function roundHalfEvenBigInt(numerator: bigint, denominator: bigint): bigint {
  let q = numerator / denominator;
  const r = numerator - q * denominator;
  const twiceR = r * 2n;
  if (twiceR > denominator) {
    q += 1n;
  } else if (twiceR === denominator) {
    if (q % 2n !== 0n) {
      q += 1n;
    }
  }
  return q;
}

/** Build the exact decimal string for `q * 10**-n` (q: non-negative BigInt, n: integer ndigits), no sign. */
function decimalStringForScaledInt(q: bigint, n: number): string {
  if (n <= 0) {
    return q.toString() + "0".repeat(-n);
  }
  let digits = q.toString();
  if (digits.length <= n) {
    digits = "0".repeat(n - digits.length + 1) + digits;
  }
  const splitAt = digits.length - n;
  return `${digits.slice(0, splitAt)}.${digits.slice(splitAt)}`;
}

/**
 * Python 3 `round(x)` — rounds to the nearest integer (round-half-to-even),
 * returned as a JS `number` that is never `-0` (Python's `int` has no signed
 * zero). Throws `RangeError` for `NaN` / `±Infinity`, matching Python's
 * `ValueError` / `OverflowError` there (JS has no distinct exception types
 * for this without extra classes, so a `RangeError` is used; the `.message`
 * text matches CPython's wording for easy recognition in logs).
 */
export function pyRound(x: number): number;
/**
 * Python 3 `round(x, ndigits)` — rounds to `ndigits` decimal places
 * (round-half-to-even on the exact binary value of `x`), returned as a JS
 * `number` that preserves a negative sign on an exact-zero result (mirrors
 * Python float's signed zero, e.g. `pyRound(-0.5, 0)` is `-0`).
 * `NaN` / `±Infinity` pass through unchanged, matching Python.
 */
export function pyRound(x: number, ndigits: number): number;
export function pyRound(x: number, ndigits?: number): number {
  if (Number.isNaN(x)) {
    if (ndigits === undefined) {
      throw new RangeError("cannot convert float NaN to integer");
    }
    return NaN;
  }
  if (!Number.isFinite(x)) {
    if (ndigits === undefined) {
      throw new RangeError("cannot convert float infinity to integer");
    }
    return x;
  }
  if (x === 0) {
    // Preserve -0 only when ndigits is explicitly given (float result);
    // round(x) with no ndigits returns a Python int, which has no -0.
    return ndigits === undefined ? 0 : x;
  }

  const n = ndigits ?? 0;
  const { sign, mantissa, exponent } = decomposeDouble(x);

  // |x| == mantissa * 2**exponent, exactly. Compute |x| * 10**n as an exact
  // BigInt fraction numerator/denominator (denominator is always a power of
  // 2 times, possibly, a power of 10 — never approximated).
  let num: bigint;
  let den: bigint;
  if (exponent >= 0) {
    num = mantissa << BigInt(exponent);
    den = 1n;
  } else {
    num = mantissa;
    den = 1n << BigInt(-exponent);
  }
  if (n >= 0) {
    num *= 10n ** BigInt(n);
  } else {
    den *= 10n ** BigInt(-n);
  }

  const q = roundHalfEvenBigInt(num, den);

  if (ndigits === undefined) {
    // Python int result: no signed zero.
    const value = Number(q);
    return sign < 0 && value !== 0 ? -value : value;
  }

  // Python float result: build the exact decimal string (sign included so
  // that an exact-zero result parses to -0 when x was negative) and let the
  // spec-mandated correctly-rounded Number() parse pick the nearest double.
  const digits = decimalStringForScaledInt(q, n);
  const text = sign < 0 ? `-${digits}` : digits;
  return Number(text);
}
