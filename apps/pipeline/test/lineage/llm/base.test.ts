/**
 * Port of `paperpilot/tests/test_llm_base.py`.
 */
import { describe, expect, it } from "vitest";
import {
  buildClassifyPrompt,
  buildEvaluationPrompt,
  CLASSIFY_SYSTEM_PROMPT,
  type EvaluationPromptPaper,
  GENERIC_TEMPLATE_RATIONALES,
  MIN_RATIONALE_LEN,
  mapBatchEvaluations,
  paperEvaluationFromDict,
  providerModelTag,
  relationClassificationFromDict,
  TEMPLATE_RATIONALES,
} from "../../../src/lineage/llm/base.js";

function paper(overrides: Partial<EvaluationPromptPaper> = {}): EvaluationPromptPaper {
  return {
    title: "X",
    abstract: "",
    categories: [],
    venue: null,
    githubStars: 0,
    citationCount: 0,
    ...overrides,
  };
}

describe("paperEvaluationFromDict", () => {
  it("test_paper_evaluation_from_dict_ok", () => {
    const ev = paperEvaluationFromDict({
      relevance: 4,
      summary_ja: "要約",
      reason: "理由",
      tags: ["新手法"],
    });
    expect(ev).not.toBeNull();
    expect(ev?.relevance).toBe(4);
    expect(ev?.summaryJa).toBe("要約");
    expect(ev?.reason).toBe("理由");
    expect(ev?.tags).toEqual(["新手法"]);
  });

  it("test_paper_evaluation_invalid_relevance", () => {
    expect(paperEvaluationFromDict({ relevance: 0 })).toBeNull();
    expect(paperEvaluationFromDict({ relevance: 6 })).toBeNull();
    expect(paperEvaluationFromDict({ relevance: "x" })).toBeNull();
    expect(paperEvaluationFromDict({})).toBeNull();
  });

  it("test_paper_evaluation_infinite_relevance_does_not_raise", () => {
    expect(paperEvaluationFromDict({ relevance: Number.POSITIVE_INFINITY })).toBeNull();
    expect(paperEvaluationFromDict({ relevance: Number.NEGATIVE_INFINITY })).toBeNull();
  });

  it("test_paper_evaluation_non_dict", () => {
    expect(paperEvaluationFromDict("not a dict")).toBeNull();
    expect(paperEvaluationFromDict(null)).toBeNull();
  });

  it("test_paper_evaluation_tags_fallback", () => {
    const ev = paperEvaluationFromDict({ relevance: 3, tags: "not a list" });
    expect(ev).not.toBeNull();
    expect(ev?.tags).toEqual([]);
  });
});

describe("mapBatchEvaluations (#391)", () => {
  it("test_map_batch_evaluations_happy_path_in_order", () => {
    const parsed = [
      { index: 1, relevance: 5, summary_ja: "s1", reason: "r1", tags: [] },
      { index: 2, relevance: 2, summary_ja: "s2", reason: "r2", tags: [] },
    ];
    const result = mapBatchEvaluations(2, parsed);
    expect(result[0]?.relevance).toBe(5);
    expect(result[1]?.relevance).toBe(2);
  });

  it("test_map_batch_evaluations_reordered_response", () => {
    const parsed = [
      { index: 3, relevance: 1, summary_ja: "c", reason: "r", tags: [] },
      { index: 1, relevance: 5, summary_ja: "a", reason: "r", tags: [] },
      { index: 2, relevance: 3, summary_ja: "b", reason: "r", tags: [] },
    ];
    const result = mapBatchEvaluations(3, parsed);
    expect(result.map((e) => e?.summaryJa)).toEqual(["a", "b", "c"]);
  });

  it("test_map_batch_evaluations_missing_index_field_dropped", () => {
    const parsed = [{ relevance: 5, summary_ja: "a", reason: "r", tags: [] }];
    expect(mapBatchEvaluations(1, parsed)).toEqual([null]);
  });

  it("test_map_batch_evaluations_non_integer_index_dropped", () => {
    const parsed = [{ index: "one", relevance: 5, summary_ja: "a", reason: "r", tags: [] }];
    expect(mapBatchEvaluations(1, parsed)).toEqual([null]);
  });

  it("test_map_batch_evaluations_rejects_coercible_but_non_strict_int_indices", () => {
    for (const sneaky of [1.5, "1", true]) {
      const parsed = [{ index: sneaky, relevance: 5, summary_ja: "a", reason: "r", tags: [] }];
      expect(
        mapBatchEvaluations(1, parsed),
        `index ${JSON.stringify(sneaky)} incorrectly accepted`,
      ).toEqual([null]);
    }
  });

  it("test_map_batch_evaluations_rejects_index_that_would_overflow_int", () => {
    const parsed = [
      { index: Number.POSITIVE_INFINITY, relevance: 5, summary_ja: "a", reason: "r", tags: [] },
    ];
    expect(mapBatchEvaluations(1, parsed)).toEqual([null]);
  });

  it("test_map_batch_evaluations_out_of_range_index_dropped", () => {
    const parsed = [
      { index: 0, relevance: 5, summary_ja: "a", reason: "r", tags: [] },
      { index: 2, relevance: 4, summary_ja: "b", reason: "r", tags: [] },
    ];
    expect(mapBatchEvaluations(1, parsed)).toEqual([null]);
  });

  it("test_map_batch_evaluations_duplicate_index_rejected_entirely", () => {
    const parsed = [
      { index: 1, relevance: 5, summary_ja: "first", reason: "r", tags: [] },
      { index: 1, relevance: 1, summary_ja: "duplicate", reason: "r", tags: [] },
      { index: 2, relevance: 3, summary_ja: "b", reason: "r", tags: [] },
    ];
    const result = mapBatchEvaluations(2, parsed);
    expect(result[0]).toBeNull();
    expect(result[1]?.summaryJa).toBe("b");
  });

  it("test_map_batch_evaluations_duplicate_where_first_occurrence_is_invalid", () => {
    const parsed = [
      { index: 1, relevance: 99 },
      { index: 1, relevance: 5, summary_ja: "b", reason: "r", tags: [] },
    ];
    expect(mapBatchEvaluations(1, parsed)).toEqual([null]);
  });

  it("test_map_batch_evaluations_gap_leaves_none", () => {
    const parsed = [
      { index: 1, relevance: 5, summary_ja: "a", reason: "r", tags: [] },
      { index: 3, relevance: 2, summary_ja: "c", reason: "r", tags: [] },
    ];
    const result = mapBatchEvaluations(3, parsed);
    expect(result[0]?.summaryJa).toBe("a");
    expect(result[1]).toBeNull();
    expect(result[2]?.summaryJa).toBe("c");
  });

  it("test_map_batch_evaluations_non_list_input", () => {
    expect(mapBatchEvaluations(2, { not: "a list" })).toEqual([null, null]);
  });

  it("test_map_batch_evaluations_non_dict_elements_dropped", () => {
    expect(mapBatchEvaluations(1, ["not a dict"])).toEqual([null]);
  });

  it("test_map_batch_evaluations_infinite_relevance_does_not_drop_whole_batch", () => {
    const parsed = [
      { index: 1, relevance: Number.POSITIVE_INFINITY, summary_ja: "x", reason: "r", tags: [] },
      { index: 2, relevance: 4, summary_ja: "good", reason: "r", tags: [] },
    ];
    const result = mapBatchEvaluations(2, parsed);
    expect(result[0]).toBeNull();
    expect(result[1]?.summaryJa).toBe("good");
  });

  it("test_map_batch_evaluations_empty_papers", () => {
    expect(mapBatchEvaluations(0, [])).toEqual([]);
    expect(mapBatchEvaluations(0, [{ index: 1, relevance: 5 }])).toEqual([]);
  });
});

describe("buildEvaluationPrompt", () => {
  it("test_build_evaluation_prompt_contains_profile_and_papers", () => {
    const papers = [
      paper({
        title: "Paper A",
        abstract: "Abstract A content.",
        categories: ["cs.CL"],
        venue: "ICLR",
        githubStars: 100,
        citationCount: 42,
      }),
    ];
    const [system, user] = buildEvaluationPrompt(papers, "RAG research");
    expect(system).toContain("JSON配列");
    expect(user).toContain("RAG research");
    expect(user).toContain("Paper A");
    expect(user).toContain("ICLR");
  });

  it("test_build_prompt_fallback_profile_when_empty", () => {
    const [, user] = buildEvaluationPrompt([paper({ title: "X" })], "");
    expect(user).toContain("プロファイル未設定");
  });
});

describe("RelationClassification", () => {
  it("test_relation_classification_from_dict_ok", () => {
    const rationale = "論文 B は論文 A と同じ課題をより少ない計算量で改良している。";
    const rc = relationClassificationFromDict({
      relation: "supersedes",
      confidence: 0.82,
      rationale,
    });
    expect(rc).toEqual({ relation: "supersedes", confidence: 0.82, rationale });
  });

  it("test_relation_classification_from_dict_ignores_extra_model_key", () => {
    const rationale = "論文 B は論文 A と同じ課題をより少ない計算量で改良している。";
    const base = { relation: "extends", confidence: 0.7, rationale };
    const withModel = { ...base, model: "gemini:gemini-2.5-flash" };
    expect(relationClassificationFromDict(withModel)).toEqual(relationClassificationFromDict(base));
  });

  it("test_relation_classification_from_dict_legacy_entry_without_model", () => {
    const rationale = "論文 B は論文 A の注意機構を線形時間に近似している。";
    const rc = relationClassificationFromDict({
      relation: "successor",
      confidence: 0.6,
      rationale,
    });
    expect(rc?.relation).toBe("successor");
    expect(rc?.rationale).toBe(rationale);
  });

  it("test_relation_classification_rejects_invalid_relation", () => {
    expect(
      relationClassificationFromDict({ relation: "bogus", confidence: 0.5, rationale: "x" }),
    ).toBeNull();
    expect(relationClassificationFromDict({ confidence: 0.5 })).toBeNull();
    expect(relationClassificationFromDict(null)).toBeNull();
  });

  it("test_relation_classification_requires_rationale", () => {
    expect(
      relationClassificationFromDict({ relation: "extends", confidence: 0.6, rationale: "   " }),
    ).toBeNull();
  });

  it("test_min_rationale_len_constant_is_pinned", () => {
    expect(MIN_RATIONALE_LEN).toBe(10);
  });

  it("test_relation_classification_rejects_degenerate_short_rationales", () => {
    for (const bad of ["A", "QD", "VLLM", "Qwen2-VL", "CMA-ES", "VLM", "P-GenRM"]) {
      expect(
        relationClassificationFromDict({ relation: "extends", confidence: 0.85, rationale: bad }),
        `degenerate short rationale not rejected: ${bad}`,
      ).toBeNull();
    }
  });

  it("test_relation_classification_rejects_at_min_length_boundary", () => {
    const nine = "あいうえおかきくけ";
    expect(Array.from(nine).length).toBe(9);
    expect(
      relationClassificationFromDict({ relation: "extends", confidence: 0.7, rationale: nine }),
    ).toBeNull();
    const ten = `${nine}こ`;
    expect(Array.from(ten).length).toBe(10);
    expect(
      relationClassificationFromDict({ relation: "extends", confidence: 0.7, rationale: ten }),
    ).not.toBeNull();
  });

  it("test_relation_classification_accepts_normal_japanese_rationale", () => {
    const rc = relationClassificationFromDict({
      relation: "supersedes",
      confidence: 0.8,
      rationale:
        "論文 B は FlashAttention-2 として、論文 A と同じ exact attention のまま work partitioning を改良し二倍高速化している。",
    });
    expect(rc).not.toBeNull();
    expect(Array.from(rc?.rationale ?? "").length).toBeGreaterThanOrEqual(30);
  });

  it("test_relation_classification_clamps_confidence", () => {
    const rationale = "論文 B は論文 A と根本的に異なる定式化を採用している。";
    expect(
      relationClassificationFromDict({ relation: "contrasts", confidence: 1.7, rationale })
        ?.confidence,
    ).toBe(1.0);
    expect(
      relationClassificationFromDict({ relation: "contrasts", confidence: -0.3, rationale })
        ?.confidence,
    ).toBe(0.0);
  });

  it("H1: clamps a non-finite confidence the way CPython's max(0, min(1, x)) does, not JS's NaN-poisoning Math.max/min", () => {
    // Verified against real CPython: max(0.0, min(1.0, float("nan"))) ==
    // 1.0 (min(1.0, nan) keeps the first arg because `nan < 1.0` is
    // False; max(0.0, 1.0) then keeps 1.0 because `1.0 > 0.0` is True).
    // JS's `Math.max(0, Math.min(1, NaN))` is NaN in either argument
    // order — the bug this guards against.
    const rationale = "論文 B は論文 A と根本的に異なる定式化を採用している。";
    expect(
      relationClassificationFromDict({ relation: "contrasts", confidence: Number.NaN, rationale })
        ?.confidence,
    ).toBe(1.0);
    expect(
      relationClassificationFromDict({
        relation: "contrasts",
        confidence: "nan",
        rationale,
      })?.confidence,
    ).toBe(1.0);
    expect(
      relationClassificationFromDict({
        relation: "contrasts",
        confidence: Number.POSITIVE_INFINITY,
        rationale,
      })?.confidence,
    ).toBe(1.0);
    expect(
      relationClassificationFromDict({
        relation: "contrasts",
        confidence: Number.NEGATIVE_INFINITY,
        rationale,
      })?.confidence,
    ).toBe(0.0);
  });

  it("test_build_classify_prompt_contains_both_papers", () => {
    const a = { title: "AlphaNet", year: 2020, abstract: "First idea." };
    const b = { title: "BetaNet", year: 2024, abstract: "Improved version." };
    const [system, user] = buildClassifyPrompt(a, b);
    expect(system).toContain("supersedes");
    expect(user).toContain("AlphaNet");
    expect(user).toContain("BetaNet");
    expect(user).toContain("2020");
    expect(user).toContain("2024");
  });
});

describe("CLASSIFY_SYSTEM_PROMPT quality (#131)", () => {
  it("test_classify_prompt_demands_paper_specific_content", () => {
    const lower = CLASSIFY_SYSTEM_PROMPT.toLowerCase();
    const markers = [
      "specific",
      "concrete",
      "technical concept",
      "abstract",
      "paper-specific",
      "must reference",
      "must mention",
    ];
    expect(markers.some((m) => lower.includes(m))).toBe(true);
  });

  it("test_classify_prompt_forbids_template_phrasings", () => {
    const fragments = [
      "異なる領域・タスク・スケール",
      "研究ラインを継承",
      "ベースライン比較にのみ",
    ];
    const matched = fragments.filter((f) => CLASSIFY_SYSTEM_PROMPT.includes(f));
    expect(matched.length).toBeGreaterThanOrEqual(2);
  });

  it("test_classify_prompt_includes_good_examples", () => {
    expect(CLASSIFY_SYSTEM_PROMPT.toLowerCase()).toContain("example");
  });

  it("test_classify_prompt_defines_each_relation", () => {
    const fragments: Record<string, string> = {
      supersedes: "凌駕",
      ablation: "構成要素の寄与を分解測定",
      successor: "漸進",
      extends: "応用",
      baseline_only: "比較対象",
      contrasts: "根本的に異なる",
    };
    const missing = Object.entries(fragments).filter(
      ([, frag]) => !CLASSIFY_SYSTEM_PROMPT.includes(frag),
    );
    expect(missing).toEqual([]);
  });

  it("test_classify_prompt_has_supersedes_and_ablation_examples", () => {
    expect(["FlashAttention-2", "置き換え"].some((m) => CLASSIFY_SYSTEM_PROMPT.includes(m))).toBe(
      true,
    );
    expect(
      ["寄与を分解", "構成要素を取り除いて"].some((m) => CLASSIFY_SYSTEM_PROMPT.includes(m)),
    ).toBe(true);
  });

  it("test_classify_prompt_within_groq_tpm_budget", () => {
    expect(CLASSIFY_SYSTEM_PROMPT.length).toBeLessThanOrEqual(1200);
  });

  it("test_classify_prompt_invariants_still_hold", () => {
    const mustDemand = ["concrete", "specific", "abstract", "concept"];
    expect(mustDemand.some((m) => CLASSIFY_SYSTEM_PROMPT.toLowerCase().includes(m))).toBe(true);
    const templates = [
      "異なる領域・タスク・スケール",
      "研究ラインを継承",
      "ベースライン比較にのみ",
    ];
    expect(
      templates.filter((t) => CLASSIFY_SYSTEM_PROMPT.includes(t)).length,
    ).toBeGreaterThanOrEqual(2);
  });
});

describe("TEMPLATE_RATIONALES single source of truth (#145)", () => {
  it("test_template_rationales_is_source_of_truth_for_reject_set", () => {
    expect(new Set(Object.values(TEMPLATE_RATIONALES))).toEqual(GENERIC_TEMPLATE_RATIONALES);
  });

  it("test_relation_classification_rejects_known_template_rationale", () => {
    expect(
      relationClassificationFromDict({
        relation: "extends",
        confidence: 0.85,
        rationale: "論文 B は論文 A の手法を異なる領域・タスク・スケールに拡張している。",
      }),
    ).toBeNull();
  });

  it("test_relation_classification_rejects_all_known_templates", () => {
    for (const t of Object.values(TEMPLATE_RATIONALES)) {
      expect(
        relationClassificationFromDict({ relation: "extends", confidence: 0.7, rationale: t }),
        `template not rejected: ${t}`,
      ).toBeNull();
    }
  });

  it("test_relation_classification_keeps_paper_specific_rationale", () => {
    const rc = relationClassificationFromDict({
      relation: "extends",
      confidence: 0.85,
      rationale:
        "論文 B のグラフ畳み込み層は、論文 A のスペクトル法を空間領域に再定式化し計算量を O(E) に落としている。",
    });
    expect(rc?.relation).toBe("extends");
    expect(rc?.rationale).toContain("O(E)");
  });
});

describe("providerModelTag (#310)", () => {
  it("test_provider_model_tag_falls_back_to_name_without_model", () => {
    expect(providerModelTag({ name: "nomodel" })).toBe("nomodel");
  });

  it("test_provider_model_tag_unknown_name_when_absent", () => {
    expect(providerModelTag({})).toBe("unknown");
  });

  it("test_provider_model_tag_with_model", () => {
    expect(providerModelTag({ name: "gemini", model: "gemini-2.5-flash" })).toBe(
      "gemini:gemini-2.5-flash",
    );
  });
});
