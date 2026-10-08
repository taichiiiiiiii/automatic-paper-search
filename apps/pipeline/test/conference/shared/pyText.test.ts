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

  it("accepts an uppercase hex marker &#X..; like CPython's html.unescape (LOW)", () => {
    // Verified against a real `html.unescape`: html.unescape("&#X49;") == "I".
    expect(htmlUnescape("&#X49;")).toBe("I");
    expect(htmlUnescape("&#x49;")).toBe("I");
  });

  it("drops (does not pass through) the HTML5 _invalid_codepoints numeric refs (LOW)", () => {
    // Verified against real CPython: html.unescape("&#1;") == "" (not "\x01"),
    // and likewise for &#11; (0x0B) and &#127; (0x7F) and a noncharacter
    // (&#64976; == 0xFDD0).
    expect(htmlUnescape("a&#1;b")).toBe("ab");
    expect(htmlUnescape("a&#11;b")).toBe("ab");
    expect(htmlUnescape("a&#127;b")).toBe("ab");
    expect(htmlUnescape("a&#64976;b")).toBe("ab");
    // Still passes through an ordinary printable codepoint untouched.
    expect(htmlUnescape("&#65;")).toBe("A");
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
