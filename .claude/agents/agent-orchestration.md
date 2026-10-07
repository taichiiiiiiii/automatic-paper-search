# agent-orchestration — サブエージェントの実行順序と分担

PaperPilot のサブエージェントは**層ごとに専門化**している。メインセッションが各エージェントを並列に呼び、最後に `paperpilot-reviewer` でまとめてレビューする。コードはすべて TypeScript（`apps/web`・`apps/api`・`apps/pipeline`・`packages/core`）。Python はもう無い。

## エージェント一覧

| エージェント | 担当 | モデル | 呼ぶとき |
|---|---|---|---|
| `source-agent` | `apps/pipeline/src/collect/sources/` の Source | sonnet | 新 Source 追加、arXiv/S2/OpenAlex の改修 |
| `signal-agent` | `apps/pipeline/src/collect/signals/` の Signal | sonnet | 新 Signal 追加、スコア正規化の変更 |
| `exporter-agent` | `apps/pipeline/src/collect/exporters/` の Exporter | sonnet | 新 Exporter 追加、CSV 列の拡張 |
| `test-agent` | `apps/*/test/`・`packages/core/test/` のテスト整備 | sonnet | テスト不足、flaky test、新モジュールの後 |
| `paperpilot-reviewer` | 絶対ルールでの最終レビュー | sonnet | 変更の最終チェック（必ず使う） |
| `failure-path-reviewer` | 「障害・壊れた上流データ・部分取得が公開データになる」経路の深掘りレビュー（読み取り専用） | opus | collector / builder / Stage / exporter / release / workflow / API を変えた後の各回 |
| `worker-agent` | API（`apps/api`）とサイト（`apps/web`）の実装 | sonnet | API・画面の指摘に直し方が決まったとき |
| `scripts-agent` | `apps/pipeline/src` の builder・収集器・release 道具と `.github/workflows` の実装 | sonnet | それらの指摘に直し方が決まったとき |
| `verifier` | Biome・typecheck・web build・全テスト・bundle 検証・データ監査・refresh のバイト一致・衛生チェックを実行して報告 | haiku | 実装の後、commit を提案する前 |

**モデルの選び方:** 判断が難しく見落としの損が大きいレビューは opus（読み取り専用なので費用に上限がある）。仕様が決まった実装は sonnet。判断の要らない検証の実行は haiku。

**レビュー → 修正のループ:** `failure-path-reviewer` → 実装エージェント（層ごと）→ `verifier` → `failure-path-reviewer` … を、重大・中程度が 0 になるまで回す。インフラの追加・仕様変更・製品方針・公開データの削除が要るものは直さず、ユーザー判断の一覧に回す。git 操作・push・デプロイ・KV 書き込み・workflow の dispatch はメインセッションだけが、ユーザーの承認の後に行う。

## 基本の流れ

```
[ ユーザーの依頼 ]
       │
       ├─→ 1 層だけの変更（例: 新 Signal）
       │   └─→ signal-agent で TDD 実装
       │       └─→ test-agent で足りないテストを補う
       │           └─→ paperpilot-reviewer で最終レビュー
       │               └─→ verifier → メインセッションが報告（commit はユーザー承認後）
       │
       └─→ 複数の層にまたがる変更（例: 新 Source + それ向けの Signal）
           ├─→ source-agent ─┐
           │                  ├─ 並列
           ├─→ signal-agent ─┘
           └─→ test-agent → paperpilot-reviewer → verifier
```

## 並列と逐次

独立した変更は**必ず並列**で呼ぶ（例: 新 Source と新 Exporter）。次は**逐次**:

- 実装 → `test-agent` で補う → `paperpilot-reviewer` で確認
- `Paper` モデル（`collect/model/paper.ts`）に項目が要る → reviewer が承認 → 該当エージェントが実装
- 共有の生成物・manifest・lockfile を触る変更は 1 つずつ

## 責務の境界

```
┌─────────────────────────────────────────────┐
│ paperpilot-reviewer（最後に必ず使う）        │
│ - 絶対ルールのチェック                        │
│ - Paper モデル変更の承認                      │
│ - CRITICAL / HIGH / MEDIUM の判定             │
└─────────────────────────────────────────────┘
       ↑ 最終レビュー
┌──────────────┬──────────────┬──────────────┐
│ source-agent │ signal-agent │ exporter-ag. │
│  sources/    │  signals/    │  exporters/  │
│ ├ arxiv/     │ ├ venue      │ ├ csv        │
│ ├ s2         │ ├ citation   │ ├ json       │
│ ├ openalex   │ ├ author     │ ├ slack      │
│ └ <new>      │ ├ github     │ ├ email(未対応)│
│              │ ├ keyword    │ └ <new>      │
│              │ ├ follow     │              │
│              │ └ <new>      │              │
└──────────────┴──────────────┴──────────────┘
                     ↓ テストを補う
          ┌──────────────────────┐
          │ test-agent            │
          │ test/ だけを触る      │
          │ 本体は触らない        │
          └──────────────────────┘
```

### 重なる領域

| 変更 | 主担当 | 副担当 |
|---|---|---|
| 新 Source + `Paper` の項目追加 | source-agent | paperpilot-reviewer（Paper 変更の承認） |
| 新 Signal + `Paper` の項目追加 | signal-agent | paperpilot-reviewer |
| CSV 列を足す | exporter-agent | — |
| CSV 列を消す | paperpilot-reviewer（承認が要る） | exporter-agent |
| `collect/runner.ts` の `build*()` に分岐を足す | 該当エージェント | — |
| `collect/runner.ts` の Stage の順序を変える | paperpilot-reviewer のみ | — |
| `collect/stages/metricScore.ts` の `total_score` の式を変える | paperpilot-reviewer のみ（設計書も改訂） | — |
| 家系図・カタログ・release・workflow | scripts-agent | failure-path-reviewer |
| API・画面 | worker-agent | failure-path-reviewer |

## 呼ぶ・呼ばないの目安

- 「新しい〜を足して」 → 該当エージェント
- 「テストだけ書いて」 → `test-agent`
- 「PR 前チェック」「レビュー」 → `paperpilot-reviewer`（必要なら `failure-path-reviewer`）
- 軽い typo、README / CLAUDE.md だけの更新、`config.yaml` の既存キーの値の変更 → メインセッションで済ませる（構造を変えるなら reviewer）

## 引き渡すもの

- 変えたファイル（`git diff --name-only`）
- 足したテスト名
- 実行したコマンドと結果（`pnpm --filter … exec vitest run …` の件数）
- 残った仕様の疑問（reviewer へ）

## 全エージェント共通のルール

1. **担当範囲を超えない。** 超えるなら reviewer に引き継ぐ
2. **外部 API を叩くテストを書かない。** `fetch` を注入してモックする
3. **秘密は環境変数（`data/config/.env`・secrets）だけ。** `config.yaml` やソースに書かない
4. **TDD の順序を守る。** RED → GREEN → REFACTOR → 登録 → 検証
5. **独立した作業は並列に呼ぶ**
6. **最終レビューは必ず paperpilot-reviewer**
7. **データのパスは `packages/core/src/layout` から取る。** 直書きしない
8. **git の書き込み・push・デプロイ・KV 書き込み・dispatch はしない**（メインセッションがユーザー承認の後に行う）

## 絶対ルールの所有者

CLAUDE.md「絶対ルール」の各項目を誰が一次的に守るか。**reviewer は常に全項目を二次チェックする。**

| # | ルール | 一次 | 二次 | 備考 |
|---|---|---|---|---|
| 1 | API キーは環境変数だけ | 該当エージェント | reviewer | source / exporter で起きやすい |
| 2 | `.env` は git に入れない | 全員 | reviewer | commit 前に `git status` |
| 3 | 外部 API を叩くテストを書かない | source / signal / exporter / test-agent | reviewer | `fetch` を注入 |
| 4 | Stage の入出力の型を変えない | **reviewer だけが承認** | — | |
| 5 | スコアの式・重みを仕様なしに変えない | signal-agent（式）/ reviewer（重み） | reviewer | 設計書と同期 |
| 6 | Stage 1 はフィルタだけ | **reviewer だけが承認** | — | `collect/stages/ruleFilter.ts` |
| 7 | Signal は `enrichBatch` を優先 | signal-agent | reviewer | |
| 8 | seen_ids は `{id: timestamp}`、`max_age_days` で消す | source-agent（uid）/ reviewer | — | `collect/state/seenIds.ts` |
| 9 | run_history に `finished_at` / `sources_status` / `errors` | **reviewer のみ** | — | `collect/state/runHistory.ts`・`runner.ts` |
| 10 | Slack は webhook 未設定なら何もしない | exporter-agent | reviewer | |
| 11 | LLM は `LLMProvider` を通す | reviewer | — | 実装は `lineage/llm/` |
| 13・14 | 家系図 JSON の生成元は 1 つ | scripts-agent | failure-path-reviewer | 手で編集しない |
| 15 | 論文のメタデータを作り話で埋めない | 全員 | reviewer・failure-path-reviewer | |

## LLM 関連の分担（llm-agent は作らない）

| 変更 | 一次担当 |
|---|---|
| 新しい provider（`lineage/llm/<name>.ts` + `collect/runtime/llmProvider.ts` への登録） | reviewer が設計を承認 → source-agent と同じ TDD の流れで実装 |
| 既存 provider のバグ修正（Ollama / Gemini / Groq / Claude） | paperpilot-reviewer |
| プロンプトの文言（`lineage/llm/base.ts` の `CLASSIFY_SYSTEM_PROMPT` など） | paperpilot-reviewer（出力形式を壊さない範囲で） |
| Stage 4 のロジック（`collect/stages/llmRank.ts`） | paperpilot-reviewer |
| LLM 関連のテスト | test-agent |

## Skills との連携

| Skill | いつ見るか | エージェント |
|---|---|---|
| `add-plugin` | プラグイン追加の TDD 手順 | source / signal / exporter-agent |
| `run-verification` | 検証の一括実行 | test-agent / reviewer / verifier |

全文は `.claude/skills/<name>/SKILL.md`。
