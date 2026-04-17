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
