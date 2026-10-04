/**
 * CSV reader/writer helpers matching Python's `csv` module default dialect
 * (delimiter `,`, quote char `"`, doubled-quote escaping, `QUOTE_MINIMAL`
 * on write, `\r\n` line terminator on write) — used to port
 * `paperpilot/scripts/build_summary_csv.py` and `build_pages.py`'s
 * `csv.DictReader` / `csv.DictWriter` usage (CAT-25..27 of
 * docs/migration/safety-contracts.md).
 *
 * The writer half (`csvField`/`csvLine`) mirrors the already byte-verified
 * helpers of the same name in `apps/pipeline/src/collect/exporters/csv.ts`
 * (not imported from there — that module keeps them private — but kept
 * textually identical on purpose).
 */

/**
 * Parse CSV text into rows of raw string fields, handling quoted fields
 * (including embedded commas, quotes, and newlines) the same way Python's
 * `csv.reader` does for the default dialect. A genuinely empty physical
 * line (no characters at all before the line terminator) yields an empty
 * row (`[]`), matching Python's reader — this is what lets
 * {@link dictReader} skip blank lines exactly where `csv.DictReader` does
 * (`while row == []`), without also skipping a line of empty fields like
 * `","` (which parses to `["", ""]`, not `[]`).
 */
export function parseCsvRows(text: string): string[][] {
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;
  // True at the start of a fresh field (row start, or right after a
  // delimiter) — the only position a `"` is recognised as opening a
  // quoted field, matching the non-strict default dialect.
  let atFieldStart = true;
  // True once anything at all has been consumed for the current row
  // (>=1 field already pushed, or the current field already has
  // content/was quote-opened) — distinguishes a genuinely empty physical
  // line (`[]`, matching Python's `csv.reader`) from an ordinary row.
  let rowStarted = false;
  let i = 0;
  const n = text.length;

  function pushField(): void {
    row.push(field);
    field = "";
    atFieldStart = true;
    rowStarted = true;
  }
  function endRow(): void {
    if (!rowStarted && field === "") {
      rows.push([]);
    } else {
      pushField();
      rows.push(row);
    }
    row = [];
    rowStarted = false;
    atFieldStart = true;
  }

  while (i < n) {
    const ch = text[i] as string;
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }
    if (ch === '"' && atFieldStart) {
      inQuotes = true;
      rowStarted = true;
      atFieldStart = false;
      i += 1;
      continue;
    }
    if (ch === ",") {
      pushField();
      i += 1;
      continue;
    }
    if (ch === "\r") {
      i += 1;
      if (text[i] === "\n") i += 1;
      endRow();
      continue;
    }
    if (ch === "\n") {
      i += 1;
      endRow();
      continue;
    }
    field += ch;
    rowStarted = true;
    atFieldStart = false;
    i += 1;
  }
  if (rowStarted || field !== "") {
    endRow();
  }
  return rows;
}

export interface DictReaderResult {
  fieldnames: string[];
  rows: Array<Record<string, string | null>>;
}

/**
 * `csv.DictReader` equivalent: the first row is `fieldnames`; every
 * subsequent genuinely-empty row (`[]`) is skipped (`while row == []` in
 * CPython's `DictReader.__next__`); a short row's missing trailing keys
 * read back as `null` (Python's `restval=None`); an over-long row's extra
 * values are dropped (Python's `restkey=None` default collects them under
 * a `None` key, which no caller here reads).
 */
export function dictReader(text: string): DictReaderResult {
  const rows = parseCsvRows(text);
  if (rows.length === 0) return { fieldnames: [], rows: [] };
  const fieldnames = rows[0] as string[];
  const out: Array<Record<string, string | null>> = [];
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i] as string[];
    if (row.length === 0) continue;
    const record: Record<string, string | null> = {};
    for (let col = 0; col < fieldnames.length; col++) {
      record[fieldnames[col] as string] = col < row.length ? (row[col] as string) : null;
    }
    out.push(record);
  }
  return { fieldnames, rows: out };
}

/** Strip a leading UTF-8 BOM character, if present (for `utf-8-sig` reads). */
export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function csvField(value: string): string {
  if (/["\r\n,]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

/** One `\r\n`-terminated CSV record, `QUOTE_MINIMAL`-quoted. */
export function csvLine(values: readonly string[]): string {
  return `${values.map(csvField).join(",")}\r\n`;
}

/** `csv.DictWriter.writeheader()` + repeated `writerow(...)`, built in memory. */
export function writeDictCsv(
  fieldnames: readonly string[],
  rows: ReadonlyArray<Record<string, string>>,
): string {
  let out = csvLine(fieldnames);
  for (const row of rows) {
    out += csvLine(fieldnames.map((f) => row[f] ?? ""));
  }
  return out;
}
