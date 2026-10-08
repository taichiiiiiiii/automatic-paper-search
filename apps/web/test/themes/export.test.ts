// Unit tests for the pure helpers in lib/themes-export.ts. The DOM-
// heavy export functions (buildSelfContainedSvgString, exportSvg,
// exportPng) are not covered here -- see that file's docstring.
import { describe, expect, it } from "vitest";
import {
  exportFilenameBase,
  isSameOriginStylesheet,
  pngExportScale,
} from "../../lib/themes-export";

describe("exportFilenameBase", () => {
  it("builds '<slug>-lineage-<date>'", () => {
    const now = new Date("2026-03-14T12:00:00Z");
    expect(exportFilenameBase("flash-attention", now)).toBe("flash-attention-lineage-2026-03-14");
  });
  it("falls back to 'theme' for a missing/blank slug", () => {
    const now = new Date("2026-03-14T12:00:00Z");
    expect(exportFilenameBase(null, now)).toBe("theme-lineage-2026-03-14");
    expect(exportFilenameBase("   ", now)).toBe("theme-lineage-2026-03-14");
  });
});

describe("isSameOriginStylesheet", () => {
  const origin = "https://example.com";
  it("accepts a same-origin absolute href", () => {
    expect(isSameOriginStylesheet("https://example.com/_next/static/x.css", origin)).toBe(true);
  });
  it("accepts a relative href resolved against the page origin", () => {
    expect(isSameOriginStylesheet("/_next/static/x.css", origin)).toBe(true);
  });
  it("rejects a cross-origin href (e.g. Google Fonts)", () => {
    expect(isSameOriginStylesheet("https://fonts.googleapis.com/css2", origin)).toBe(false);
  });
  it("rejects a null/missing href (e.g. an inline <style> sheet)", () => {
    expect(isSameOriginStylesheet(null, origin)).toBe(false);
  });
  it("rejects an unparsable href instead of throwing", () => {
    expect(isSameOriginStylesheet("http://", origin)).toBe(false);
  });
});

describe("pngExportScale", () => {
  it("never upscales past 2x for small dimensions", () => {
    expect(pngExportScale(100, 100)).toBe(2);
  });
  it("caps the longer edge at the cap value", () => {
    const scale = pngExportScale(16000, 4000, 8000);
    expect(scale).toBeCloseTo(0.5);
    expect(16000 * scale).toBeCloseTo(8000);
  });
  it("uses the longer of width/height", () => {
    expect(pngExportScale(4000, 16000, 8000)).toBeCloseTo(0.5);
  });
});
