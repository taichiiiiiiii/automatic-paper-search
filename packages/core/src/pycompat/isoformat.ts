/**
 * pyIsoformat — reproduce Python's `datetime.isoformat()` for a tz-aware
 * UTC `datetime`, e.g. `2026-06-27T12:10:56.718401+00:00`.
 *
 * Python's `datetime` stores microseconds (0..999999); JS's `Date` only
 * stores milliseconds, so it cannot by itself represent the value Python
 * would format. `microseconds` is therefore an explicit, separate argument
 * (0..999999) that *replaces* whatever sub-second value is in `date` — pass
 * the full microsecond value you want formatted, not an additional offset.
 * If omitted, `date.getUTCMilliseconds() * 1000` is used (adequate when the
 * ported value only ever had millisecond precision to begin with).
 *
 * `date`'s other UTC fields (year/month/day/hour/minute/second) are read
 * with the `getUTC*` accessors, so `date` must represent the wall-clock UTC
 * instant you want printed (construct with `Date.UTC(...)` or `new Date(...)`
 * + `setUTCFullYear` etc — see the pitfall below).
 *
 * The `+00:00` suffix is hard-coded: this only reproduces Python's
 * `isoformat()` for a datetime whose `tzinfo` is exactly `timezone.utc` (as
 * every current call site in `paperpilot/` uses — see
 * docs/design/39-typescript-cloudflare-migration.md §7.2, "時刻の書式"). A
 * datetime with a non-UTC fixed offset, or a naive (tz-less) datetime (whose
 * `isoformat()` omits the offset suffix entirely), is out of scope and would
 * need a different function.
 *
 * ## Formatting rule mirrored from CPython
 *
 * `datetime.isoformat()` omits the `.ffffff` microsecond field *entirely*
 * when `microsecond == 0` (it does not print `.000000`). This function does
 * the same: the fractional part only appears when `microseconds !== 0`.
 *
 * ## `Date.UTC` pitfall for year 0-99
 *
 * `Date.UTC(y, ...)` (and the `new Date(y, ...)` constructor) treats a
 * two-digit `y` in `0..99` as a legacy shorthand for `1900 + y` (e.g.
 * `Date.UTC(1, 0, 1)` means the year **1901**, not year **1**). Python's
 * `datetime` has no such special case and supports years `1..9999` literally.
 * Build the `Date` via `new Date(0)` followed by
 * `d.setUTCFullYear(y, month - 1, day)` (which has no two-digit quirk) when
 * `y < 100` is possible, as the test fixtures do.
 *
 * Verified against real CPython `datetime.isoformat()` output; see
 * packages/core/test/pycompat/isoformat.test.ts and
 * packages/core/test/pycompat/fixtures/gen.py.
 */
export function pyIsoformat(date: Date, microseconds?: number): string {
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth() + 1;
  const day = date.getUTCDate();
  const hour = date.getUTCHours();
  const minute = date.getUTCMinutes();
  const second = date.getUTCSeconds();
  const us = microseconds ?? date.getUTCMilliseconds() * 1000;

  const pad = (n: number, width = 2) => String(n).padStart(width, "0");

  let text = `${pad(year, 4)}-${pad(month)}-${pad(day)}T${pad(hour)}:${pad(minute)}:${pad(second)}`;
  if (us !== 0) {
    text += `.${pad(us, 6)}`;
  }
  return `${text}+00:00`;
}
