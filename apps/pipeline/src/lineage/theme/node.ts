/**
 * Theme-specific graph node serialization — TS port of the
 * `_to_theme_node` wrapper in `paperpilot/scripts/build_theme_lineage.py`.
 *
 * `toNode`/`venueTierFor`/`ThemeGraphNode` themselves are NOT
 * theme-specific — they are the `build_lineage.py`-family node
 * serializer shared by every builder, consolidated into
 * `../shared/node.ts` per docs/migration/p4-followups.md #23. This file
 * now only holds the one piece that IS theme-specific: preserving a
 * node's normalized strong aliases.
 */

import type { ThemeGraphNode } from "../shared/node.js";
import { toNode } from "../shared/node.js";
import { type AliasablePaper, declaredAliasValues } from "./identity.js";
import type { ThemePaper } from "./openalexWork.js";
import { applyS2Count } from "./s2CitationCounts.js";

/** `_to_theme_node`: serialize a graph node while preserving its
 * normalized strong aliases. */
export function toThemeNode(
  paper: ThemePaper & AliasablePaper,
  options: { focus?: boolean; trending?: boolean } = {},
): ThemeGraphNode {
  const node = toNode(paper, options);
  // R2-36: S2's count (carried by `mergeMapped` when it is the larger one)
  // is published when it beats OpenAlex's, and the source recorded.
  applyS2Count(node, Number(paper._s2_citation_count) || 0);
  const aliases = declaredAliasValues(paper);
  if (aliases.length > 0) {
    node.aliases = aliases.map(([ns, id]) => [ns, id]);
  }
  return node;
}
