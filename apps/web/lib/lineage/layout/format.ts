/**
 * Display-formatting helpers ported 1:1 from docs/assets/utils.js
 * (`PP.truncateTitle`, `PP.formatStars`, `PP.shortVenue`,
 * `PP.formatVenue`). Needed by the graph node cards and topics cards
 * (components/lineage/graph/*) for the same venue-acronym / star-count
 * / title-truncation text the current SVG cards show. Not placed in
 * lib/lineage/relations.ts or core.ts -- this page agent does not own
 * those files -- so it lives under layout/ instead, scoped to this
 * area's rendering needs.
 *
 * Pure string functions, no DOM. `escapeHtml` is deliberately not
 * ported: React escapes text content by default (SCR-26), so callers
 * render these return values as plain text/children, never via
 * dangerouslySetInnerHTML.
 */

// Map full venue names -> conventional field acronyms, most specific
// pattern first (e.g. NeurIPS-DB before NeurIPS). Ported verbatim from
// utils.js `VENUE_ACRONYMS`.
const VENUE_ACRONYMS: [RegExp, string][] = [
  [/neurips datasets and benchmarks/i, "NeurIPS-DB"],
  [/neural information processing systems/i, "NeurIPS"],
  [/international conference on machine learning/i, "ICML"],
  [/international conference on learning representations/i, "ICLR"],
  [/computer vision and pattern recognition/i, "CVPR"],
  [/european conference on computer vision/i, "ECCV"],
  [/ieee international conference on computer vision/i, "ICCV"],
  [/international conference on 3d vision/i, "3DV"],
  [
    /international conference on medical image computing and computer-assisted intervention/i,
    "MICCAI",
  ],
  [/aaai conference on artificial intelligence/i, "AAAI"],
  [/north american chapter of the association for computational linguistics/i, "NAACL"],
  [/annual meeting of the association for computational linguistics/i, "ACL"],
  [/conference on empirical methods in natural language processing/i, "EMNLP"],
  [/conference on fairness, accountability and transparency/i, "FAccT"],
  [/conference on robot learning/i, "CoRL"],
  [/robotics:\s*science and systems/i, "RSS"],
  [/symposium on operating systems principles/i, "SOSP"],
  [/usenix symposium on operating systems design and implementation/i, "OSDI"],
  [/journal of machine learning research/i, "JMLR"],
  [/trans\.?\s*mach\.?\s*learn\.?\s*res\.?/i, "TMLR"],
  [/international journal of computer vision/i, "IJCV"],
  [/proceedings of the national academy of sciences/i, "PNAS"],
  [/ieee\/?\s*transactions on pattern analysis and machine intelligence/i, "TPAMI"],
  [/ieee\/?\s*transactions on geoscience and remote sensing/i, "TGRS"],
  [/ieee\/?\s*transactions on circuits and systems for video technology/i, "TCSVT"],
  [/ieee\/?\s*transactions on image processing/i, "TIP"],
  [/ieee\/?\s*transactions on multimedia/i, "TMM"],
  [/ieee\/?\s*transactions on neural networks and learning systems/i, "TNNLS"],
  [/ieee\/?\s*transactions on robotics/i, "T-RO"],
  [/ieee\/cvf conference on computer vision and pattern recognition/i, "CVPR"],
  [/ieee\s*workshop\/winter conference on applications of computer vision/i, "WACV"],
  [/winter conference on applications of computer vision/i, "WACV"],
  [/ieee\/?(rsj|rjs)?\s*international conference on intelligent robots and systems/i, "IROS"],
  [/international conference on intelligent transportation systems/i, "ITSC"],
  [/^arxiv(\.org)?$/i, "arXiv"],
  [/^biorxiv$/i, "bioRxiv"],
];

/** Truncate a paper title without cutting mid-word: cut at the last
 * space inside the budget when one exists past the halfway point,
 * else hard-cut (CJK titles have no spaces). Counts code points, not
 * UTF-16 units, so an astral char sitting on the boundary is never
 * split into an unpaired surrogate. Ported from `PP.truncateTitle`. */
export function truncateTitle(value: unknown, max = 60): string {
  const str = String(value ?? "");
  const chars = Array.from(str);
  if (chars.length <= max) return str;
  const cut = chars.slice(0, max).join("");
  const sp = cut.lastIndexOf(" ");
  return `${sp > max / 2 ? cut.slice(0, sp) : cut}…`;
}

/** Ported from `PP.formatStars`. Returns "" for non-positive/non-numeric
 * counts (the card hides the stars row entirely in that case). */
export function formatStars(n: unknown): string {
  if (typeof n !== "number" || Number.isNaN(n) || n <= 0) return "";
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k`;
  return n.toString();
}

/** Ported from `PP.shortVenue`. Falls through to the trimmed original
 * when no pattern matches, so niche venues (Nature, Science, ...) are
 * not destroyed. */
export function shortVenue(venue: unknown): string {
  if (!venue) return "";
  const trimmed = String(venue).trim();
  if (!trimmed) return "";
  for (const [re, abbr] of VENUE_ACRONYMS) {
    if (re.test(trimmed)) return abbr;
  }
  return trimmed;
}

/** Canonical card-header form "<short venue> <year>". Ported from
 * `PP.formatVenue`. Either field may be missing; output collapses
 * gracefully (never emits a stray separator). */
export function formatVenue(venue: unknown, year: unknown): string {
  const v = shortVenue(venue);
  const y = year !== null && year !== undefined && year !== "" ? String(year) : "";
  return [v, y].filter(Boolean).join(" ");
}
