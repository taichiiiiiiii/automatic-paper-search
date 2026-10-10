# 45. 系譜の 2 人目の審査とサイトの使い勝手の点検（2026-10-10）

- 位置づけ: 記録。2026-10-10 時点で公開していた 4 テーマ（GNN・MoE・ViT・Flash Attention）を 2 人目として審査した結果と、本番サイトの点検結果
- ここで見つかった問題の多くは、同じ日に R2-16〜R2-20 で直した（[41](41-lineage-publication-and-reliability.md) の実装メモ）。成果物はその後作り直したので、下の表の数字は当時のもの
- 元の作業ファイル（審査の下書き・スクリーンショット）は一時領域に置いていたため残していない

## 1. 審査の要約（当時）

# R2 second review of the 4 published theme lineages (2026-10-10)

Inputs: `data/published/themes/*/lineage.json` on develop (repo untouched). Fixture drafts were dry-run through the real `buildLineageQualityCli` (output: `dryrun-quality.json`, placeholders swapped for a dummy reviewer/time).

| theme | nodes / edges | off-topic (sample) | strong edges: correct / wrong | other flagged edges (wrong or doubtful) | dry-run golden_fixture | verdict |
|---|---|---|---|---|---|---|
| graph-neural-network | 13 / 40 | 0/13 = 0% (LINE, 2× graph-signal-processing borderline) | 1 supersedes: 1 / 0 | 6: survey_citing_extends 5, survey_citing_successor 1 (+1 info: year_inversion) | passed | Can be audited as-is. Regeneration recommended: 7/13 nodes are surveys, the only seed is a survey, core GNN method papers are missing, and 6 visible edges are wrong |
| mixture-of-experts | 10 / 13 | 0/10 = 0% | none | 0 (+1 info: multi_citation_quote) | passed | Can be audited as-is. Low value: all 13 edges are baseline_only and form a star around one survey seed; Shazeer 2017, GShard, Switch, GLaM and Mixtral are missing. Regenerate with method seeds |
| vision-transformer | 18 / 52 | 2/18 = 11.1% (SwinNet, ConvNeXt) | 3 (2 contrasts, 1 supersedes): 1 / 2 | 15: protocol_follow_as_extends 3, multi_citation 2, heuristic_dubious 2, survey_citing_extends 1, generic_intro_extends 1, comparison_as_extends 1, ablation_as_extends 1, direction_reversed/cycle 1, missed_version 1, under_classified 1, heuristic_wrong 1 (+1 info: rationale_quote_mismatch) | FAILED (off-topic rate + 2 wrong contrasts) | Needs regeneration: both contrasts are wrong and the off-topic rate is over the bar by one node |
| flash-attention | 4 / 4 | 1/4 = 25% (EfficientViT, borderline) | 3 supersedes: 3 / 0 | 0 (+1 info: rationale_quote_mismatch) | FAILED (off-topic rate) | Needs regeneration: the graph is too thin, so one borderline node breaks the 10% bar. FA-1 also has the wrong abstract (an OpenAlex error) and an unofficial GitHub repo |

See the per-theme `*.audit-draft.md` files for node-by-node and edge-by-edge reasons.

## 2. 生成の誤りの傾向

# Systematic error patterns (feed for generator fixes)

1. **A review as the citing side of `extends`/`successor`** (GNN ×6, ViT ×1). Examples: GNN-2008 → "Geometric Deep Learning: Going beyond Euclidean data" (an IEEE SPM review), the 4 edges into "GNNs for materials science and chemistry", and ViT → "Transformers in Vision: A Survey" (an allowlist edge).
   - Causes: survey detection only reads the TITLE; the prompt (`llm/base.ts` ~l.367) explicitly allows "サーベイ/レビューなら baseline_only か extends"; `foundational_allowlist` edges skip `relationGuard`.
   - Fix: detect reviews from the abstract, venue (*Surveys*, *Signal Processing Magazine*, Comm. Surveys & Tutorials) and S2 `publicationTypes=Review`. In `relationGuard`, demote ANY relation except baseline_only when the citing side (dst) is a review, and apply it to allowlist/heuristic edges too. Drop "or extends" from the prompt.
2. **Unsupported `contrasts` from the abstract-only LLM** (ViT 2/2 wrong). T2T→Swin and ViViT→SwinV2 have empty S2 contexts; the LLM called "a different way to improve ViT" or "same Kinetics benchmark" a contrast.
   - Fix: forbid `contrasts` without a contrast cue in an S2 context (or force baseline_only when contexts are empty), and require the same task with an opposing design (CNN vs Transformer), not two variants of the same family.
3. **`s2_context_rule` → `extends` from non-methodological sentences** (ViT 8 edges). The rule fires on intent=methodology or a "follow" cue, but the sentences are:
   - an experimental protocol ("we follow [30,47] and train Semantic FPN 80k", "follow [1] using 4×3 views", "follow the LR schedule of PVT");
   - a comparison ("outperforming PVT-Small [34], T2T-ViT…"): the same quote gave baseline_only for T2T→CvT but extends for PVT→CvT;
   - a generic intro listing many refs ("Built upon the success of ViT … [8,8,10,13,…]");
   - an ablation ("we also try … in [11]").
   - Fix: add negative cues (train/schedule/iterations/batch/views/crop/evaluation protocol/"for fair comparison"/outperform/surpass) that map to baseline_only. Treat sentences with ≥3 bracketed refs as background unless the cited paper is named in the sentence. Key the rule per sentence on the cited reference number, not per paper.
4. **Rationale quote does not mention the cited paper** (FA→EfficientViT quotes the MobileViT/ONNX sentence; Swin→SwinIR quotes a figure caption; T2T→SwinNet quotes "ViT [66]"). The generator quotes the last or first context rather than the one that drove the decision.
   - Fix: choose the quote that triggered the rule. Prefer sentences where the cited paper's ref marker or name appears, and say "no specific context" instead of quoting an unrelated sentence.
5. **Version detection misses** (ViT: PVT → "PVT v2" got successor 0.4 from the heuristic). `title_version` only matches identical name stems plus `-2`/`V2`, so an acronym vs a full name ("Pyramid Vision Transformer" vs "PVT v2") is missed.
   - Fix: match the acronym and the expansion as one name stem (author overlap ≥2 plus "v2/V2/++" in the title), then emit supersedes.
6. **Reversed direction and 2-cycles from revised preprints** (ViT: PVT v2 → PVT, baseline_only, alongside PVT → PVT v2). S2's record for PVT is a later revision that cites PVTv2 ("we recently propose PVTv2"). GNN shows the same effect as a year inversion (2020 survey → 2019 survey, via the arXiv version).
   - Fix: drop an edge when citing.year < cited.year by ≥1, or when the reverse edge exists. Keep the older→newer direction and log the case.
7. **Under-classification of real extensions** (Swin → Video Swin is baseline_only "uses data/code" although the quote says "our architecture is adapted from Swin Transformer"). The S2 intent overrode an explicit adaptation cue.
   - Fix: let "adapted from / built upon / based on <name>" cues outrank the resultUsage intent.
8. **The citation heuristic is still visible** (5 edges: GNN 1, ViT 4). Swin → ConvNeXt `successor` is the opposite of the truth (ConvNeXt competes with Swin), and Video Swin → SwinV2 and Swin → PVTv2 are doubtful.
   - Fix: render `citation_heuristic` edges as "unclassified" (never successor) or run the context LLM on them. They stay under the 20% gate, but users still see them.
9. **The foundational allowlist blankets a whole theme** (ViT: 14/52 edges are allowlist `extends` 0.65 from ViT to every node, including the survey and downstream apps). This overrides S2 evidence and dominates the histogram.
   - Fix: use the allowlist only to admit the node or as a tie-breaker. Take the relation from S2/LLM evidence, and never emit allowlist extends into reviews.
10. **Survey-only seeds make survey-centric, low-value graphs** (GNN: the single seed is a survey and 7/13 nodes are reviews; MoE: the single seed is a survey, all 13 edges are baseline_only in a star, and the classic MoE line is missing).
    - Fix: require ≥1 method-paper seed per theme (search filter excluding reviews, or a canonical seed list in config), down-weight a review as root, and add a quality check (e.g. `review_share ≤ 30%` and `lineage_relation_share > 0`).
11. **Off-topic downstream/app papers and counter-papers** (ViT: SwinNet as an app using the Swin backbone, ConvNeXt as a pure CNN; FA: EfficientViT, a vision architecture citing FA as background). The embedding+term gate admits them because their titles contain the theme terms (Swin/Transformer/Memory-Efficient).
    - Fix: penalise "<X> drives/for/with <task>" application titles, and require the theme concept to be the subject of the abstract (a z-score on the abstract, not only the title).
12. **Thin graphs on the OpenAlex-seed path** (FA: 4 nodes, so one borderline node = 25% off-topic). The FA predecessors (Rabe & Staats 2021, online softmax 2018) and successors (Flash-Decoding, PagedAttention, Ring Attention) are absent.
    - Fix: let the BFS ancestor step read the S2 references when OpenAlex `referenced_works` is empty (the R2-13 remaining gap). Add a theme_min_nodes gate (e.g. ≥10) so tiny graphs cannot pass a 10% sample bar only by luck.
13. **Wrong node metadata from upstream** (FA-1's abstract is a different document, a note on FA-2 rounding error that OpenAlex W4281758439 itself carries; FA-1's GitHub is the unofficial `xrsrke/flashattention` with 5★; DINO → `YeongHyeon/DINO_MNIST-PyTorch`; ViViT → an unofficial port; the IJCNN 2005 GNN paper is dated 2006).
    - Fix: check title↔abstract embedding similarity and fall back to the S2/arXiv abstract. Prefer GitHub repos linked from the paper (S2/PapersWithCode official flag) over name search, and reject repos with < N stars or an owner mismatch.

## 3. 本番サイトの点検（当時）

# PaperPilot R2 UX review (live https://paperpilot.pages.dev, 2026-10-10, read-only)

## Prioritized issues
P0-1 Evidence hidden by default. `比較`(baseline_only) and `対立` chips are off on first load (DEFAULT_RELATIONS, apps/web/lib/themes-tree.ts:44). Under D6, every S2 background/uses_resource/compares_with relation maps to baseline_only, so most of the quoted-sentence edges are hidden: MoE shows 0 of 13 edges (moe-default-no-edges.png), GNN 8/40, VIT 34/52 (the visible ones are mostly the 14 English allowlist edges), FA 3/4. Nothing on screen says edges are hidden; the "絞り込み中" chip only appears after the user toggles something. Fix: include baseline_only in the defaults (at least when it is >50% of edges or the visible count would be <5), or show "N 件の関係を非表示中" with a one-click show-all.
P0-2 Rationale/citation not readable. The edge tooltip is 260x110 px with line-clamp-3 (LineageTree.tsx:1083-1096). Rationales run 150–421 chars, so the `引用文: "…"` part is always cut off (VIT tooltip clipped=true, vit-edge-tooltip.png). Edges are 1–2 px lines, often overlapping, and hover-only. Touch/375px users can't reach a rationale at all, and tapping a card opens arXiv in a new tab. No relation list exists on /themes/. Fix: click/tap an edge to open a pinned panel or dialog showing the full rationale, the quote as a blockquote, the method (S2 rule / LLM / title pattern / allowlist), the source/target titles and a link to S2. Also add a "関係の一覧" list under the graph (reuse components/lineage/relation-list.tsx).
P1-3 "🟢 高品質" sits right under the "未監査（自動生成）" badge on every gallery card (ThemeGallery.tsx:86-93, lib/themes-gallery.ts:57). It reads as a quality endorsement and undercuts D1's caveat. It is really template_ratio telemetry, and its tooltip is the English "template_ratio=…". Fix: drop it for unaudited tiers, or rename it (e.g. "根拠: 論文ごと") and keep it out of the badge area.
P1-4 Internal/English rationales leak to users. All 14 VIT foundational_allowlist edges say "…is a canonical research-lineage ancestor and is preserved here as a direct extends edge — see lineage_foundational_allowlist.json." LLM rationales use bare "A"/"B" (7 GNN, 4 VIT), e.g. "B の『…』は…A を置き換える". Fix in the pipeline rationale templates (apps/pipeline/src/lineage/theme/… allowlist + LLM prompt): use Japanese, use titles instead of A/B, and no file names.
P1-5 Evidence quality is visible to users. Some quotes are useless (GNN: `引用文: "[19, 41]."`, twice). Some don't support the claim: the FA→EfficientViT LLM rationale says EfficientViT discusses FlashAttention's IO-aware optimisation, but its quote is about MobileViT accuracy. EfficientViT is also arguably off-topic for "Flash Attention". Fix: drop quotes with fewer than ~25 alphabetic chars after stripping citation markers, and require the quote to contain the cited marker or the cited title (apps/pipeline/src/lineage/theme/s2Relations.ts, classify/apiRelations.ts).
P1-6 Japanese label "比較" (baseline_only) is wrong for most edges. The rationale text says "背景・関連研究として引用", and /how-it-works/ defines 比較 as "性能比較の物差し…ベースライン". Fix now: relabel it to "参照/背景" in LineageTree.tsx:95, lib/lineage/relations.ts:34 and how-it-works. Later R2-12 brings the 5-type v2 vocabulary.
P1-7 The default theme is the weakest one. /themes/ without a param opens Flash Attention (4 papers, includes the off-topic EfficientViT, sparse banner). Its FA-1→FA-3 edge runs straight down behind the EfficientViT card, which looks like EfficientViT is in the chain (flash-attention-edge-tooltip.png). Fix: default to the richest or audited theme (ThemesClient.tsx), and route edges around cards or draw them under translucent cards.
P2-8 The sparse banner is too eager and mixes languages. SPARSE_NODE_THRESHOLD=15 flags GNN (13 papers / 40 edges) and MoE as "家系図がまだ薄い". The text "(13 件 / 40 edges)" mixes 件 and "edges". Fix: lib/themes-tree.ts:482-494, base it on edges per node, and write "13 論文 / 40 関係".
P2-9 Mixed English UI strings: "today", "papers", "1 keywords", "Lineage — Theme Lineage", "横軸 (X-axis encoding)", "Export", the HUB/TREND tooltips "hub paper: high connectivity", "confidence 0.65". The filter chip shows internal keys "関係: ablation, baseline_only, extends, successor, supersedes". Fix: ThemeGallery formatThemeAge, LineageTree chip rendering (use RELATION_LABEL_JA), page title in app/themes/layout.tsx.
P2-10 Request form copy and validation (ThemeRequestForm.tsx, lib/themes-request.ts):
  - The form is hidden behind a small "ⓘ について / ✨ 新規テーマ" toggle.
  - The hint says "英数字・スペース・ハイフン", but the pattern and the error also allow "_".
  - Native bubbles are generic ("指定されている形式で入力してください。"), and Japanese input gets no "英語で入力" guidance.
  - The success copy "🚀 受付完了…再読み込みしてください" doesn't mention that the result appears as 未監査.
  - The hint says "数分" but the client timeout is 12 min.
  - Progress/failure copy exposes internals and stale stack names: "develop に commit", "LLM 関係分類", "Groq", "GitHub Actions", and "build_theme_lineage.py" (the Python pipeline no longer exists).
  - It says "品質監査を通過しませんでした" where the site elsewhere says "自動検査".
  Fix: use setCustomValidity with the custom message, show the form inline for empty-result searches, and rewrite the steps in user terms (受付→論文収集→関係の判定→自動検査→公開（未監査）).
P2-11 /how-it-works/ accuracy:
  - It doesn't mention that relations now come primarily from Semantic Scholar citation sentences/intents/isInfluential, with the quoted sentence shown as evidence (D6). It still frames the LLM as the "曖昧なもの" helper plus a "ヒューリスティック" fallback.
  - 比較 is defined as baseline only (see P1-6).
  - "さらに詳しく" links design 39, not 41 (tiers).
  - The CTA "系譜の公開準備状況を見る" links to /themes/, which is a viewer, not a status page.
  No stale weekly-regeneration, GitHub Pages or Python text was found on the landing page or how-it-works. Python survives only in the request-form failure copy (P2-10). Fix: app/how-it-works/page.tsx.
P2-12 Attribution/licensing is minimal. The footer has plain text "データ: arXiv / Semantic Scholar / OpenAlex" (site-footer.tsx:34) with no links and no license notes (OpenAlex CC0; S2 API attribution terms; arXiv abstracts). Abstracts are shown on cards and the English quote sentences come from S2. Fix: link each source, add a short 出典/ライセンス line on /how-it-works/, and add "出典: Semantic Scholar" in the evidence panel.
P3-13 CSP violation on the landing page: `script-src eval` from chunk 954 (zod v4's JIT probe `Function("")`). It's harmless but pollutes the console/CSP reports. Fix: `z.config({ jitless: true })` at app init (apps/web, wherever zod schemas are imported). /themes/ and /how-it-works/ had no console errors or CSP violations.
P3-14 Performance: a cold /themes/ load is about 765 KB. Of that, about 590 KB is 12 woff2 font files and about 181 KB is JS/CSS; the lineage JSON is 4–17 KB. Warm load event is under 200 ms and cold about 310 ms here. The landing page lazily loads search-index-v2.json (2.0 MB gz / 6.6 MB) on first search. Fix: subset or trim the font families/weights (app/fonts.ts).
P3-15 Mobile 375 px: no horizontal page overflow (the graph is in its own scroller, 716 px wide). The graph starts below the fold after the badges, axis buttons and filter chips, and the edges have no tap target (see P0-2). Fix: collapse the axis/export toolbar on narrow screens.

## OK / working
- All 4 themes load (200, lineage.json 4–17 KB) and show "未監査（自動生成）" on the card, plus an explanation line above the graph and a footer note.
- The landing page lists the 4 lineages with the badge and paper/relation counts. The tiers are described correctly on the landing page, /how-it-works/ and in the form panel.
- No console errors on /themes/. Edges have aria-labels with the full rationale (keyboard/screen-reader path exists).
