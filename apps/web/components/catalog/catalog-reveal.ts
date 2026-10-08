/**
 * Pure decisions for the catalog's staggered first-paint entrance, ported
 * from `docs/assets/app.js`'s `renderPaper`/`renderList` (see the comment
 * at `renderPaper`: "`revealIndex` opts a row into the staggered
 * entrance: null = no animation ... Only the first paint and 'show more'
 * appends pass it").
 *
 * The CSS half of this (`.revealRow`, `data-reveal="0".."8"`,
 * `prefers-reduced-motion`) already existed in `catalog.module.css` /
 * `CatalogPaperCard`; this module is the missing wiring that decides
 * *which* rows currently get a non-null `revealIndex` -- without it
 * `CatalogApp` always passed `revealIndex={null}` and the animation never
 * ran (migration gap doc row 10).
 */

/** The half-open range `[start, end]` (both inclusive) of absolute
 * positions in the displayed list that should animate in on this render.
 * `null` means "no row animates" -- every filter/search/sort/tag change
 * and every popstate restore must land here, matching the original's
 * `renderList()` (no `animate` argument) call sites. */
export interface RevealBatch {
  readonly start: number;
  readonly end: number;
}

/**
 * The reveal index to pass a row at `absoluteIndex` (its position in the
 * full, already-filtered/sorted/pinned display list), or `null` to
 * render it without any entrance animation.
 *
 * For the initial-paint batch (`start === 0`) this is simply
 * `absoluteIndex` -- the original's `renderList(true)` call passes
 * `revealIndex = i` for the absolute index `i`. For a "show more" append
 * batch (`start === previousShownCount`) it is the position *within the
 * newly appended rows* -- the original's append handler calls
 * `renderPaper(p, prevShown + i, i)`, i.e. the reveal step resets to 0 at
 * the start of every new batch rather than continuing to climb. Both
 * cases are simply `absoluteIndex - batch.start`.
 */
export function resolveRevealIndex(
  batch: RevealBatch | null,
  absoluteIndex: number,
): number | null {
  if (!batch) return null;
  if (absoluteIndex < batch.start || absoluteIndex > batch.end) return null;
  return absoluteIndex - batch.start;
}

/**
 * The reveal batch for an initial render that shows `shownCount` rows
 * (0-based positions `0..shownCount-1`), or `null` when there is nothing
 * to show.
 */
export function initialRevealBatch(shownCount: number): RevealBatch | null {
  return shownCount > 0 ? { start: 0, end: shownCount - 1 } : null;
}

/**
 * The reveal batch for a "show more" click that grows the shown count
 * from `previousShownCount` to `nextShownCount` -- only the newly
 * appended rows animate, never the rows that were already on screen.
 * `null` when the click did not actually reveal any new row (e.g.
 * already showing everything).
 */
export function appendRevealBatch(
  previousShownCount: number,
  nextShownCount: number,
): RevealBatch | null {
  return nextShownCount > previousShownCount
    ? { start: previousShownCount, end: nextShownCount - 1 }
    : null;
}
