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
