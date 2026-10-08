/**
 * Shared constants for the conference catalog pages, ported 1:1 from
 * docs/assets/app.js / docs/assets/catalog-core.js (see
 * docs/design/39-typescript-cloudflare-migration.md §8 P2).
 */

/** Progressive reveal: render the first PAGE_SIZE rows, then grow by
 * PAGE_SIZE per "show more" click (docs/assets/app.js `PAGE_SIZE`). */
export const PAGE_SIZE = 30;

/** Top-N topic tags shown as chips (docs/assets/app.js `buildTagChips`). */
export const TAG_CHIP_LIMIT = 18;

/** Of the top TAG_CHIP_LIMIT tags, this many are shown up front; the rest
 * sit behind a "+N タグ" expander (docs/assets/app.js `HEAD_COUNT`). */
export const TAG_CHIP_HEAD_COUNT = 8;

/** Chars of context kept before the first search match in an abstract
 * preview (docs/assets/app.js `SNIPPET_LEAD`). */
export const SNIPPET_LEAD = 70;

/** Abstracts shorter than this need no "続きを読む" toggle
 * (docs/assets/app.js `CLAMP_MIN`). */
export const CLAMP_MIN = 140;

export const SORT_VALUES = ["default", "newest", "oral", "title"] as const;
export type SortValue = (typeof SORT_VALUES)[number];

export const ACCEPTANCE_TYPES = ["all", "Oral", "Poster"] as const;
export type AcceptanceType = (typeof ACCEPTANCE_TYPES)[number];

export const NEWEST_LABEL = "新着順";
export const NEWEST_UNAVAILABLE_LABEL = "新着順（arXiv ID がない学会では使えません）";

export const CATALOG_LOAD_ERROR = "論文一覧を読み込めませんでした。";

/** docs/assets/app.js `CATALOG_HISTORY_VERSION` / `CATALOG_RESTORE_KEY`. */
export const CATALOG_HISTORY_VERSION = 1;
export const CATALOG_RESTORE_KEY = "paperpilotCatalogRestore";

/** Reserved top-level slugs that must never be treated as a conference
 * route (design doc §8 P2: "keep reserved slugs ... out"). None of these
 * currently appear in conferences.json, but generateStaticParams filters
 * them out defensively so a future same-named conference can never
 * silently shadow (or be shadowed by) one of these site sections. */
export const RESERVED_CATALOG_SLUGS = new Set(["daily", "themes", "lineage", "how-it-works"]);
