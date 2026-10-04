import { describe, expect, it } from "vitest";
import {
  htmlUnescape,
  pyWhitespaceCollapse,
  stripTagsUnescapeCollapse,
} from "../../../src/conference/shared/pyText.js";

describe("pyWhitespaceCollapse", () => {
  it("collapses runs and trims, including Python-only whitespace (U+001C, U+0085)", () => {
    expect(pyWhitespaceCollapse("  a   b  ")).toBe("a b");
    expect(pyWhitespaceCollapse(`a\u001cb\u0085c`)).toBe("a b c");
  });

  it("does NOT treat U+FEFF (BOM) as whitespace, unlike JS \\s", () => {
    expect(pyWhitespaceCollapse("a﻿b")).toBe("a﻿b");
  });

  it("empty/whitespace-only collapses to empty string", () => {
    expect(pyWhitespaceCollapse("   ")).toBe("");
    expect(pyWhitespaceCollapse("")).toBe("");
  });
});

describe("htmlUnescape", () => {
  it("unescapes core + Latin-1 named entities", () => {
    expect(htmlUnescape("Bridges &amp; Translation")).toBe("Bridges & Translation");
    expect(htmlUnescape("Caf&eacute;")).toBe("Café");
    expect(htmlUnescape("A &lt; B &gt; C")).toBe("A < B > C");
  });

  it("unescapes decimal and hex numeric references", () => {
    expect(htmlUnescape("&#169; 2026")).toBe("© 2026");
    expect(htmlUnescape("&#xA9; 2026")).toBe("© 2026");
  });

  it("leaves an unknown named entity and a semicolon-less reference untouched (documented gap)", () => {
    expect(htmlUnescape("&notarealentity; x")).toBe("&notarealentity; x");
    expect(htmlUnescape("&amp x")).toBe("&amp x");
  });
});

describe("stripTagsUnescapeCollapse", () => {
  it("strips tags, unescapes entities, then collapses whitespace (in that order)", () => {
    const input = "<p>Image-to-Image translation   converts &amp; an <b>image</b>.</p>";
    expect(stripTagsUnescapeCollapse(input)).toBe(
      "Image-to-Image translation converts & an image .",
    );
  });
});
