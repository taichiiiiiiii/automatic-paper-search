import { describe, expect, it } from "vitest";
import { edgeLayer, edgeStyle } from "../../lib/lineage/edge-style";

const base = {
  confidence: 0.5,
  influential: false,
  selected: false,
  onMain: false,
  onPath: false,
  showMainPath: false,
  focusId: null,
  src: "a",
  dst: "b",
};

describe("edgeLayer (#459)", () => {
  it("draws plain citations under strong relations under the main path", () => {
    expect(edgeLayer("baseline_only", false)).toBe(0);
    expect(edgeLayer("extends", false)).toBe(1);
    expect(edgeLayer("contrasts", false)).toBe(1);
    expect(edgeLayer("baseline_only", true)).toBe(2);
  });
});

describe("edgeStyle (#459)", () => {
  it("draws a plain citation thin and faint, a strong relation darker", () => {
    const plain = edgeStyle({ ...base, relation: "baseline_only" });
    const strong = edgeStyle({ ...base, relation: "extends", confidence: 0.8 });
    expect(plain).toEqual({ width: 1, opacity: 0.28 });
    expect(strong.opacity).toBeGreaterThan(plain.opacity);
    expect(strong.width).toBeGreaterThan(plain.width);
  });

  it("keeps the S2 mark visible on a plain citation (#444) without making it a strong relation", () => {
    const marked = edgeStyle({ ...base, relation: "baseline_only", influential: true });
    const plain = edgeStyle({ ...base, relation: "baseline_only" });
    expect(marked.width).toBe(3);
    expect(marked.opacity).toBeGreaterThan(plain.opacity);
    expect(marked.opacity).toBeLessThan(0.9);
  });

  it("brings the edges of the pointed paper forward and fades the others", () => {
    const touching = edgeStyle({ ...base, relation: "baseline_only", focusId: "a" });
    const other = edgeStyle({ ...base, relation: "baseline_only", focusId: "z" });
    expect(touching.opacity).toBe(1);
    expect(touching.width).toBeGreaterThanOrEqual(2);
    expect(other.opacity).toBeLessThan(0.1);
    // a strong relation elsewhere is dimmed less than a plain one
    expect(edgeStyle({ ...base, relation: "extends", focusId: "z" }).opacity).toBeGreaterThan(
      other.opacity,
    );
  });

  it("selection and the main path always win", () => {
    expect(edgeStyle({ ...base, relation: "baseline_only", selected: true })).toEqual({
      width: 4,
      opacity: 1,
    });
    expect(edgeStyle({ ...base, relation: "extends", onMain: true, focusId: "z" })).toEqual({
      width: 5,
      opacity: 1,
    });
    expect(
      edgeStyle({ ...base, relation: "baseline_only", showMainPath: true }).opacity,
    ).toBeLessThan(0.28);
  });
});

import { edgeAnchors } from "../../lib/lineage/edge-style";

describe("edgeAnchors (#461)", () => {
  const W = 100;
  const H = 40;
  it("runs bottom-centre to top-centre when the citing card is lower", () => {
    const a = edgeAnchors({ x: 0, y: 0 }, { x: 200, y: 100 }, W, H);
    expect(a).toEqual({ x1: 50, y1: 40, x2: 250, y2: 100, notDownward: false });
  });
  it("joins top to bottom when the citing card is above", () => {
    const a = edgeAnchors({ x: 0, y: 100 }, { x: 200, y: 0 }, W, H);
    expect(a).toEqual({ x1: 50, y1: 100, x2: 250, y2: 40, notDownward: true });
  });
  it("joins the facing sides on one line", () => {
    expect(edgeAnchors({ x: 0, y: 0 }, { x: 200, y: 0 }, W, H)).toEqual({
      x1: 100,
      y1: 20,
      x2: 200,
      y2: 20,
      notDownward: true,
    });
    expect(edgeAnchors({ x: 200, y: 0 }, { x: 0, y: 0 }, W, H)).toEqual({
      x1: 200,
      y1: 20,
      x2: 100,
      y2: 20,
      notDownward: true,
    });
  });
});
