/**
 * Port of `paperpilot/tests/test_lineage_edge_provenance.py`,
 * `test_lineage_slotfill_rationale.py`, and the non-`build_deep_lineage`
 * portions of `test_lineage_classify_dead_paths.py`.
 */

import { describe, expect, it } from "vitest";
import type { RelationClassification } from "../../../src/collect/llm/provider.js";
import { classifyS2Pair } from "../../../src/lineage/classify/apiRelations.js";
import {
  _INTENT_RELATION_MAP,
  applyLlmClassification,
  buildEdgeFromLlm,
  classifyFromContexts,
  deriveRelation,
  deriveRelationHeuristic,
  foundationalAncestorEdge,
  isAmbiguous,
  slotFillRationale,
  _TEMPLATE_RATIONALES_SET as TEMPLATE_RATIONALES_SET,
  VALID_PROVENANCES,
} from "../../../src/lineage/classify/classify.js";
import { MIN_RATIONALE_LEN } from "../../../src/lineage/llm/base.js";
import { ruleEdge } from "../../../src/lineage/theme/s2Relations.js";

function rc(
  relation: RelationClassification["relation"] = "extends",
  confidence = 0.8,
  rationale = "paper-specific reason",
): RelationClassification {
  return { relation, confidence, rationale };
}

// ---------------------------------------------------------------------
// Provenance (test_lineage_edge_provenance.py)
// ---------------------------------------------------------------------

describe("provenance", () => {
  it("test_make_derived_intent_map_sets_intent_map_provenance", () => {
    const result = deriveRelationHeuristic({ _intents: ["methodology"] });
    expect(result?.provenance).toBe("intent_map");
  });

  it("test_year_cite_contrast_sets_year_cite_provenance", () => {
    const parent = { year: 2019, citationCount: 0 };
    const child = { year: 2021, citationCount: 0 };
    const result = deriveRelationHeuristic({}, parent, child);
    expect(result?.provenance).toBe("year_cite");
  });

  it("test_classify_from_contexts_sets_context_pattern_provenance", () => {
    const result = classifyFromContexts(["we extend [12] to handle cross-lingual tasks"]);
    expect(result?.provenance).toBe("context_pattern");
  });

  it("test_foundational_ancestor_edge_sets_foundational_allowlist_provenance", () => {
    const result = foundationalAncestorEdge({ title: "Attention Is All You Need" });
    expect(result.provenance).toBe("foundational_allowlist");
  });

  it("test_build_edge_from_llm_sets_llm_provenance", () => {
    const result = buildEdgeFromLlm(rc("extends", 0.85));
    expect(result?.provenance).toBe("llm");
  });

  it("test_apply_llm_classification_overrides_heuristic_sets_llm_provenance", () => {
    const heuristic = {
      relation: "extends" as const,
      confidence: 0.7,
      rationale: "paper-specific heuristic rationale from context",
      provenance: "context_pattern",
    };
    const result = applyLlmClassification(
      heuristic,
      rc("successor", 0.9, "paper-specific LLM reason"),
    );
    expect(result?.provenance).toBe("llm");
  });

  it("test_apply_llm_classification_llm_none_keeps_heuristic_provenance", () => {
    const heuristic = {
      relation: "extends" as const,
      confidence: 0.7,
      rationale: "we extend [12] to multimodal settings, adding a cross-modal encoder.",
      provenance: "context_pattern",
    };
    const result = applyLlmClassification(heuristic, null);
    expect(result?.provenance).toBe("context_pattern");
  });

  it("test_derive_relation_end_to_end_persists_provenance", async () => {
    const result = await deriveRelation({ _intents: ["methodology"] });
    expect(result).not.toBeNull();
    expect(VALID_PROVENANCES.has(result?.provenance ?? "")).toBe(true);
  });

  it("test_provenance_enum_is_closed_set", () => {
    const expected = new Set([
      "context_pattern",
      "intent_map",
      "year_cite",
      "title_version",
      "foundational_allowlist",
      "llm",
      "s2_context_rule",
    ]);
    expect(VALID_PROVENANCES).toEqual(expected);

    const collected = new Set<string>();
    collected.add(
      classifyFromContexts(["we extend [12] by adding a visual encoder"])?.provenance ?? "",
    );
    collected.add(deriveRelationHeuristic({ _intents: ["methodology"] })?.provenance ?? "");
    collected.add(
      deriveRelationHeuristic(
        {},
        { year: 2018, citationCount: 0 },
        { year: 2021, citationCount: 0 },
      )?.provenance ?? "",
    );
    collected.add(foundationalAncestorEdge({ title: "Attention Is All You Need" }).provenance);
    collected.add(buildEdgeFromLlm(rc("extends", 0.85))?.provenance ?? "");
    collected.add(
      deriveRelationHeuristic(
        { _intents: [] },
        { title: "FlashAttention", year: 2022 },
        { title: "FlashAttention-2", year: 2023 },
      )?.provenance ?? "",
    );
    // R2-10: the Semantic Scholar context rule path (theme/s2Relations.ts).
    const s2Signals = {
      found: true,
      intents: [],
      contexts: ["We build on the GCN layer [4]."],
      isInfluential: true,
    };
    collected.add(
      ruleEdge(
        classifyS2Pair(s2Signals),
        s2Signals,
        { srcId: "a", dstId: "b" },
        { title: "GCN", year: 2017 },
        { title: "GAT", year: 2018 },
      )?.provenance ?? "",
    );
    expect(collected).toEqual(expected);
  });
});

// ---------------------------------------------------------------------
// Slot-fill rationale (#300, test_lineage_slotfill_rationale.py)
// ---------------------------------------------------------------------

const PARENT = { title: "Deep Residual Learning for Image Recognition", year: 2015 };
const CHILD = {
  title: "An Image is Worth 16x16 Words: Transformers for Image Recognition",
  year: 2020,
};

describe("slotFillRationale", () => {
  it("test_slot_fill_successor_embeds_both_titles_and_years", () => {
    const out = slotFillRationale("successor", PARENT, CHILD);
    expect(out).toContain("Deep Residual Learning");
    expect(out).toContain("An Image is Worth 16x16 Words");
    expect(out).toContain("2015");
    expect(out).toContain("2020");
    expect(TEMPLATE_RATIONALES_SET.has(out)).toBe(false);
    expect(Array.from(out).length).toBeGreaterThanOrEqual(MIN_RATIONALE_LEN);
  });

  it("test_slot_fill_contrasts_embeds_both_titles", () => {
    const out = slotFillRationale("contrasts", PARENT, CHILD);
    expect(out).toContain("Deep Residual Learning");
    expect(out).toContain("An Image is Worth 16x16 Words");
    expect(TEMPLATE_RATIONALES_SET.has(out)).toBe(false);
  });

  it("test_slot_fill_intent_extends_names_the_intent", () => {
    const out = slotFillRationale("extends", PARENT, CHILD, "methodology");
    expect(out).toContain("手法");
    expect(TEMPLATE_RATIONALES_SET.has(out)).toBe(false);
  });

  it("test_slot_fill_intent_generic_relation_still_names_intent", () => {
    const out = slotFillRationale("successor", PARENT, CHILD, "result");
    expect(out).toContain("結果");
    expect(TEMPLATE_RATIONALES_SET.has(out)).toBe(false);
  });

  it("test_slot_fill_intent_unknown_keyword_passes_through_verbatim", () => {
    const out = slotFillRationale("successor", PARENT, CHILD, "some_future_keyword");
    expect(out).toContain("some_future_keyword");
  });

  it("test_slot_fill_truncates_long_titles", () => {
    const longParent = { title: "X".repeat(200), year: 2019 };
    const longChild = { title: "Y".repeat(200), year: 2021 };
    const out = slotFillRationale("successor", longParent, longChild);
    expect(out).not.toContain("X".repeat(70));
    expect(out).not.toContain("Y".repeat(70));
  });

  it("test_slot_fill_missing_parent_title_falls_back_gracefully", () => {
    const out = slotFillRationale("successor", { year: 2020 }, CHILD);
    expect(out).toBeTruthy();
    expect(TEMPLATE_RATIONALES_SET.has(out)).toBe(false);
    expect(Array.from(out).length).toBeGreaterThanOrEqual(MIN_RATIONALE_LEN);
  });

  it("test_slot_fill_both_titles_missing_still_non_template", () => {
    const out = slotFillRationale("contrasts", null, null);
    expect(out).toBeTruthy();
    expect(TEMPLATE_RATIONALES_SET.has(out)).toBe(false);
  });

  it("test_slot_fill_never_emits_a_template_member", () => {
    const relations = ["successor", "contrasts", "extends", "baseline_only", "supersedes"] as const;
    const intents = [undefined, "methodology", "result", "background"];
    for (const relation of relations) {
      for (const intent of intents) {
        const out = slotFillRationale(relation, PARENT, CHILD, intent);
        expect(TEMPLATE_RATIONALES_SET.has(out)).toBe(false);
      }
    }
  });
});

describe("deriveRelationHeuristic — slot-filled", () => {
  it("test_heuristic_year_cite_successor_embeds_titles_and_years", () => {
    const parent = { title: "ResNet", year: 2015, citationCount: 1000 };
    const child = { title: "Vision Transformer", year: 2020, citationCount: 800 };
    const rel = deriveRelationHeuristic({ _intents: [] }, parent, child);
    expect(rel?.relation).toBe("successor");
    expect(rel?.provenance).toBe("year_cite");
    expect(rel?.rationale).toContain("ResNet");
    expect(rel?.rationale).toContain("Vision Transformer");
    expect(rel?.rationale).toContain("2015");
    expect(rel?.rationale).toContain("2020");
  });

  it("falls through a falsy camelCase citationCount to the snake_case alias, matching Python's `or` chain", () => {
    // Python: `parent.get("citationCount") or parent.get("citation_count") or 0`
    // is an `or` chain, not a "first defined" chain — a present-but-falsy
    // `citationCount: 0` must fall through to `citation_count`, the same
    // way a `??` chain would NOT (since `0` is neither null nor undefined).
    const parent = { title: "BERT", year: 2018, citationCount: 0, citation_count: 500 };
    const child = { title: "RoBERTa", year: 2018, citationCount: 0, citation_count: 600 };
    const rel = deriveRelationHeuristic({ _intents: [] }, parent, child);
    expect(rel?.relation).toBe("contrasts");
    expect(rel?.provenance).toBe("year_cite");
  });

  it("test_heuristic_year_cite_contrasts_embeds_titles", () => {
    const parent = { title: "BERT", year: 2018, citationCount: 500 };
    const child = { title: "RoBERTa", year: 2018, citationCount: 600 };
    const rel = deriveRelationHeuristic({ _intents: [] }, parent, child);
    expect(rel?.relation).toBe("contrasts");
    expect(rel?.provenance).toBe("year_cite");
    expect(rel?.rationale).toContain("BERT");
    expect(rel?.rationale).toContain("RoBERTa");
  });

  it("test_heuristic_intent_map_match_embeds_titles_and_names_intent", () => {
    const parent = { title: "Word2Vec", year: 2013 };
    const child = { title: "GloVe", year: 2014 };
    const rel = deriveRelationHeuristic({ _intents: ["methodology"] }, parent, child);
    expect(rel?.relation).toBe("extends");
    expect(rel?.provenance).toBe("intent_map");
    expect(rel?.rationale).toContain("Word2Vec");
    expect(rel?.rationale).toContain("GloVe");
    expect(rel?.rationale).toContain("手法");
  });

  it("test_heuristic_intent_map_without_parent_child_degrades_gracefully", () => {
    const rel = deriveRelationHeuristic({ _intents: ["methodology"] });
    expect(rel?.relation).toBe("extends");
    expect(rel?.provenance).toBe("intent_map");
    expect(rel?.rationale).toBeTruthy();
    expect(Array.from(rel?.rationale ?? "").length).toBeGreaterThanOrEqual(MIN_RATIONALE_LEN);
  });

  it("test_heuristic_no_signal_still_returns_none", () => {
    expect(deriveRelationHeuristic({ _intents: [] })).toBeNull();
    const parent = { title: "Old", year: 2010, citationCount: 200 };
    const child = { title: "New", year: 2024, citationCount: 50 };
    expect(deriveRelationHeuristic({ _intents: [] }, parent, child)).toBeNull();
  });
});

describe("the collapse fix (#300): heuristic edge + LLM=null survives", () => {
  it("test_heuristic_edge_with_llm_none_now_survives_apply_classification", () => {
    const parent = { title: "ResNet", year: 2015, citationCount: 1000 };
    const child = { title: "Vision Transformer", year: 2020, citationCount: 800 };
    const heuristic = deriveRelationHeuristic({ _intents: [] }, parent, child);
    expect(heuristic).not.toBeNull();
    const kept = applyLlmClassification(heuristic!, null);
    expect(kept).not.toBeNull();
    expect(kept?.relation).toBe("successor");
    expect(kept?.rationale).toContain("ResNet");
    expect(kept?.rationale).toContain("Vision Transformer");
  });

  it("test_intent_map_edge_with_llm_none_now_survives", () => {
    const parent = { title: "Word2Vec", year: 2013 };
    const child = { title: "GloVe", year: 2014 };
    const heuristic = deriveRelationHeuristic({ _intents: ["methodology"] }, parent, child);
    expect(heuristic).not.toBeNull();
    const kept = applyLlmClassification(heuristic!, null);
    expect(kept?.relation).toBe("extends");
    expect(kept?.rationale).toContain("Word2Vec");
  });

  it("test_template_reject_backstop_still_active_for_literal_template", async () => {
    const { TEMPLATE_RATIONALES } = await import("../../../src/lineage/llm/base.js");
    const legacyTemplateEdge = {
      relation: "successor" as const,
      confidence: 0.7,
      rationale: TEMPLATE_RATIONALES.successor_result as string,
      provenance: "year_cite",
    };
    expect(applyLlmClassification(legacyTemplateEdge, null)).toBeNull();
  });
});

// ---------------------------------------------------------------------
// #283 dead-path removal regressions (test_lineage_classify_dead_paths.py)
// ---------------------------------------------------------------------

describe("#283 dead heuristic emit paths removal", () => {
  it("test_intent_map_no_longer_contains_background_baseline_only", () => {
    const keywords = new Set(_INTENT_RELATION_MAP.map(([kw]) => kw));
    expect(keywords.has("background")).toBe(false);
  });

  it("test_intent_map_keeps_alive_entries", () => {
    const mapping = new Map(_INTENT_RELATION_MAP.map(([kw, rel]) => [kw, rel]));
    expect(mapping.get("methodology")).toBe("extends");
    expect(mapping.get("result")).toBe("successor");
  });

  it("test_intent_only_background_returns_none", () => {
    expect(deriveRelationHeuristic({ _intents: ["background"] })).toBeNull();
  });

  it("test_background_intent_is_ambiguous_post_removal", () => {
    expect(isAmbiguous({ _intents: ["background"] })).toBe(true);
    expect(isAmbiguous({ _intents: ["methodology"] })).toBe(false);
    expect(isAmbiguous({ _intents: ["result"] })).toBe(false);
  });

  it("test_year_cite_does_not_emit_supersedes", () => {
    const parent = { year: 2015, citationCount: 500 };
    const child = { year: 2020, citationCount: 5000 };
    const rel = deriveRelationHeuristic({ _intents: [] }, parent, child);
    expect(rel === null || rel.relation !== "supersedes").toBe(true);
  });

  it("test_year_cite_does_not_emit_ablation", () => {
    const parent = { year: 2018, citationCount: 5000 };
    const child = { year: 2019, citationCount: 30 };
    const rel = deriveRelationHeuristic({ _intents: [] }, parent, child);
    expect(rel?.relation).toBe("successor");
  });

  it("test_year_cite_still_emits_contrasts", () => {
    const parent = { title: "ParentNet", year: 2020, citationCount: 500 };
    const child = { title: "ChildNet", year: 2020, citationCount: 600 };
    const rel = deriveRelationHeuristic({ _intents: [] }, parent, child);
    expect(rel?.relation).toBe("contrasts");
    expect(TEMPLATE_RATIONALES_SET.has(rel?.rationale ?? "")).toBe(false);
    expect(rel?.rationale).toContain("ParentNet");
    expect(rel?.rationale).toContain("ChildNet");
  });

  it("test_year_cite_still_emits_successor", () => {
    const parent = { year: 2019, citationCount: 100 };
    const child = { year: 2021, citationCount: 150 };
    const rel = deriveRelationHeuristic({ _intents: [] }, parent, child);
    expect(rel?.relation).toBe("successor");
  });
});
