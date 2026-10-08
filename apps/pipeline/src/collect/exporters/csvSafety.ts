/**
 * Spreadsheet-formula neutralization for CSV output — TS port of
 * `paperpilot/utils/csv_safety.py` (OUT-07, OUT-08 of
 * docs/migration/safety-contracts.md).
 *
 * Excel, LibreOffice and Google Sheets evaluate a cell as a formula when its
 * text begins with one of a few characters, no matter how the CSV itself is
 * quoted. Paper titles/abstracts/author lists are untrusted upstream text,
 * so a title like `=HYPERLINK("http://attacker","click")` would execute in
 * the recipient's spreadsheet session — CWE-1236.
 */

/** A leading tab or CR also lets a spreadsheet re-interpret the cell. */
export const FORMULA_TRIGGERS = ["=", "+", "-", "@", "\t", "\r"] as const;

function startsWithTrigger(value: string): boolean {
  return FORMULA_TRIGGERS.some((t) => value.startsWith(t));
}

/**
 * Prefix a single quote when a cell would otherwise start a formula. Only
 * values that actually begin with a trigger are touched.
 */
export function neutralize(value: string): string {
  return startsWithTrigger(value) ? `'${value}` : value;
}

/**
 * Drop the guard prefix {@link neutralize} added — its exact inverse. Only
 * one prefix is ever removed; a quote followed by anything else is genuine
 * content and is left alone.
 */
export function unneutralize(value: string): string {
  if (value.startsWith("'") && startsWithTrigger(value.slice(1, 2))) {
    return value.slice(1);
  }
  return value;
}

/** Apply {@link neutralize} to every string cell of a CSV row (non-string cells pass through). */
export function neutralizeRow<T extends Record<string, unknown>>(row: T): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    out[k] = typeof v === "string" ? neutralize(v) : v;
  }
  return out as T;
}
