/**
 * Ported from paperpilot/tests/viewer/test_catalog_viewer_medium.mjs
 * (§2, §5, §6 -- the first-paint clamp, entity-safety, and
 * not-length-preserving-lowercase cases), adapted to this port's
 * segment-based API (no HTML string / `<mark>` to match against; the
 * React layer does the escaping, see lib/catalog-text.ts's doc
 * comment).
 */
import { describe, expect, it } from "vitest";
import { buildAbstractDek, highlightSegments } from "../../lib/catalog-text";

describe("highlightSegments", () => {
  it("returns the whole text unmarked when there is no query", () => {
    expect(highlightSegments("R&D samples", "")).toEqual([{ text: "R&D samples", mark: false }]);
  });

  it("marks only the matched term, leaving an entity-like substring intact as plain text", () => {
    // "amp" sits inside "samples", NOT inside the literal "&" -- there is
    // no HTML-escaped "&amp;" for the match to accidentally land inside,
    // because these are raw text segments, not markup.
    const segments = highlightSegments("R&D samples", "amp");
    expect(segments).toEqual([
      { text: "R&D s", mark: false },
      { text: "amp", mark: true },
      { text: "les", mark: false },
    ]);
  });

  it("matches case-insensitively and marks every occurrence", () => {
    const segments = highlightSegments("Vision Transformer VISION", "vision");
    expect(segments.filter((s) => s.mark).map((s) => s.text)).toEqual(["Vision", "VISION"]);
  });
});

describe("buildAbstractDek", () => {
  it("the first paint clamps a long preview and keeps it un-marked as is-full", () => {
    const longPreview = "alpha ".repeat(40); // 240 chars, > CLAMP_MIN (140)
    const dek = buildAbstractDek(longPreview, "", { isFull: false, isSelected: false });
    expect(dek.needsToggle).toBe(true);
  });

  it("the selected card is never clamped, even with a long cached full text", () => {
    const longPreview = "alpha ".repeat(40);
    const dek = buildAbstractDek(longPreview, "", { isFull: true, isSelected: true });
    expect(dek.needsToggle).toBe(false);
    expect(dek.leadEllipsis).toBe(false);
  });

  it("a short preview needs no toggle", () => {
    const dek = buildAbstractDek("short preview text.", "", { isFull: false, isSelected: false });
    expect(dek.needsToggle).toBe(false);
  });

  // The window index used to come from abstract.toLowerCase(), which is
  // not length-preserving: "İ" becomes two code units there, so every
  // index after it was one too high for the raw string the window is
  // sliced out of.
  it("opens the match window from the RAW text's index, not a lowercased one", () => {
    const words = Array.from({ length: 40 }, (_, n) => `w${String(n).padStart(2, "0")}`).join(" ");
    const abstract = `İ ${words}`;
    const query = "w25";
    expect(abstract.indexOf(query)).toBe(102);
    expect(abstract.toLowerCase().indexOf(query)).toBe(103);

    const dek = buildAbstractDek(abstract, query, { isFull: false, isSelected: false });
    expect(dek.leadEllipsis).toBe(true);
    const text = dek.segments.map((s) => s.text).join("");
    expect(text.startsWith("w07")).toBe(true);
    const marked = dek.segments.find((s) => s.mark);
    expect(marked?.text).toBe("w25");
  });
});
