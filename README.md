# PaperPilot

AI/ML 論文を arXiv / Semantic Scholar / OpenAlex から自動収集し、品質シグナルで絞り込んだ上で **系譜（家系図）として可視化** するパイプライン。補助出力として CSV / JSON / Slack / Email にも配信できます。

**主要な出力:** GitHub Pages 上の10学会・28,300件の横断検索と学会別カタログ。サイト上のフォームから新規テーマ投稿 → CF Worker (`worker/index.ts`) が validate + dedup + rate-limit してから `theme-on-demand.yml` を直接 dispatch して生成します。
論文系譜は引用・分類結果をそのまま公開せず、品質監査、artifact hash、strict schemaの全条件を満たしたcollectionだけを表示します。現在のsnapshotには公開条件を満たす系譜がないため、系譜UIは準備中としてfail closedです。

**3 つの運用モード + 1 つの手動メンテナンス**（GitHub Actions）：
- **週次深掘り**（現在は手動起動のみ、`collect-weekly.yml`）— 収集 → スコアリング → summary.csv → papers.json → lineage.json の全工程を回す（旧 Sat 7:00 JST の schedule は停止中）
- **毎日の著者ウォッチ**（現在は手動起動のみ、`collect-daily-watch.yml`）— フォロー中の研究者の新作を通知する lean 経路（LLM 不使用、旧 07:00 JST の schedule は停止中）
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
- **学会横断検索** — トップページ（`docs/index.html`）の検索ボックスから 10 学会 28,300 本を横断検索。現行索引は `docs/search-index-v2.json`（`paperpilot/scripts/build_search_index.py` が生成）で、canonical paper IDから各学会カタログのselected cardへ遷移する。`search-index.json`は互換artifactとして残る
- **グローバルナビ** — `docs/` 配下の全 27 HTML が `<nav class="site-nav">`（探す / テーマ系譜 / 仕組み）を共有
- **アセット版数の自動同期** — `paperpilot/scripts/sync_asset_versions.py` が CSS/JS の内容ハッシュから `?v=` を付け替え、`docs/assets/versions.json` を唯一の真実源として全 HTML に書き戻す。手で `?v=` を書き換えない

## 必要環境

- Docker Engine / Docker Desktop と Docker Compose
- wrapper起動用のホストPython 3.10+（依存packageは不要）
- 承認済みの digest 固定 base image（Python 3.12 / uv 0.12.7 / Node 20）
- 任意で GitHub Personal Access Token（API レート制限を 60 → 5,000 req/h に拡大）

ホストPythonは安全なDocker wrapperのpreflightに使います。ホスト`uv`はlock更新や短い補助checkだけに使い、
production実行と統合testの正規経路はDockerへ移行します。現時点のGitHub Actionsはまだ`uv`経路で、
approved imageによるruntime/CI shadow gate後に移行します。完全な境界は [`docker/README.md`](docker/README.md) を参照してください。

## セットアップ

```bash
# placeholderをローカル用ファイルへコピー
cp docker/docker-env.example .env.docker

# 各placeholderを、別途承認して明示取得したrepository@sha256へ置換してからexport
set -a
. ./.env.docker
set +a

# canonical wrapperは暗黙pullを行わない
docker/paperpilot-compose build collector
```

`.env.docker`はbase image digestなどの非秘密入力専用です。API keyはそこへ書かず、必要な名前だけを
`docker/paperpilot-compose run --env NAME ...`で渡します。現在のchecked-in exampleは意図的に無効であり、
承認済みdigest setと実image buildはまだ完了していません。

## 実行

```bash
# デフォルト設定で実行
docker/paperpilot-compose run --rm --no-deps collector

# 過去3日間のみ
docker/paperpilot-compose run --rm --no-deps collector \
  --config /etc/paperpilot/config.yaml --days 3

# キーワードを追加
docker/paperpilot-compose run --rm --no-deps collector \
  --config /etc/paperpilot/config.yaml --keyword "diffusion model"

# seen_ids を無視して再出力
docker/paperpilot-compose run --rm --no-deps collector \
  --config /etc/paperpilot/config.yaml --full

# LLM 評価（Stage 4）を一時的にスキップ
docker/paperpilot-compose run --rm --no-deps collector \
  --config /etc/paperpilot/config.yaml --skip-llm

# approved images取得後に実行するDocker統合test（現時点では未実施）
docker/paperpilot-compose build test node-test
docker/paperpilot-compose run --rm --no-deps test
docker/paperpilot-compose run --rm --no-deps node-test

# GitHub Pagesと同じproject baseでローカルpreview
docker/paperpilot-compose build site-preview
docker/paperpilot-compose --profile preview up --no-build site-preview
# http://127.0.0.1:8137/automatic-paper-search/
```

ホスト上の`uv run`は、Docker imageを作る前の高速な補助checkには使えますが、Docker gateの代替にはしません。

### Replay Lite（Identity Lite のオフライン再検証）

Replay Lite R0 は、retention 内の凍結入力と `run-manifest-v1` を検証し、登録済みの
`identity-lite-v1` projector が同じ出力 byte を生成することをネットワークなしで確認します。
リポジトリ内の fixture は次のコマンドで再生できます。

```bash
docker/paperpilot-compose run --rm --no-deps test \
  /opt/paperpilot/bin/python -I -m paperpilot.scripts.replay_run \
  --manifest paperpilot/tests/fixtures/replay-lite-r0/manifest.json \
  --repo-root paperpilot/tests/fixtures/replay-lite-r0/repository \
  --artifact-root paperpilot/tests/fixtures/replay-lite-r0/bundle \
  --output-dir /tmp/replay-output \
  --now 2026-08-30T00:00:00Z
```

`--output-dir` は存在しないか空である必要があります。CLI は manifest、lock hash、artifact の
期限・size・SHA-256、生成後の全 output hash を検証し、全件一致した場合だけ出力ディレクトリを
atomic publish します。collector、外部 API、LLM、manifest に書かれた任意 command は実行せず、
retention 外や未登録 projector の replay は保証しません。失敗時は stable な `REPLAY_*` code を
標準エラーへ出して非ゼロ終了します。完全な契約は
[`docs/design/15-replay-lite-contract.md`](docs/design/15-replay-lite-contract.md) を参照してください。

## Stage 4 (LLM rerank) — Ollama セットアップ（任意）

Stage 4 を使うと LLM が各論文に `relevance (1-5) / 日本語要約 / 読むべき理由 / タグ` を付与し、関連度順にリランクします。完全ローカルで無料動作する **Ollama** を推奨します。これはPaperPilot製品runtimeの任意設定であり、リポジトリの実装・レビューagentは [`PAPERPILOT_PROFILE.md`](PAPERPILOT_PROFILE.md) のGPT-5.6 Sol経路を使います。

> 以下はホスト補助経路です。Docker-first phase 1ではcollectorからhost上の`localhost:11434`へ接続する
> 経路をまだ認可していないため、Ollamaをproduction Docker経路としては未検証です。

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
docker/paperpilot-compose run --rm --no-deps ops \
  -m paperpilot.scripts.build_summary_csv --conference iclr-2026
docker/paperpilot-compose run --rm --no-deps ops \
  -m paperpilot.scripts.build_pages --conference iclr-2026
```

外部API/LLMを使う`build_lineage`は、credentialを持たない`ops`（network none）の責務外です。Docker-first phase 1には
networked operator targetがまだないため、これをcanonicalなローカル実行としては案内しません。workflow移行と同じ
明示承認gateで専用targetを追加します。

`docs/` 以下は GitHub Pages が自動デプロイします（`develop` への push を `.github/workflows/pages.yml` がフックし、公開対象変更時だけexact-SHA検証・releaseを実行）。ブラウザからカタログを利用でき、テーマ追加は `/themes/` のフォームからCF Worker経由で依頼できます。完了確認は公開 `themes-manifest.json` をpollingします。PAT付きGitHub runs APIを読むstatus endpointは、原子的quota/cacheを実装するまで休眠中です。

### LLM プロバイダの優先順位

`build_lineage.py` は `PAPERPILOT_GROQ_API_KEY` を優先し、無ければ `PAPERPILOT_GEMINI_API_KEY` にフォールバックします。1 Oral 論文あたり最大 30 件の引用関係を分類するため、無料枠を考えると Groq 推奨です。

### テーマで時系列家系図を生成（任意）

学会単位ではなく **任意の研究テーマ**（例: `Mixture of Experts`, `RAG`, `Direct Preference Optimization`）から、時系列を Y 軸にした家系図を生成できます。出力は `docs/themes/<slug>/lineage.json` に置かれ、`docs/themes/index.html` のピッカーから切り替えられます。

テーマ探索本体は外部API/LLMを使うため、Docker-first phase 1のcredential-free `ops`では実行しません。既存artifactから
ピッカー用manifestだけを決定的に再生成する場合は次を使います。

```bash
docker/paperpilot-compose run --rm --no-deps ops \
  -m paperpilot.scripts.generate_themes_manifest --themes-dir docs/themes
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

## GitHub Actions

> ⚠️ **定期実行されているのは `lighthouse.yml`（毎週月曜 02:00 UTC）だけです**（2026-08-20 実測）。
> 下の 2 つの収集ワークフローは **#245（2026-06-04）で cron を外し、手動実行専用**になりました。
> テーマ家系図へスコープを絞った際に「会議カタログ収集と著者ウォッチはテーマ生成に寄与しない」と
> 判断されたためで、ワークフロー自体は残してあるので `workflow_dispatch` でいつでも回せます。
> 実測の最終実行は collect-weekly が 2026-05-29、collect-daily-watch が 2026-06-02。
> ∴ `docs/` のカタログは **`generated: 2026-06-28` で凍結**しています。

### 1. 週次深掘り — `.github/workflows/collect-weekly.yml`

**手動実行のみ**（`workflow_dispatch`。旧: 毎週土曜 07:00 JST ＝ Fri 22:00 UTC、#245 で廃止）。
フル機能で生成し、credential-free candidateを作成してからlatest `develop`へCAS promotionし、promoted exact SHAをreleaseします。

- `paperpilot/config.yaml` を参照
- Stage 0〜4 フル稼働（LLM 有効時は Ollama/Gemini/Claude で日本語要約）
- 先週 1 週間の引用数・Stars・venue 情報が熟成した状態で総合ランキング

### 2. 毎日の著者ウォッチ — `.github/workflows/collect-daily-watch.yml`

**手動実行のみ**（`workflow_dispatch`。旧: 毎朝 07:00 JST ＝ 22:00 UTC、#245 で廃止）。
`follow_authors` / `follow_orgs` にヒットした論文だけ Slack 通知。

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
│   ├── search-index-v2.json # 現行の横断検索インデックス（28,300 件）
│   ├── sitemap.xml         # サイトマップ
│   ├── <10 学会>/          # iclr-2026/ cvpr-2025/ cvpr-2026/ neurips-2025/ icml-2025/ ...
│   │   └── index.html, lineage.html, {papers,lineage}.json
│   ├── themes/             # テーマartifact 3本 + 投稿フォーム（表示eligibleは現在0件）
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
    ├── scripts/            # ビューア・索引生成（全 33 Python scripts。主要: build_summary_csv /
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
