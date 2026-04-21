# PaperPilot

AI/ML 論文を arXiv / Semantic Scholar / OpenAlex から自動収集し、品質シグナルで絞り込んだ上で **系譜（家系図）として可視化** するパイプライン。補助出力として CSV / JSON / Slack / Email にも配信できます。

**主要な出力:** Cloudflare Pages 上のインタラクティブ家系図ビュー（`docs/<conference>/lineage.html`）。
LLM が論文間の引用関係を 7 種類 (`supersedes` / `successor` / `extends` / `ablation` / `baseline_only` / `contrasts` / `unrelated`) に分類し、先行研究と後継研究を一枚の SVG で俯瞰できます。

**2 つの自動実行モード**（GitHub Actions）：
- **週次深掘り**（Sat 7:00 JST）— 収集 → スコアリング → summary.csv → papers.json → lineage.json の全工程を回す
- **毎日の著者ウォッチ**（07:00 JST 毎日）— フォロー中の研究者の新作を公開 0 秒後に通知（lean、LLM 不使用）

## 特徴

- **5段階パイプライン**（全 Stage 実装済み）
  - Stage 0: arXiv + Semantic Scholar + OpenAlex からの並列収集（async）
  - Stage 1: ルールベースフィルタ（カテゴリ/日付/除外語/差分）
  - Stage 2: 品質シグナル（venue / citation / author / GitHub Stars / keyword / **follow**）でスコアリング
  - Stage 3: Embedding 類似度（MiniLM、オプション）
  - Stage 4: **LLM によるリランク + 日本語要約**（Ollama / Gemini / Claude / Groq）
- **家系図ビューア** — S2 の引用グラフを LLM で関係分類し、`docs/<conference>/lineage.html` にインタラクティブ表示
- **FollowSignal** — 特定研究者 / 組織の新作を day-1 で最上位に（他シグナルが熟成前でも）
- **プラグイン構造** — Source / Signal / Exporter / LLMProvider は基底クラスを継承するだけで追加可能
- **設定駆動** — `config.yaml` でキーワード・カテゴリ・重み・LLMモデル・フォロー研究者を変更
- **秘匿分離** — API キー類は `.env` のみ（`config.yaml` に書かない）
- **冪等性** — 既出論文は seen_ids で除外。同じ config で2回実行しても重複しない
- **Fail-Safe** — 外部API障害時は該当ソース/シグナルをスキップして継続

## 必要環境

- Python 3.10+（開発・CI は 3.12）
- 任意で GitHub Personal Access Token（API レート制限を 60 → 5,000 req/h に拡大）

## セットアップ

```bash
# runtime のみ
pip install -r paperpilot/requirements.txt

# 開発用（pytest + ruff + mypy を含む）
pip install -e '.[dev]'

cp paperpilot/.env.example paperpilot/.env   # 必要に応じて値を記入
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

## 家系図ビューア

パイプラインの成果物を `docs/<conference>/` 配下の静的サイトに変換する補助パイプラインが `paperpilot/scripts/` にあります。

```
output/<conf>/papers_YYYY-MM-DD.csv
  │
  ├─ build_summary_csv.py   → summary.csv（8 列 + 自動タグ）
  ├─ build_pages.py         → docs/<conf>/papers.json（一覧ビュー）
  └─ build_lineage.py       → docs/<conf>/lineage.json（家系図）
                              （S2 引用グラフ + LLM 関係分類）
```

### ローカルで実行

```bash
# 論文一覧ビューだけ（LLM 不要）
python paperpilot/scripts/build_summary_csv.py --conference iclr-2026
python paperpilot/scripts/build_pages.py --conference iclr-2026

# 家系図（Groq API キーが必要）
export PAPERPILOT_GROQ_API_KEY=gsk_...   # https://console.groq.com/keys (無料、30 RPM)
python paperpilot/scripts/build_lineage.py --conference iclr-2026 --limit 1  # スモーク
python paperpilot/scripts/build_lineage.py --conference iclr-2026            # 全 Oral
```

`docs/` 以下は Cloudflare Pages が自動デプロイします（リポジトリの GitHub 連携経由。`collect-weekly.yml` が docs/ を push すると Cloudflare が push をフックしてデプロイ）。ブラウザから `index.html` / `lineage.html` にアクセスできます。キャッシュ / セキュリティヘッダは `docs/_headers` で制御。

### LLM プロバイダの優先順位

`build_lineage.py` は `PAPERPILOT_GROQ_API_KEY` を優先し、無ければ `PAPERPILOT_GEMINI_API_KEY` にフォールバックします。1 Oral 論文あたり最大 30 件の引用関係を分類するため、無料枠を考えると Groq 推奨です。

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

## GitHub Actions（2 系統運用）

### 1. 週次深掘り — `.github/workflows/collect-weekly.yml`

毎週土曜 07:00 JST（Fri 22:00 UTC）実行。フル機能で CSV/JSON 生成 + commit。

- `paperpilot/config.yaml` を参照
- Stage 0〜4 フル稼働（LLM 有効時は Ollama/Gemini/Claude で日本語要約）
- 先週 1 週間の引用数・Stars・venue 情報が熟成した状態で総合ランキング

### 2. 毎日の著者ウォッチ — `.github/workflows/collect-daily-watch.yml`

毎朝 07:00 JST（22:00 UTC）実行。`follow_authors` / `follow_orgs` にヒットした論文だけ Slack 通知。

- `paperpilot/config.daily-watch.yaml` を参照
- LLM / citation 無効（day-1 では意味なし）
- 1 日窓 + 3 日 seen-ids で同じ論文の連続通知を防止

### Secrets（オプション）

| 名前 | 用途 |
|------|------|
| `GH_PAT` | GitHub API 用 PAT（未設定時は `github.token` を使用） |
| `S2_API_KEY` | Semantic Scholar API |
| `OPENALEX_EMAIL` | OpenAlex polite-pool |
| `GEMINI_API_KEY` | Gemini プロバイダ（Stage 4 + lineage 分類） |
| `CLAUDE_API_KEY` | Claude プロバイダ（Stage 4） |
| `GROQ_API_KEY` | Groq プロバイダ（lineage 分類の第一候補、無料枠 30 RPM） |
| `SLACK_WEBHOOK_URL` | Slack 通知 + 失敗通知 |

## ディレクトリ構成

```
automatic-paper-search/
├── docs/
│   ├── _headers            # Cloudflare Pages キャッシュ / セキュリティヘッダ
│   ├── iclr-2026/          # Cloudflare Pages 家系図ビュー（本命出力）
│   │   ├── index.html      # 論文一覧（papers.json）
│   │   ├── lineage.html    # 家系図（lineage.json）
│   │   └── {papers,lineage}.json
│   └── assets/             # 共通 CSS/JS
└── paperpilot/
    ├── collector.py        # CLI エントリ
    ├── config.yaml         # 検索設定（秘匿情報なし）
    ├── .env.example        # 環境変数テンプレート
    ├── pipeline/           # Stage 0〜4 の実装
    ├── sources/            # arXiv / S2 / OpenAlex
    ├── signals/            # venue / citation / author / github / keyword / follow
    ├── exporters/          # CSV / JSON / Slack / Email
    ├── llm/                # Ollama / Gemini / Claude / Groq
    ├── scripts/            # build_summary_csv / build_pages / build_lineage / sync_to_sheets
    ├── models/paper.py     # 論文データモデル
    ├── utils/              # config_loader, dedup, http, rate_limiter, logger
    ├── data/               # seen_ids.json, run_history.jsonl, lineage-cache/
    ├── output/             # papers_YYYY-MM-DD.{csv,json}
    └── logs/               # paperpilot.log
```

## 拡張ポイント

- **新しい Source の追加**: `sources/base.py` の `AbstractSource` を継承し `fetch()` を実装
- **新しい Signal の追加**: `signals/base.py` の `AbstractSignal` を継承し `enrich_one()` または `enrich_batch()` を実装
- **新しい Exporter の追加**: `exporters/base.py` の `AbstractExporter` を継承し `export()` を実装
- **新しい LLMProvider の追加**: `llm/base.py` の `AbstractLLMProvider` を継承し `evaluate_batch()` を実装（家系図分類にも対応したい場合は `classify_relation()` も）

詳細は [`docs/design/`](docs/design/) の基本設計書 v2.1 を参照。

## ライセンス

MIT
