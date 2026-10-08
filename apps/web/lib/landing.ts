/**
 * Pure port of docs/assets/landing.js's conference-count and
 * conference-list logic (SCR-09, SCR-10): the two numerals on first
 * paint, and the collapsible "学会から探す" list. Everything here is a
 * pure function over plain data -- DOM wiring (the fetch, the toggle,
 * the example chips, the pointer-gated focus) lives in
 * components/landing/landing.tsx.
 *
 * The audited-lineage shelf (`#s0-lineages`, SCR-11) is intentionally
 * NOT ported here -- see the handback report for why.
 */

export const CONFERENCE_SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;

export interface ConferenceRow {
  name: string;
  papers: number;
}

/** `index.html`'s static placeholder numerals, shown until the first
 * fetch resolves (success or failure) -- never left blank/loading. */
export const PLACEHOLDER_COUNTS: ConferenceCounts = Object.freeze({ n: "10", m: "28,000" });

/** Fallback numerals for "we never learned the real counts" (fetch
 * failure, non-200, or a 200 with malformed/empty JSON) -- a stale
 * static number must never be left on screen looking like live data. */
export const UNKNOWN_COUNTS: ConferenceCounts = Object.freeze({ n: "複数", m: "多数" });

export interface ConferenceCounts {
  n: string;
  m: string;
}

function isValidConferenceRow(value: unknown): value is ConferenceRow {
  if (!value || typeof value !== "object") return false;
  const rec = value as Record<string, unknown>;
  return (
    typeof rec.name === "string" &&
    CONFERENCE_SLUG_RE.test(rec.name) &&
    Number.isSafeInteger(rec.papers) &&
    (rec.papers as number) >= 0
  );
}

/** Same ordering as landing.js's conference-list sort: most papers
 * first, then alphabetically (locale-aware) by slug. */
export function sortConferenceRows<T extends ConferenceRow>(rows: readonly T[]): T[] {
  return [...rows].sort((a, b) => b.papers - a.papers || a.name.localeCompare(b.name));
}

export function venueLabel(slug: string): string {
  const match = /^(.*)-(\d{4})$/.exec(slug);
  return match ? `${(match[1] ?? "").toUpperCase()} ${match[2]}` : slug.toUpperCase();
}

/** Percent-encoded conference link (SCR-09): a hostile slug cannot add
 * path segments or escape into another href attribute. */
export function conferenceHref(slug: string): string {
  return `/${encodeURIComponent(slug)}/`;
}

export type LandingConferenceState =
  | { kind: "unknown" }
  | {
      kind: "loaded";
      n: string;
      m: string;
      list: ConferenceRow[];
      label: string;
    };

/**
 * Mirrors landing.js's `.then` handler exactly:
 *   - non-array or empty-array response -> `{ kind: "unknown" }` (the
 *     caller renders `UNKNOWN_COUNTS` and leaves the list untouched --
 *     SCR-10).
 *   - otherwise, filter rows through `CONFERENCE_SLUG_RE` + a safe
 *     non-negative integer `papers` (SCR-09), sort, and report real
 *     counts -- even if every row failed that filter (0/0 is landing.js's
 *     actual behaviour for an all-invalid non-empty array, not a 複数/多数
 *     fallback; ported as-is).
 */
export function deriveLandingConferenceState(conferences: unknown): LandingConferenceState {
  if (!Array.isArray(conferences) || conferences.length === 0) {
    return { kind: "unknown" };
  }
  const valid = sortConferenceRows(conferences.filter(isValidConferenceRow));
  const total = valid.reduce((sum, row) => sum + row.papers, 0);
  return {
    kind: "loaded",
    n: String(valid.length),
    m: total.toLocaleString("en-US"),
    list: valid,
    label: `学会から探す (${valid.length})`,
  };
}
