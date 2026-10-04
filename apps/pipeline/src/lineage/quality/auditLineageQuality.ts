/**
 * Audit `lineage.json` files — structural checks + edge-level metrics. TS
 * port of `paperpilot/scripts/audit_lineage_quality.py` (LIN-33, LIN-49,
 * LIN-50 of docs/migration/safety-contracts.md).
 *
 * See the Python module's own extensive doc comment for the full rule
 * table (template_rationale_ratio / short_rationale_ratio / popularity
 * sinks / year reversals / off-topic-non-focus detection); it is not
 * repeated here verbatim to avoid drift between two copies of the prose.
 *
 * Exit codes: 0 — every audited lineage passes, is skipped as an empty
 * stub, or has only warnings. 1 — at least one lineage has a hard-fail
 * problem.
 */

import { readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { codepointCompare } from "@paperpilot/core";
import {
  isFoundationalAncestor,
  _TEMPLATE_RATIONALES_SET as TEMPLATE_RATIONALES_SET,
} from "../classify/classify.js";
import { codePointLength, MIN_RATIONALE_LEN } from "../llm/base.js";
import { isTopicRelevant, loadDenylist, type ThemeSeedLike } from "../theme/seedFilters.js";

function isMapping(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Edge-level thresholds (#209). See Python module doc comment for rationale.
const TEMPLATE_RATIO_FAIL = 0.8;
const TEMPLATE_RATIO_WARN = 0.6;
const POPULARITY_SINK_INCOMING = 8;
const POPULARITY_SINK_FAIL_COUNT = 5;
const YEAR_REVERSAL_FAIL_COUNT = 10;
const SHORT_RATIONALE_RATIO_WARN = 0.2;
const OFFTOPIC_NONFOCUS_RATIO_WARN = 0.5;
const OFFTOPIC_EXAMPLE_LIMIT = 5;

const CONF_DIR_YEAR_RE = /^(.+)-(\d{4})$/;

/** `<venue>-<year>` conference year from a `lineage.json` path, or `null` for themes/unparseable dirs. */
export function conferenceYearFromPath(path: string, isThemePath: boolean): number | null {
  if (isThemePath) return null;
  const name = basename(dirname(path));
  const m = CONF_DIR_YEAR_RE.exec(name);
  if (!m) return null;
  return Number(m[2]);
}

export function isEmptyStub(data: Record<string, unknown>): boolean {
  const nodes = data.nodes ?? [];
  const edges = data.edges ?? [];
  if (!Array.isArray(nodes) || !Array.isArray(edges)) return false;
  return nodes.length === 0 && edges.length === 0;
}

export function effectiveMinYear(
  path: string,
  isThemePath: boolean,
  explicit: number | null,
  fallback: number,
): number {
  if (explicit !== null) return explicit;
  const confYear = conferenceYearFromPath(path, isThemePath);
  if (confYear !== null) return confYear - 1;
  return fallback;
}

function title60(node: Record<string, unknown>): string {
  const t = node.title;
  return typeof t === "string" ? t.slice(0, 60) : "";
}

/** Structural problems (focus papers, denylist, clusters). */
export function auditStructural(
  path: string,
  data: Record<string, unknown>,
  minYear: number,
): string[] {
  const nodes = data.nodes ?? [];
  if (!Array.isArray(nodes)) return ["nodes field missing or non-list"];
  const problems: string[] = [];
  const focusPapers = nodes.filter(
    (n): n is Record<string, unknown> => isMapping(n) && Boolean(n.is_focus),
  );
  if (focusPapers.length === 0) {
    problems.push("no focus papers");
    return problems;
  }
  const isTheme = path.split(/[\\/]/).includes("themes");
  if (!isTheme) {
    for (const n of focusPapers) {
      const y = n.year;
      if (typeof y === "number" && Number.isInteger(y) && y < minYear) {
        problems.push(`focus paper too old (year=${y}): ${title60(n)}`);
      }
    }
  }
  const denylist = loadDenylist().paperIds;
  if (denylist.size > 0) {
    for (const n of focusPapers) {
      const pid = n.id ?? n.paperId;
      if (typeof pid === "string" && denylist.has(pid)) {
        problems.push(`denylisted lib paper marked as focus: ${title60(n)}`);
      }
    }
  }
  const clusters = new Set(
    (Array.isArray(data.clusters) ? data.clusters : [])
      .filter((c): c is Record<string, unknown> => isMapping(c))
      .map((c) => c.id),
  );
  if (clusters.size > 0) {
    for (const n of nodes) {
      if (!isMapping(n)) continue;
      const cid = n.cluster;
      if (cid !== null && cid !== undefined && !clusters.has(cid)) {
        problems.push(`dangling cluster ref (${String(cid)}) on paper ${title60(n)}`);
        break;
      }
    }
  }
  return problems;
}

export interface EdgeMetrics {
  edge_count: number;
  template_count: number;
  template_ratio: number;
  short_rationale_count: number;
  short_rationale_ratio: number;
  popularity_sinks: number;
  year_reversals: number;
}

/** Compute the four edge-level metrics for a lineage (#209). */
export function edgeMetrics(data: Record<string, unknown>): EdgeMetrics {
  const edges = Array.isArray(data.edges) ? data.edges : [];
  if (edges.length === 0) {
    return {
      edge_count: 0,
      template_count: 0,
      template_ratio: 0,
      short_rationale_count: 0,
      short_rationale_ratio: 0,
      popularity_sinks: 0,
      year_reversals: 0,
    };
  }
  const nodesById = new Map<string, Record<string, unknown>>();
  for (const n of Array.isArray(data.nodes) ? data.nodes : []) {
    if (isMapping(n)) {
      const nid = n.id ?? n.paperId;
      if (typeof nid === "string") nodesById.set(nid, n);
    }
  }

  let templateCount = 0;
  let shortRationaleCount = 0;
  const incoming = new Map<string, number>();
  let yearReversals = 0;

  for (const e of edges) {
    if (!isMapping(e)) continue;
    const rationale = e.rationale;
    const stripped = typeof rationale === "string" ? rationale.trim() : "";
    if (typeof rationale === "string" && TEMPLATE_RATIONALES_SET.has(rationale.trim())) {
      templateCount += 1;
    }
    const len = codePointLength(stripped);
    if (len > 0 && len < MIN_RATIONALE_LEN) shortRationaleCount += 1;
    const dst = e.dst;
    if (typeof dst === "string") incoming.set(dst, (incoming.get(dst) ?? 0) + 1);
    const src = e.src;
    const srcNode = typeof src === "string" ? nodesById.get(src) : undefined;
    const dstNode = typeof dst === "string" ? nodesById.get(dst) : undefined;
    if (srcNode && dstNode) {
      const sy = srcNode.year;
      const dy = dstNode.year;
      if (
        typeof sy === "number" &&
        Number.isInteger(sy) &&
        typeof dy === "number" &&
        Number.isInteger(dy) &&
        sy > dy + 1
      ) {
        yearReversals += 1;
      }
    }
  }

  let popularitySinks = 0;
  for (const count of incoming.values())
    if (count >= POPULARITY_SINK_INCOMING) popularitySinks += 1;

  return {
    edge_count: edges.length,
    template_count: templateCount,
    template_ratio: templateCount / edges.length,
    short_rationale_count: shortRationaleCount,
    short_rationale_ratio: shortRationaleCount / edges.length,
    popularity_sinks: popularitySinks,
    year_reversals: yearReversals,
  };
}

function nodeToRelevancePaper(node: Record<string, unknown>): ThemeSeedLike {
  const title = node.title;
  const shortAbstract = node.short_abstract;
  const tldr = node.tldr;
  return {
    title: typeof title === "string" ? title : "",
    abstract:
      typeof shortAbstract === "string" && shortAbstract
        ? shortAbstract
        : typeof tldr === "string"
          ? tldr
          : "",
  };
}

export interface OfftopicNonfocusMetric {
  theme: string;
  nonfocus_count: number;
  offtopic_count: number;
  offtopic_ratio: number;
  offtopic_titles: string[];
  foundational_exempt: number;
}

/** Off-topic-non-focus ratio for a theme lineage (#298 Part 4). DETECTION ONLY. */
export function offtopicNonfocusMetric(data: Record<string, unknown>): OfftopicNonfocusMetric {
  const meta = isMapping(data.meta) ? data.meta : {};
  const theme = String(meta.theme || meta.slug || "");
  const nodes = data.nodes;
  const empty: OfftopicNonfocusMetric = {
    theme,
    nonfocus_count: 0,
    offtopic_count: 0,
    offtopic_ratio: 0,
    offtopic_titles: [],
    foundational_exempt: 0,
  };
  if (!theme || !Array.isArray(nodes)) return empty;
  const nonfocus = nodes.filter((n): n is Record<string, unknown> => isMapping(n) && !n.is_focus);
  let considered = 0;
  let offtopicCount = 0;
  let foundationalExempt = 0;
  const offtopicTitles: string[] = [];
  for (const n of nonfocus) {
    if (isFoundationalAncestor(n)) {
      foundationalExempt += 1;
      continue;
    }
    considered += 1;
    const paper = nodeToRelevancePaper(n);
    if (!isTopicRelevant(paper, theme)) {
      offtopicCount += 1;
      const title = String(n.title || n.id || "").trim();
      if (title && offtopicTitles.length < OFFTOPIC_EXAMPLE_LIMIT) offtopicTitles.push(title);
    }
  }
  return {
    theme,
    nonfocus_count: considered,
    offtopic_count: offtopicCount,
    offtopic_ratio: considered > 0 ? offtopicCount / considered : 0,
    offtopic_titles: offtopicTitles,
    foundational_exempt: foundationalExempt,
  };
}

/** Python `f"{ratio:.0%}"` — nearest-integer percentage (ties handled the ordinary round-half-away-from-zero way; see module doc comment on this being a non-persisted message string). */
function pct(ratio: number): string {
  return `${Math.round(ratio * 100)}%`;
}

export function auditOfftopicNonfocus(data: Record<string, unknown>): string[] {
  const m = offtopicNonfocusMetric(data);
  if (m.nonfocus_count === 0 || m.offtopic_ratio <= OFFTOPIC_NONFOCUS_RATIO_WARN) return [];
  const examples =
    m.offtopic_titles.length > 0
      ? ` e.g. ${m.offtopic_titles.map((t) => t.slice(0, 60)).join("; ")}`
      : "";
  return [
    `offtopic_nonfocus_ratio=${pct(m.offtopic_ratio)} ` +
      `(${m.offtopic_count}/${m.nonfocus_count} BFS-discovered nodes are NOT ` +
      `topic-relevant to theme '${m.theme}', foundational anchors ` +
      `exempt);${examples}; warn above ` +
      `${pct(OFFTOPIC_NONFOCUS_RATIO_WARN)} (#298 — a drifted seed may have ` +
      "dragged in an off-topic neighbourhood; inspect and blacklist/" +
      "regenerate. NOTE: deep legitimate lineages whose ancestors don't " +
      "share the theme's surface terms also score high here, so this is " +
      "DETECTION not a hard fail)",
  ];
}

export function auditEdges(data: Record<string, unknown>): {
  warnings: string[];
  failures: string[];
} {
  const m = edgeMetrics(data);
  const warnings: string[] = [];
  const failures: string[] = [];
  if (m.edge_count === 0) return { warnings, failures };
  if (m.template_ratio > TEMPLATE_RATIO_FAIL) {
    failures.push(
      `template_rationale_ratio=${pct(m.template_ratio)} (${m.template_count}/${m.edge_count}); hard fail above ${pct(TEMPLATE_RATIO_FAIL)}`,
    );
  } else if (m.template_ratio > TEMPLATE_RATIO_WARN) {
    warnings.push(
      `template_rationale_ratio=${pct(m.template_ratio)} (${m.template_count}/${m.edge_count}); warn above ${pct(TEMPLATE_RATIO_WARN)}`,
    );
  }
  if (m.short_rationale_ratio > SHORT_RATIONALE_RATIO_WARN) {
    warnings.push(
      `short_rationale_ratio=${pct(m.short_rationale_ratio)} (${m.short_rationale_count}/${m.edge_count} edges with ` +
        `<${MIN_RATIONALE_LEN}-char rationale, e.g. "A"); warn above ${pct(SHORT_RATIONALE_RATIO_WARN)} (#297 — regenerate ` +
        "the lineage to re-derive rationales)",
    );
  }
  if (m.popularity_sinks > POPULARITY_SINK_FAIL_COUNT) {
    failures.push(
      `popularity_sinks=${m.popularity_sinks} (nodes with ≥${POPULARITY_SINK_INCOMING} incoming); hard fail above ${POPULARITY_SINK_FAIL_COUNT}`,
    );
  } else if (m.popularity_sinks > 0) {
    warnings.push(
      `popularity_sinks=${m.popularity_sinks} (nodes with ≥${POPULARITY_SINK_INCOMING} incoming)`,
    );
  }
  if (m.year_reversals > YEAR_REVERSAL_FAIL_COUNT) {
    failures.push(
      `year_reversals=${m.year_reversals} (parent.year > child.year+1); hard fail above ${YEAR_REVERSAL_FAIL_COUNT}`,
    );
  } else if (m.year_reversals > 0) {
    warnings.push(`year_reversals=${m.year_reversals}`);
  }
  return { warnings, failures };
}

/** (warnings, hard_failures) for one lineage.json. */
export function auditLineage(
  path: string,
  minYear: number,
  data: Record<string, unknown>,
  _isThemePath: boolean,
): { warnings: string[]; failures: string[] } {
  const structural = auditStructural(path, data, minYear);
  const { warnings: edgeWarn, failures: edgeFail } = auditEdges(data);
  const offtopicWarn = auditOfftopicNonfocus(data);
  return { warnings: [...edgeWarn, ...offtopicWarn], failures: [...structural, ...edgeFail] };
}

/** Glob both `docs/<slug>/lineage.json` and `docs/themes/<slug>/lineage.json`, sorted by path. */
export function collectTargets(docsDir: string): string[] {
  const targets = new Set<string>();
  let topLevel: string[] = [];
  try {
    topLevel = readdirSync(docsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    topLevel = [];
  }
  for (const name of topLevel) {
    const p = join(docsDir, name, "lineage.json");
    try {
      readFileSync(p);
      targets.add(p);
    } catch {
      // not present — not a target
    }
  }
  const themesDir = join(docsDir, "themes");
  let themeSlugs: string[] = [];
  try {
    themeSlugs = readdirSync(themesDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    themeSlugs = [];
  }
  for (const slug of themeSlugs) {
    const p = join(themesDir, slug, "lineage.json");
    try {
      readFileSync(p);
      targets.add(p);
    } catch {
      // not present
    }
  }
  return Array.from(targets).sort(codepointCompare);
}
