import { describe, expect, it } from "vitest";
import { currentNavKey, NAV_LINKS } from "../../lib/site-nav";

describe("site header navigation (UX audit, design 53)", () => {
  it("links search, conference catalogs, themes and the guide", () => {
    expect(NAV_LINKS.map((link) => [link.label, link.href])).toEqual([
      ["探す", "/"],
      ["学会", "/#s0-confs"],
      ["系譜", "/themes/"],
      ["仕組み", "/how-it-works/"],
    ]);
  });

  it.each([
    ["/", "search"],
    ["/themes/", "themes"],
    ["/themes", "themes"],
    ["/lineage/", "themes"],
    ["/how-it-works/", "guide"],
    ["/cvpr-2026/", "catalogs"],
    ["/iclr-2026/lineage/", "catalogs"],
    ["/aaai-2026/paper-links/2/", "catalogs"],
  ] as const)("marks %s as %s", (path, key) => {
    expect(currentNavKey(path)).toBe(key);
  });

  it("marks nothing on unknown paths (404) or without a pathname", () => {
    expect(currentNavKey("/no-such-page/")).toBeNull();
    expect(currentNavKey("/404")).toBeNull();
    expect(currentNavKey(null)).toBeNull();
    expect(currentNavKey("")).toBeNull();
  });
});
