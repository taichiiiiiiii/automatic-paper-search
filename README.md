# PaperPilot

AI/ML 論文を arXiv から自動収集し、学会採択ステータス・GitHub Stars・キーワードマッチに基づいてスコアリングして CSV/JSON で出力するパイプライン。

GitHub Actions で毎日自動実行され、結果がリポジトリに自動コミットされます。

## 特徴

- **5段階パイプライン設計**（MVPでは Stage 0〜2 を実装）
  - Stage 0: arXiv からの並列収集（async）
  - Stage 1: ルールベースフィルタ + 差分更新（seen_ids）
  - Stage 2: 品質シグナル（venue / GitHub Stars / keyword）でスコアリング
  - Stage 3 (Embedding) / Stage 4 (LLM) は将来拡張
- **プラグイン構造** — Source / Signal / Exporter は基底クラスを継承するだけで追加可能
- **設定駆動** — `config.yaml` でキーワード・カテゴリ・重みを変更
- **秘匿分離** — API キー類は `.env` のみ（`config.yaml` に書かない）
- **冪等性** — 既出論文は seen_ids で除外。同じ config で2回実行しても重複しない

## 必要環境

- Python 3.12+
- 任意で GitHub Personal Access Token（API レート制限を 60 → 5,000 req/h に拡大）

## セットアップ

```bash
cd paperpilot
pip install -r requirements.txt
cp .env.example .env   # 必要に応じて値を記入
```

## 実行

```bash
# デフォルト設定で実行
python -m paperpilot.collector

# 過去3日間のみ
python -m paperpilot.collector --days 3

# キーワードを追加
python -m paperpilot.collector --keyword "diffusion model"

# seen_ids を無視して再出力
python -m paperpilot.collector --full
```

出力は `paperpilot/output/papers_YYYY-MM-DD.{csv,json}` に保存されます。

## 設定（`paperpilot/config.yaml`）

```yaml
search:
  keywords: [large language model, retrieval augmented generation]
  categories: [cs.LG, cs.AI, cs.CL]
  days_back: 7
  max_results_per_keyword: 30

signals:
  venue: { enabled: true }
  github: { enabled: true, max_lookups: 50 }

weights:
  venue: 3.0
  github: 2.0
  keyword: 0.5

pipeline:
  stage2_top_n: 30
```

## スコアリング

各シグナルは 0〜100 に正規化され、`weights` で重み付けされた合計が `total_score` になります。

| シグナル | 出典 | 100点の例 |
|----------|------|-----------|
| venue | arXiv comment 欄を正規表現でパース | NeurIPS / ICML / ICLR 採択 |
| github | Papers with Code → GitHub Stars | 1,000 stars 以上 |
| keyword | タイトル・アブスト中のキーワード一致 | 全キーワードがタイトルに出現 |

## GitHub Actions

`.github/workflows/collect.yml` が毎日 22:00 UTC（07:00 JST）に実行されます。
結果は `paperpilot/output/` に commit されます。

### Secrets（オプション）

| 名前 | 用途 |
|------|------|
| `GH_PAT` | GitHub API 用 PAT（未設定時は `github.token` を使用） |
| `S2_API_KEY` | Semantic Scholar API（将来拡張用） |
| `SLACK_WEBHOOK_URL` | Slack 通知（将来拡張用） |

## ディレクトリ構成

```
paperpilot/
├── collector.py          # CLI エントリ
├── config.yaml           # 検索設定（秘匿情報なし）
├── .env.example          # 環境変数テンプレート
├── pipeline/             # Stage 0〜2 の実装
├── sources/              # arXiv source（基底クラス + プラグイン）
├── signals/              # venue / github / keyword シグナル
├── exporters/            # CSV / JSON
├── models/paper.py       # 論文データモデル
├── utils/                # config_loader, dedup, rate_limiter, logger
├── data/                 # seen_ids.json, run_history.jsonl
├── output/               # papers_YYYY-MM-DD.{csv,json}
└── logs/                 # paperpilot.log
```

## 拡張ポイント

- **新しい Source の追加**: `sources/base.py` の `AbstractSource` を継承し `fetch()` を実装
- **新しい Signal の追加**: `signals/base.py` の `AbstractSignal` を継承し `enrich_one()` または `enrich_batch()` を実装
- **新しい Exporter の追加**: `exporters/base.py` の `AbstractExporter` を継承し `export()` を実装

詳細は同梱の基本設計書 v2.1（`PaperPilot_基本設計書_v2.1_FINAL.docx`）を参照。

## ライセンス

MIT
