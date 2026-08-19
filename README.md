# PaperPilot

AI/ML 論文を arXiv / Semantic Scholar / OpenAlex から自動収集し、品質シグナルで絞り込んだ上で **系譜（家系図）として可視化** するパイプライン。補助出力として CSV / JSON / Slack / Email にも配信できます。

**主要な出力:** GitHub Pages 上のインタラクティブ家系図ビュー（`docs/<conference>/lineage.html`、`.github/workflows/pages.yml` でデプロイ）。サイト上のフォームから新規テーマ投稿 → CF Worker (`worker/index.ts`) が validate + dedup + rate-limit してから `theme-on-demand.yml` を直接 dispatch して生成。
LLM が論文間の引用関係を 7 種類 (`supersedes` / `successor` / `extends` / `ablation` / `baseline_only` / `contrasts` / `unrelated`) に分類し、先行研究と後継研究を一枚の SVG で俯瞰できます。

**3 つの自動実行モード + 1 つの手動メンテナンス**（GitHub Actions）：
- **週次深掘り**（Sat 7:00 JST、`collect-weekly.yml`）— 収集 → スコアリング → summary.csv → papers.json → lineage.json の全工程を回す
- **毎日の著者ウォッチ**（07:00 JST 毎日、`collect-daily-watch.yml`）— フォロー中の研究者の新作を公開 0 秒後に通知（lean、LLM 不使用）
- **オンデマンドテーマ生成**（フォーム経由、`theme-on-demand.yml`）— サイト上のフォームから新テーマを 1 件だけ生成、CF Worker `worker/index.ts` 経由で直接 `theme-on-demand.yml` を dispatch。`/themes/` ギャラリーは **このフォーム経由で生成されたテーマだけ** を表示する
- **手動バルク再生成**（`regen-themes.yml` の `workflow_dispatch` のみ）— LLM 契約変更や lineage 形式バンプ等のメンテナンス用ブレークグラス。通常は使わない（PR #261 で週次 cron を廃止）

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
- **学会横断検索** — トップページ（`docs/index.html`）の検索ボックスから 10 学会 28,300 本を横断検索。索引は `docs/search-index.json`（gzip 約 0.72 MB、`paperpilot/scripts/build_search_index.py` が生成）で、検索結果から各学会カタログの該当論文へ遷移する
- **グローバルナビ** — `docs/` 配下の全 17 ページが `<nav class="site-nav">`（探す / テーマ系譜 / 仕組み）を共有
- **アセット版数の自動同期** — `paperpilot/scripts/sync_asset_versions.py` が CSS/JS の内容ハッシュから `?v=` を付け替え、`docs/assets/versions.json` を唯一の真実源として全 HTML に書き戻す。手で `?v=` を書き換えない

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

`docs/` 以下は GitHub Pages が自動デプロイします（`develop` への push を `.github/workflows/pages.yml` がフック、`docs/**` 変更時のみ起動）。ブラウザから `index.html` / `lineage.html` にアクセスできます。テーマ追加のリクエストは GitHub Issue (`theme-request` テンプレ) で受け付け、運用者が `gh workflow run theme-on-demand.yml --ref develop -f theme="..."` を手動で叩いて生成 → 自動コミット → GH Pages 再デプロイ、の流れです。

### LLM プロバイダの優先順位

`build_lineage.py` は `PAPERPILOT_GROQ_API_KEY` を優先し、無ければ `PAPERPILOT_GEMINI_API_KEY` にフォールバックします。1 Oral 論文あたり最大 30 件の引用関係を分類するため、無料枠を考えると Groq 推奨です。

### テーマで時系列家系図を生成（任意）

学会単位ではなく **任意の研究テーマ**（例: `Mixture of Experts`, `RAG`, `Direct Preference Optimization`）から、時系列を Y 軸にした家系図を生成できます。出力は `docs/themes/<slug>/lineage.json` に置かれ、`docs/themes/index.html` のピッカーから切り替えられます。

```bash
# 1. テーマから家系図 JSON を生成（CLI 事前生成、再実行は cache 経由で高速）
uv run python -m paperpilot.scripts.build_theme_lineage \
    --theme "Mixture of Experts" --depth 2 --seeds 8

uv run python -m paperpilot.scripts.build_theme_lineage \
    --theme "Direct Preference Optimization" --depth 2 --seeds 8

# 2. ピッカー用マニフェストを再生成
uv run python -m paperpilot.scripts.generate_themes_manifest \
    --themes-dir docs/themes
```

主なフラグ:

| フラグ | 既定 | 説明 |
|---|---|---|
| `--theme STR` | (必須) | 自由文字列。500 字以内、制御文字は除去される |
| `--depth N` | 2 | 各 seed から祖先方向の BFS 深さ |
| `--seeds N` | 8 | テーマ検索結果から焦点とする論文数 |
| `--width N` | 8 | 1 hop あたり保持する親論文数（cost 制御） |
| `--since-year YYYY` | なし | この年以降の論文のみ採用 |

ビューアは Y 軸が「年（rank-based 等間隔: 出現年だけが等間隔で並ぶ）」、X 軸が引用数順の chronological tree です。エッジ色は `supersedes / successor / extends / ablation / baseline / contrasts` の関係種別ごとに分かれます。

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
│   ├── index.html          # ランディング（学会一覧 + サイト横断検索）
│   ├── 404.html            # GH Pages の SPA フォールバック
│   ├── conferences.json    # 全学会の集約インデックス
│   ├── search-index.json   # 横断検索インデックス（28,300 件・gzip 約 0.72 MB）
│   ├── sitemap.xml         # サイトマップ
│   ├── <10 学会>/          # iclr-2026/ cvpr-2025/ cvpr-2026/ neurips-2025/ icml-2025/ ...
│   │   └── index.html, lineage.html, {papers,lineage}.json
│   ├── themes/             # テーマ家系図（3 本公開 + 投稿フォーム）
│   ├── how-it-works/       # サイトの仕組み
│   ├── research/           # 市場調査レポート
│   ├── design/             # 基本設計書
│   ├── daily/              # papers.json のみ。⚠️ どの HTML/JS からも参照が無い死データ（2026-08-20 実測）
│   └── assets/             # CSS / JS / 画像 / versions.json
└── paperpilot/
    ├── collector.py        # CLI エントリ
    ├── config.yaml         # 検索設定（秘匿情報なし）
    ├── .env.example        # 環境変数テンプレート
    ├── pipeline/           # Stage 0〜4 の実装
    ├── sources/            # arXiv / S2 / OpenAlex
    ├── signals/            # venue / citation / author / github / keyword / follow
    ├── exporters/          # CSV / JSON / Slack / Email
    ├── llm/                # Ollama / Gemini / Claude / Groq
    ├── scripts/            # ビューア・索引生成（全 27 本。主要: build_summary_csv /
    │                       # build_pages / build_lineage / build_deep_lineage /
    │                       # build_theme_lineage / build_search_index / sync_asset_versions /
    │                       # generate_{deep,themes}_manifest。詳細は paperpilot/scripts/README.md）
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
