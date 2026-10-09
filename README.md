# PaperPilot

AI/ML 論文を arXiv / Semantic Scholar / OpenAlex から集め、品質シグナルで絞り込み、**系譜（家系図）として見せる**ツールです。補助出力として CSV / JSON / Slack にも配信できます。

**主な出力:** 10 学会・28,300 本の横断検索と学会別カタログ（静的サイト）。サイトのフォームから新しいテーマを投稿すると、API（`apps/api`）が検査・重複確認・回数制限をしてから `theme-on-demand.yml` を起動し、テーマの家系図を作ります。
論文の系譜は、品質監査・artifact hash・strict schema の条件をすべて満たしたものだけを表示します。今のデータには条件を満たす系譜がないため、系譜の画面は「準備中」で閉じています（fail closed）。

> **移行中の注意（2026-10-07）:** Python から TypeScript への移行の最終段（P5）です。このブランチ（`p5/consolidate`）は TypeScript だけの構成です。本番（`develop`）はまだ旧構成（GitHub Pages・旧 Worker・Python の workflow）で動いています。切替の手順は [`docs/migration/p5-plan.md`](docs/migration/p5-plan.md)、全体の設計は [`docs/design/39-typescript-cloudflare-migration.md`](docs/design/39-typescript-cloudflare-migration.md) を見てください。

**運用の形**（GitHub Actions。schedule で動くのは Lighthouse だけで、ほかは手動かフォームから起動）:
- **週次深掘り**（`collect-weekly.yml`）— 収集 → スコア → summary.csv → papers.json → lineage.json の全工程
- **毎日の著者ウォッチ**（`collect-daily-watch.yml`）— フォロー中の研究者の新作を Slack に通知する軽い経路（LLM なし）
- **テーマ生成**（`theme-on-demand.yml`）— サイトのフォームから 1 テーマだけ作る
- **学会カタログの追加**（`conference-on-demand.yml`）— arXiv の自己申告から新しい学会カタログを作る
- **一括再生成**（`regen-themes.yml`）— LLM の契約や家系図の形式を変えたときの保守用

## 特徴

- **5 段のパイプライン**
  - Stage 0: arXiv + Semantic Scholar + OpenAlex から並列に収集
  - Stage 1: ルールでの絞り込み（カテゴリ・日付・除外語・既出）
  - Stage 2: 品質シグナル（venue / citation / author / GitHub Stars / keyword / **follow**）でスコア
  - Stage 3: Embedding 類似度（TypeScript 版では未対応。有効にすると記録して続行）
  - Stage 4: **LLM による並べ替えと日本語要約**（Ollama / Gemini / Claude / Groq）
- **家系図ビューア** — 監査に合格した関係だけを表示します。学会ごとの家系図に加え、一論文の Focus View（`/lineage/?paper=<paper_id>`）があります。公開用の pilot index は今は空です。
- **FollowSignal** — 決めた研究者・組織の新作を初日から上位に出します。
- **プラグイン構造** — Source / Signal / Exporter / LLM provider は、決まったインターフェースを実装するだけで足せます。
- **設定で動く** — `data/config/config.yaml` でキーワード・カテゴリ・重み・LLM・フォローする研究者を変えます。
- **秘密の分離** — API キーは環境変数だけに置きます（`config.yaml` に書かない）。
- **冪等** — 既出の論文は seen_ids で除きます。同じ設定で 2 回動かしても重複しません。
- **失敗に強い** — 外部 API が落ちてもその部品だけ飛ばして続けます。失敗は実行履歴に残します。
- **学会横断検索** — トップページでタイトル・著者・タグを 2 文字以上入れると、学会・年・発表種別で絞り込めます。条件付き URL の共有、20 件ずつの表示、ブラウザの「戻る」に対応します。要旨全文・日本語の概念検索は未対応です。索引は `data/published/search-index-v2.json` で、canonical paper ID から学会カタログの該当カードへ移動します。

## 必要環境

- Node.js 22 以上
- pnpm 10.34.6（`package.json` の `packageManager` で固定。corepack で有効にするか `npx --yes pnpm@10.34.6 …`）
- 任意: GitHub Personal Access Token（GitHub API の上限を 60 → 5,000 req/h に上げる）

Python・uv・Docker はもう使いません。

## セットアップ

```bash
corepack enable                    # 使えなければ npx --yes pnpm@10.34.6 install --frozen-lockfile
pnpm install --frozen-lockfile
cp data/config/.env.example data/config/.env   # 使う API キーだけ埋める（git には入らない）
```

## よく使うコマンド

```bash
# 検証
pnpm exec biome check .
pnpm -r typecheck
pnpm --filter @paperpilot/web build      # apps/web/out に静的書き出し（契約テストの一部が使う）
pnpm -r test

# 収集（Stage 0〜4）
pnpm exec tsx apps/pipeline/src/collect/cli.ts --config data/config/config.yaml
pnpm exec tsx apps/pipeline/src/collect/cli.ts --config data/config/config.yaml --days 3
pnpm exec tsx apps/pipeline/src/collect/cli.ts --config data/config/config.yaml --keyword "diffusion model"
pnpm exec tsx apps/pipeline/src/collect/cli.ts --config data/config/config.yaml --full       # seen_ids を無視
pnpm exec tsx apps/pipeline/src/collect/cli.ts --config data/config/config.yaml --skip-llm   # Stage 4 を飛ばす

# サイトをローカルで見る
pnpm --filter @paperpilot/web dev
```

- `--config` は必ず渡してください。CLI の既定値はまだ旧パス（`paperpilot/config.yaml`）を指しています。
- 出力は `data/inputs/papers_YYYY-MM-DD.{csv,json}` です。同じ日のファイルがあれば上書きせず、`papers_YYYY-MM-DD-HHMMSS.*` という別名で足します。CSV の出力先を学会のフォルダ（`data/inputs/<conf>/`）にしないでください。カタログの道具は素の `papers_YYYY-MM-DD.csv` しか読まないので、別名のファイルは黙って無視されます。

## 学会カタログを作る・更新する

収集元は学会によって使い分けます。arXiv 以外の収集器は出力先を `PAPERPILOT_OUTPUT_ROOT` で受け取ります。

```bash
# arXiv の自己申告（採択の 3〜4 割の部分収録。どの学会でも可）
pnpm exec tsx apps/pipeline/src/conference/arxiv/cli.ts --conference <slug> --venue <TOKEN> \
  --query 'co:"<Conf Year>"' --max 1600 --output-root data/inputs
# OpenReview（ICLR / NeurIPS / ICML の全件、Oral/Spotlight の公式ラベル付き）
PAPERPILOT_OUTPUT_ROOT=data/inputs pnpm exec tsx apps/pipeline/src/conference/openreview/cli.ts \
  --conference iclr-2026 --venue ICLR --venueid "ICLR.cc/2026/Conference"
# CVF Open Access（CVPR / ICCV の全件）
PAPERPILOT_OUTPUT_ROOT=data/inputs pnpm exec tsx apps/pipeline/src/conference/cvf/cli.ts \
  --conference cvpr-2025 --venue CVPR --cvf-id CVPR2025 --oral-arxiv-query 'co:"CVPR 2025"'
# ACL Anthology（ACL / EMNLP / NAACL の全件）
PAPERPILOT_OUTPUT_ROOT=data/inputs pnpm exec tsx apps/pipeline/src/conference/acl/cli.ts \
  --conference acl-2025 --venue ACL --xml-id 2025.acl --oral-arxiv-query 'co:"ACL 2025"'

# summary → ページ → 横断検索の索引
pnpm exec tsx apps/pipeline/src/catalog/buildSummaryCli.ts --conference <slug>
pnpm exec tsx apps/pipeline/src/catalog/buildPagesCli.ts        # --conference なしで conferences.json も作り直す
pnpm exec tsx apps/pipeline/src/release/derived/searchIndexCli.ts
# 新しい学会なら、表示名と紹介文を書く（data/config/conference-copy/<slug>.json）
DISPLAY="<Display>" LEDE="<lede>" pnpm exec tsx apps/pipeline/src/conference/scaffold/cli.ts --conference <slug>
```

公開済みより件数・Oral 数が減る、論文が消える、要旨・著者が空になる場合、`buildPagesCli` は何も書かずに止まります。意図した変更だけ `--allow-shrink-for <slug>` で通します。

## 家系図

```bash
# 学会の家系図（S2 + LLM。arxiv_id が要る）
pnpm exec tsx apps/pipeline/src/lineage/conference/buildLineageCli.ts --conference iclr-2026
# 学会の家系図（OpenAlex のみ、LLM 不要。arxiv_id の無い学会向け）
pnpm exec tsx apps/pipeline/src/lineage/conference/buildConferenceLineageCli.ts --conference cvpr-2025
# テーマの家系図（workflow と同じ指定）
pnpm exec tsx apps/pipeline/src/lineage/theme/cli.ts --theme "Vision Transformer" \
  --primary-source openalex --llm-strict ambiguous
pnpm exec tsx apps/pipeline/src/lineage/theme/generateThemesManifestCli.ts
```

- LLM の鍵は `PAPERPILOT_GROQ_API_KEY` を優先し、無ければ `PAPERPILOT_GEMINI_API_KEY` を使います。無料枠なら Groq を勧めます。
- テーマ CLI の主なフラグ: `--theme`（必須）、`--depth`（既定 2）、`--seeds`（既定 8）、`--width`（既定 8）、`--since-year`、`--primary-source`（`s2` / `openalex`、既定 `s2`）、`--llm-strict`（`off` / `ambiguous` / `all`、既定 `off`）。
- 家系図の JSON は builder だけが作ります。手で編集しません。
- テーマのビューアは Y 軸が年、X 軸が引用数順です。辺の色は関係の種別（`supersedes` / `successor` / `extends` / `ablation` / `baseline_only` / `contrasts`）で分かれます。

### Stage 4 をローカルの Ollama で使う（任意）

[Ollama](https://ollama.com) を入れ、モデル（例: `ollama pull qwen2.5:7b`）を取得し、`ollama serve` で起動します。そのあと `data/config/config.yaml` を `llm.enabled: true`・`llm.provider: ollama` にします。

## 設定（`data/config/config.yaml`）

```yaml
search:
  keywords: [large language model, retrieval augmented generation]
  categories: [cs.LG, cs.AI, cs.CL]
  days_back: 7

weights:
  venue: 3.0
  github: 2.0
  citation: 1.5
  author: 1.0
  keyword: 0.5
  embedding: 2.5
  follow: 3.5

llm:
  enabled: false
  provider: ollama   # ollama / gemini / claude / groq
```

実物はもっと項目があります（`sources`・`signals`・`pipeline`・`output`・`incremental` など）。毎日のウォッチ用は `data/config/config.daily-watch.yaml`（LLM・citation なし）です。

## スコアリング

各シグナルを 0〜100 に正規化し、`weights` で重み付けした合計が `total_score` になります。

| シグナル | 出典 | 正規化 |
|---|---|---|
| follow | フォローリスト | 著者一致=100 / 所属一致=50 / 不一致=0 |
| venue | arXiv の comment 欄を正規表現で解析 | Tier1=100 / Tier2=80 / Tier3=60 / Workshop=30 |
| citation | Semantic Scholar `/paper/batch` | `min(citations_per_day / saturation, 1) × 100` |
| author | Semantic Scholar `/author/batch` | `min(h_index / 50, 1) × 100` |
| github | 対応表 → GitHub 検索 → Stars | `log(stars+1) / log(10001) × 100` |
| keyword | タイトル・要旨のキーワード一致 | `min(match_count / 3, 1) × 100` |

Stage 4 を有効にすると、さらに `llm_relevance`（1..5）で並べ替えます。

## 公開と API

- **サイト:** `apps/web`（Next.js の静的書き出し）を Cloudflare Pages に出します。`pages.yml` → `pages-release.yml` が validate → build → admit → deploy → smoke → record の順に進め、検証した exact SHA だけを公開します。戻すときは `pages-rollback.yml`（作り直さず、記録済みのデプロイに戻す）。
- **API:** `apps/api`（Hono on Cloudflare Workers）。`POST /api/themes`（テーマ依頼）、`GET /api/health`（受付状態の確認）。KV の `accepting` で受付を止められ、`origin_allowlist` で呼び出し元を絞ります。回数制限は Durable Object で数えます。
- **旧 URL:** GitHub Pages には転送ページ（`legacy/redirect/`、`legacy-redirects.yml`）を置き、クエリと `#` を保って新しい URL に送ります。
- Cloudflare Pages のプロジェクト名と公開 origin はまだ仮の値です（ユーザーがプロジェクトを作ってから決める）。

## GitHub Actions

| workflow | 起動 | 内容 |
|---|---|---|
| `tests.yml` | PR、`develop`/`main` への push、手動 | Python が残っていないか、Biome、typecheck、web build、全テスト、bundle 検証 |
| `data-audit.yml` | 家系図 JSON・監査コードの push/PR、手動 | テーマ seed と家系図の品質監査 |
| `pages.yml` | `develop` の公開対象の push | `pages-release.yml` を呼ぶ |
| `pages-release.yml` | 呼び出し専用 | Cloudflare Pages への 6 段の公開と記録 |
| `pages-rollback.yml` | 手動（`ROLLBACK` 確認） | 記録済みのデプロイに戻す |
| `lighthouse.yml` | PR、毎週月曜 02:00 UTC、手動 | Core Web Vitals（警告のみ） |
| `collect-weekly.yml` | 手動 | 週次の深掘り収集 → 候補 → promote → 公開 |
| `collect-daily-watch.yml` | 手動 | 著者ウォッチ → Slack 通知 → 状態をコミット |
| `regen-themes.yml` | 手動 | テーマの一括再生成 |
| `theme-on-demand.yml` | フォーム経由・手動 | 1 テーマ生成 → promote → 公開 |
| `conference-on-demand.yml` | 手動 | 新しい学会カタログ → promote → 公開 |
| `legacy-redirects.yml` | 手動（`REDIRECT` 確認） | 旧 GitHub Pages に転送サイトを出す |

収集の 2 本は `--fail-on-errors` で動きます（取得元や出力の失敗、不完全なキーワードで exit 1）。シグナルの劣化は失敗にせず、実行履歴の `degraded_signals` に残します。daily-watch は失敗した run でも出力・`data/state/seen_ids.daily.json`・`data/state/run_history.daily.jsonl` をコミットします（コミットしないと同じ論文を再通知するため）。weekly は失敗時に `data/state/run_history.jsonl` を artifact に残します。

### Secrets

| 名前 | 用途 |
|---|---|
| `GH_PAT` | daily-watch の push（無ければ `github.token`） |
| `OPENALEX_EMAIL` | OpenAlex polite pool |
| `PAPERPILOT_S2_API_KEY`（旧名 `S2_API_KEY` も可）/ `GEMINI_API_KEY` / `CLAUDE_API_KEY` / `GROQ_API_KEY` | 週次収集の取得元・LLM |
| `PAPERPILOT_GROQ_API_KEY` / `PAPERPILOT_S2_API_KEY` | テーマ家系図（`PAPERPILOT_S2_API_KEY` は週次収集と共通） |
| `SLACK_WEBHOOK_URL` | 通知と失敗通知 |
| `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` | Pages の公開・戻し（environment `cloudflare-pages-deploy` に置く） |

## ディレクトリ構成

```
automatic-paper-search/
├── apps/
│   ├── web/          # Next.js 静的書き出し（Cloudflare Pages）
│   ├── api/          # Hono on Cloudflare Workers（テーマ依頼 API）
│   └── pipeline/     # 収集（collect/）、学会収集器（conference/）、カタログ（catalog/）、
│                     # 家系図（lineage/）、公開道具（release/）
├── packages/core/    # 共有のデータ形式・zod スキーマ・データ配置の切替・slug・identity
├── schemas/          # JSON Schema（正本）
├── data/
│   ├── published/    # サイトが配信する JSON（conferences.json、search-index-v2.json、<学会>/、themes/）
│   ├── state/        # seen_ids、run_history、lineage-cache
│   ├── inputs/       # 収集器の CSV/JSON
│   └── config/       # config.yaml、config.daily-watch.yaml、denylist・alias、.env.example
├── legacy/redirect/  # 旧 GitHub Pages の転送サイト
├── docs/             # design/（設計書）、migration/（移行の記録）、research/（市場調査）
└── .github/          # workflows/（12 本）、actions/setup-pnpm/
```

## 拡張ポイント

- **Source:** `apps/pipeline/src/collect/sources/source.ts` の `Source` を実装し、`collect/runner.ts` の `buildSources()` に登録
- **Signal:** `collect/signals/signal.ts` の `BaseSignal` を継承して `enrichOne()` か `enrichBatch()` を実装し、`buildSignals()` に登録
- **Exporter:** `collect/exporters/exporter.ts` の `Exporter` を実装し、`buildExporters()` に登録
- **LLM provider:** `collect/llm/provider.ts` の `LLMProvider` を `lineage/llm/` に実装し、`collect/runtime/llmProvider.ts` に登録

開発のルールは [`CLAUDE.md`](CLAUDE.md)、設計は [`docs/design/`](docs/design/) を見てください。

## ライセンス

MIT
