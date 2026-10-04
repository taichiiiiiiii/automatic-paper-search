/**
 * Theme graph node serialization — TS port of the lineage-node slice of
 * `paperpilot/scripts/build_lineage.py` (`VENUE_TIER_MAP`, `venue_tier_for`,
 * `to_node`) that `build_theme_lineage.py` imports and wraps as
 * `_to_theme_node`, plus that wrapper itself.
 *
 * Scope note: `to_node`/`venue_tier_for` belong to `build_lineage.py`
 * (the conference/ICLR builder), which is a separate P4d task from this
 * one (`build_theme_lineage.py`/`_fetch_state.py`) — see this task's
 * brief. Because every theme-graph node is serialized through
 * `_to_theme_node` -> `to_node`, a local, scoped copy lives here rather
 * than leaving the theme builder unable to produce real output; this is
 * the same pattern as `apps/pipeline/src/catalog/identity.ts`'s scope
 * note for a dependency that belongs in a shared location but is copied
 * locally to respect this task's edit-path restriction. If/when
 * `build_lineage.py` is ported to `apps/pipeline/src/lineage/builders/
 * conference-s2.ts`, this should import from there instead.
 */

import { type AliasablePaper, declaredAliasValues } from "./identity.js";
import type { ThemePaper } from "./openalexWork.js";

/** Lineage-local venue tier lookup (distinct from the catalog's
 * `VenueSignal` tiers) — substring match against the lowercased venue
 * name, first match wins, in this declared order. */
const VENUE_TIER_MAP: readonly [string, string][] = [
  // Tier A+ (top ML / CV / NLP)
  ["neural information processing systems", "A+"],
  ["international conference on machine learning", "A+"],
  ["international conference on learning representations", "A+"],
  ["computer vision and pattern recognition", "A+"],
  ["european conference on computer vision", "A+"],
  ["international conference on computer vision", "A+"],
  ["annual meeting of the association for computational linguistics", "A+"],
  ["empirical methods in natural language processing", "A+"],
  // Abbreviated aliases (for rare papers where S2 uses short form)
  ["neurips", "A+"],
  ["icml", "A+"],
  ["iclr", "A+"],
  ["cvpr", "A+"],
  ["eccv", "A+"],
  ["iccv", "A+"],
  ["acl", "A+"],
  ["emnlp", "A+"],
  // Tier A
  ["north american chapter of the association for computational linguistics", "A"],
  ["aaai conference on artificial intelligence", "A"],
  ["conference on robot learning", "A"],
  ["robotics: science and systems", "A"],
  ["knowledge discovery and data mining", "A"],
  ["trans. mach. learn. res.", "A"],
  ["journal of machine learning research", "A"],
  ["naacl", "A"],
  ["aaai", "A"],
  ["kdd", "A"],
  ["tmlr", "A"],
  ["corl", "A"],
  ["sigir", "A"],
  ["www", "A"],
  ["ijcai", "A"],
];

export function venueTierFor(venue: string | null | undefined): string {
  if (!venue) return "preprint";
  const v = venue.toLowerCase();
  for (const [substring, tier] of VENUE_TIER_MAP) {
    if (v.includes(substring)) return tier;
  }
  return "preprint";
}

export interface ThemeGraphNode {
  id: string;
  title: string;
  year: number | null | undefined;
  venue: string;
  venue_tier: string;
  authors: string[];
  kinds: string[];
  citation_count: number;
  github_stars: number;
  tldr: string;
  short_abstract?: string;
  arxiv_id?: string;
  doi?: string;
  is_focus?: boolean;
  is_trending?: true;
  aliases?: [string, string][];
  [extra: string]: unknown;
}

/** Truncate `text` to `maxLen`, breaking at the nearest earlier space
 * (never mid-word) when the cut would otherwise land inside one, and
 * append an ellipsis. Mirrors `to_node`'s tldr/short_abstract cuts.
 *
 * M9 (#review): Python slices `str` by Unicode CODE POINT
 * (`abstract[:maxLen]`), not UTF-16 code unit. A native `text.slice(0,
 * maxLen)` counts UTF-16 units instead, so any abstract containing a
 * character outside the Basic Multilingual Plane (rare emoji, some CJK
 * extension ideographs — each represented as a surrogate PAIR, 2 units)
 * can have `maxLen` land between the pair's two halves, producing a lone
 * unpaired surrogate (an invalid, unrepresentable code point) in the
 * output. `Array.from(text)` splits by code point, matching Python. */
function truncateAtWordBoundary(text: string, maxLen: number, minLastSpace: number): string {
  const codePoints = Array.from(text);
  let cut = codePoints.slice(0, maxLen).join("").trim();
  if (cut && codePoints.length > maxLen) {
    const lastSpace = cut.lastIndexOf(" ");
    if (lastSpace > minLastSpace) {
      // Safe to slice `cut` itself by UTF-16 offset here: a plain ASCII
      // space is always exactly one code unit and never the second half
      // of a surrogate pair, so `lastIndexOf(" ")` can only ever return
      // an offset that already falls on a code-point boundary.
      cut = `${cut.slice(0, lastSpace)}…`;
    }
  }
  return cut;
}

/** Serialize an S2/OpenAlex-shape paper dict into the public lineage
 * node shape (`to_node`). */
export function toNode(
  paper: ThemePaper,
  options: {
    focus?: boolean;
    trending?: boolean;
    kinds?: string[];
    overrideVenue?: string;
    overrideTier?: string;
    catalogCitations?: number;
    catalogStars?: number;
  } = {},
): ThemeGraphNode {
  const venue = options.overrideVenue || (paper.venue || "arXiv").trim() || "arXiv";
  const tier = options.overrideTier || venueTierFor(paper.venue || "");
  const abstractFull = (paper.abstract || "").trim();
  const tldr = truncateAtWordBoundary(abstractFull, 140, 80);
  const shortAbstract = truncateAtWordBoundary(abstractFull, 1000, 800);
  const citationCount =
    options.catalogCitations !== undefined ? options.catalogCitations : paper.citationCount || 0;
  const githubStars = options.catalogStars !== undefined ? options.catalogStars : 0;
  const external = paper.externalIds || {};
  const arxivId = external.ArXiv || external.arxiv;
  const doi = external.DOI || external.doi;

  const node: ThemeGraphNode = {
    id: paper.paperId,
    title: paper.title,
    year: paper.year,
    venue,
    venue_tier: tier,
    authors: (paper.authors || []).slice(0, 5).map((a) => a.name || ""),
    kinds: options.kinds || [],
    citation_count: citationCount,
    github_stars: githubStars,
    tldr,
  };
  if (shortAbstract) node.short_abstract = shortAbstract;
  if (arxivId) node.arxiv_id = arxivId;
  if (doi) node.doi = doi;
  if (options.focus) node.is_focus = true;
  if (options.trending) node.is_trending = true;
  return node;
}

/** `_to_theme_node`: serialize a graph node while preserving its
 * normalized strong aliases. */
export function toThemeNode(
  paper: ThemePaper & AliasablePaper,
  options: { focus?: boolean; trending?: boolean } = {},
): ThemeGraphNode {
  const node = toNode(paper, options);
  const aliases = declaredAliasValues(paper);
  if (aliases.length > 0) {
    node.aliases = aliases.map(([ns, id]) => [ns, id]);
  }
  return node;
}
