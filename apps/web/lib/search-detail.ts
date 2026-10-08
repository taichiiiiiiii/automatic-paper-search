/**
 * Pure port of docs/assets/search-detail.js's click-target validation
 * (SCR-08): the detail dialog may only load a same-origin, same-base
 * `<conf>-<yyyy>/?paper=<40hex>` URL with no other params and no hash.
 * DOM wiring (the `<dialog>`, the iframe, the stale-load guard) lives in
 * components/search/search-detail-dialog.tsx.
 */

const PAPER_ID_RE = /^[0-9a-f]{40}$/;
const CONFERENCE_SUFFIX_RE = /^[a-z0-9][a-z0-9-]*-\d{4}\/$/;

/**
 * @param anchorHref The clicked result link's `href` (may be relative).
 * @param locationHref The page's current `window.location.href`, used
 *   both to resolve a relative `anchorHref` and as the same-origin /
 *   same-base ("./") reference point.
 * @returns The validated absolute URL, or `null` if any check fails.
 */
export function detailFrameUrl(anchorHref: string, locationHref: string): URL | null {
  let url: URL;
  let base: URL;
  try {
    url = new URL(anchorHref, locationHref);
    base = new URL("./", locationHref);
  } catch {
    return null;
  }
  if (url.origin !== base.origin || !url.pathname.startsWith(base.pathname)) return null;
  const suffix = url.pathname.slice(base.pathname.length);
  if (!CONFERENCE_SUFFIX_RE.test(suffix)) return null;
  if (url.searchParams.getAll("paper").length !== 1) return null;
  const paper = url.searchParams.get("paper");
  if (!paper || !PAPER_ID_RE.test(paper)) return null;
  if ([...url.searchParams.keys()].some((key) => key !== "paper")) return null;
  if (url.hash) return null;
  return url;
}
