/**
 * CVF Open Access year-listing parsing — TS port of
 * `paperpilot/scripts/collect_cvf.py::detail_paths`.
 */

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Ordered, de-duplicated detail-page paths for a CVF year listing. */
export function detailPaths(listingHtml: string, cvfId: string): string[] {
  const re = new RegExp(`href="(/content/${escapeRegExp(cvfId)}/html/[^"]+?\\.html)"`, "g");
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of listingHtml.matchAll(re)) {
    const path = m[1];
    if (path === undefined || seen.has(path)) continue;
    seen.add(path);
    out.push(path);
  }
  return out;
}
