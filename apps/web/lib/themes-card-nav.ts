/**
 * #521 (UI/UX round 4, U1/U2): keyboard movement between lineage cards and
 * the order in which search matches are visited. Pure functions over the
 * laid-out card positions (top-left corners), so they are unit-testable
 * without rendering the graph.
 */

export interface CardPoint {
  id: string;
  x: number;
  y: number;
}

export type CardDirection = "left" | "right" | "up" | "down";

const DIRECTION_KEYS: Readonly<Record<string, CardDirection>> = {
  ArrowLeft: "left",
  ArrowRight: "right",
  ArrowUp: "up",
  ArrowDown: "down",
};

/** The direction an arrow key asks for, or null for any other key. */
export function cardDirectionForKey(key: string): CardDirection | null {
  return DIRECTION_KEYS[key] ?? null;
}

/**
 * The card to move to from `fromId` in `dir`: among the cards strictly on
 * that side, the one with the smallest distance along the direction plus
 * four times the sideways offset (so the same row / column wins over a closer
 * card diagonally). Null when there is no card on that side.
 */
export function nextCardInDirection(
  points: readonly CardPoint[],
  fromId: string,
  dir: CardDirection,
): string | null {
  const from = points.find((p) => p.id === fromId);
  if (!from) return null;
  let best: string | null = null;
  let bestScore = Number.POSITIVE_INFINITY;
  for (const p of points) {
    if (p.id === fromId) continue;
    const dx = p.x - from.x;
    const dy = p.y - from.y;
    const along = dir === "right" ? dx : dir === "left" ? -dx : dir === "down" ? dy : -dy;
    const side = dir === "left" || dir === "right" ? Math.abs(dy) : Math.abs(dx);
    if (along <= 0) continue;
    const score = along + 4 * side;
    if (score < bestScore || (score === bestScore && best !== null && p.id < best)) {
      best = p.id;
      bestScore = score;
    }
  }
  return best;
}

/** Matching cards in reading order (top to bottom, then left to right). */
export function matchesInReadingOrder(
  points: readonly CardPoint[],
  matches: ReadonlySet<string>,
): string[] {
  return points
    .filter((p) => matches.has(p.id))
    .sort((a, b) => a.y - b.y || a.x - b.x || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((p) => p.id);
}
