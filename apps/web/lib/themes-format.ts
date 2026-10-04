/**
 * Ported subset of docs/assets/utils.js's `window.PP` display
 * formatters -- scoped to exactly what the themes tree card / popover
 * need: `shortVenue` (full venue name -> conventional acronym),
 * `formatVenue` ("<short venue> <year>"), and `formatStars` (GitHub
 * star-count compaction, e.g. 12345 -> "12k").
 *
 * These are generic cross-viewer utilities (app.js / lineage.js use
 * the same `window.PP` functions), but no shared apps/web location for
 * them exists yet on this branch, and lib/data.ts / lib/config.ts are
 * out of this page agent's ownership (see the P2 brief). Local port
 * here, same as lib/themes-quality.ts explains for lineage-core.js --
 * a future shared `lib/format.ts` can re-export from here.
 */

// Map full venue names -> conventional acronyms used by the field.
// Most-specific pattern first (e.g. NeurIPS-DB before NeurIPS) so the
// longer/more specific match wins.
const VENUE_ACRONYMS: ReadonlyArray<readonly [RegExp, string]> = [
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

/** Collapse a full conference/journal name to a familiar acronym
 * ("Neural Information Processing Systems" -> "NeurIPS"). Returns the
 * trimmed original when no pattern matches so niche venues (Nature,
 * Science, etc.) that are already short are not destroyed. */
export function shortVenue(venue: string | null | undefined): string {
  if (!venue) return "";
  const trimmed = String(venue).trim();
  if (!trimmed) return "";
  for (const [re, abbr] of VENUE_ACRONYMS) {
    if (re.test(trimmed)) return abbr;
  }
  return trimmed;
}

/** Canonical card-header form of "<short venue> <year>". Either field
 * may be missing; the output collapses gracefully. */
export function formatVenue(
  venue: string | null | undefined,
  year: number | string | null | undefined,
): string {
  const v = shortVenue(venue);
  const y = year != null && year !== "" ? String(year) : "";
  return [v, y].filter(Boolean).join(" ");
}

/** Compact a GitHub star count: 0 or negative/non-numeric -> "" (no
 * badge), <1000 -> as-is, >=1000 -> "N.Nk"/"Nk" (1 decimal below 10k,
 * none at/above). */
export function formatStars(n: number | null | undefined): string {
  if (typeof n !== "number" || n <= 0) return "";
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k`;
  return n.toString();
}
