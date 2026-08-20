# 8. リネージ機能ロードマップ

論文の **後継 / 置換 / 拡張** 関係を LLM で判定し、サイト上で系譜として表示する機能の実装計画。

## 現状 — Phase 1 + 2 完了、テーマ家系図 公開運用中（2026-05-25）

### Conference lineage (ICLR 2026)

| 項目 | 値 |
|---|---|
| 対象 | ICLR 2026 Oral 全件 |
| 祖先深さ | ±1 世代（直親・直子のみ） |
| 各方向の幅 | 上位 15（citation count 降順） |
| 使用 LLM | Groq Llama 3.3 70B（無料） |
| 公開先 | [`docs/iclr-2026/lineage.html`](../iclr-2026/lineage.html) |
| Deep tree | 14 件生成 (`deep-*.json`) — 1 論文 × N hop BFS、`build_deep_lineage.py` |

### Theme lineage (オンデマンド + 週次自動再生成)

| 項目 | 値 |
|---|---|
| 入力 | 任意の研究テーマ文字列 (frontend form) |
| パイプライン | GitHub Issue (`theme-request` テンプレ) → 運用者が `gh workflow run theme-on-demand.yml` → `build_theme_lineage.py` → develop commit → GH Pages 自動デプロイ |
| 公開済 themes | 19 (Diffusion / DPO / MoE / RAG / RLHF / Vision Transformer / GNN / Speculative Decoding / 他) |
| デフォルト LLM mode | `--llm-strict=ambiguous`（free-tier Groq の TPM 6,000/min 制約に整合） |
| 品質フィルタ | (1) Topic relevance seeds (2) Foundational ref 除外 (2× max seed cites) (3) Implementation denylist (Adam/PyTorch/NumPy 等) |
| LLM rationale 品質 | `CLASSIFY_SYSTEM_PROMPT` ~250 tokens、MUST/MUST NOT block、template echo reject (`_GENERIC_TEMPLATE_RATIONALES`) |
| Classification cache | `paperpilot/data/lineage-cache/classifications.json` を build_lineage と共有、git 永続化で run 間で蓄積 |
| Push race 対策 | `commit-and-push.sh` の 5 回 retry + rebase（per-IP 5/h dispatch を全件公開可） |

## Phase 2 — ICLR 2026 全件へ拡大

### スコープ

| 項目 | 値 |
|---|---|
| 対象 | Oral + Poster 全 218 件 |
| 祖先深さ | ±1 世代（現状と同じ） |
| 各方向の幅 | 上位 10（Phase 1 の 15 から絞る） |

### 規模試算

- S2 呼び出し: ~218 × 3 = ~650 リクエスト
  - `/paper/arXiv:*` で 1 回
  - `/paper/*/references` で 1 回
  - `/paper/*/citations` で 1 回
- LLM 呼び出し: ~218 × 20 = ~4,400 判定

### 時間・コスト

| プロバイダ | 所要時間 | コスト |
|---|---|---|
| Groq Llama 3.3 70B 無料枠（30 RPM）| ~2.5 時間 | $0 |
| Gemini 2.5 Flash 課金 | ~1 時間（並列化で短縮可） | ~$1〜$2 |

### ブロッカー対策

- **S2 レート制限 (#209 / #217 で根本解決)**: 2026-05-27 以降、`theme-on-demand` / `regen-themes` workflows は **`--primary-source openalex`** がデフォルト。OpenAlex は no-auth polite pool で 10 req/s + 100K/day なので S2 throttle に依存しない。S2 key 申請 (gmail 拒否される問題) も回避。S2 を使いたい環境では `--primary-source s2` で従来動作。
  - 旧情報 (参考): S2 key 申請 https://www.semanticscholar.org/product/api#api-key-form (gmail 不可、organizational email 必須)
- **新着論文の S2 未登録**: OpenAlex でカバー (#217)。 OpenAlex は arXiv preprint も即時に index する。
- **citation contexts / intent labels の喪失**: OpenAlex は提供しないので、edge は year/cite contrast or LLM (optional) に fall through。Phase 2 (multicite-scibert local) と unarXive 2022 統合で埋め合わせ計画。

## Phase 3 — 深さ拡張

### スコープ

| 項目 | 値 |
|---|---|
| 対象 | 全 218 件 |
| 祖先深さ | ±2 世代（祖父・孫まで） |
| 各世代の幅 | gen±1=10, gen±2=5 |

### 規模試算

- エッジ数: 218 × 20 (gen1) + 218 × 10 (gen2 簡易) = ~6,500
- LLM 呼び出し: ~6,500
- 時間: Groq で ~3.5 時間 / Gemini 課金で ~1.5 時間

### 追加機能

- **時系列リネージ**（水平系統樹ビュー）の価値が高まる
- **急上昇検出**（citation count 時系列スナップショット）
- 同じ祖先を共有する **兄弟論文のクラスタ化**

## Phase 4 — 能動配信

### スコープ

- 毎週土曜に **新着論文の lineage を差分更新**
  - ⚠️ **前提が消えている**: 本項が同日実行の相手にしていた `collect-weekly.yml` は
    **#245（2026-06-04）で cron を外され手動専用**になった。着手時は起動契機から設計し直すこと（2026-08-20 追記）
- 追跡設定された論文に新しい後継が出たら **Slack 通知**

### 実装要件

- `stage_lineage.py` を pipeline に追加
- `config.yaml` に `lineage:` セクション:
  ```yaml
  lineage:
    provider: groq
    top_parents: 10
    top_children: 10
    max_depth: 1
  ```
- LLM 判定結果を `paperpilot/data/lineage-cache/` に蓄積
- Slack 通知フォーマット: 「あなたが追跡している FA-2 の新しい後継 FA-3 が出ました」

## 判定品質の改善計画

### 実測結果 (2026-06-12 時点、issue #285)

`paperpilot/scripts/audit_lineage_classification_breakdown` (#286) を public lineage + persistent LLM cache に走らせた結果:

- **`supersedes`=0 / `ablation`=0** across 452 wellformed LLM calls (`paperpilot/data/lineage-cache/classifications.json`)
- LLM-only edges の 98% が `extends` + `contrasts` に collapse
- Prompt は bottleneck の一つであることが定量的に確定 — **ただし #293 (下記「Provider 比較」) で model も同等以上の bottleneck と判明**。当初の「prompt が真の bottleneck」という結論は改訂された

`paperpilot/tests/fixtures/relation_gold_set.jsonl` (#287、29 records 人手ラベル) に対する current prompt の baseline:

- **macro-F1 = 0.237** (`uv run python -m paperpilot.scripts.eval_relation_prompt`)
- **Caveat**: macro-F1 0.237 は `successor` / `unrelated` / `baseline_only` が 0 emit による分母膨張アーティファクト。`extends` + `contrasts` のみで見た binary-F1 は ~0.59。これらを emit させたい label とするか自体が未決定 (issue #285 step 4 前段の判断項目)。

### Provider 比較 (2026-06-13 追記、issue #293 + 再測定)

`eval_relation_prompt --provider {auto,groq,gemini}` (#293) で初の **live** macro-F1 を測定。**prompt は無変更**で provider のみ差し替えた:

| Predictor | Model | n | accuracy | macro-F1 | 429 で None 化 |
|---|---|---|---|---|---|
| current (snapshot) | groq llama-3.3-70b | 29 | 0.448 | **0.237** | — |
| live (#293) | gemini-2.5-flash | 29 | 0.414 | **0.372** | 4/29 (14%) |
| live (再測定 2026-06-13) | gemini-2.5-flash | 29 | 0.379 | **0.354** | **8/29 (28%)** |

判明したこと:

- **方向は頑健**: Gemini は Groq が 452 call で一度も出さなかった `successor` / `unrelated` を自然に emit する (再測定の per-class: `unrelated` F1=0.667 / `extends`=0.571 / `successor`=0.333)。モデル差は実在。
- **magnitude はノイズ帯**: 0.354↔0.372 の振れは主に free-tier 429 の None=wrong 汚染が原因 (`_macro_f1` は `pred is None` を gold class の fn に計上、`eval_relation_prompt.py:218`)。n=29・単一ラベラーの noise (±~0.05) と合わせ、現状の数字で magnitude を確定してはいけない。
- **🔴 free-tier Gemini の 429-storm は本番ブロッカー (実証)**: わずか 29 call の eval で 28% が 429 失敗。本番 regen は ~90 LLM call/run なので free-tier では大量の無言 heuristic fallback で崩壊する。`GeminiProvider` には Groq 相当の quota circuit breaker (#191) が無いため劣化が無言。**本番で Gemini を使うなら paid tier が前提**。

### 2026-06-17 実測 (Gemini, targeted supersedes — #296 を検証)

gold set は **54 行に拡張済み** (全7クラス網羅、supersedes 7件・ablation 1件、PR #295)。`PAPERPILOT_LLM_PROVIDER=gemini` override (#311) で **NEW(#296 develop) vs OLD(#296 親) prompt × `--gold-rel supersedes`** をクォータ節約のため targeted 実行:

| prompt | supersedes recall | precision | f1 |
|---|---|---|---|
| **NEW (#296)** | **4/7 = 0.571** | **1.00** | 0.727 |
| OLD (#296 前) | 0/7 = 0.00 | — | 0.00 |

(各 none=1 = Gemini 取りこぼし、`macro_f1_excl_none` で除外処理)

→ **#296 のプロンプト書き換えは supersedes 判定を 0→4/7 (精度1.00) に改善することを実証**。OLD は 7件中6件を `successor` と誤判定。改訂成功基準 (NEW recall≥3/7・precision≥0.5・OLD≈0) を満たす。Caveat: n=7・単一ラベラー。

### 残作業

- **(任意, measurement)** フル 54 行 macro-F1 (NEW vs OLD × Gemini 全クラス precision/recall) + #285 へ結果コメント。free-tier の日次クォータが空いている間に実行。
- ~~gold set scaling (29 → 50+)~~ — **完了** (PR #295 で 54 行、全7クラス網羅)
- second labeler validation (Cohen's κ) — 未実施 (任意)
- gate 案: live macro-F1 ≥ **0.40** (#288 PR description で提案、未確定)
- ~~`PAPERPILOT_GROQ_API_KEY` rotate~~ — Gemini key で live 測定可能なため降格。**さらに実測で Groq は無料枠の使用上限 (429) が本番ブロッカーと判明 — 有効鍵でも 1 テーマ生成中に枯渇し heuristic フォールバックするため rotate の効果は限定的、現状維持が妥当**
- **(decision, user 判断項目)** 本番 provider を Groq→Gemini に切替えるか。ガードレールは**実装済み**になった:
  - cache value の `model` field — **完了** (#313)。混在を `by_model` で監査可能
  - `PAPERPILOT_LLM_PROVIDER` override — **完了** (#311)。`build_provider()` で provider を明示選択でき、上記 Gemini 実測もこれ経由
  - 残: `theme-on-demand.yml`/`regen-themes.yml` への `PAPERPILOT_GEMINI_API_KEY` 配線 + Gemini circuit breaker (free-tier 429 を無言フォールバックさせない) は未実施。free-tier Gemini は本番 ~90 call/run で 429 枯渇するため paid 前提

### 過去の傾向 (Phase 1 実測、refs only)

| 観察 | 対処方針 |
|---|---|
| `supersedes` がほぼ付かない | プロンプト例示で明示的に区別 (#285 step 4) |
| `ablation` もほぼ付かない | 同上、または ablation を `extends` のサブタイプに統合 |
| `extends` が全体の 46% | 基準を厳しくする (#285 step 4 で扱う) |

## ユーザー向け設定の予定

カタログ画面に:

- 🔄 **関係種別の ON/OFF トグル**（現在既に実装済）
- 📅 **時間範囲フィルタ**（1990〜2026 の範囲指定）
- 🎯 **「追跡」ボタン** — その論文を追跡登録し、後継が出たら通知

## 参考: 関係種別ラベルの定義

本プロジェクトで定義する 7 種類の関係:

| ラベル | 定義 |
|---|---|
| **supersedes** | 同じアプローチで明確に性能を凌駕、基準論文を置き換える |
| **successor** | 研究ラインの自然な発展、漸進的な改良 |
| **extends** | 同じ手法を別ドメイン・別タスク・別規模に応用 |
| **ablation** | 構成要素の寄与を分解測定する解析論文 |
| **baseline_only** | 比較対象として引用するだけで、知的な継承はない |
| **contrasts** | 同じ問題に対する根本的に異なるアプローチ |
| **unrelated** | 引用はあるが知的な関連は希薄（出力から除外）|
