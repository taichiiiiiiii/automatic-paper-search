/**
 * The single `LAYOUT_MODE` literal flip (p5-plan.md §5.1: "Commit B changes
 * exactly one literal plus the tests' expected mode"). A plain substring
 * replace, not a parser — `packages/core/src/layout/index.ts` is a
 * hand-written module, not generated, so the literal text is stable; the
 * "fail if not exactly one match" guard is what makes that safe (if the
 * module is ever edited so the literal appears twice, or not at all, this
 * throws instead of silently flipping the wrong occurrence or doing
 * nothing).
 */

export class LayoutFlipError extends Error {}

const LEGACY_LITERAL = 'export const LAYOUT_MODE: LayoutMode = "legacy";';
const P5_LITERAL = 'export const LAYOUT_MODE: LayoutMode = "p5";';

function replaceExactlyOnce(text: string, from: string, to: string): string {
  const first = text.indexOf(from);
  if (first === -1) {
    throw new LayoutFlipError(
      `expected exactly one occurrence of ${JSON.stringify(from)}, found none`,
    );
  }
  const second = text.indexOf(from, first + from.length);
  if (second !== -1) {
    throw new LayoutFlipError(
      `expected exactly one occurrence of ${JSON.stringify(from)}, found more than one`,
    );
  }
  return text.slice(0, first) + to + text.slice(first + from.length);
}

/** `"legacy"` -> `"p5"`. Throws unless the legacy literal appears exactly once. */
export function flipLayoutModeToP5(text: string): string {
  return replaceExactlyOnce(text, LEGACY_LITERAL, P5_LITERAL);
}

/** `"p5"` -> `"legacy"` (the exact inverse). Throws unless the p5 literal appears exactly once. */
export function flipLayoutModeToLegacy(text: string): string {
  return replaceExactlyOnce(text, P5_LITERAL, LEGACY_LITERAL);
}
