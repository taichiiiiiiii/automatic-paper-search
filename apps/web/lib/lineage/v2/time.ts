/**
 * Date/timestamp validation and ordering, ported 1:1 from
 * docs/assets/lineage-v2-core.js. `dateValue`/`timestampValue` return
 * microsecond-resolution `bigint`s (not `Date`, whose millisecond
 * resolution cannot distinguish two timestamps that differ only in
 * fractional-second microseconds) so release.ts's
 * `generatedAt > fixtureAt` / review-time ordering checks compare
 * exactly what the JS does.
 */
import { DATE_RE, TIMESTAMP_RE } from "./constants";

function calendarPartsValid(
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0,
  second = 0,
): boolean {
  if (
    year < 1 ||
    year > 9999 ||
    month < 1 ||
    month > 12 ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  ) {
    return false;
  }
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day >= 1 && day <= (days[month - 1] as number);
}

export function validDate(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = DATE_RE.exec(value);
  if (!match) return false;
  const [, year, month, day] = match;
  return calendarPartsValid(Number(year), Number(month), Number(day));
}

export function validTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = TIMESTAMP_RE.exec(value);
  if (!match) return false;
  const [, year, month, day, hour, minute, second] = match;
  if (
    !calendarPartsValid(
      Number(year),
      Number(month),
      Number(day),
      Number(hour),
      Number(minute),
      Number(second),
    )
  ) {
    return false;
  }
  const offset = /([+-])(\d{2}):(\d{2})$/.exec(value);
  if (offset && (Number(offset[2]) > 23 || Number(offset[3]) > 59)) return false;
  return Number.isFinite(Date.parse(value));
}

export function timestampValue(value: unknown): bigint | null {
  if (!validTimestamp(value)) return null;
  const str = value as string;
  const fraction = /\.(\d+)(?=Z|[+-]\d{2}:\d{2}$)/.exec(str)?.[1] || "";
  const withoutFraction = str.replace(/\.\d+(?=Z|[+-]\d{2}:\d{2}$)/, "");
  const wholeMilliseconds = Date.parse(withoutFraction);
  if (!Number.isFinite(wholeMilliseconds)) return null;
  const microseconds = BigInt((fraction.slice(0, 6) || "0").padEnd(6, "0"));
  return BigInt(wholeMilliseconds) * 1000n + microseconds;
}

export function dateValue(value: unknown): bigint | null {
  if (validDate(value)) return BigInt(Date.parse(`${value}T00:00:00Z`)) * 1000n;
  if (validTimestamp(value)) return timestampValue(value);
  return null;
}
