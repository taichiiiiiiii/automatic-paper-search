/**
 * pyFloatRepr — reproduce the float text that Python's `json.dumps` writes
 * for a float (which is also what plain `repr(float)` writes, EXCEPT for
 * non-finite values — see "Divergence from bare repr()" below).
 *
 * Examples (from docs/design/39-typescript-cloudflare-migration.md §7.2 and
 * CPython's own `repr`): `1.0` -> `"1.0"`, `1e16` -> `"1e+16"`,
 * `0.1+0.2` -> `"0.30000000000000004"`.
 *
 * ## Why this needs its own implementation
 *
 * Both Python and JS pick the *shortest decimal digit string that round-trips
 * back to the exact same double* (this is a uniquely-defined value per IEEE
 * double, so Python's `repr()`/`json.dumps` and JS's
 * `Number.prototype.toExponential()` — used here without a `fractionDigits`
 * argument, which per the ECMAScript spec also means "shortest round-tripping
 * digit string" — always produce the *same digit sequence*). What differs is
 * purely the **surface formatting**: when to switch to exponential notation,
 * whether a trailing ".0" is forced, and how the exponent is written. This
 * module gets the digits from the JS engine (`toExponential()`) and then
 * reformats them using Python's own `float_repr_style` rules (CPython
 * `Python/pystrtod.c: format_float_short`, mode `'r'`):
 *
 * - Fixed-point notation is used when the decimal point position `decpt`
 *   (1-based, i.e. value = 0.D1D2...Dn * 10**decpt) satisfies
 *   `-3 <= decpt <= 16`; otherwise exponential notation is used. This is
 *   *not* the same cutover point as JS's own `Number.prototype.toString()`
 *   (which switches to exponential at 1e21 / below 1e-6), so `.toString()`
 *   cannot be used directly — e.g. `(1e16).toString()` is `"10000000000000000"`
 *   but `repr(1e16)` is `"1e+16"`.
 * - Fixed-point numbers always keep at least one digit after the point
 *   (`"100.0"`, not `"100"`) — Python floats always print with a `.`,
 *   unlike JS's `(100).toString()` === `"100"`.
 * - Exponential notation omits the `.` entirely when there is only one
 *   significant digit (`"1e+16"`, not `"1.0e+16"`), and otherwise is
 *   `"D.DDDDe±EE"`.
 * - The exponent is always signed and zero-padded to at least 2 digits
 *   (`"e+05"`, `"e-05"`, `"e+100"` — no extra padding once >= 2 digits).
 *
 * ## Divergence from bare `repr()`: non-finite values
 *
 * Plain Python `repr(float("nan"))` is `"nan"` (lowercase, unquoted token,
 * not valid JSON). `json.dumps(float("nan"))`, which is what this function
 * matches per its task spec, instead writes the JSON (non-standard, but
 * accepted by Python's encoder/decoder with default settings) tokens
 * `NaN` / `Infinity` / `-Infinity`. `pyFloatRepr` always returns the
 * `json.dumps` spelling. If a caller ever needs the bare-`repr()` spelling
 * instead, they must special-case it themselves; this module does not
 * expose it since every real call site in `paperpilot/` reaches float
 * formatting through `json.dumps`, never bare `repr()` of a float that could
 * be non-finite (see pyJsonDumps.ts doc comment for the grepped call sites).
 *
 * ## Exactness
 *
 * For all finite values this is a lossless reformatting of the engine's own
 * shortest-round-trip digit string — no rounding or precision loss is
 * introduced beyond what already happened when `x` became a JS `number`.
 *
 * Verified against real CPython `repr()` / `json.dumps()` output; see
 * packages/core/test/pycompat/floatRepr.test.ts and
 * packages/core/test/pycompat/fixtures/gen.py.
 */

const EXPONENTIAL_RE = /^(\d)(?:\.(\d+))?e([+-]\d+)$/;

export function pyFloatRepr(x: number): string {
  if (Number.isNaN(x)) return "NaN";
  if (x === Infinity) return "Infinity";
  if (x === -Infinity) return "-Infinity";

  const negative = x < 0 || Object.is(x, -0);
  const ax = Math.abs(x);
  const sign = negative ? "-" : "";

  if (ax === 0) return `${sign}0.0`;

  const expText = ax.toExponential();
  const match = EXPONENTIAL_RE.exec(expText);
  if (!match) {
    // Should be unreachable for any finite, non-zero double.
    throw new Error(`pyFloatRepr: unexpected toExponential() output ${JSON.stringify(expText)}`);
  }
  const digits = match[1] + (match[2] ?? "");
  const exponent = Number(match[3]);
  const decpt = exponent + 1;

  const useExponential = decpt > 16 || decpt < -3;

  if (useExponential) {
    const mantissa = digits.length === 1 ? digits : `${digits[0]}.${digits.slice(1)}`;
    const expValue = decpt - 1;
    const expSign = expValue < 0 ? "-" : "+";
    const expDigits = String(Math.abs(expValue)).padStart(2, "0");
    return `${sign}${mantissa}e${expSign}${expDigits}`;
  }

  if (decpt <= 0) {
    return `${sign}0.${"0".repeat(-decpt)}${digits}`;
  }
  if (decpt >= digits.length) {
    return `${sign}${digits}${"0".repeat(decpt - digits.length)}.0`;
  }
  return `${sign}${digits.slice(0, decpt)}.${digits.slice(decpt)}`;
}
