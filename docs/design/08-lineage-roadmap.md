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
| パイプライン | CF Worker `/api/themes` → `theme-on-demand.yml` workflow_dispatch → `build_theme_lineage.py` → develop commit → CF Pages 自動デプロイ |
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

- 毎週土曜（既存の `collect-weekly.yml` と同日）に **新着論文の lineage を差分更新**
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

Phase 1 実測で以下の傾向が見えた:

| 観察 | 対処 |
|---|---|
| `supersedes` がほぼ付かない | プロンプト例示で明示的に区別 |
| `ablation` もほぼ付かない | 同上、または ablation を `extends` のサブタイプに統合 |
| `extends` が全体の 46% | 基準を厳しくする（真に別ドメイン応用のみ） |

### LLM-as-judge 評価

- サンプル 100 エッジを目視ラベル付け
- プロンプトを A/B して精度測定
- 閾値調整（confidence 0.7 未満を除外するか等）

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
