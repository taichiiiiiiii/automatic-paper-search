/**
 * Year × citation-count timeline of a theme lineage — design doc 48 P1-5
 * (I7, the Litmaps-style "年軸" view). x = publication year, y =
 * log10(citations + 1). Papers of the same year are spread a little
 * sideways so they do not sit on one vertical line.
 *
 * Pure layout only (numbers for SVG attributes); the component draws it.
 * No inline styles are needed, which keeps the strict CSP intact.
 */

export interface TimelineNodeInput {
  id: string;
  year?: number | null;
  citation_count?: number | null;
}

export interface TimelinePoint {
  id: string;
  year: number;
  citations: number;
  x: number;
  y: number;
}

export interface TimelineTick {
  value: number;
  label: string;
  /** Pixel position along the axis (x for years, y for citations). */
  pos: number;
}

export interface TimelineLayout {
  width: number;
  height: number;
  /** Plot area. */
  plot: { left: number; top: number; right: number; bottom: number };
  points: TimelinePoint[];
  xTicks: TimelineTick[];
  yTicks: TimelineTick[];
  /** Papers left out because they have no usable year. */
  missingYear: number;
}

export const TIMELINE_MARGIN = { left: 56, right: 24, top: 16, bottom: 36 } as const;
export const TIMELINE_MIN_COL_W = 64;
export const TIMELINE_HEIGHT = 420;

function finiteYear(y: number | null | undefined): number | null {
  return typeof y === "number" && Number.isFinite(y) && y > 1800 && y < 2200 ? Math.trunc(y) : null;
}

function citationsOf(c: number | null | undefined): number {
  return typeof c === "number" && Number.isFinite(c) && c > 0 ? Math.trunc(c) : 0;
}

export function formatCitationTick(v: number): string {
  if (v >= 1_000_000) return `${v / 1_000_000}M`;
  if (v >= 1_000) return `${v / 1_000}k`;
  return String(v);
}

export function layoutYearCitationTimeline(
  nodes: readonly TimelineNodeInput[],
  opts: { minWidth?: number; height?: number } = {},
): TimelineLayout {
  const height = opts.height ?? TIMELINE_HEIGHT;
  const m = TIMELINE_MARGIN;
  const withYear = nodes
    .map((n) => ({ n, year: finiteYear(n.year) }))
    .filter((x): x is { n: TimelineNodeInput; year: number } => x.year !== null);
  const missingYear = nodes.length - withYear.length;

  if (withYear.length === 0) {
    const width = Math.max(opts.minWidth ?? 320, 320);
    return {
      width,
      height,
      plot: { left: m.left, top: m.top, right: width - m.right, bottom: height - m.bottom },
      points: [],
      xTicks: [],
      yTicks: [],
      missingYear,
    };
  }

  const years = withYear.map((x) => x.year);
  const minYear = Math.min(...years);
  const maxYear = Math.max(...years);
  const span = maxYear - minYear + 1;
  const width = Math.max(opts.minWidth ?? 320, m.left + m.right + span * TIMELINE_MIN_COL_W);
  const plot = { left: m.left, top: m.top, right: width - m.right, bottom: height - m.bottom };
  const colW = (plot.right - plot.left) / span;

  const maxCites = Math.max(1, ...withYear.map((x) => citationsOf(x.n.citation_count)));
  const maxLog = Math.max(1, Math.ceil(Math.log10(maxCites + 1)));
  const yOf = (c: number): number =>
    plot.bottom - (Math.log10(c + 1) / maxLog) * (plot.bottom - plot.top);
  const xCenter = (year: number): number => plot.left + (year - minYear + 0.5) * colW;

  // Spread papers of one year across 70% of the column, most-cited in
  // the middle-left, by a stable order (citations desc, then id).
  const byYear = new Map<number, TimelineNodeInput[]>();
  for (const { n, year } of withYear) {
    if (!byYear.has(year)) byYear.set(year, []);
    byYear.get(year)?.push(n);
  }
  const points: TimelinePoint[] = [];
  for (const [year, group] of [...byYear.entries()].sort((a, b) => a[0] - b[0])) {
    group.sort(
      (a, b) =>
        citationsOf(b.citation_count) - citationsOf(a.citation_count) ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );
    const k = group.length;
    group.forEach((n, i) => {
      const offset = k === 1 ? 0 : (i / (k - 1) - 0.5) * colW * 0.7;
      const citations = citationsOf(n.citation_count);
      points.push({ id: n.id, year, citations, x: xCenter(year) + offset, y: yOf(citations) });
    });
  }

  // Year ticks: every year when there is room, otherwise every 2/5/10.
  const step = [1, 2, 5, 10].find((s) => colW * s >= 40) ?? 10;
  const xTicks: TimelineTick[] = [];
  for (let y = minYear; y <= maxYear; y += 1) {
    if ((y - minYear) % step === 0 || y === maxYear) {
      xTicks.push({ value: y, label: String(y), pos: xCenter(y) });
    }
  }
  const yTicks: TimelineTick[] = [];
  for (let p = 0; p <= maxLog; p += 1) {
    const v = p === 0 ? 0 : 10 ** p;
    yTicks.push({ value: v, label: formatCitationTick(v), pos: yOf(v === 0 ? 0 : v - 1) });
  }

  return { width, height, plot, points, xTicks, yTicks, missingYear };
}
