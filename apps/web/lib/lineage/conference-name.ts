/**
 * Derives a display name ("CVPR 2026") from a conference slug
 * ("cvpr-2026") for use in page titles / headings in this area's
 * routes only. This is a heuristic (uppercase + year), not a canonical
 * display-name source -- `docs/conferences.json` / `lib/data.ts`'s
 * `ConferenceSummary` carry no display field today (only `name`, the
 * slug itself). If the catalog agent's `app/[conf]/page.tsx` later
 * introduces a real display-name mapping, this should be replaced by
 * it rather than kept as a second source of truth.
 */
export function conferenceDisplayName(slug: string): string {
  const match = /^([a-z]+)-(\d{4})$/.exec(slug);
  if (!match) return slug;
  return `${(match[1] as string).toUpperCase()} ${match[2]}`;
}
