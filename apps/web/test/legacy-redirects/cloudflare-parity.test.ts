/**
 * Cross-checks that the legacy GitHub Pages redirect site
 * (legacy/redirect/redirect.js, via apps/web/scripts/legacy-redirects.ts's
 * `mapLegacyPath`) and the live Cloudflare Pages `_redirects` generator
 * (apps/web/scripts/redirects.ts's `LEGACY_HTML_RULES`) agree on where
 * every legacy `.html` path ends up. Read-only: this file only imports
 * from `redirects.ts`, never modifies it (that generator is owned by a
 * different changeset).
 *
 * `LEGACY_HTML_RULES` uses Cloudflare's `:placeholder` syntax and never
 * sees the GitHub Pages `/automatic-paper-search` prefix (Cloudflare
 * Pages serves from the domain root); `mapLegacyPath` operates on the
 * already-prefix-stripped path. This test strips the prefix itself
 * before comparing, so the two are compared on the same ground: the
 * site-relative path Cloudflare's rule table was written for.
 */

import { LEGACY_GITHUB_PAGES_BASE_PATH } from "@paperpilot/core/site";
import { describe, expect, it } from "vitest";
import { mapLegacyPath } from "../../scripts/legacy-redirects";
import { LEGACY_HTML_RULES, type RedirectRule } from "../../scripts/redirects";

/** Turns one Cloudflare `:placeholder` rule into a matcher + substitutor,
 * e.g. "/:conf/lineage.html" -> "/:conf/lineage/" matches
 * "/iclr-2026/lineage.html" and yields "/iclr-2026/lineage/". */
function matchCloudflareRule(rule: RedirectRule, path: string): string | undefined {
  const placeholderNames: string[] = [];
  const pattern = rule.from.replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, (_m, name: string) => {
    placeholderNames.push(name);
    return "([^/]+)";
  });
  const match = new RegExp(`^${pattern}$`).exec(path);
  if (!match) {
    return undefined;
  }
  const values: Record<string, string> = {};
  placeholderNames.forEach((name, i) => {
    values[name] = match[i + 1] as string;
  });
  return rule.to.replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, (_m, name: string) => {
    const value = values[name];
    if (value === undefined) {
      throw new Error(`rule ${rule.from} -> ${rule.to} used unbound placeholder :${name}`);
    }
    return value;
  });
}

/** What Cloudflare's own rule table would do with this path; falls
 * back to "unchanged" exactly like `LEGACY_HTML_RULES`'s comment
 * ("anything else keeps its path") and `mapLegacyPath`'s default. */
function cloudflareMap(path: string): string {
  for (const rule of LEGACY_HTML_RULES) {
    const mapped = matchCloudflareRule(rule, path);
    if (mapped !== undefined) {
      return mapped;
    }
  }
  return path;
}

describe("legacy redirect site agrees with the Cloudflare _redirects rules", () => {
  const PATHS = [
    "/iclr-2026/lineage.html",
    "/iclr-2026/deep.html",
    "/iclr-2026/paper-links.html",
    "/iclr-2026/index.html",
    "/cvpr-2026/lineage.html",
    "/themes/index.html",
    "/how-it-works/index.html",
    "/index.html",
  ];

  it.each(PATHS)("%s maps to the same target on both sides", (path) => {
    expect(mapLegacyPath(path)).toBe(cloudflareMap(path));
  });

  it("agrees that an unmapped, non-.html path is left untouched on both sides", () => {
    const path = "/assets/style.css";
    expect(mapLegacyPath(path)).toBe(path);
    expect(cloudflareMap(path)).toBe(path);
  });

  it("the GitHub Pages prefix constant both sides key off of is stable", () => {
    // Sanity check that the prefix redirect.js strips is the one the
    // old site is actually served under -- if this ever changes, both
    // redirect.js's hard-coded LEGACY_PREFIX and this test must change
    // together.
    expect(LEGACY_GITHUB_PAGES_BASE_PATH).toBe("/automatic-paper-search");
  });
});
