# CLAUDE.md — PaperPilot 実装ガイド

本ファイルは **Claude Code** がこのプロジェクトで作業するときの指示書。Claude Code での実装・レビュー・commit/push の承認境界は本ファイルが正本。`AGENTS.md` / `PAPERPILOT_PROFILE.md` / `.codex/` の Codex CLI・Qwen の運用は別ツール向けで、Claude Code には適用しない（残すか消すかは判断待ち 8）。

> 本文は必要なタスクでのみ参照する。人手監査・科学的根拠・公開承認の gate と、下の「絶対ルール」は省略しない。

設計書は [`docs/design/`](docs/design/)、移行の記録は [`docs/migration/`](docs/migration/)。

---

## ⚠️ このブランチの状態（`p5/consolidate`）

- Python を TypeScript に移し終え、「1 プロジェクト = 1 フォルダ」に整理したブランチ。`feat/ts-migration` の上に P5 の commit B（`dataMove apply`、`83a7551`）と Tier C の削除（`24cf1c1`）を載せている。
- 削除済み: `paperpilot/`（Python 一式）、`pyproject.toml`、`uv.lock`、Docker 一式（`Dockerfile`・`docker-compose.yml`・`docker/`・`containers/`）、`tools/`、`.github/scripts/`、旧 Worker `worker/`、ルートの `wrangler.jsonc`。
- 🔴 **P5 切替の手順書（[`docs/migration/p5-runbook.md`](docs/migration/p5-runbook.md)）の「切替」の段階に来るまで、このブランチを `develop` に merge しない。** `develop` の本番は今も `worker/`（Cloudflare Workers Builds が自動デプロイ）と Python の workflow で動いている。merge すると本番の Worker と workflow が消える。
- Phase W（Worker を apps/api に切り替える段階）は、`feat/ts-migration` を develop に入れた後（Merge A）、このブランチを merge する前に行う。切替後に旧 Worker を予備として使うことはしない（2026-10-08 の決定）。
- 本番の値: Cloudflare Pages のプロジェクトは `paperpilot`、公開 origin は `https://paperpilot.pages.dev`（2026-10-09 確定）。本番ブランチは `production`（プロジェクト設定と照合済み）。値は `packages/core/src/site/config.ts` と `pages-release.yml`・`pages-rollback.yml` の env の 3 か所で揃える。

---

## プロジェクト概要

- **目的:** AI/ML 論文を arXiv / Semantic Scholar / OpenAlex から集め、品質シグナルで絞り込み、**系譜（家系図）として見せる**。
- **主な出力:** 10 学会・28,300 本の横断検索と学会別カタログ（静的サイト）。系譜は品質 manifest で fail closed し、今の表示対象は 0 件。サイトのフォームからテーマを投稿できる（`apps/api` → `theme-on-demand.yml` → 候補を作る → 最新 `develop` へ CAS で promote → その exact SHA を公開）。補助出力として CSV / JSON / Slack も残す。
- **公開先:** 移行後は Cloudflare Pages（静的書き出し）と Cloudflare Workers（API）。旧 GitHub Pages は転送ページ（`legacy/redirect/`）になる。
- **対象ユーザー:** AI/ML 研究者、R&D エンジニア、独立リサーチャー。
- **運用コスト目標:** ¥0 が基本（LLM の有料枠と独自ドメインだけが任意の費用）。
- **差別化:** OSS、YAML 設定、日本語対応、品質シグナルの統合スコア、**LLM による引用関係の意味分類**（`supersedes` / `successor` / `extends` / `ablation` / `baseline_only` / `contrasts` / `unrelated`）。

---

## 環境と道具

- **Node 22 以上**（`package.json` の `engines`。jsdom・wrangler 4 が要求。CI も Node 22）。ホストが Node 20 なら `npx --yes -p node@22 node -e 'console.log(process.execPath)'` で得た Node 22 を PATH の先頭に置く。
- **pnpm 10.34.6**（`packageManager` で固定）。corepack が使えない環境では `npx --yes pnpm@10.34.6 …`。
- **Biome**（lint・format）、**Vitest**（テスト）、**tsx**（CLI 実行）、**TypeScript 5.9**。
- Python・uv・Docker はもう使わない。

```bash
pnpm install --frozen-lockfile
pnpm exec biome check .                 # lint（error は 0 にする。warning/info は可）
pnpm -r typecheck                       # 全パッケージの型検査
pnpm -r test                            # 全テスト（Vitest）
pnpm --filter @paperpilot/web build     # 静的書き出し → apps/web/out
pnpm exec tsx apps/pipeline/src/release/cli.ts validate bundle apps/web/out
```

- テスト件数（`feat/ts-migration` 時点、2026-10-07）: core 1,845、api 214、web 887、pipeline 2,633。このブランチでは変わり得るので、報告は実行結果の数字を使う。
- `apps/web` の契約テストの一部は `apps/web/out` を読む。先に web build をしないと skip になる（`tests.yml` も build → test の順）。
- `pnpm -r test` の出力はログファイルに書いてから `Test Files|Tests` を grep する。`head` で切ると各パッケージの集計が消える。
- カバレッジ計測の道具（`@vitest/coverage-v8` など）はまだ入っていない。入れるなら依存追加の承認を取る。

---

## フォルダ構成

```
automatic-paper-search/
├── CLAUDE.md / README.md / CHANGELOG.md
├── AGENTS.md / PAPERPILOT_PROFILE.md / .codex/   # Codex CLI 向け（判断待ち 8）
├── package.json / pnpm-workspace.yaml / pnpm-lock.yaml / tsconfig.base.json / biome.json
├── .lighthouserc.json                       # staticDistDir: ./apps/web/out
├── apps/
│   ├── web/        # Next.js 静的書き出し（Cloudflare Pages）。app/・components/・lib/・scripts/・static/・test/
│   ├── api/        # Hono on Cloudflare Workers。src/{app,index,config}.ts、routes/、lib/、durable/quota-object.ts
│   │               # wrangler.jsonc（本番 paperpilot-themes）、wrangler.preview.jsonc（プレビュー、dry-run）
│   └── pipeline/   # Node の収集・生成・公開道具
│       └── src/
│           ├── collect/      # Stage 0〜4（stages/）、sources/、signals/、exporters/、llm/、state/、runner.ts、cli.ts
│           ├── conference/   # 学会収集器 acl/・arxiv/・cvf/・openreview/、scaffold/、watch/、shared/
│           ├── catalog/      # buildSummary（summary.csv）、buildPages（papers.json・conferences.json）
│           ├── lineage/      # conference/・deep/・theme/・classify/・llm/・quality/・contract/・unarxive/
│           ├── release/      # cli.ts（promote・package・commit-push・validate・marker・cf-*・gh-record・no-skip-gate）
│           │                 # derived/（searchIndex・identityLite）、dataMove/、cloudflare/、github/、git/
│           ├── parity/       # 比較ツール（compare-trees）
│           └── shared/       # lock・CLI 共通（isMain）
├── packages/
│   └── core/       # 共有のデータ形式・zod スキーマ・layout 切替・slug・identity・paths・Python 互換関数（pycompat/）・site 設定
├── schemas/        # JSON Schema（正本）
├── data/
│   ├── published/  # サイトが配信する JSON（conferences.json、search-index-v2.json、<conf>/、themes/ …）
│   ├── state/      # seen_ids.json、seen_ids.daily.json、run_history.jsonl、lineage-cache/
│   ├── inputs/     # 収集器の CSV/JSON（<conf>/、daily/、papers_YYYY-MM-DD.*）
│   └── config/     # config.yaml、config.daily-watch.yaml、denylist・allowlist・alias、.env.example
│                   # conference-copy/<slug>.json（scaffold CLI が作る、1 slug = 1 ファイル）
├── legacy/redirect/   # 旧 GitHub Pages 用の転送サイト（legacy-redirects.yml が公開）
├── docs/              # design/、migration/、research/、QWEN_IMPLEMENTER.md（配信はしない）
└── .github/
    ├── workflows/     # Node の workflow 12 本（下の表）
    └── actions/setup-pnpm/   # Node 22 + corepack + frozen install の共通 action
```

- データの置き場所はコードに直書きしない。`packages/core/src/layout/index.ts` の `layoutFor()` / `relLayout()` を使う（`LAYOUT_MODE` はこのブランチで `"p5"`）。
- `legacy/gh-pages-site/`（旧サイトの凍結コピー）は別作業で削除される予定。新しいコードから読まない。

---

## 実装ルール

### エージェント動作の基本方針

- 実装・レビューは Claude Code の `/code-review` を使う。bounded な実装は `/code-review medium`、security・provenance・schema・migration・publication-risk は `/code-review high`。`ultra` は通常使わない。
- 独立した調査・レビューは `Agent` ツールでサブエージェントに並列で任せてよい。共有の生成物・manifest・lockfile の更新は owner が直列に行う。
- workflow の dispatch、通知、Cloudflare / GitHub Pages への公開、Worker のデプロイ、KV への書き込み、secret・設定の変更、`develop` への push・merge は、ユーザーの明示承認の後だけ行う。

### 設計原則

- **Open/Closed:** 新しい Source / Signal / Exporter / LLM provider は、既存のインターフェース（`Source`・`Signal`/`BaseSignal`・`Exporter`・`LLMProvider`）を実装して足す。既存の実装は書き換えない。
- **Fail-Safe:** 外部 API の障害時はその部品を飛ばしてパイプラインを続ける。ただし失敗は必ず記録する（run_history・`--fail-on-errors`）。黙って空データにしない。
- **設定駆動:** キーワード・カテゴリ・重み・出力先は `data/config/config.yaml` で決める。
- **冪等性:** 同じ config で 2 回実行しても `seen_ids` で差分管理され、出力が重複しない。
- **秘匿分離:** API キーは環境変数（`.env` または GitHub / Cloudflare の secrets）だけ。`config.yaml` やソースに書かない。
- **1 ファイル 1 責務。** 公開 API には「なぜ」と使い方のコメントを書く。型は `strict` のまま通す（`any` で逃げない）。
- **CLI は `isMain()` で守る。** import しただけで通信や書き込みが走らないようにする（`apps/pipeline/src/shared/cli/isMain.ts`）。引数は strict に解析し、知らないフラグは exit 2。

### HTTP とエラー処理

- 収集側の HTTP は `apps/pipeline/src/collect/http/requestWithRetry.ts` を通す。429 は指数待機（2 秒から倍、上限 30 秒、最大 3 回）、5xx は 3 秒固定で最大 2 回、タイムアウトは 1 回だけ再試行。全体の期限で合計時間を抑える。
- 失敗した件は WARNING を出して飛ばし、パイプライン全体は続ける。失敗は run_history に残す。
- `fetch` は注入できる形にする（テストでモックするため）。`AbortSignal.timeout` で実際に中断する。

### 環境変数

ハードコードは禁止。ローカルでは `data/config/.env`（git 管理外。雛形は `data/config/.env.example`）に書く。`collect/config/load.ts` が `--config` と同じディレクトリから読む。

```
PAPERPILOT_GITHUB_TOKEN      # GitHub API のレート制限緩和
PAPERPILOT_S2_API_KEY        # Semantic Scholar
PAPERPILOT_OPENALEX_EMAIL    # OpenAlex polite pool
PAPERPILOT_GEMINI_API_KEY    # Gemini
PAPERPILOT_CLAUDE_API_KEY    # Claude
PAPERPILOT_GROQ_API_KEY      # Groq（系譜の関係分類）
PAPERPILOT_SLACK_WEBHOOK_URL # Slack 通知
```

- Email（SMTP）は TS 版では対応しない。`output.email.enabled: true` の run は `export:email:` として記録され失敗扱いになる（TS 版の既知の制限）。出荷済みの config はどちらも無効。
- Stage 3（embedding）も TS 版では対応しない。有効にすると `stage3:` として記録して続行する。

---

## 開発ワークフロー（プランレビュー → TDD → レビュー）

**この順序を守る。** 手戻りのコストは実装後ほど大きい。

### フェーズ 0: 調査

`gh search repos` / `gh search code` → Context7 でライブラリの docs → npm レジストリ → 最後に Exa。既存実装で 8 割以上まかなえるなら再利用を優先する。新しい依存の追加はユーザー承認が要る。

### フェーズ 1: プラン作成

TodoWrite でタスクを分け、必要なら `Agent`（`Plan`）や `EnterPlanMode` でユーザーと合意する。変更ファイルと行数の見積もり、テスト計画（RED/GREEN、モックの方針）、依存とリスクを書く。

### フェーズ 1.5: プランレビュー（着手前に必須）

コードを書く前にプランを並列レビューする。

| 観点 | 手段 |
|---|---|
| 設計の整合性・拡張性、既存パターンの遵守 | `Agent`（`general-purpose`） |
| 似た機能・重複の確認、再利用できる箇所 | `Agent`（`Explore`） |
| secrets・injection・公開リスク | `/security-review`、またはセキュリティ観点を明示した `Agent` |

確認する 10 項目:
1. 絶対ルールに反していないか
2. Stage の入出力の型を崩していないか
3. スコアの正規化式・重みを無断で変えていないか
4. API キーが環境変数に分離されているか
5. プラグインは既存インターフェースの実装になっているか
6. 外部 API 障害時に続行できる設計か（失敗は記録されるか）
7. テスト計画の粒度・モックの方針
8. CLAUDE.md・設計書・README を同時に更新する計画か
9. 既存実装との重複を確認したか
10. PR 1 本で終わるか、分けるべきか

CRITICAL / HIGH はプランを直して再レビュー。MEDIUM は注記して着手。LOW は後段で拾う。最後にユーザーに「GO / 作り直し / 縮小」を聞く。

### フェーズ 2: TDD 実装

1. **RED** — `apps/<app>/test/…` または `packages/core/test/…` に先にテストを書き、失敗を確かめる
2. **GREEN** — 最小の実装で通す
3. **REFACTOR** — 設計原則に沿って整える
4. 丸め・数値表記・並び順・時刻・正規表現は `packages/core/src/pycompat/` の関数を使う（公開データのバイト一致を保つため）

### フェーズ 3〜4: コードレビューと修正

```
/code-review medium        # bounded な実装
/code-review high          # security / provenance / schema / migration / publication-risk
/security-review           # secrets、injection、workflow、Worker、公開
```

CRITICAL / HIGH は commit 前に必ず直し、0 になるまで繰り返す。MEDIUM はできる範囲で直し、残りは報告。

### フェーズ 5: 報告、承認後の commit & push

差分・検証結果・skip・残リスクを先に報告する。ユーザーが commit / push を明示承認したときだけ、Conventional Commits で行う。

```bash
git commit -m "<type>(<scope>): <subject> (closes #N)"
git push
```

`type`: `feat` / `fix` / `refactor` / `docs` / `test` / `chore` / `perf` / `ci`

### フェーズ 6〜8: 最終確認・残項目・PR

公開リスクを含む変更は high effort で独立レビューする。残項目は報告だけにし、issue 作成・PR 作成・`develop` への merge はユーザー承認の後に行う。

### テストの方針

- **実 API を叩かない。** `fetch` を注入してモックする。LLM はキャッシュかモック。
- テストは `apps/*/test/`・`packages/core/test/` に置く。収集の e2e は `apps/pipeline/test/collect/cli.e2e.test.ts`（偽の fetch で配線全体を通す）。
- 生成済みのフィクスチャ（Python 時代の出力を含む）は消さない。期待値を手で書き換えるときは理由を書く。
- venue 検出率の境界テスト（95% 以上）は `apps/pipeline/test/collect/signals/venue.test.ts` の `test_detection_rate_above_95_percent`。

```bash
pnpm --filter @paperpilot/pipeline test                     # 1 パッケージ
pnpm --filter @paperpilot/pipeline exec vitest run test/collect/signals/venue.test.ts
```

---

## 各モジュールの仕様

### Paper（データモデル）

`apps/pipeline/src/collect/model/paper.ts` の `Paper`。全 Stage を流れる中心のデータ。必須項目（title・authors・abstract・url・published_date・source）、Stage 0 の任意項目（arxiv_id・doi・pdf_url・categories・comment）、Stage 2 の enrich 項目（venue・github・citation・author・keyword の各スコア）、`total_score`、Stage 4 の `llm_relevance`（1..5 または null）・`llm_summary_ja` などを持つ。フィールド名は Python 版と同じ（出力 CSV/JSON の互換のため）。

### スコアリング（変更禁止）

各シグナルを 0〜100 に正規化し、`weights` で重み付けした合計が `total_score`。実装は `collect/stages/metricScore.ts`、重みは `data/config/config.yaml` の `weights`。

| シグナル | 正規化式 | 既定の重み |
|---|---|---|
| follow | 著者完全一致=100 / 所属部分一致=50 / 不一致=0 | **3.5** |
| venue | Tier1=100 / Tier2=80 / Tier3=60 / Workshop=30 / 未査読=0 | **3.0** |
| embedding | cos 類似度 × 100（Stage 3 有効時のみ。TS 版は未対応） | **2.5** |
| github | `log(stars+1) / log(10001) × 100` | **2.0** |
| citation | `min(cites/day / saturation, 1) × 100`（sat=2.0） | **1.5** |
| author | `min(h_index / 50, 1) × 100` | **1.0** |
| keyword | `min(match_count / 3, 1) × 100` | **0.5** |

理論最大値: `100 × (3.5+3+2.5+2+1.5+1+0.5) = 1400`

### Stage フロー（変更禁止）

```
Stage 0: collect (並列)        → dedup                         collect/stages/collect.ts
Stage 1: rule_filter           → category ∧ since_date ∧ exclude_words ∧ ¬seen_ids   ruleFilter.ts
Stage 2: metric_score          → 各 signal.enrichBatch → total_score → top_n          metricScore.ts
(Stage 3: embedding)           → TS 版は未対応（有効にすると stage3 として記録）    embedding.ts
Stage 4: llm_rank              → provider.evaluateBatch → relevance 降順 → top_n     llmRank.ts
Export                         → CSV / JSON / Slack（Email は未対応）               collect/exporters/
State                          → seen_ids 保存 + run_history 追記                    collect/state/
```

統合は `collect/runner.ts`（`PipelineRunner`）、実行入口は `collect/cli.ts`。

### 可視化（家系図）の生成

```
data/inputs/<conf>/papers_YYYY-MM-DD.csv
  ├─ catalog/buildSummaryCli.ts      → data/inputs/<conf>/summary.csv（8 列 + 自動タグ）
  └─ catalog/buildPagesCli.ts        → data/published/<conf>/papers.json、conferences.json、要旨シャード
       ├─ release/derived/searchIndexCli.ts           → data/published/search-index-v2.json（+ search-paper-ids-v1/）
       ├─ lineage/conference/buildLineageCli.ts       → data/published/<conf>/lineage.json（S2 + LLM）
       ├─ lineage/conference/buildConferenceLineageCli.ts → 同上（OpenAlex のみ、LLM 不要の無料版）
       └─ lineage/deep/buildDeepLineageCli.ts         → data/published/<conf>/deep-*.json
            └─ lineage/deep/generateDeepManifestCli.ts → deep-manifest.json

[テーマ文字列] → lineage/theme/cli.ts → data/published/themes/<slug>/lineage.json
                  lineage/theme/generateThemesManifestCli.ts → themes-manifest.json
                  lineage/theme/computeThemeQualityCli.ts    → 品質集計
品質: lineage/quality/{buildLineageQuality,auditLineageQuality}Cli.ts、lineage/theme/auditThemeSeedsCli.ts
```

関係の種別は `supersedes` / `successor` / `extends` / `ablation` / `baseline_only` / `contrasts` / `unrelated`（`unrelated` は辺から除く）。

### プラグイン追加手順

1. 該当するインターフェースを実装する: `collect/sources/source.ts` の `Source`、`collect/signals/signal.ts` の `BaseSignal`、`collect/exporters/exporter.ts` の `Exporter`、`collect/llm/provider.ts` の `LLMProvider`（実装は `lineage/llm/` に置く）
2. テストを先に書く（`fetch` を注入するモックの形は既存テストに合わせる）
3. 実装する
4. `collect/runner.ts` の `buildSources()` / `buildSignals()` / `buildExporters()`、LLM は `collect/runtime/llmProvider.ts` の `buildLlmProviderFromConfig()` に登録する
5. `data/config/config.yaml` と `data/config/.env.example` に設定を足す

手順の詳細は `.claude/skills/add-plugin/SKILL.md`。

---

## フロントエンド（`apps/web`）

- Next.js の静的書き出し（`output: export`）。ページ: `/`（検索トップ）、`/[conf]/`（学会カタログ）、`/[conf]/lineage/`、`/[conf]/deep/`、`/[conf]/paper-links/`、`/lineage/`（一論文の Focus View）、`/themes/`、`/how-it-works/`。
- `prebuild` が `scripts/copy-data.ts` で `data/published` を `public/` に写す。`postbuild` が `strip-nojs` → `csp-hash`（ページごとのハッシュ CSP）→ `redirects`（`out/_redirects`、旧 `.html` URL の 301）→ `sitemap`（`out/sitemap.xml`）を順に実行する。
- `out/_headers` は `frame-ancestors 'self'` だけ。script の CSP はページの meta に入る。インラインスクリプトを足すときはハッシュが付くことをテストで確かめる。
- 公開 origin・API の URL（`API_BASE`）・パスの接頭辞は `packages/core/src/site/config.ts` の 1 か所だけで決める。
- テーマ投稿フォーム: `components/themes/ThemeRequestForm.tsx`、`lib/themes-request.ts`。API が止まっていれば `paused`、空打ちモードなら `dry_run` を表示する。API が無いときは GitHub Issue へ逃がす（degraded mode）。
- 見た目は旧サイトのトークン（色・文字・余白）を引き継ぐ。生の色リテラルを書かない。モバイル 320/375px で横はみ出し 0、開閉ボタンは `aria-expanded`、件数は `aria-live` を保つ。
- ローカル確認: `pnpm --filter @paperpilot/web dev`、または build 後に `apps/web/out` を静的サーバーで開く。Lighthouse は `lighthouse.yml`（warn のみ）。

---

## カタログを追加・更新する流れ

収集元は venue で使い分ける。学会収集器（arxiv 以外）は出力先を環境変数 `PAPERPILOT_OUTPUT_ROOT` で受け取る（既定値なし）。

```bash
# 1) 収集（どれか 1 つ）
#   arXiv 自己申告（部分収録、採択の 3〜4 割。どの venue でも可）
pnpm exec tsx apps/pipeline/src/conference/arxiv/cli.ts --conference <slug> --venue <TOKEN> \
  --query 'co:"<Conf Year>"' --max 1600 --output-root data/inputs
#   全件: OpenReview = ICLR/NeurIPS/ICML（Oral/Spotlight の公式ラベル付き）
PAPERPILOT_OUTPUT_ROOT=data/inputs pnpm exec tsx apps/pipeline/src/conference/openreview/cli.ts \
  --conference iclr-2026 --venue ICLR --venueid "ICLR.cc/2026/Conference"
#   全件: CVF Open Access = CVPR/ICCV。oral 区分が無いので arXiv 申告の oral を重ねる
PAPERPILOT_OUTPUT_ROOT=data/inputs pnpm exec tsx apps/pipeline/src/conference/cvf/cli.ts \
  --conference cvpr-2025 --venue CVPR --cvf-id CVPR2025 --oral-arxiv-query 'co:"CVPR 2025"'
#   全件: ACL Anthology = ACL/EMNLP/NAACL
PAPERPILOT_OUTPUT_ROOT=data/inputs pnpm exec tsx apps/pipeline/src/conference/acl/cli.ts \
  --conference acl-2025 --venue ACL --xml-id 2025.acl --oral-arxiv-query 'co:"ACL 2025"'

# 2) summary → ページ → （新規なら）scaffold
pnpm exec tsx apps/pipeline/src/catalog/buildSummaryCli.ts --conference <slug>
pnpm exec tsx apps/pipeline/src/catalog/buildPagesCli.ts          # --conference なしで conferences.json も作り直す
DISPLAY="<Display>" LEDE="<lede>" pnpm exec tsx apps/pipeline/src/conference/scaffold/cli.ts --conference <slug>
pnpm exec tsx apps/pipeline/src/release/derived/searchIndexCli.ts  # 横断検索の索引（--check で差分検査）
```

- **`buildPagesCli --conference X` は X の `papers.json` だけを書く。** `conferences.json` と要旨シャードは作り直さないので、最後に `--conference` なしで実行する。全件ビルドは全学会の検証を先に済ませ、1 学会でも失敗すれば何も書かない。
- **縮小ゲート:** 公開済みより行数が減る、Oral 数が減る、公開済みの `paper_id` が 1 件でも消える、要旨・著者が空になる、公開済みの `papers.json` が読めない — どれかなら何も書かずに exit 1。意図した変更だけ `--allow-shrink-for <conf>`（複数可）か `--allow-shrink` で通す。workflow では dispatch 入力 `allow_shrink_for` がこれになる。
- **Oral 一覧の保持:** CVF/ACL は oral 区分を持たない。再収集で Oral 一覧が空でも既存の `oral_summaries_ja.md` を残す。消したいときだけ `--clear-oral`。overlay の取得が `--oral-max` に達したら不完全とみなして既存を残す。
- **ACL の巻チェック:** 必要な巻が欠けていれば何も書かずに exit 1。その年に本当に無い巻だけ `--allow-missing-volume <id>`。
- **新しい学会の文言:** `scaffold/cli.ts` が `data/config/conference-copy/<slug>.json` を書き、`apps/web/lib/catalog-copy.ts` が読む。共有の manifest は使わない。
- **無料の家系図:** S2 は 429 が多く、`buildLineageCli` は arxiv_id が要る。OpenReview/CVF/ACL 由来（arxiv_id なし）には `buildConferenceLineageCli`（OpenAlex で題名を解決、LLM 不要）を使う。

---

## 絶対ルール

1. **API キーは環境変数（`.env`・GitHub Secrets・Cloudflare Secrets）だけに置く。`config.yaml`・ソース・生成物・ログに書かない**
2. **`.env` は `.gitignore` で除外済み。commit 前に `git status` で確かめる**
3. **外部 API を叩くテストを書かない。`fetch` を注入してモックする**
4. **Stage の入出力の型（Stage I/O 契約）を変えない**
5. **スコアの正規化式・重みを仕様なしに変えない**
6. **Stage 1 はフィルタだけ。スコア計算を混ぜない**
7. **Signal は `enrichBatch` を優先する。1 件ずつの処理は遅い**
8. **seen_ids は `{id: timestamp}` 形式。`max_age_days` で消す**
9. **run_history には `finished_at` / `sources_status` / `errors` を入れる**
10. **Slack 通知は webhook 未設定なら何もしない（パイプラインを失敗させない）**
11. **LLM 呼び出しは `LLMProvider` インターフェース（`collect/llm/provider.ts`、実装は `lineage/llm/`）を通す。Groq・Gemini・Claude を `fetch` で直接叩く二重実装をしない**
12. **カタログ系の道具は収集器の出力（`data/inputs/<conf>/papers_YYYY-MM-DD.csv`）だけを入力にする。venue・citation・著者を再クロールしない**
    - 例外（家系図）: 引用グラフ（references / citations）の取得は許す。焦点論文の `venue` / `venue_tier` / `citation_count` / `github_stars` は `papers.json` の値を優先する
13. **`data/published/<conf>/lineage.json` の生成元は `lineage/conference/` の builder だけ。手で編集しない**
14. **`data/published/themes/<slug>/lineage.json` の生成元は `lineage/theme/cli.ts` だけ。`themes-manifest.json` の生成元は `generateThemesManifestCli.ts` だけ。手で編集しない**（詳細は下の「テーマ家系図」）
15. **論文のメタデータ（題名・著者・venue・DOI・引用数・関係）を作り話で埋めない。** 取れなかった値は空・null・失敗として記録する
16. **公開・デプロイ・dispatch・通知・merge・KV 書き込みはユーザー承認の後だけ**
17. **このブランチは P5 切替手順（Phase W・Merge B）が終わるまで `develop` に merge しない**（上の「このブランチの状態」）

### テーマ家系図（ルール 14 の詳細）

- **依頼の流れ:** `/themes/` のフォーム → `apps/api` の `POST /api/themes`（origin 許可リスト → 受付スイッチ → 入力検査 → manifest で重複確認 → Durable Object で枠を数える → dispatch）→ `theme-on-demand.yml` → `lineage/theme/cli.ts` → 候補 → 最新 `develop` へ CAS で promote → exact SHA を公開。完了の正本は公開済みの `themes-manifest.json`（ブラウザが polling）。`GET /api/themes/status` は固定 503 の休眠 endpoint。
- **slug:** 正本は `packages/core/src/slug/theme.ts` の `themeSlug()`。`apps/web/lib/themes-slug.ts` はそれを再 export する。`apps/api/src/lib/slug.ts` はまだ 1:1 の複製（core へ移す TODO あり）。規則を変えるときは両方とテストを同時に変える。
- **出力パスは `themeSlug()` の戻り値だけで作る。** 生の `--theme` 文字列をパスに使わない（path traversal 防止）。
- **スキーマは会議版と互換**（`root` / `nodes` / `edges` / `meta`）。`meta.theme` / `meta.slug` / `meta.keywords` / `meta.seeds` / `meta.depth` / `meta.since_year` / `meta.generated_at` を持つ。
- **manifest は builder の中で作らない**（並列実行の競合を避ける）。`rel` が許可 enum 外のテーマは manifest から外す。
- **OpenAlex が主:** workflow は `--primary-source openalex` で起動する（S2 の共有 IP 制限を避ける）。`--primary-source s2` は旧経路。`PAPERPILOT_OPENALEX_EMAIL` で polite pool。
- **ノイズ除け 5 層:** S2 の `fieldsOfStudy`、OpenAlex の `concepts.id`（Computer Science / Mathematics / Linguistics）、seed の話題一致（2 語は両方、3 語以上は半分以上）、基盤論文の引用数フィルタ（seed 最大の 2 倍超で methodology でないもの）、実装系の denylist（`data/config/lineage_denylist.json`）。実装は `lineage/theme/seedFilters.ts` ほか。
- **別名:** seed が 0 件なら `data/config/theme_aliases.json` の代替語を順に試す。
- **不完全ビルドのゲート:** 公開済みより node/edge が減る、公開済みの焦点論文・node・edge が消える場合は公開しない（再実行か `--allow-incomplete`）。焦点論文が 1 本も残らなければ subject failure（exit 4、`--allow-incomplete` でも通らない）。
- **workflow は `--llm-strict ambiguous` で起動する**（CLI 自体の既定は `off`、`--primary-source` の既定は `s2`）。Groq 無料枠（TPM 12,000 / RPD 1,000 / TPD 100,000、2026-06-06 確認）では `all` は破綻する。内蔵の RPM 制限（既定 25）は日次上限を追わない。
- **Groq の遮断器:** `lineage/llm/groq.ts` は使えない応答（200 以外・JSON でない本文・空の choices・空の content）が 3 回続くと遮断し、以後は API を呼ばずにヒューリスティックへ落ちる。成功で数え直す。
- **プロンプトの質:** `lineage/llm/base.ts` の `CLASSIFY_SYSTEM_PROMPT` はテンプレ文の翻訳を禁じる。テンプレ的な根拠は分類結果として受け取らない。テンプレを足すときは両方を同時に直す。
- **分類キャッシュ:** `data/state/lineage-cache/classifications.json` を全 builder で共有する。書く直前にディスクから読み直して合わせ、ロック（`apps/pipeline/src/shared/lock.ts`）と原子的な置き換えで書く。
- **並列依頼:** concurrency group は使わない（GitHub は pending を 1 件しか持たず依頼を落とす）。生成ジョブは書き込み権限を持たず、promote が最新 `develop` に対して許可パスと base SHA を検査して CAS で入れる。
- **監査:** `auditThemeSeedsCli.ts`・`auditLineageQualityCli.ts`。`data-audit.yml` が該当パスの push/PR で走る。

---

## CI / GitHub Actions

`.github/workflows/` の Node workflow は 12 本。どれも `permissions: {}` を最上位に置き、ジョブに最小権限を付ける。action は commit SHA で固定し、`./.github/actions/setup-pnpm` で Node 22 と依存を入れる。dispatch 入力は `env:` 経由でだけシェルに渡し、全体一致の正規表現と改行の拒否で検査する。

🔴 **トリガ表** — 名前から推測せず `on:` 節を確かめること。

| workflow | push | PR | schedule | dispatch | その他 |
|---|:--:|:--:|:--:|:--:|---|
| `tests` | ✅ `develop`/`main` | ✅ | | ✅ | job 名 `test`（必須チェック名を保つ） |
| `data-audit` | ✅ `develop`/`main`（paths） | ✅（paths） | | ✅ | |
| `pages` | ✅ `develop`（paths） | | | | `pages-release` を呼ぶ |
| `pages-release` | | | | | `workflow_call` のみ（reusable） |
| `pages-rollback` | | | | ✅（`ROLLBACK` 確認） | |
| `lighthouse` | | ✅（paths） | ✅ `0 2 * * 1` | ✅ | |
| `collect-weekly` / `collect-daily-watch` / `regen-themes` / `theme-on-demand` / `conference-on-demand` | | | | ✅ のみ | |
| `legacy-redirects` | | | | ✅（`REDIRECT` 確認） | 旧 GitHub Pages に転送サイトを出す |

- **schedule を持つのは `lighthouse` だけ。** カタログは自動では更新されない。更新は dispatch で明示的に回す。
- `tests.yml`: `.codex/` を除く tracked な `*.py` が 0 件か → Biome → typecheck → web build → test（skip は warning）→ `validate bundle`。
- `data-audit.yml`: `data/published/themes/*/lineage.json`・`themes-manifest.json`・`data/published/*/lineage.json`・関連 builder/auditor の変更で 2 つの監査を走らせる。
- `pages.yml`: `data/published/**`・`data/config/conference-copy/**`・`apps/web/**`・`packages/core/**`・`schemas/**`・lockfile・`apps/pipeline/src/release/**` などの push で、`source_sha: github.sha` を `pages-release.yml` に渡す。
- 収集の 2 本は collector を `--fail-on-errors` で起動する（取得元・出力・状態ファイルの失敗、不完全なキーワード、有効な取得元なしで exit 1）。シグナルの劣化は失敗にせず run_history の `degraded_signals` に残す。daily-watch は失敗時もコミット step を走らせ、`data/inputs/daily`・`data/state/seen_ids.daily.json`・`data/state/run_history.daily.jsonl` を `release/cli.ts commit-push` で入れる（入れないと同じヒットを再通知する）。weekly は失敗時に `data/state/run_history.jsonl` を artifact に残す。
- 生成系（weekly・regen-themes・theme-on-demand・conference-on-demand）の形は共通: 書き込み権限なしで候補を作る → `release/cli.ts package` → artifact → 別ジョブの `release/cli.ts promote <kind>` が最新 `develop` に CAS で入れる（promote 先ツリー自身のコードで共有出力を作り直して検査する）→ promote した exact SHA を `pages-release.yml` に渡す。
- `.github/workflows/*.yml` を push するには PAT に `workflow` scope が要る。

### GitHub Secrets と environments

| 名前 | 使う workflow | 用途 |
|---|---|---|
| `GH_PAT` | collect-daily-watch | push 用 PAT（無ければ `github.token`） |
| `OPENALEX_EMAIL` | collect-weekly、collect-daily-watch | OpenAlex polite pool |
| `S2_API_KEY` / `GEMINI_API_KEY` / `CLAUDE_API_KEY` / `GROQ_API_KEY` | collect-weekly | 収集と Stage 4・家系図分類 |
| `PAPERPILOT_GROQ_API_KEY` / `PAPERPILOT_S2_API_KEY` | regen-themes、theme-on-demand | テーマ家系図の分類・S2 |
| `SLACK_WEBHOOK_URL` | collect-daily-watch | 通知と失敗通知 |
| `LHCI_GITHUB_APP_TOKEN` | lighthouse | 任意 |
| `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` | pages-release、pages-rollback | environment `cloudflare-pages-deploy`（develop のみ）の secret |

- `cloudflare-pages-deploy`: deploy と rollback のジョブだけが使う。develop のみ許可。
- `cloudflare-pages-production`: secret なし。どのジョブも `environment:` に書かない。`record` ジョブが REST API で書く「正常に出た SHA の台帳」。ジョブに `environment:` を書くと smoke の前に成功扱いの Deployment ができてしまうので、名前を分けている。
- `github-pages`: `legacy-redirects.yml` だけが使う。
- Worker の secret `GH_DISPATCH_PAT`（fine-grained、このリポジトリのみ、Actions: Read & write）は Cloudflare 側に置く。

---

## 公開（Cloudflare Pages）とロールバック

`pages-release.yml`（group `paperpilot-pages-production`、`cancel-in-progress: false`）は 6 段 + 記録。

1. **validate** — SHA・`release_kind`（`normal` のみ）・request_id を検査 → exact SHA を checkout → Biome・typecheck・web build・全テスト → `release/cli.ts no-skip-gate`（skip が 1 件でもあれば失敗）→ `auditThemeSeedsCli`・`auditLineageQualityCli`・`searchIndexCli --check`
2. **build** — `pnpm --filter @paperpilot/web build` → `release/cli.ts marker apps/web/out` → `validate local $SHA apps/web/out` → artifact `cf-pages-$SHA`
3. **admit** — SHA が `origin/develop` の祖先で、公開対象のパスが tip と同じときだけ `deployable=true`（古いリリースを出さない）。このパス集合は `pages.yml` の paths に含まれていること（契約テスト）
4. **deploy** — environment `cloudflare-pages-deploy`、develop のみ。marker を確かめ、`wrangler pages deploy … --commit-hash=$SHA` → `release/cli.ts cf-deployment-id`（commit_hash で絞る。wrangler の出力を読まない）
5. **smoke** — secret なし。`release/cli.ts validate smoke "$PUBLIC_ORIGIN" "$SHA" --wait-marker … --expect-bytes …`（デプロイ固有 URL も先に smoke できる）
6. **record** — `release/cli.ts gh-record` が `cloudflare-pages-production` に GitHub Deployment と success status を書く（payload に `source_sha`・`cf_deployment_id` など）

smoke が失敗すると、壊れたデプロイが記録なしで残る。運用者はすぐ `pages-rollback.yml` で最後に記録された SHA に戻す（自動ロールバックはしない）。

**`pages-rollback.yml`**（dispatch、`confirm=ROLLBACK`）: 対象 SHA が develop の祖先で `cloudflare-pages-production` に成功記録があるか確かめる → `cf-verify-deployment` → `cf-rollback`（environment `cloudflare-pages-deploy`）→ smoke（marker・404・転送・ヘッダ。バイト比較はしない）→ `release_kind: rollback` で記録。作り直し（rebuild）はしない。データとブランチは戻さない。P5 以後に Cloudflare に出した SHA だけが対象。

---

## API（`apps/api`）

Hono on Cloudflare Workers。本番設定は `apps/api/wrangler.jsonc`（Worker 名 `paperpilot-themes`、`DISPATCH_MODE=live`、KV binding `CONFIG_KV` = 本番 namespace `3e11d3e73dae42a8b94f06a9fa9de19f`、Durable Object `QUOTA` = `QuotaCounter`）。プレビューは `wrangler.preview.jsonc`（`paperpilot-api-preview`、`DISPATCH_MODE=dry-run`、プレビュー用 KV）。

| endpoint | 中身 |
|---|---|
| `POST /api/themes` | origin が KV `origin_allowlist` に無ければ 403 → `accepting` が `"true"` でなければ 503 `paused`（枠も dispatch も使わない）→ `content-type` が JSON でなければ 415、1KB 超は 413 → 入力検査 → manifest で既存なら `exists`（manifest が読めなければ 503）→ 枠（IP ごと 5/時、全体 100/日、Durable Object で正確に数える）→ dispatch。新規は `{ ok: true, status: "queued", slug, request_id }` |
| `GET /api/health` | 読むだけ。`{ accepting, dispatch_mode, pat_configured, kv_namespace_tag }` |
| `GET /api/themes/status` | 固定 503 の休眠 endpoint |
| `OPTIONS /api/*` | CORS preflight。許可リストの origin だけ ACAO を返し、`Vary: Origin` |

- **受付スイッチ:** KV `accepting` が文字列 `"true"` のときだけ受け付ける。値が無い・違う・読めないときは止まる（fail closed）。
- **origin 許可リスト:** KV `origin_allowlist`（JSON 配列）。プレビューや `<hash>.<project>.pages.dev` を入れない。
- **空打ちモード:** `DISPATCH_MODE=dry-run` は本番の ref・origin を指していれば拒否する。本番は常に `live`。
- **KV の操作（承認が要る）:** `wrangler kv key put --namespace-id=3e11d3e73dae42a8b94f06a9fa9de19f <key> <value> --remote`。wrangler 4 は既定でローカルに書く場合があるので `--remote` を付け、`wrangler kv key get --remote` で読み戻し、`/api/health` で確かめる。各段の値と記録は `docs/migration/p5-runbook.md`。
- D1 はまだ使っていない（P6 の項目）。

---

## Issue 作成ワークフロー

レビューで見つかった「止めるほどではないが直したい」項目を、ユーザーが issue 作成を明示承認したときに使う。承認前は候補を報告するだけ。

1. **1 issue = 1 問題に分ける。** 関係が強くても別 issue にし、本文で相互にリンクする（`#21 の続き`）。
2. **タイトル:** `[<カテゴリ>] <日本語の要約>`。

| 接頭辞 | GitHub ラベル |
|---|---|
| `[bug]` | `bug` |
| `[docs]` | `documentation` |
| `[refactor]` / `[consistency]` / `[lint]` | `refactor` |
| `[tests]` / `[test-quality]` | `test` |
| `[typing]` | `typing` |
| `[scripts]` / `[spec-gap]` | `enhancement` |
| `[infrastructure]` | `infrastructure`（止まっていれば `help wanted` も） |

3. **本文（5 節、この順）:**

```markdown
## 概要
（1-2 段落。何が起きていて、なぜ問題か）

## 背景
（CLAUDE.md §N / 設計書 §N / 過去の事例）

## 該当
（file:line とコード片）

## 提案 / あるべき記述
（直し方、before/after）

## タスク
- [ ] 具体的な作業
- [ ] 必要ならテスト追加
- [ ] 必要ならドキュメント更新
```

4. **投入:** `gh issue create --title "…" --label "…" --body "$(cat <<'EOF' … EOF)"`。関連 issue はまとめて続けて入れる。
5. **解決時の commit:** `closes #N` を入れる（例: `fix(pipeline): … (closes #32)`）。

---

## よくある実装ミスと対策

| ミス | 対策 |
|---|---|
| API キーを `config.yaml` やソースに書く | 環境変数から読む |
| 外部 API を叩くテストを書く | `fetch` を注入してモックする |
| データのパスを直書きする | `layoutFor()` / `relLayout()` を使う |
| CLI を import しただけで通信が走る | `isMain()` で守る |
| Stage 1 にスコア計算を混ぜる | Stage 2 の keyword シグナルに移す |
| Signal で 1 件ずつ loop を書く | `enrichBatch` でバッチ API を使う |
| JS の `Math.round` / `toFixed` / `split(/\s+/)` で Python 版と結果がずれる | `packages/core/src/pycompat/` の関数を使う |
| テスト失敗のまま commit | `pnpm -r test` を通してから |
| web build をせずにテストして skip を見落とす | build → test の順に回す |
| 新しい Source/Signal/Exporter を runner に登録し忘れる | `runner.ts` の `build*()` に足す |
| collector を `--config` なしで起動する | 既定の設定パスはまだ古い値（`paperpilot/config.yaml`）なので、`--config data/config/config.yaml` を必ず渡す |

---

## 仕様変更時のルール

**仕様・設計を変えたら、このファイルと設計書（[`docs/design/`](docs/design/)）を同時に直す。**

| 変更の種類 | 直す場所 |
|---|---|
| スコアの重み・正規化式 | CLAUDE.md「スコアリング」、`data/config/config.yaml` の `weights`、`collect/stages/metricScore.ts`、設計書 |
| Stage の入出力の型 | `collect/stages/*.ts`、`apps/pipeline/test/collect/stages/`、CLAUDE.md「Stage フロー」 |
| Source / Signal / Exporter の追加 | `collect/<kind>/`、テスト、`runner.ts`、`config.yaml`、CLAUDE.md |
| LLM provider の追加 | `lineage/llm/<name>.ts`、テスト、`collect/runtime/llmProvider.ts`、`config.yaml`、`.env.example`、CLAUDE.md |
| 環境変数の追加 | `data/config/.env.example`、`collect/config/env.ts`、CLAUDE.md「環境変数」 |
| 公開 JSON の形 | `schemas/`、`packages/core` の zod、生成元と読み手のテスト |
| GitHub Actions | `.github/workflows/*.yml`、README「GitHub Actions」、CLAUDE.md「CI / GitHub Actions」、workflow の契約テスト |
| venue の tier・パターン | `collect/signals/venue.ts`、`venue.test.ts`、設計書 |

---

## Claude Code 運用ノート

- `AGENTS.md` / `PAPERPILOT_PROFILE.md` の Qwen・Codex の routing と role 表は Codex CLI 向けの別運用。Claude Code には適用しない。
- 製品の LLM provider 設定（Ollama / Gemini / Groq / Claude）は、作業エージェントの routing とは別物。混同しない。
- サブエージェントは `.claude/agents/`、手順は `.claude/skills/`（`run-verification`・`add-plugin`）。
- 変更後は差分と gate（lint・typecheck・テスト）を確かめ、結果・skip・残リスクを報告する。workflow の dispatch、issue/PR 作成、commit/push/merge、公開、通知、secret・設定の変更はユーザーの明示承認を取る。

---

## 実装ステータス

現在の状況は設計書 [`40-post-cutover-roadmap.md`](docs/design/40-post-cutover-roadmap.md)（計画）と [`41-lineage-publication-and-reliability.md`](docs/design/41-lineage-publication-and-reliability.md)（系譜の公開方針と実装メモ）、運用は [`docs/migration/p5-runbook.md`](docs/migration/p5-runbook.md) を正とする。移行の設計（39）・計画（p5-plan）・残作業表（p4-followups）などは 2026-10-10 に削除した（git の履歴に残っている）。

- カタログは 10 学会 / 28,300 本（`data/published/conferences.json`）。
- 系譜は品質 manifest で fail closed。表示対象は 0 件。

---

*最終更新: 2026-10-07（P5 Tier C。Python・uv・Docker・旧 Worker の記述を消し、TypeScript だけの構成・`data/` の配置・12 workflow・Cloudflare の公開とロールバック・KV スイッチと `/api/health` に書き直した）*
