// @vitest-environment jsdom
//
// UX audit (design 53 §系譜ページ): the tree's on-screen width/height
// follow the zoom, but an SVG/PNG export must always be the drawing's
// natural size (its viewBox).
import { describe, expect, it } from "vitest";
import { buildSelfContainedSvgString, svgNaturalSize } from "../../lib/themes-export";

const NS = "http://www.w3.org/2000/svg";

function zoomedSvg(): SVGSVGElement {
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", "0 0 1000 600");
  svg.setAttribute("width", "650");
  svg.setAttribute("height", "390");
  svg.setAttribute("data-zoom", "0.65");
  document.body.appendChild(svg);
  return svg;
}

describe("export size ignores the viewer zoom", () => {
  it("reads the natural size from the viewBox", () => {
    expect(svgNaturalSize(zoomedSvg())).toEqual({ width: 1000, height: 600 });
  });

  it("falls back to width/height without a viewBox", () => {
    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("width", "320");
    svg.setAttribute("height", "200");
    expect(svgNaturalSize(svg)).toEqual({ width: 320, height: 200 });
  });

  it("serialises the clone at the natural size without the zoom marker", () => {
    const svg = zoomedSvg();
    const xml = buildSelfContainedSvgString(svg);
    expect(xml).toContain('width="1000"');
    expect(xml).toContain('height="600"');
    expect(xml).not.toContain("data-zoom");
    // The live element is untouched.
    expect(svg.getAttribute("width")).toBe("650");
  });
});
