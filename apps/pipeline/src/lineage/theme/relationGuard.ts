/**
 * Post-classification relation guard (R2-2d, design doc 40).
 *
 * `contrasts` means "both papers propose competing methods for the same
 * task". The LLM over-assigns it whenever two papers look different —
 * e.g. "signal processing on graphs" contrasts "A Comprehensive Survey on
 * GNNs", or a pets dataset contrasts the ViT paper. A survey/review only
 * organises the works it cites, and a dataset/benchmark paper is only
 * evaluated on, so neither can propose a competing method: such a
 * `contrasts` is rewritten to `baseline_only` (cited without intellectual
 * inheritance). Every other classification passes through unchanged.
 *
 * The edge keeps its classification provenance (`llm`, prompt version,
 * evidence hash of the prompt actually sent); the rationale says that the
 * relation was corrected and why, so a reviewer can tell the two apart.
 */

import type { DerivedEdge } from "../classify/classify.js";
import { looksLikeDataset, type TopicPaperLike } from "./topicScope.js";

/** "A Survey on ...", "...: A Comprehensive Review", "An Overview of ...",
 * "Towards X in LLMs: A Critical Review", "... Tutorial". Whole words, so
 * "reviewer" / "reviewing" do not match. */
const SURVEY_LIKE_TITLE_RE =
  /\b(?:survey|surveys|review|overview|tutorial|primer|literature\s+review|systematic\s+review)\b/i;

export function isSurveyLike(paper: TopicPaperLike | null | undefined): boolean {
  if (!paper || typeof paper !== "object") return false;
  const title = paper.title;
  return typeof title === "string" && SURVEY_LIKE_TITLE_RE.test(title);
}

/** Highest confidence a corrected edge may carry: the classifier was
 * wrong about the kind of relation, so it should not look certain. */
export const GUARDED_RELATION_MAX_CONFIDENCE = 0.6;

const MAX_RATIONALE_CODEPOINTS = 200;

function why(parent: TopicPaperLike, child: TopicPaperLike): string | null {
  if (isSurveyLike(parent) || isSurveyLike(child)) return "サーベイ/レビュー論文";
  if (looksLikeDataset(parent) || looksLikeDataset(child)) return "データセット/ベンチマーク論文";
  return null;
}

/** Rewrite a `contrasts` whose endpoint is a survey/review or a
 * dataset/benchmark paper to `baseline_only`; pass everything else. */
export function guardRelation(
  classification: DerivedEdge,
  parent: TopicPaperLike,
  child: TopicPaperLike,
): DerivedEdge {
  if (classification.relation !== "contrasts") return classification;
  const kind = why(parent, child);
  if (kind === null) return classification;
  const note = `${kind}が端点のため contrasts を baseline_only に補正（競合手法の対比ではない）。`;
  const original = String(classification.rationale ?? "").trim();
  const rationale = [...`${note}${original ? ` 元の判定: ${original}` : ""}`]
    .slice(0, MAX_RATIONALE_CODEPOINTS)
    .join("");
  return {
    ...classification,
    relation: "baseline_only",
    confidence: Math.min(classification.confidence, GUARDED_RELATION_MAX_CONFIDENCE),
    rationale,
  };
}
