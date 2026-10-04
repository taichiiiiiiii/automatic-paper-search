/**
 * Layout/UI constants ported 1:1 from docs/assets/lineage.js (top of
 * file) and docs/assets/utils.js's edge-fan constants. Kept as plain
 * data so layout math (tree.ts / timeline.ts / edges.ts) and the view
 * model (view-model.ts) can both depend on them without duplicating
 * magic numbers. Values must stay byte-identical to the JS source --
 * test/lineage/graph/*.test.ts pin tree/timeline output against the
 * original lineage.js run under node:vm, and any drift here changes
 * both outputs the same way only if the numbers match.
 */
import type { Relation } from "../core";

export const NODE_W = 220;
export const NODE_H = 150;
export const LEVEL_GAP = 80;
export const SIBLING_GAP = 28;
export const PADDING = 40;
export const MAX_DEPTH = 3;

/** Relations lineage.js's `layoutTree` walks to build the genealogy
 * tree (parents/children). `baseline_only` and `contrasts` connect
 * nodes but are not genealogy, so they never participate in BFS depth
 * or positioning -- an edge can still be drawn between two nodes that
 * both became visible via genealogy edges. */
export const GENEALOGY = new Set<Relation>(["supersedes", "successor", "extends", "ablation"]);

export type LineageLayout = "topics" | "tree" | "timeline";
export type LineageView = "list" | "graph";

export const VALID_LAYOUTS = new Set<LineageLayout>(["topics", "tree", "timeline"]);

export const STORAGE_KEY = "pp.lineage.prefs";

/** Default layout on first visit -- Topics gives bird's-eye context
 * before asking the user to pick a paper to center the tree on. */
export const DEFAULT_LAYOUT: LineageLayout = "topics";

/** Footer copy per layout mode -- tells the user what clicking a card
 * does. Ported from lineage.js `FOOTER_HINT`. */
export const FOOTER_HINT: Record<LineageLayout, string> = {
  topics: "カードをクリック → その論文の家系図に遷移",
  tree: "カードをクリック → その論文を中心に家系図を再描画",
  timeline: "カードをクリック → 家系図モードでその論文にフォーカス",
};

export const LIST_FOOTER_HINT = "関係、確信度、根拠、生成 provenance を読み上げ可能な一覧で表示";

/** Japanese subtitles for common primary-tag cluster labels -- ported
 * from lineage.js `CLUSTER_SUBTITLE`. Unknown labels fall through to
 * "" so a new Stage-2 kind never needs a JS/TS change to display. */
export const CLUSTER_SUBTITLE: Record<string, string> = {
  LLM: "大規模言語モデル",
  Vision: "コンピュータビジョン",
  VLM: "視覚-言語モデル",
  MLLM: "マルチモーダル LLM",
  Diffusion: "拡散モデル",
  RL: "強化学習",
  SSL: "自己教師あり学習",
  Transformer: "Transformer 系アーキテクチャ",
  MoE: "Mixture of Experts",
  Medical: "医療応用",
  TimeSeries: "時系列",
  Theory: "理論",
  Optim: "最適化",
  Eval: "評価・ベンチマーク",
  uncategorized: "未分類",
};

/** CSS class suffix for a relation's marker/edge styling -- ported
 * from lineage.js `markerClass`. `baseline_only` draws as "baseline"
 * everywhere (marker id, edge class, label class) because the original
 * CSS/marker set predates the `baseline_only` relation name. */
export function markerClass(relation: Relation): string {
  return relation === "baseline_only" ? "baseline" : relation;
}
