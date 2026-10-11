/**
 * Global header navigation (components/site-header.tsx), kept pure so the
 * "which item is the current page" rule is unit-tested
 * (test/misc/site-nav.test.ts).
 *
 * UX audit (design 53, トップ・共通): the conference catalogs had no entry
 * in the header, so a visitor on /cvpr-2026/ had no one-tap way to another
 * conference. "学会" points at the top page's catalog section and is the
 * current item on every /<conf>/... route.
 */
export type NavKey = "search" | "catalogs" | "themes" | "guide";

export interface NavLink {
  readonly key: NavKey;
  readonly href: string;
  readonly label: string;
}

export const NAV_LINKS: readonly NavLink[] = [
  { key: "search", href: "/", label: "探す" },
  { key: "catalogs", href: "/#s0-confs", label: "学会" },
  { key: "themes", href: "/themes/", label: "系譜" },
  { key: "guide", href: "/how-it-works/", label: "仕組み" },
];

/** A conference route's first segment, e.g. `cvpr-2026` or `iclr-2026`. */
const CONFERENCE_SEGMENT_RE = /^[a-z][a-z0-9-]*-\d{4}$/;

/** The nav item to mark `aria-current="page"` for `pathname`, or `null`
 * (404 and anything unrecognised: better no marker than a wrong one). */
export function currentNavKey(pathname: string | null | undefined): NavKey | null {
  if (!pathname) return null;
  const path = pathname.replace(/\/+$/, "") || "/";
  if (path === "/") return "search";
  const first = path.split("/")[1] ?? "";
  if (first === "themes" || first === "lineage") return "themes";
  if (first === "how-it-works") return "guide";
  if (CONFERENCE_SEGMENT_RE.test(first)) return "catalogs";
  return null;
}
