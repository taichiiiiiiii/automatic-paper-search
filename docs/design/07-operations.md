# 8. 非機能要件

## 8.1 ログ設計（v2.0新設）
**【v2.0修正】 **ログレベル・フォーマット・ローテーション方針を定義。

| 項目 | 仕様 |
|---|---|
| ライブラリ | Python標準 logging モジュール |
| レベル | DEBUG / INFO / WARNING / ERROR |
| フォーマット | %(asctime)s [%(levelname)s] %(name)s: %(message)s |
| 出力先1 | コンソール（INFO以上） |
| 出力先2 | logs/paperpilot_YYYYMMDD.log（DEBUG以上） |
| ローテーション | 日次ローテーション。7日分を保持、古いファイルは自動削除 |
| 記録対象 | Stage遷移、API呼び出し（URL/ステータス/レスポンスタイム）、エラー詳細、件数遷移 |
| run_historyとの違い | run_history.jsonlは実行サマリー（1 Run = 1行）。ログは詳細トレース |

## 8.2 非機能要件一覧

| 要件 | 仕様 | 備考 |
|---|---|---|
| 可用性 | 外部API障害時も部分的に稼働 | 個別Sourceスキップで継続 |
| 性能 | 【v2.0変更】1回の実行が5分以内に完了 | バッチAPI化で達成 |
| スケーラビリティ | キーワード50個/Source3種まで対応 | それ以上はバッチ分割 |
| セキュリティ | 【v2.0変更】APIキーは環境変数/.envのみ | config.yamlに秘匿情報を含めない |
| 可観測性 | 【v2.0変更】構造化ログ + run_history.jsonl | 日次ローテーション |
| 冪等性 | 同一configで再実行しても出力が重複しない | seen_idsによる差分管理 |
| 可搬性 | Python 3.10+、OS非依存 | Windows/Mac/Linux対応 |
| テスト | 各Stage単体テスト + パイプライン統合テスト | pytest、カバレッジ80%以上 |

# 9. テスト計画

| レベル | 対象 | 手法 | 基準 |
|---|---|---|---|
| 単体テスト | 各Source/Signal/Exporterクラス | pytest + モック | カバレッジ80%以上 |
| 統合テスト | PipelineRunner全Stage通し | テストfixture（20件の固定データ） | 期待件数±10% |
| 正規表現テスト | venue検出パターン | 既知のarXivコメント100件 | 検出率95%以上 |
| スコアリングテスト | 重み変更時のランキング変動 | 固定データセットでの順位検証 | Top5の70%が一致 |
| JSONパーステスト | 【v2.0追加】LLM出力の壊れパターン | 正常/バッククォート/部分破損の10パターン | パース成功率90%以上 |
| バッチAPIテスト | 【v2.0追加】S2/GitHub バッチ呼び出し | 50件のテストデータ | レスポンス完全性100% |
| E2Eテスト | config → CSV出力の全フロー | 本番APIへの実アクセス（週次） | エラー0件で完走 |

# 10. 実装計画

| Sprint | 期間 | 実装対象 | 成果物 |
|---|---|---|---|
| Sprint 1 | Week 1-2 | Paper model(comment含む), ArxivSource(async), Stage 0-1, CSV | arXiv非同期収集→ルールフィルタ→CSV出力 |
| Sprint 2 | Week 3-4 | S2Source(async), VenueSignal, GitHubSignal(バッチ), Citation(バッチ) | バッチAPI対応の品質スコアリング |
| Sprint 3 | Week 5-6 | AuthorSignal, KeywordBoost, compute_total_score, .env管理 | 統合スコア + 環境変数によるセキュア認証 |
| Sprint 4 | Week 7-8 | Stage 3(Embedding), init-profile CLI, プロファイルフォールバック | SPECTER2類似度 + プロファイル管理 |
| Sprint 5 | Week 9-10 | Stage 4(LLM), json_parser, SlackExporter | 日本語要約 + 堅牢JSONパース + Slack通知 |
| Sprint 6 | Week 11-12 | GitHub Actions, ログ設計, テスト全体, ドキュメント | OSS公開可能な状態 |

# 11. GitHub Actionsワークフロー設計（v2.0新設）

**【v2.0修正】 **定期実行のためのGitHub Actionsワークフロー設計を追加。v2.1でsecret名修正・rebase追加・webhook存在チェック追加。

```
# .github/workflows/collect.yml
name: PaperPilot Daily Collection
```

```
on:
  schedule:
    - cron: '0 22 * * *'    # UTC 22:00 = JST 7:00
  workflow_dispatch:          # 手動実行ボタン
```

```yaml
jobs:
  collect:
    runs-on: ubuntu-latest
    timeout-minutes: 15
    steps:
      - uses: actions/checkout@v4
```

```
      - uses: actions/setup-python@v5
        with:
          python-version: '3.12'
          cache: pip
```

```
      - name: Install dependencies
        run: pip install -r requirements.txt
```

```
      - name: Run PaperPilot
        env:
          PAPERPILOT_S2_API_KEY: ${{ secrets.S2_API_KEY }}
          PAPERPILOT_GITHUB_TOKEN: ${{ secrets.GH_PAT }}        # 【v2.1修正】予約名回避
          PAPERPILOT_CLAUDE_API_KEY: ${{ secrets.CLAUDE_API_KEY }}
          PAPERPILOT_SLACK_WEBHOOK_URL: ${{ secrets.SLACK_WEBHOOK_URL }}
        run: python collector.py
```

```bash
      - name: Commit results
        run: |
          git config user.name "PaperPilot Bot"
          git config user.email "bot@paperpilot.dev"
          git add output/ data/
          git pull --rebase origin main || true   # 【v2.1追加】並行commit対策
          git diff --cached --quiet || git commit -m "📚 $(date +%Y-%m-%d) 論文更新"
          git push
```

```
      - name: Notify on failure
        if: failure() && secrets.SLACK_WEBHOOK_URL != ''   # 【v2.1修正】webhook未設定時スキップ
        run: |
          curl -X POST $SLACK_URL \
            -H 'Content-type: application/json' \
            -d '{"text": "⚠️ PaperPilot実行失敗: ${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}"}'
        env:
          SLACK_URL: ${{ secrets.SLACK_WEBHOOK_URL }}
```

本書は基本設計v2.1であり、Round 1レビュー全14件 + Round 2レビュー全11件（計25件）を反映済みである。修正箇所はオレンジ背景の【v2.0修正】【v2.1修正】表記で特定可能。