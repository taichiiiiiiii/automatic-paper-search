/**
 * Same-day re-export path resolution, shared by CSV/JSON exporters — TS
 * port of the identical `_resolve_export_path` helper in
 * `paperpilot/exporters/csv_exporter.py` / `json_exporter.py` (OUT-05,
 * OUT-06 of docs/migration/safety-contracts.md).
 *
 * The first export of the day keeps the plain `papers_<date>.<ext>` name.
 * Once that file exists, later exports in the same day go to a run-unique
 * sibling `papers_<date>-<HHMMSS>.<ext>` (LOCAL time — not UTC), falling
 * back to a numeric counter if even that collides. Both the date and the
 * HHMMSS suffix are read off ONE clock call, so they can never disagree
 * right around local midnight.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

function pad(n: number, width = 2): string {
  return String(n).padStart(width, "0");
}

/** Local-time `YYYY-MM-DD` (matches Python's naive `date.today().isoformat()`). */
function localIsoDate(d: Date): string {
  return `${pad(d.getFullYear(), 4)}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Local-time `HHMMSS`. */
function localHms(d: Date): string {
  return `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

export function resolveExportPath(outDir: string, ext: string, now: Date): string {
  const today = localIsoDate(now);
  const plain = join(outDir, `papers_${today}.${ext}`);
  if (!existsSync(plain)) return plain;

  const stamp = localHms(now);
  let candidate = join(outDir, `papers_${today}-${stamp}.${ext}`);
  let counter = 2;
  while (existsSync(candidate)) {
    candidate = join(outDir, `papers_${today}-${stamp}-${counter}.${ext}`);
    counter += 1;
  }
  return candidate;
}
