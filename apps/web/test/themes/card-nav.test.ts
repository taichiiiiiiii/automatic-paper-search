import { describe, expect, it } from "vitest";
import {
  cardDirectionForKey,
  matchesInReadingOrder,
  nextCardInDirection,
} from "../../lib/themes-card-nav";

// 3 x 2 grid, 200 px apart, plus one card offset diagonally.
const grid = [
  { id: "a", x: 0, y: 0 },
  { id: "b", x: 200, y: 0 },
  { id: "c", x: 400, y: 0 },
  { id: "d", x: 0, y: 200 },
  { id: "e", x: 200, y: 200 },
  { id: "f", x: 400, y: 200 },
  { id: "g", x: 150, y: 60 },
];

describe("#521 U1: arrow keys move between lineage cards", () => {
  it("maps only the four arrow keys", () => {
    expect(cardDirectionForKey("ArrowRight")).toBe("right");
    expect(cardDirectionForKey("ArrowUp")).toBe("up");
    expect(cardDirectionForKey("Tab")).toBeNull();
  });

  it("prefers the same row / column over a closer diagonal card", () => {
    expect(nextCardInDirection(grid, "a", "right")).toBe("b");
    expect(nextCardInDirection(grid, "b", "right")).toBe("c");
    expect(nextCardInDirection(grid, "b", "down")).toBe("e");
    expect(nextCardInDirection(grid, "e", "up")).toBe("b");
    expect(nextCardInDirection(grid, "f", "left")).toBe("e");
  });

  it("returns null at the edge or for an unknown card", () => {
    expect(nextCardInDirection(grid, "c", "right")).toBeNull();
    expect(nextCardInDirection(grid, "a", "up")).toBeNull();
    expect(nextCardInDirection(grid, "zz", "down")).toBeNull();
  });
});

describe("#521 U2: search matches are visited in reading order", () => {
  it("sorts by row, then column", () => {
    expect(matchesInReadingOrder(grid, new Set(["f", "a", "e", "g"]))).toEqual([
      "a",
      "g",
      "e",
      "f",
    ]);
    expect(matchesInReadingOrder(grid, new Set())).toEqual([]);
  });
});
