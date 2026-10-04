import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { resultUrl, type SearchRow, searchUrl } from "../../lib/search-core";

// Port of paperpilot/tests/viewer/test_search_untrusted_text.mjs (a
// static-analysis guard on docs/assets/search.js) plus a behavioural
// check of the percent-encoding it asserts the source *has*.
//
// docs/assets/search.js once built result rows with innerHTML behind an
// `escapeHtml` helper that silently became the identity function if
// utils.js failed to load. The fix was to stop producing HTML strings
// at all. React's default JSX text-child escaping gives apps/web the
// same property structurally (there is no string-concatenation step to
// audit), but SCR-02/SCR-03 explicitly ban `dangerouslySetInnerHTML` as
// the one way to opt back into that old failure mode -- so this test
// still greps the component source for it, the same way the original
// grepped for `innerHTML`.

const COMPONENT_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "components",
  "search",
);
const LIB_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "lib");

const SOURCE_FILES = [
  join(COMPONENT_DIR, "search-area.tsx"),
  join(COMPONENT_DIR, "search-detail-dialog.tsx"),
  join(LIB_DIR, "search-core.ts"),
  join(LIB_DIR, "search-detail.ts"),
  join(LIB_DIR, "data-search.ts"),
];

describe("search component source never builds HTML from untrusted text", () => {
  for (const file of SOURCE_FILES) {
    it(`${file.split("/").slice(-2).join("/")} has no dangerouslySetInnerHTML / innerHTML / insertAdjacentHTML`, () => {
      const src = readFileSync(file, "utf8");
      expect(src).not.toMatch(/dangerouslySetInnerHTML/);
      expect(src).not.toMatch(/\.innerHTML\s*(=|\+=)/);
      expect(src).not.toMatch(/\.outerHTML\s*(=|\+=)/);
      expect(src).not.toMatch(/insertAdjacentHTML\s*\(/);
      expect(src).not.toMatch(/document\s*\.\s*write\s*\(/);
    });
  }
});

describe("href values are percent-encoded (SCR-04)", () => {
  it("resultUrl percent-encodes a hostile conference slug and paper id", () => {
    // resultUrl itself must encode whatever it's handed, regardless of
    // whether validateIndex would have rejected it upstream.
    const row: SearchRow = ["Title", "iclr-2026", 0, [], [], 2026, "Oral"];
    const href = resultUrl(row, "../../etc/passwd&x=1");
    expect(href).not.toContain("../");
    expect(href).toContain(encodeURIComponent("../../etc/passwd&x=1"));
  });

  it("searchUrl percent-encodes a hostile query value via URLSearchParams", () => {
    const href = searchUrl("https://example.test/", '"><img src=x>', 1, {
      conference: "",
      year: null,
      type: "",
      invalid: false,
    });
    expect(href).not.toContain("<img");
    expect(href).not.toContain('">');
  });
});
