# PaperPilot

AI/ML 論文を arXiv から自動収集し、学会採択ステータス・GitHub Stars・キーワードマッチに基づいてスコアリングして CSV/JSON で出力するパイプライン。

GitHub Actions で毎日自動実行され、結果がリポジトリに自動コミットされます。

## 特徴

- **5段階パイプライン設計**（Stage 0, 1, 2, 4 を実装済み / Stage 3 Embedding は将来拡張）
  - Stage 0: arXiv + Semantic Scholar からの並列収集（async）
  - Stage 1: ルールベースフィルタ（カテゴリ/日付/除外語/差分）
  - Stage 2: 品質シグナル（venue / citation / author / GitHub Stars / keyword）でスコアリング
  - Stage 4: **LLM によるリランク + 日本語要約**（Ollama で完全ローカル動作、無料）
- **プラグイン構造** — Source / Signal / Exporter / LLMProvider は基底クラスを継承するだけで追加可能
- **設定駆動** — `config.yaml` でキーワード・カテゴリ・重み・LLMモデルを変更
- **秘匿分離** — API キー類は `.env` のみ（`config.yaml` に書かない）
- **冪等性** — 既出論文は seen_ids で除外。同じ config で2回実行しても重複しない
- **Fail-Safe** — 外部API障害時は該当ソース/シグナルをスキップして継続

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

# LLM 評価（Stage 4）を一時的にスキップ
python -m paperpilot.collector --skip-llm
```

## Stage 4 (LLM rerank) — Ollama セットアップ（任意）

Stage 4 を使うと LLM が各論文に `relevance (1-5) / 日本語要約 / 読むべき理由 / タグ` を付与し、関連度順にリランクします。完全ローカルで無料動作する **Ollama** を推奨します。

```bash
# 1. Ollama インストール  (https://ollama.com)
curl -fsSL https://ollama.com/install.sh | sh

# 2. モデル取得（日本語に強い qwen2.5 を推奨 / 7B で ~5GB）
ollama pull qwen2.5:7b

# 3. Ollama サーバ起動（別ターミナル）
ollama serve
```

`paperpilot/config.yaml` の `llm` セクションを有効化：

```yaml
llm:
  enabled: true
  provider: ollama
  model: qwen2.5:7b
  host: http://localhost:11434
  batch_size: 5
  timeout_seconds: 120
```

他の LLM を使う場合は `paperpilot/llm/` に `AbstractLLMProvider` を継承したクラスを追加してください（Claude / Gemini / OpenAI / Groq など）。

出力は `paperpilot/output/papers_YYYY-MM-DD.{csv,json}` に保存されます。

## 設定（`paperpilot/config.yaml`）

```yaml
search:
  keywords: [large language model, retrieval augmented generation]
  categories: [cs.LG, cs.AI, cs.CL]
  days_back: 7
  max_results_per_keyword: 30

sources:
  arxiv: { enabled: true, delay_seconds: 3 }
  s2:    { enabled: true, delay_seconds: 1 }

signals:
  venue:    { enabled: true }
  citation: { enabled: true, velocity_saturation: 2.0 }
  author:   { enabled: true }
  github:   { enabled: true, max_lookups: 50 }

weights:
  venue: 3.0
  github: 2.0
  citation: 1.5
  author: 1.0
  keyword: 0.5

pipeline:
  stage2_top_n: 30
  stage4_top_n: 10

llm:
  enabled: false        # true にして Ollama を起動すれば Stage 4 が有効
  provider: ollama
  model: qwen2.5:7b
```

## スコアリング

各シグナルは 0〜100 に正規化され、`weights` で重み付けされた合計が `total_score` になります。

| シグナル | 出典 | 正規化 |
|----------|------|--------|
| venue | arXiv comment 欄を正規表現でパース | Tier1=100 / Tier2=80 / Tier3=60 / Workshop=30 |
| citation | Semantic Scholar `/paper/batch` | `min(citations_per_day / saturation, 1) × 100` |
| author | Semantic Scholar `/author/batch` | `min(h_index / 50, 1) × 100` |
| github | Papers with Code → GitHub Stars | `log(stars+1) / log(10001) × 100` |
| keyword | タイトル・アブストラクトのキーワード一致 | `min(match_count / 3, 1) × 100` |

Stage 4 (LLM) を有効化すると、さらに `llm_relevance (1..5)` で最終ランキングされます。

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
