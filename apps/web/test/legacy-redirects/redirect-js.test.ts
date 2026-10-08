// @vitest-environment jsdom
/**
 * Table-driven tests for legacy/redirect/redirect.js (design doc §5.4 /
 * docs/migration/p5-plan.md §5.4, changeset A8). The jsdom environment
 * pragma matches the plan's "loading redirect.js in jsdom"; it does
 * not change the result here because the UMD guard always takes the
 * `module.exports` branch under Vitest's CJS interop (see the file's
 * own doc comment) -- importing it never touches `window` or
 * navigates, in any Vitest environment.
 */
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const REDIRECT_JS = pathToFileURL(resolve(here, "../../../../legacy/redirect/redirect.js")).href;

// legacy/redirect/redirect.js is plain untyped ES5, deliberately outside
// the TS project (no build step runs over it -- see its own doc
// comment); this interface describes just the shape this test needs.
interface LegacyRedirectModule {
  readonly LEGACY_PREFIX: string;
  readonly NEW_ORIGIN: string;
  mapPath(pathname: string): string;
  mapUrl(pathname: string, search: string, hash: string): string;
  redirect(): void;
}

async function loadRedirectModule(): Promise<LegacyRedirectModule> {
  return (await import(REDIRECT_JS)) as LegacyRedirectModule;
}

describe("redirect.js mapPath / mapUrl", () => {
  it("is loadable and exports the mapping functions, not a real navigation", async () => {
    const mod = await loadRedirectModule();
    expect(typeof mod.mapPath).toBe("function");
    expect(typeof mod.mapUrl).toBe("function");
    expect(typeof mod.redirect).toBe("function");
    expect(mod.LEGACY_PREFIX).toBe("/automatic-paper-search");
  });

  const PATH_CASES: ReadonlyArray<[string, string]> = [
    ["/automatic-paper-search/iclr-2026/lineage.html", "/iclr-2026/lineage/"],
    ["/automatic-paper-search/iclr-2026/deep.html", "/iclr-2026/deep/"],
    ["/automatic-paper-search/iclr-2026/paper-links.html", "/iclr-2026/paper-links/"],
    ["/automatic-paper-search/iclr-2026/index.html", "/iclr-2026/"],
    ["/automatic-paper-search/themes/index.html", "/themes/"],
    ["/automatic-paper-search/index.html", "/"],
    // bare prefix, no trailing path
    ["/automatic-paper-search", "/"],
    ["/automatic-paper-search/", "/"],
    // unknown path: no rule matches, so the path (minus the GH Pages
    // prefix) is kept verbatim
    ["/automatic-paper-search/assets/style.css", "/assets/style.css"],
    ["/automatic-paper-search/robots.txt", "/robots.txt"],
    // no GH Pages prefix at all: nothing to strip, path kept as-is
    ["/some/other/path.html", "/some/other/path.html"],
  ];

  it.each(PATH_CASES)("mapPath(%s) -> %s", async (input, expected) => {
    const mod = await loadRedirectModule();
    expect(mod.mapPath(input)).toBe(expected);
  });

  it("preserves location.search verbatim, including encoded characters", async () => {
    const mod = await loadRedirectModule();
    const url = mod.mapUrl(
      "/automatic-paper-search/iclr-2026/lineage.html",
      "?q=%E3%83%86%E3%83%BC%E3%83%9E",
      "",
    );
    expect(url).toBe(`${mod.NEW_ORIGIN}/iclr-2026/lineage/?q=%E3%83%86%E3%83%BC%E3%83%9E`);
  });

  it("preserves a ?theme= query string verbatim", async () => {
    const mod = await loadRedirectModule();
    const url = mod.mapUrl(
      "/automatic-paper-search/themes/index.html",
      "?theme=Vision+Transformer",
      "",
    );
    expect(url).toBe(`${mod.NEW_ORIGIN}/themes/?theme=Vision+Transformer`);
  });

  it("preserves a #hash fragment verbatim", async () => {
    const mod = await loadRedirectModule();
    const url = mod.mapUrl("/automatic-paper-search/iclr-2026/deep.html", "", "#section-2");
    expect(url).toBe(`${mod.NEW_ORIGIN}/iclr-2026/deep/#section-2`);
  });

  it("preserves both query and hash together, in order", async () => {
    const mod = await loadRedirectModule();
    const url = mod.mapUrl("/automatic-paper-search/iclr-2026/lineage.html", "?x=1", "#y");
    expect(url).toBe(`${mod.NEW_ORIGIN}/iclr-2026/lineage/?x=1#y`);
  });

  it("maps a bare prefix with no path to the new origin's root", async () => {
    const mod = await loadRedirectModule();
    expect(mod.mapUrl("/automatic-paper-search", "", "")).toBe(`${mod.NEW_ORIGIN}/`);
  });

  it("keeps an unknown path's query/hash even though the path itself is unchanged", async () => {
    const mod = await loadRedirectModule();
    const url = mod.mapUrl("/automatic-paper-search/assets/style.css", "?v=3", "");
    expect(url).toBe(`${mod.NEW_ORIGIN}/assets/style.css?v=3`);
  });
});
