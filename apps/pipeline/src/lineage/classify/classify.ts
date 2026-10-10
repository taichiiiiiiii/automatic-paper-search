/**
 * Relation classification for lineage edges — TS port of
 * `paperpilot/scripts/_lineage_classify.py` (the heuristic + LLM merge
 * logic; the cache machinery lives in `./cache.ts`).
 *
 * Three layers in priority order decide what relation an edge represents:
 *   1. unarXive citation contexts (regex over the citing paper's own
 *      sentences about the cited work) — highest evidence, no LLM cost.
 *   2. S2 intent map (`methodology`/`result` -> relation + heuristic).
 *   3. Year + citation contrast, when the intent map produces nothing.
 * On top of that, an optional LLM pass either confirms or refutes the
 * heuristic edge.
 */

import { readFileSync } from "node:fs";
import { getRepoRoot } from "@paperpilot/core";
import { foundationalAllowlist, layoutFor } from "@paperpilot/core/layout";
import type {
  ClassifyPaperLike,
  Relation,
  RelationClassification,
} from "../../collect/llm/provider.js";
import { truthy } from "../../collect/pyish.js";
import { TEMPLATE_RATIONALES } from "../llm/base.js";
import { titleizeRationale } from "./citedTarget.js";

export type LineagePaperLike = ClassifyPaperLike;

export interface DerivedEdge {
  relation: Relation;
  confidence: number;
  rationale: string;
  provenance: string;
  /** For `provenance: "llm"`: the provider/model that actually answered,
   * when known (fallback chain / provider-agnostic cache). */
  producedBy?: { provider: string; model: string };
  /** R2-10: the evidence actually behind this classification when it is
   * not the abstract prompt (`llm`) or the paper-metadata input (other
   * methods) — the Semantic Scholar citation context of an
   * `s2_context_rule` edge, or the citation-context prompt of an `llm`
   * edge. Edge provenance hashes it instead of the default input. */
  evidence?: { source: string; kind: string; sha256: string };
  /** For `provenance: "llm"` answers to a prompt other than the abstract
   * prompt (e.g. `relation-prompt-v4-context`). */
  promptVersion?: string;
}

/** The LLM-branch DerivedEdge for a usable classification (shared by both LLM paths). */
function llmDerived(llmResult: RelationClassification): DerivedEdge {
  const edge: DerivedEdge = {
    relation: llmResult.relation,
    confidence: Number(llmResult.confidence),
    rationale: llmResult.rationale,
    provenance: "llm",
  };
  if (llmResult.producedBy) edge.producedBy = { ...llmResult.producedBy };
  return edge;
}

// ===== Constants =====

// Issue #53 / #300: the heuristic no longer emits the legacy template
// rationale below — it builds a slot-filled, paper-specific rationale via
// `slotFillRationale()` instead, so a signal-bearing edge survives
// `applyLlmClassification`'s template-reject step when the LLM is null.
// The template strings are retained only to keep the single-source-of-truth
// link to `TEMPLATE_RATIONALES` (the #131 LLM-echo reject set) in sync, and
// to document which template each intent used to emit.
const INTENT_RELATION_MAP: ReadonlyArray<readonly [string, Relation, string]> = [
  // (intent name, relation enum, legacy rationale template) — order matters:
  // methodology > result when an entry has multiple intents, since
  // methodology implies the citing paper actually built on top of the
  // referenced work.
  ["methodology", "extends", TEMPLATE_RATIONALES.extends_methodology as string],
  ["result", "successor", TEMPLATE_RATIONALES.successor_result as string],
];

export { INTENT_RELATION_MAP as _INTENT_RELATION_MAP };

const DERIVED_CONFIDENCE = 0.7; // constant — heuristic, not LLM probability

// #300: max chars of a paper title embedded in a slot-filled rationale.
const SLOT_FILL_TITLE_TRIM = 60;

// #300: placeholder for a missing title in a slot-filled rationale.
const MISSING_TITLE_JA = "引用元の論文";

// Minimum LLM confidence to keep an edge. Below this, the LLM itself is
// signalling the relation is weak; emitting it as a styled arrow misleads
// the reader.
const MIN_LLM_CONFIDENCE = 0.4;

const TEMPLATE_RATIONALES_SET: ReadonlySet<string> = new Set(Object.values(TEMPLATE_RATIONALES));

export { TEMPLATE_RATIONALES_SET as _TEMPLATE_RATIONALES_SET };

/**
 * Closed enum of valid provenance labels for lineage edges. Every emit path
 * in this module MUST set one of these values on the returned object.
 */
export const VALID_PROVENANCES: ReadonlySet<string> = new Set([
  "context_pattern", // unarXive citation context regex matched
  "intent_map", // S2 intent label matched INTENT_RELATION_MAP
  "year_cite", // year / citation-count contrast heuristic
  "title_version", // child title is a version-increment of parent (supersedes)
  "foundational_allowlist", // title matched lineage_foundational_allowlist.json
  "llm", // LLM provider returned a valid classification
  "s2_context_rule", // R2-10: Semantic Scholar citation context/intents/isInfluential, rule set v2
]);
export { VALID_PROVENANCES as _VALID_PROVENANCES };

// ===== Phase J: unarXive citation-context classifier =====

const MAX_CONTEXT_RATIONALE_LEN = 280;

interface ContextPattern {
  relation: Relation;
  confidence: number;
  patterns: RegExp[];
}

// Priority order matters because some sentences match multiple patterns
// (e.g. "we extend [X], outperforming the baseline" matches both extends
// and supersedes — supersedes wins).
const CITATION_CONTEXT_PATTERNS: readonly ContextPattern[] = [
  {
    relation: "supersedes",
    confidence: 0.88,
    patterns: [
      /\boutperform(s|ed|ing)?\b/i,
      /\bsupersed(es|ed|e)\b/i,
      /\bsurpass(es|ed|ing)?\b/i,
      /\bnew\s+state[\s-]of[\s-]the[\s-]art\b/i,
      /\bachiev(es|ed|ing)\s+sota\b/i,
    ],
  },
  {
    relation: "contrasts",
    confidence: 0.86,
    patterns: [
      /\bunlike\b/i,
      /\bin\s+contrast\s+to\b/i,
      /\bdiffer(s|ent)?\s+from\b/i,
      /\bas\s+opposed\s+to\b/i,
    ],
  },
  {
    relation: "extends",
    confidence: 0.84,
    patterns: [
      /\bbuild(s|ing)?\s+(on|upon)\b/i,
      /\bextend(s|ing|ed)?\b/i,
      // Tightened: plain "based on" matched background sentences; require
      // a self-referential subject so the phrase only fires when the
      // CITING paper claims to build on the cited one.
      /\b(?:our|this)\s+(?:model|method|approach|work|paper|system|framework|architecture)\s+is\s+based\s+on\b/i,
      /\bfollowing\s+\[?/i,
      /\bimprov(e|es|ing|ed)\s+(on|upon)\b/i,
      /\binspired\s+by\b/i,
      /\badapt(s|ed|ing)?\s+from\b/i,
    ],
  },
  {
    relation: "ablation",
    confidence: 0.82,
    patterns: [/\bablation\b/i, /\bablate(s|d|ing)?\b/i],
  },
  {
    relation: "baseline_only",
    confidence: 0.78,
    patterns: [
      /\bas\s+a\s+baseline\b/i,
      /\bbaseline(s)?\b/i,
      /\bcompare(d|s)?\s+(to|with|against)\b/i,
      /\bcomparison\s+(to|with|against)\b/i,
    ],
  },
  {
    relation: "successor",
    confidence: 0.75,
    patterns: [/\bsubsequent\s+work\b/i, /\bsuccessor\b/i, /\bfollow[\s-]?up\b/i],
  },
];

/**
 * Match citation-paragraph text against the relation pattern table. First
 * match wins (priority order above). `null` if no context provided or no
 * pattern fires — callers fall through to the intent-map / year-cite
 * heuristic.
 */
export function classifyFromContexts(
  contexts: readonly string[] | null | undefined,
): DerivedEdge | null {
  if (!contexts || !Array.isArray(contexts)) return null;
  for (const { relation, confidence, patterns } of CITATION_CONTEXT_PATTERNS) {
    for (const ctx of contexts) {
      if (typeof ctx !== "string" || !ctx.trim()) continue;
      for (const pattern of patterns) {
        if (pattern.test(ctx)) {
          let rationale = ctx.trim();
          const cps = Array.from(rationale);
          if (cps.length > MAX_CONTEXT_RATIONALE_LEN) {
            rationale = `${cps.slice(0, MAX_CONTEXT_RATIONALE_LEN - 1).join("")}…`;
          }
          return { relation, confidence, rationale, provenance: "context_pattern" };
        }
      }
    }
  }
  return null;
}
export { classifyFromContexts as _classify_from_contexts };

// ===== Slot-filled rationale (#300) =====

function slotFillTitle(paper: LineagePaperLike | null | undefined): string {
  let title = "";
  if (paper && typeof paper === "object") {
    const raw = paper.title;
    if (typeof raw === "string") {
      title = raw.trim().replaceAll("「", "").replaceAll("」", "");
    }
  }
  if (!title) return MISSING_TITLE_JA;
  const cps = Array.from(title);
  if (cps.length > SLOT_FILL_TITLE_TRIM) {
    return `${cps.slice(0, SLOT_FILL_TITLE_TRIM - 1).join("")}…`;
  }
  return title;
}

function slotFillYear(paper: LineagePaperLike | null | undefined): string {
  if (paper && typeof paper === "object") {
    const year = paper.year;
    if (typeof year === "number" && Number.isInteger(year)) return String(year);
  }
  return "?";
}

// #306: Japanese labels for S2 intent keywords embedded in slot-fill
// rationales.
const INTENT_JA_LABEL: Readonly<Record<string, string>> = {
  methodology: "手法",
  result: "結果",
  background: "背景",
};

/**
 * Build a paper-specific, Japanese rationale embedding the actual
 * parent/child titles (truncated) + years + the signal (#300). Can NEVER be
 * a member of {@link TEMPLATE_RATIONALES_SET} because it embeds the actual
 * titles, so a signal-bearing heuristic edge survives
 * {@link applyLlmClassification}'s template-reject step even when the LLM
 * is unavailable.
 *
 * `parent` is the OLDER / cited paper (A), `child` is the NEWER / citing
 * paper (B) — same A->B convention as `buildClassifyPrompt`.
 */
export function slotFillRationale(
  relation: Relation,
  parent: LineagePaperLike | null | undefined,
  child: LineagePaperLike | null | undefined,
  intent?: string | null,
): string {
  const pt = slotFillTitle(parent);
  const ct = slotFillTitle(child);
  const py = slotFillYear(parent);
  const cy = slotFillYear(child);

  if (intent !== undefined && intent !== null) {
    const intentJa = INTENT_JA_LABEL[intent] ?? intent;
    if (relation === "extends") {
      return `「${ct}」(${cy}) は「${pt}」(${py}) の${intentJa}を拡張している。`;
    }
    return `「${ct}」(${cy}) は「${pt}」(${py}) を${intentJa}として参照している。`;
  }

  if (relation === "successor") {
    return `「${ct}」(${cy}) は「${pt}」(${py}) を引用する後発研究（年代差と引用関係から後継と推定）。`;
  }
  if (relation === "contrasts") {
    return `「${ct}」(${cy}) は「${pt}」(${py}) と近い年代の対照的研究（年代・引用規模から推定）。`;
  }

  return `「${ct}」(${cy}) は「${pt}」(${py}) と引用関係にある（${relation}）。`;
}
export { slotFillRationale as _slot_fill_rationale };

// ===== Title-version supersedes (#283) =====

const VERSION_SUFFIX_RE = /^(.+?)[\s-]+v?(\d+)$/i;
const IMPROVE_PREFIX_RE = /^(?:improved|improving|enhanced)\s+(.+)$/i;
const MIN_VERSION_BASE_LEN = 4;
const MAX_VERSION_TOKEN = 20;

function shortTitle(paper: LineagePaperLike | null | undefined): string {
  let raw = "";
  if (paper && typeof paper === "object" && typeof paper.title === "string") {
    raw = paper.title as string;
  }
  raw = raw.split(":", 1)[0]?.trim().toLowerCase().replaceAll("「", "").replaceAll("」", "") ?? "";
  return raw.replace(/\s+/g, " ");
}

function stripVersion(short: string): [string, number | null] {
  const m = VERSION_SUFFIX_RE.exec(short);
  if (m && (m[1] as string).trim().length >= MIN_VERSION_BASE_LEN) {
    return [(m[1] as string).trim(), Number.parseInt(m[2] as string, 10)];
  }
  return [short, null];
}

/** The version family of a paper title: the lower-cased short title
 * (before the first colon) without a trailing version number, and that
 * number (`null` when the title carries none, i.e. the first version).
 * "FlashAttention-2: Faster…" -> `{ base: "flashattention", version: 2 }`.
 * `null` for an empty title. Used by the theme builder's version-family
 * pass (`theme/bfs.ts::addVersionFamilyEdges`). */
export function titleVersionOf(
  paper: LineagePaperLike | null | undefined,
): { base: string; version: number | null } | null {
  const short = shortTitle(paper);
  if (!short) return null;
  const [base, version] = stripVersion(short);
  return { base, version: version !== null && version <= MAX_VERSION_TOKEN ? version : null };
}

/** True when `child`'s title is a version increment of `parent`'s
 * (`title_version` supersedes, #283). Exported for the R2-10 S2 path,
 * which leaves such pairs to the existing heuristic. */
export function isVersionIncrement(
  parent: LineagePaperLike | null | undefined,
  child: LineagePaperLike | null | undefined,
): boolean {
  const pt = shortTitle(parent);
  const ct = shortTitle(child);
  if (!pt || !ct || pt === ct) return false;

  const [pbase, pver] = stripVersion(pt);
  const [cbase, cver] = stripVersion(ct);
  if (
    cver !== null &&
    cver <= MAX_VERSION_TOKEN &&
    cbase === pbase &&
    (pver === null || cver > pver)
  ) {
    return true;
  }

  const m = IMPROVE_PREFIX_RE.exec(ct);
  if (m && (m[1] as string).trim() === pt) return true;
  return isAcronymVersionIncrement(parent, child);
}

// ---- R2-17: acronym versions ("Pyramid Vision Transformer" -> "PVT v2") ----

/** "PVT v2", "PVTv2", "PVT-2", "PVT V2", "PVT++" (the short title before
 * the colon, original case). Group 1 = the acronym; the acronym needs at
 * least two upper-case letters so ordinary words are never read as one. */
const ACRONYM_VERSION_RE =
  /^([\p{Lu}][\p{L}\p{N}]*?)(?:[\s-]*[vV](\d{1,2})|[\s-]+(\d{1,2})|\s*(\+\+))$/u;
const INITIALISM_STOPWORDS = new Set([
  "a",
  "an",
  "the",
  "of",
  "for",
  "and",
  "with",
  "in",
  "on",
  "to",
  "via",
]);

function rawShortTitle(paper: LineagePaperLike | null | undefined): string {
  const raw =
    paper && typeof paper === "object" && typeof paper.title === "string" ? paper.title : "";
  return (raw.split(":", 1)[0] ?? "").normalize("NFKC").replace(/\s+/g, " ").trim();
}

/** Upper-cased initialisms of a full name: every word, content words
 * only, and with hyphenated parts split ("Pre-trained" -> "PT"). */
function initialismsOf(name: string): Set<string> {
  const out = new Set<string>();
  for (const splitter of [/\s+/, /[\s-]+/]) {
    const words = name.split(splitter).filter((w) => /\p{L}/u.test(w));
    if (words.length < 2) continue;
    out.add(words.map((w) => w[0]!.toUpperCase()).join(""));
    const content = words.filter((w) => !INITIALISM_STOPWORDS.has(w.toLowerCase()));
    if (content.length >= 2) out.add(content.map((w) => w[0]!.toUpperCase()).join(""));
  }
  return out;
}

function authorKeys(paper: LineagePaperLike | null | undefined): Set<string> {
  const out = new Set<string>();
  const list =
    paper && typeof paper === "object" ? (paper as Record<string, unknown>).authors : null;
  if (!Array.isArray(list)) return out;
  for (const a of list) {
    const name =
      typeof a === "string"
        ? a
        : a && typeof a === "object" && typeof (a as Record<string, unknown>).name === "string"
          ? ((a as Record<string, unknown>).name as string)
          : "";
    const parts = name
      .normalize("NFKC")
      .toLowerCase()
      .replace(/[^\p{L}\s-]/gu, " ")
      .trim()
      .split(/\s+/);
    const last = parts[parts.length - 1];
    if (last && last.length >= 2) out.add(`${parts[0]![0] ?? ""}.${last}`);
  }
  return out;
}

/**
 * R2-17 (ERROR_PATTERNS 5): `child` is a new version of `parent` written
 * with the ACRONYM of its name — "PVT v2: Improved Baselines…" of
 * "Pyramid Vision Transformer: A Versatile Backbone…", or "PVTv2" of
 * "PVT: …". The acronym (2+ upper-case letters) must equal the parent's
 * short title or the initialism of it, and the child carries an explicit
 * version token (`v2`, ` 2`, `-2`, `++`). When both papers list authors
 * they must share at least two (one when either side has a single
 * author): an acronym alone is a weaker identity than a shared full name.
 */
export function isAcronymVersionIncrement(
  parent: LineagePaperLike | null | undefined,
  child: LineagePaperLike | null | undefined,
): boolean {
  const cm = ACRONYM_VERSION_RE.exec(rawShortTitle(child));
  if (!cm) return false;
  const acronym = (cm[1] as string).toUpperCase();
  if ((cm[1]!.match(/\p{Lu}/gu) ?? []).length < 2 || acronym.length > 8) return false;
  const version = cm[2] ?? cm[3];
  if (version !== undefined && (Number(version) < 2 || Number(version) > MAX_VERSION_TOKEN)) {
    return false;
  }
  const pshort = rawShortTitle(parent);
  if (!pshort) return false;
  // The parent must be the unversioned work itself.
  if (ACRONYM_VERSION_RE.test(pshort)) return false;
  const pAcronym = pshort.replace(/[^\p{L}\p{N}]/gu, "").toUpperCase();
  const named = pAcronym === acronym || initialismsOf(pshort).has(acronym);
  if (!named) return false;
  const pa = authorKeys(parent);
  const ca = authorKeys(child);
  if (pa.size === 0 || ca.size === 0) return true;
  let shared = 0;
  for (const k of ca) if (pa.has(k)) shared += 1;
  return shared >= Math.min(2, pa.size, ca.size);
}

// ===== Heuristic (LLM-free) classifier =====

export function deriveRelationHeuristic(
  intentRecord: Record<string, unknown>,
  parent?: LineagePaperLike | null,
  child?: LineagePaperLike | null,
): DerivedEdge | null {
  const intentsRaw = intentRecord._intents;
  const intents = Array.isArray(intentsRaw) ? intentsRaw : [];
  const intentsSet = new Set(
    intents.filter((i) => typeof i === "string").map((i) => (i as string).toLowerCase()),
  );
  for (const [keyword, relation] of INTENT_RELATION_MAP) {
    if (intentsSet.has(keyword)) {
      const rationale = slotFillRationale(relation, parent, child, keyword);
      return makeDerived(relation, rationale, "intent_map");
    }
  }

  // No matching intent — title-version supersedes signal BEFORE year/cite.
  if (isVersionIncrement(parent, child)) return titleVersionEdge(parent, child);

  // No matching intent — year + citation contrast.
  if (parent && child) {
    const py = parent.year;
    const cy = child.year;
    // Python: `parent.get("citationCount") or parent.get("citation_count") or 0`
    // — an `or` chain, not a "first defined" chain: a falsy-but-present
    // value (0, "", None) falls through to the NEXT alternative, same as
    // `??` would NOT do (`?? ` only falls through on null/undefined, so a
    // present `citationCount: 0` would incorrectly win over a real
    // `citation_count: 50`).
    const pc = (
      truthy(parent.citationCount)
        ? parent.citationCount
        : truthy(parent.citation_count)
          ? parent.citation_count
          : 0
    ) as number;
    const cc = (
      truthy(child.citationCount)
        ? child.citationCount
        : truthy(child.citation_count)
          ? child.citation_count
          : 0
    ) as number;
    if (
      typeof py === "number" &&
      Number.isInteger(py) &&
      typeof cy === "number" &&
      Number.isInteger(cy)
    ) {
      const delta = cy - py;
      if (delta <= 1 && pc > 100 && cc / Math.max(pc, 1) >= 0.5 && cc / Math.max(pc, 1) <= 2.0) {
        return makeDerived("contrasts", slotFillRationale("contrasts", parent, child), "year_cite");
      }
      if (delta >= 1 && delta <= 5) {
        return makeDerived("successor", slotFillRationale("successor", parent, child), "year_cite");
      }
    }
  }
  return null;
}
export { deriveRelationHeuristic as _derive_relation_heuristic };

/** Confidence of a version edge inferred from titles alone, with no
 * citation between the two papers in the data (`citationBacked: false`). */
export const TITLE_VERSION_UNCITED_CONFIDENCE = 0.6;

/**
 * The `title_version` supersedes edge for a version increment (#283).
 * `citationBacked: false` marks a pair linked only because the titles are
 * explicit versions of the same work and the years do not decrease
 * (theme builder's version-family pass): lower confidence and a rationale
 * that says the citation data lacks the link.
 */
export function titleVersionEdge(
  parent: LineagePaperLike | null | undefined,
  child: LineagePaperLike | null | undefined,
  options: { citationBacked?: boolean } = {},
): DerivedEdge {
  const citationBacked = options.citationBacked ?? true;
  const head =
    `「${slotFillTitle(child)}」(${slotFillYear(child)}) は` +
    `「${slotFillTitle(parent)}」(${slotFillYear(parent)}) の`;
  if (citationBacked) {
    return makeDerived(
      "supersedes",
      `${head}バージョンアップ版にあたり、命名パターンから置き換え (supersedes) と推定される。`,
      "title_version",
    );
  }
  return {
    relation: "supersedes",
    confidence: TITLE_VERSION_UNCITED_CONFIDENCE,
    rationale:
      `${head}次の版にあたる（題名が同じ研究の明示的な版番号で、発表年も後）。` +
      "引用データにこの引用は見当たらないが、命名から置き換え (supersedes) と推定される。",
    provenance: "title_version",
  };
}

/** True iff S2 intents fail to pick a key in `INTENT_RELATION_MAP`. */
export function isAmbiguous(intentRecord: Record<string, unknown>): boolean {
  const intentsRaw = intentRecord._intents;
  const intents = Array.isArray(intentsRaw) ? intentsRaw : [];
  const intentsSet = new Set(
    intents.filter((i) => typeof i === "string").map((i) => (i as string).toLowerCase()),
  );
  return INTENT_RELATION_MAP.every(([keyword]) => !intentsSet.has(keyword));
}
export { isAmbiguous as _is_ambiguous };

/**
 * Merge an LLM classification into an existing heuristic edge. Decision
 * matrix (#118 / #209 / 2026-06-05 followup):
 *   - `llmResult === null` AND heuristic rationale IS a template -> drop.
 *   - `llmResult === null` AND heuristic rationale is paper-specific -> keep.
 *   - `relation === "unrelated"` -> drop.
 *   - `confidence < MIN_LLM_CONFIDENCE` -> drop.
 *   - otherwise -> use LLM verbatim.
 */
export function applyLlmClassification(
  heuristic: DerivedEdge,
  llmResult: RelationClassification | null,
): DerivedEdge | null {
  if (llmResult === null) {
    const heuristicRationale = (heuristic.rationale ?? "").trim();
    if (TEMPLATE_RATIONALES_SET.has(heuristicRationale)) return null;
    return heuristic;
  }
  if (llmResult.relation === "unrelated") return null;
  if (Number(llmResult.confidence) < MIN_LLM_CONFIDENCE) return null;
  return llmDerived(llmResult);
}
export { applyLlmClassification as _apply_llm_classification };

/**
 * Build an edge from an LLM-only classification. Used when the heuristic
 * produced no signal — if the LLM didn't produce a confident, non-unrelated
 * result either, the edge is dropped entirely.
 */
export function buildEdgeFromLlm(llmResult: RelationClassification | null): DerivedEdge | null {
  if (llmResult === null) return null;
  if (llmResult.relation === "unrelated") return null;
  if (Number(llmResult.confidence) < MIN_LLM_CONFIDENCE) return null;
  return llmDerived(llmResult);
}
export { buildEdgeFromLlm as _build_edge_from_llm };

function makeDerived(relation: Relation, rationale: string, provenance: string): DerivedEdge {
  if (!VALID_PROVENANCES.has(provenance)) {
    throw new Error(
      `provenance=${provenance} not in VALID_PROVENANCES — see classify.ts's VALID_PROVENANCES`,
    );
  }
  return { relation, confidence: DERIVED_CONFIDENCE, rationale, provenance };
}

export { makeDerived as _make_derived };

// ===== Foundational-ancestor allowlist (#277) =====

const FOUNDATIONAL_ALLOWLIST_PATH = foundationalAllowlist(layoutFor(getRepoRoot()));
const FOUNDATIONAL_ALLOWLIST_CONFIDENCE = 0.65;

let cachedAllowlist: RegExp[] | null = null;

/** Compile title patterns once per process — the allowlist is tiny (~30 entries) and never mutated at runtime. */
function loadFoundationalAllowlist(): RegExp[] {
  if (cachedAllowlist !== null) return cachedAllowlist;
  let compiled: RegExp[] = [];
  try {
    const data = JSON.parse(readFileSync(FOUNDATIONAL_ALLOWLIST_PATH, "utf-8"));
    const patterns =
      (data && typeof data === "object"
        ? (data as Record<string, unknown>).title_patterns
        : null) ?? [];
    if (Array.isArray(patterns)) {
      compiled = patterns
        .filter((p): p is string => typeof p === "string" && p.trim().length > 0)
        .flatMap((p) => {
          try {
            return [new RegExp(p, "i")];
          } catch {
            return [];
          }
        });
    }
  } catch {
    compiled = [];
  }
  cachedAllowlist = compiled;
  return compiled;
}

/** True iff `parent` matches a title pattern in the foundational allowlist. */
export function isFoundationalAncestor(parent: LineagePaperLike | null | undefined): boolean {
  if (!parent || typeof parent !== "object") return false;
  const title = parent.title;
  if (typeof title !== "string" || !title.trim()) return false;
  return loadFoundationalAllowlist().some((pat) => pat.test(title));
}
export { isFoundationalAncestor as _is_foundational_ancestor };

/** Emit a stable extends edge for a foundational ancestor. The rationale
 * is Japanese and slot-filled like every other rule rationale (it used to
 * be a fixed English template); `child` is the citing paper, when known. */
export function foundationalAncestorEdge(
  parent: LineagePaperLike | null | undefined,
  child?: LineagePaperLike | null,
): DerivedEdge {
  const cited = `「${slotFillTitle(parent)}」(${slotFillYear(parent)})`;
  const rationale =
    child === undefined || child === null
      ? `${cited} は分野の基礎文献として登録されており、この系譜の祖先として拡張関係で残している（基礎文献リストに基づく規則）。`
      : `「${slotFillTitle(child)}」(${slotFillYear(child)}) は分野の基礎文献${cited}を引用しており、` +
        "その系譜に連なるものとして拡張関係で残している（基礎文献リストに基づく規則）。";
  return {
    relation: "extends",
    confidence: FOUNDATIONAL_ALLOWLIST_CONFIDENCE,
    rationale,
    provenance: "foundational_allowlist",
  };
}
export { foundationalAncestorEdge as _foundational_ancestor_edge };

// ===== Top-level entry point =====

export interface DeriveRelationOptions {
  parent?: LineagePaperLike | null;
  child?: LineagePaperLike | null;
  classifyRelation?: (
    a: ClassifyPaperLike,
    b: ClassifyPaperLike,
  ) => Promise<RelationClassification | null>;
  strictMode?: "off" | "ambiguous" | "all";
}

/**
 * Classify how the cited paper relates to the citing paper. TS port of
 * `derive_relation`. Heuristic path is the default; when `strictMode` is
 * `"ambiguous"` or `"all"`, the heuristic result is refined by a real LLM
 * classification via `options.classifyRelation`.
 */
export async function deriveRelation(
  intentRecord: Record<string, unknown>,
  options: DeriveRelationOptions = {},
): Promise<DerivedEdge | null> {
  const { parent = null, child = null, classifyRelation, strictMode = "off" } = options;

  if (intentRecord._is_influential === false) return null;

  const contextEdge = classifyFromContexts(intentRecord._contexts as readonly string[] | undefined);
  if (contextEdge !== null) return contextEdge;

  const heuristic = deriveRelationHeuristic(intentRecord, parent, child);

  // #277: foundational ancestor short-circuit, takes priority over the
  // heuristic (see Python's docstring for the two reasons). R2-16: only
  // when the record carries no citation evidence for the pair (no S2
  // intents, no contexts) — the allowlist admits a canonical ancestor, it
  // must not overwrite what the citing paper says about it.
  if (isFoundationalAncestor(parent) && !hasCitationEvidence(intentRecord)) {
    return foundationalAncestorEdge(parent, child);
  }

  // R2-16: LLM rationales name the papers by short title, not "A"/"B".
  const named = (edge: DerivedEdge | null): DerivedEdge | null =>
    edge !== null && edge.provenance === "llm"
      ? { ...edge, rationale: titleizeRationale(edge.rationale, parent, child) }
      : edge;

  if (heuristic === null) {
    if (strictMode === "off" || !classifyRelation) return null;
    const llmResult = await classifyRelation(parent ?? {}, child ?? {});
    return named(buildEdgeFromLlm(llmResult));
  }

  if (strictMode === "off" || !classifyRelation) return heuristic;
  if (strictMode === "ambiguous" && !isAmbiguous(intentRecord)) return heuristic;
  const llmResult = await classifyRelation(parent ?? {}, child ?? {});
  return named(applyLlmClassification(heuristic, llmResult));
}

/** True when an intent record carries citation evidence for the pair:
 * S2 intents or citation-context sentences (R2-16, allowlist rule). */
export function hasCitationEvidence(intentRecord: Record<string, unknown>): boolean {
  const nonEmpty = (v: unknown) =>
    Array.isArray(v) && v.some((x) => typeof x === "string" && x.trim().length > 0);
  return nonEmpty(intentRecord._intents) || nonEmpty(intentRecord._contexts);
}
export { deriveRelation as derive_relation };
