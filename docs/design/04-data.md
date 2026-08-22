# 5. データ設計


> ## ⚠️ この文書は陳腐化しています（2026-08-20 実測・#360）
>
> **v2.1（2026-04-05）時点の設計のままで、実装から約 4.5 か月ぶん乖離しています。**
> 実測監査で **33 件の食い違い**（高 16 / 中 13 / 低 4）が確認されており、
> **存在しないファイル・CI・モデルを記載している箇所があります。**
>
> - 現況の単一の真実源は **[09-implementation-status.md](09-implementation-status.md)**
> - 手順やフィールド名を使う前に、**必ず実コード・実設定で裏を取ってください**
> - 代表例: `.github/workflows/collect.yml` は存在しない / embedding は SPECTER2 ではなく MiniLM /
>   LLM は Claude 必須ではなく ollama 既定の 4 プロバイダ / `social` シグナルは存在せず実際は `follow`
> - 🔴 **このファイルは末尾で切断されています**（最終行 `# 更新トリガー:`）。§5.5 の本体が欠落しています。
> - 🔴 `stage2_top_n` は **30**（本文の 80 は誤り）。`profile_vectors.npy` / `venue_cache.json` は**存在しません**。


## 5.1 永続データ一覧

| ファイル | 形式 | 用途 | 更新タイミング |
|---|---|---|---|
| config.yaml | YAML | 全体設定（秘匿情報を含まない） | ユーザーが手動編集 |
| .env | dotenv | 【v2.0追加】APIキー等の秘匿情報 | ユーザーが手動編集 |
| data/seen_ids.json | JSON | 【v2.0変更】{id: timestamp}形式 | 毎Run終了時 |
| data/profile_vectors.npy | NumPy | 研究プロファイルのembedding | プロファイル更新時 |
| data/run_history.jsonl | JSONL | 実行履歴（日時/件数/エラー等） | 毎Run終了時 |
| data/venue_cache.json | JSON | 【v2.0変更】有効期限付きキャッシュ | イベント駆動 or 30日毎 |
| logs/paperpilot_YYYYMMDD.log | テキスト | 【v2.0追加】構造化ログ | 毎Run時（日次ローテーション） |

## 5.2 config.yaml 完全スキーマ（v2.0修正版）
**【v2.0修正】 **APIキーを完全に除去。認証情報は環境変数のみ。キーワードブースト重みを追加。

```yaml
# ===== 検索設定 =====
search:
  keywords: ['large language model', 'transformer', 'reinforcement learning']
  categories: [cs.LG, cs.AI, cs.CL, cs.CV]
  days_back: 7
  max_results_per_keyword: 30
  exclude_words: [survey, tutorial, thesis, workshop report]
```

```
# ===== データソース（認証情報はenv参照）=====
sources:
  arxiv:    { enabled: true,  delay_seconds: 3 }
  s2:       { enabled: true,  delay_seconds: 1 }   # 【v2.0変更】api_key除去
  openalex: { enabled: false }                      # 【v2.0変更】email除去
```

```
# ===== 品質シグナル =====
signals:
  venue:    { enabled: true }
  github:   { enabled: true }     # 【v2.0変更】token除去
  citation: { enabled: true }
  author:   { enabled: true }
  social:   { enabled: false }
```

```
# ===== スコアリング重み =====
weights:
  venue:     3.0
  github:    2.0
  citation:  1.5
  author:    1.0
  social:    1.0
  keyword:   0.5     # 【v2.0追加】
  embedding: 2.5
```

```
# ===== パイプライン制御 =====
pipeline:
  stage2_top_n: 80
  stage3_top_n: 30
  stage4_top_n: 10
  embedding_model: allenai/specter2
  llm_model: claude-sonnet-4-20250514
  llm_batch_size: 5
```

```
# ===== 出力設定 =====
output:
  csv:   { enabled: true,  dir: ./output, encoding: utf-8-sig }
  json:  { enabled: false }
  slack: { enabled: false }   # webhook_urlはenvで指定
  email: { enabled: false }   # smtp設定はenvで指定
```

```
# ===== 差分更新 =====
incremental:
  enabled: true
  seen_ids_file: ./data/seen_ids.json
  max_age_days: 14   # 【v2.0変更】日数ベースパージ（旧: max_seen_ids: 50000）
```

## 5.3 環境変数設計（v2.0新設）
**【v2.0修正】 **秘匿情報を環境変数に分離。.env.exampleをリポジトリに含め、.envは.gitignoreで除外。

```
# .env.example（リポジトリに含める。ユーザーは.envにコピーして値を記入）
```

```
# Semantic Scholar API（任意。設定するとレート制限が緩和）
PAPERPILOT_S2_API_KEY=
```

```
# GitHub API（任意。設定するとレート制限が60→5000 req/h）
PAPERPILOT_GITHUB_TOKEN=
```

```
# Claude API（Stage 4を使用する場合は必須）
PAPERPILOT_CLAUDE_API_KEY=
```

```
# OpenAlex（任意。礼儀的にメールアドレスを設定）
PAPERPILOT_OPENALEX_EMAIL=
```

```
# Slack Webhook（Slack通知を使用する場合）
PAPERPILOT_SLACK_WEBHOOK_URL=
```

```
# Email SMTP（メール通知を使用する場合）
PAPERPILOT_SMTP_SERVER=
PAPERPILOT_SMTP_USER=
PAPERPILOT_SMTP_PASSWORD=
PAPERPILOT_EMAIL_TO=
```

## 5.4 seen_idsパージ戦略（v2.0新設）
**【v2.0修正】 **v1.0の件数ベース（max_seen_ids: 50000）から日付ベースのパージに変更。

```
# 旧形式（v1.0）: IDのリスト
# ["2604.02322", "2604.02309", ...]
```

```
# 新形式（v2.0）: ID → タイムスタンプのdict
# {"2604.02322": "2026-04-03T00:00:00", "2604.02309": "2026-04-03T00:00:00", ...}
```

```python
def purge_seen_ids(seen: dict, max_age_days: int) -> dict:
    cutoff = datetime.now() - timedelta(days=max_age_days)
    return {id: ts for id, ts in seen.items()
            if datetime.fromisoformat(ts) > cutoff}
```

## 5.5 venue_cacheの有効期限管理（v2.0新設）
**【v2.0修正】 **週次バッチ更新からイベント駆動 + 有効期限30日に変更。

```
# venue_cache.json の形式
{
  "metadata": {
    "last_updated": "2026-01-20T00:00:00",
    "expires_at": "2026-02-19T00:00:00",
    "source": "openreview"
  },
  "iclr_2026": {
    "Paper Title Here": {"venue": "ICLR", "tier": 1},
    ...
  }
}
```

```
# 更新トリガー: