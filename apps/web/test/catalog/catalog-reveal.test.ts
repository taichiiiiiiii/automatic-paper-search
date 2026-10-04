import { describe, expect, it } from "vitest";
import {
  appendRevealBatch,
  initialRevealBatch,
  resolveRevealIndex,
} from "../../components/catalog/catalog-reveal";

/**
 * Unit tests for the catalog's staggered first-paint entrance (migration
 * gap doc row 10): the CSS existed but nothing ever passed a non-null
 * `revealIndex`, so the animation never ran. These pin the pure
 * decisions `CatalogApp` now wires up -- ported from the behavior
 * described by `docs/assets/app.js`'s `renderPaper`/`renderList`/"show
 * more" click handler comments.
 */

describe("initialRevealBatch", () => {
  it("covers positions 0..shownCount-1", () => {
    expect(initialRevealBatch(5)).toEqual({ start: 0, end: 4 });
    expect(initialRevealBatch(1)).toEqual({ start: 0, end: 0 });
  });

  it("is null when nothing is shown", () => {
    expect(initialRevealBatch(0)).toBeNull();
  });
});

describe("appendRevealBatch", () => {
  it("covers only the newly appended positions", () => {
    expect(appendRevealBatch(30, 60)).toEqual({ start: 30, end: 59 });
  });

  it("is null when the click revealed nothing new (already showing everything)", () => {
    expect(appendRevealBatch(30, 30)).toBeNull();
  });
});

describe("resolveRevealIndex", () => {
  it("is null when there is no active batch", () => {
    expect(resolveRevealIndex(null, 0)).toBeNull();
  });

  it("is null for a position outside the batch", () => {
    const batch = { start: 30, end: 59 };
    expect(resolveRevealIndex(batch, 29)).toBeNull();
    expect(resolveRevealIndex(batch, 60)).toBeNull();
  });

  it("is the absolute index itself for the initial batch (start === 0)", () => {
    const batch = initialRevealBatch(9);
    expect(resolveRevealIndex(batch, 0)).toBe(0);
    expect(resolveRevealIndex(batch, 8)).toBe(8);
  });

  it("resets to 0 at the start of an append batch, not the absolute index", () => {
    const batch = appendRevealBatch(30, 60);
    expect(resolveRevealIndex(batch, 30)).toBe(0);
    expect(resolveRevealIndex(batch, 31)).toBe(1);
    expect(resolveRevealIndex(batch, 59)).toBe(29);
  });
});
