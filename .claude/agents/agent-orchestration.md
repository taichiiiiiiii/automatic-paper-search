# agent-orchestration — サブエージェントの実行順序と分担

PaperPilot のサブエージェントは**プラグイン層ごとに専門化**されています。メインセッションは各エージェントを並列に呼び出し、最後に `paperpilot-reviewer` で統合レビューする流れです。

## エージェント一覧

| エージェント | 担当 | モデル | 自動起動トリガー |
|-------------|------|------|------------|
| `source-agent` | `paperpilot/sources/` の Source プラグイン開発 | sonnet | 新 Source 追加、arXiv/S2/OpenAlex 改修 |
| `signal-agent` | `paperpilot/signals/` の Signal プラグイン開発 | sonnet | 新 Signal 追加、スコア正規化変更 |
| `exporter-agent` | `paperpilot/exporters/` の Exporter プラグイン開発 | sonnet | 新 Exporter 追加、CSV 列の拡張 |
| `test-agent` | `paperpilot/tests/` のテスト整備 | sonnet | カバレッジ低下、flaky test、新モジュール後 |
| `paperpilot-reviewer` | 絶対ルール10項目での PR レビュー | sonnet | 変更の最終チェック（MUST BE USED） |

## 基本の実行フロー

```
[ ユーザー要求 ]
       │
       ├─→ 単一レイヤーの変更（例: 新 Signal 追加）
       │   └─→ signal-agent で TDD 実装
       │       └─→ test-agent で不足テスト補完・カバレッジ確認
       │           └─→ paperpilot-reviewer で最終レビュー
       │               └─→ develop へ commit / push
       │
       └─→ 複数レイヤーに跨る変更（例: 新 Source + それ向け Signal）
           ├─→ source-agent ─┐
           │                  ├─ 並列実行
           ├─→ signal-agent ─┘
           │
           └─→ test-agent（全体のテスト整合性チェック）
               └─→ paperpilot-reviewer
                   └─→ develop へ commit / push
```

## 並列実行の原則

独立した変更は**必ず並列**で呼び出す。例：

- 新 Source + 新 Exporter → `source-agent` と `exporter-agent` を同時起動
- 既存 Source 修正 + 既存 Signal 修正 → 互いに依存しなければ並列

逆に以下は**逐次**：

- `*-agent` で実装 → `test-agent` で補完 → `paperpilot-reviewer` で最終確認（順序あり）
- Paper モデルに新フィールドが必要な場合 → reviewer で承認 → 当該 agent 実装

## 各エージェントの責務境界

```
┌─────────────────────────────────────────────┐
│ paperpilot-reviewer (最後に必ず起動)       │
│ - 絶対ルール10項目チェック                  │
│ - Paper モデル変更の承認                    │
│ - CRITICAL / HIGH / MEDIUM 判定             │
└─────────────────────────────────────────────┘
       ↑ 最終レビュー
┌──────────────┬──────────────┬──────────────┐
│ source-agent │ signal-agent │ exporter-ag. │
│  sources/    │  signals/    │  exporters/  │
│ ├ arxiv      │ ├ venue      │ ├ csv        │
│ ├ s2         │ ├ citation   │ ├ json       │
│ ├ openalex   │ ├ author     │ ├ slack      │
│ └ <new>      │ ├ github     │ ├ email      │
│              │ ├ keyword    │ └ <new>      │
│              │ └ <new>      │              │
└──────────────┴──────────────┴──────────────┘
                     ↓ テスト補完
          ┌──────────────────────┐
          │    test-agent         │
          │ tests/ のみ触る       │
          │ カバレッジ維持        │
          │ 本体は触らない        │
          └──────────────────────┘
```

### 重なる領域の取り扱い

| 変更 | 主担当 | 副担当 |
|------|-------|-------|
| 新 Source 追加 + Paper フィールド追加 | source-agent | paperpilot-reviewer（Paper 変更承認） |
| 新 Signal 追加 + Paper フィールド追加 | signal-agent | paperpilot-reviewer |
| CSV 列を追加 | exporter-agent | — |
| CSV 列を削除 | paperpilot-reviewer（承認必須） | exporter-agent |
| `pipeline/runner.py` の `_build_*` に分岐追加 | 該当 \*-agent | — |
| `pipeline/runner.py` の Stage 順序変更 | paperpilot-reviewer のみ | — |
| `stage_metric_score.py` の `total_score` 計算式変更 | paperpilot-reviewer のみ（設計書も改訂） | — |

## エージェントの起動ガイドライン

### 1. 専門エージェントを呼ぶべき場合

- 「新しい〜を追加して」系 → 該当 `*-agent`
- 「テストだけ書いて」「カバレッジ上げて」→ `test-agent`
- 「PR 前チェック」「コードレビュー」→ `paperpilot-reviewer`

### 2. 専門エージェントを呼ばなくていい場合

- 軽微な typo 修正 → メインエージェントで完結
- README / CLAUDE.md の更新のみ → メインエージェントで完結
- `config.yaml` の既存キーの値変更 → メインエージェントで完結（構造変更なら reviewer）

### 3. 並列起動の推奨ケース

複数プラグイン層を同時に触るとき：

```
# 例: 新しい API 連携（source + signal + exporter を同時に作る）
並列起動:
  - source-agent: PubMedSource 実装
  - signal-agent: PubMedCitationSignal 実装
  - exporter-agent: PubMedDiscordExporter 実装
  （互いに依存しない場合のみ）

逐次:
  - test-agent: 3 つの追加テストを統合的に検証
  - paperpilot-reviewer: 10項目チェック
```

## エージェント間の引き渡し契約

エージェントが作業を終えたら**次のエージェントに渡す情報**：

- 変更したファイルのリスト（`git diff --name-only develop..HEAD`）
- 追加したテストケース名
- カバレッジの before/after（test-agent へ）
- 未解決の仕様疑問（reviewer へ）

## 絶対ルール（全エージェント共通）

1. **担当範囲を絶対に超えない。** 超える必要があるなら reviewer に引き継ぐ
2. **外部 API を叩くテストを書かない。** モック必須
3. **`.env` に秘匿情報。** `config.yaml` に書かない
4. **TDD の順序を守る。** RED → GREEN → REFACTOR → REGISTER → VERIFY
5. **複数エージェント変更時は並列起動。** 独立作業を直列にしない
6. **最終レビューは必ず paperpilot-reviewer。** 他のエージェントが pass と言っても reviewer を通す

## CLAUDE.md「絶対ルール10項目」の所有者マトリクス

`CLAUDE.md`「絶対ルール」セクションの各項目をどのエージェントが一次的に守るかを明示。**reviewer は常に全項目を二次チェック**。

| # | ルール | 一次所有 | 二次 | 備考 |
|---|--------|---------|------|------|
| 1 | API キーは `.env` にのみ記載。`config.yaml` や `.py` ソースに書かない | 該当 \*-agent | reviewer | 特に source/exporter で発生 |
| 2 | `.env` は `.gitignore` で除外されている | 全エージェント | reviewer | commit 前に `git status` で確認 |
| 3 | 外部 API を叩くテストを書かない。必ずモック | source / signal / exporter / test-agent | reviewer | `request_with_retry` を必ず patch |
| 4 | 既存の Stage インターフェース（入出力の型）を変更しない | **reviewer のみ承認可** | — | 変更したい場合は reviewer に相談 |
| 5 | スコアリングの正規化式・重みを仕様なく変更しない | signal-agent（式）/ reviewer（重み） | reviewer | 設計書 Table 12 と同期 |
| 6 | Stage 1 はフィルタのみ。スコアリングを混ぜない（§4.2） | **reviewer のみ承認可** | — | `stage_rule_filter.py` の変更は reviewer 経由 |
| 7 | Signal は `enrich_batch` を優先（§3.2.2） | signal-agent | reviewer | バッチ API があれば override |
| 8 | seen_ids は `{id: timestamp}` 形式。`max_age_days` でパージ | source-agent（uid 生成）/ reviewer | — | 形式変更は reviewer |
| 9 | run_history.jsonl には `finished_at` / `sources_status` / `errors` を含める | **reviewer のみ** | — | `pipeline/runner.py` の構造責務 |
| 10 | Slack / Email 通知は webhook・SMTP 未設定時に no-op | exporter-agent | reviewer | `return None + logger.info` |

### 判断フロー

```
変更が絶対ルールに触れる？
  ├─ 一次所有 = 特定の *-agent
  │    → その agent で実装 → test-agent → reviewer（二次チェック）
  │
  └─ 一次所有 = "reviewer のみ"（項目 4, 6, 9）
       → reviewer にまず相談
       → reviewer が承認した設計に基づいて *-agent で実装
       → reviewer が最終確認
```

## llm/ ディレクトリの扱い（llm-agent を作らない方針の補完）

中間セット（5 エージェント）には llm-agent を含めなかったため、`paperpilot/llm/` の変更は**以下のように分担**する：

| 変更内容 | 一次担当 | 理由 |
|---------|---------|------|
| 新 LLM Provider 追加（例: ClaudeProvider, OpenAIProvider） | paperpilot-reviewer が設計承認 → source-agent 相当の TDD で実装 | 頻度が低い + `AbstractLLMProvider` パターンが Source に類似 |
| 既存 Provider のバグ修正（Ollama/Gemini） | paperpilot-reviewer | 変更影響が Stage 4 に限定されるため reviewer 判断で十分 |
| プロンプトの文言修正（`llm/base.py` の `SYSTEM_PROMPT` 等） | paperpilot-reviewer | 出力フォーマットが壊れない範囲で調整 |
| Stage 4 のロジック変更（`pipeline/stage_llm_rank.py`） | paperpilot-reviewer | Stage フローに影響するため reviewer 専権 |
| LLM 関連のテスト追加 | test-agent | モックテストは `test-agent` が担当 |

### 将来的に llm-agent を作る判断基準

- LLM Provider が 4 種類以上になったら分離（現在: 2 種類）
- Stage 4 のロジックが複雑化してプロバイダ独立の処理が 100 行超えたら分離
- プロンプトエンジニアリングを頻繁に調整するフェーズに入ったら分離

## Skills との連携

各エージェントは以下の Skill を活用する：

| Skill | いつ参照 | エージェント |
|-------|---------|----------|
| `add-plugin` | プラグイン追加の TDD フロー詳細 | source / signal / exporter-agent |
| `run-verification` | テスト・カバレッジ・スモーク検証の一括実行 | test-agent / reviewer |

Skill の全文は `.claude/skills/<name>/SKILL.md` にあり、エージェントは必要に応じて `Read` ツールで参照すればよい。
