# CLAUDE.md — PaperPilot 実装ガイド

このファイルは Claude Code が本プロジェクトを実装する際に参照する指示書です。
設計書（[`docs/design/`](docs/design/)）および市場調査レポート（[`docs/research/`](docs/research/)）と合わせて読むこと。
原本 `.docx` は [`archive/`](archive/) に保管されていますが、**編集は markdown 側で行う**ことが正。

---

## プロジェクト概要

- **目的：** AI/ML 論文を arXiv / Semantic Scholar / OpenAlex から自動収集し、品質シグナルで絞り込んだ上で **系譜（家系図）として可視化** するパイプライン
- **主要な出力：** GitHub Pages 上のインタラクティブ家系図ビュー（`docs/<conference>/lineage.html`、`.github/workflows/pages.yml` でデプロイ）。サイト上のフォームから新規テーマ投稿可能（CF Worker `worker/index.ts` → `theme-on-demand.yml` 直接 workflow_dispatch → `build_theme_lineage.py` → develop へ commit → Pages 再デプロイ）。補助出力として CSV / JSON / Slack / Email も維持
- **対象ユーザー：** AI/ML 研究者、R&D エンジニア、独立リサーチャー
- **運用コスト目標：** ¥0〜¥1,500/月（Stage 4 LLM / 系譜分類 LLM のみ有料オプション）
- **差別化：** OSS・ローカル実行可能・YAML 設定駆動・日本語対応・品質シグナル統合スコア・**LLM による引用関係の意味分類**（`supersedes` / `successor` / `extends` / `ablation` / `baseline_only` / `contrasts` / `unrelated`）
- **参照仕様書：** [`docs/design/`](docs/design/)（v2.1、Round 2 レビュー25件反映版、原本は `archive/`）

---

## 環境情報

```
OS：Linux / macOS / Windows
Python：3.10 以上（開発・CIは 3.12）
パッケージ管理：pyproject.toml（pip install -e '.[dev]'）/ 互換用に requirements.txt も維持
実行方法：python -m paperpilot.collector
```

### 開発ツール

**実環境では `uv run` 経由で呼ぶ**（bare の `ruff`/`mypy`/`pytest` は解決しないことがある）:

```bash
uv run ruff check paperpilot/                 # lint（push 前必須。pytest は I001 import-sort を拾わない）
uv run mypy paperpilot/                        # type check
uv run pytest paperpilot/tests/                # 全テスト（~22s, 1000+ 件）
uv run pytest paperpilot/tests/test_venue_signal.py::test_x -q   # 単一テスト
uv run pytest paperpilot/tests/ --cov=paperpilot --cov-config=/dev/null   # カバレッジ
```

既知の pre-existing failure: `tests/viewer/test_theme_viewer_smoke.py::test_theme_typography_tokens`（node ベースの環境依存、本作業と無関係）。`pip install -e '.[dev]'` 互換も維持。

### 依存ライブラリ

```txt
# paperpilot/requirements.txt
arxiv>=2.1.0            # arXiv API クライアント
requests>=2.31.0        # HTTP (同期)
aiohttp>=3.9.0          # HTTP (非同期 Stage 0)
pyyaml>=6.0             # YAML 設定読み込み
python-dotenv>=1.0.0    # .env 読み込み

# paperpilot/requirements-dev.txt
pytest>=8.0
pytest-cov>=4.1
```

---

## フォルダ構成

```
automatic-paper-search/
├── CLAUDE.md                            # このファイル
├── README.md                            # ユーザー向けドキュメント
├── docs/
│   ├── design/                          # 基本設計書 v2.1（markdown 正本）
│   ├── research/                        # 市場調査レポート v2.0（markdown 正本）
│   ├── iclr-2026/                       # GitHub Pages 論文ビューア（家系図ビュー本命）
│   │   ├── index.html                   # 採択論文一覧（papers.json を表示）
│   │   ├── lineage.html                 # 家系図ビュー（lineage.json を表示）
│   │   ├── papers.json                  # build_pages.py が生成
│   │   └── lineage.json                 # build_lineage.py が生成
│   └── assets/                          # 共通 CSS/JS（app.js / lineage.js / style.css）
├── archive/                             # 原本 .docx の保管先（編集禁止）
├── .github/
│   └── workflows/
│       ├── collect-weekly.yml           # 毎週土曜 07:00 JST 深掘り（PAT に workflow scope 必要）
│       ├── collect-daily-watch.yml      # 毎日 07:00 JST フォロー著者ウォッチ
│       ├── regen-themes.yml             # 手動 workflow_dispatch のみ (PR #261 で週次 cron 廃止)
│       ├── theme-on-demand.yml          # ★ オンデマンド単一テーマ生成（運用者が gh workflow run で手動 dispatch）
│       ├── lighthouse.yml               # PR ごと + 週次の Lighthouse / Core Web Vitals 測定
│       ├── data-audit.yml               # ★ PR/push 時に audit_theme_seeds + audit_lineage_quality 自動実行 → off-topic seed / 構造異常 regression を block
│       └── publish.yml                  # PyPI trusted-publisher（release 発火）
└── paperpilot/
    ├── collector.py                     # CLI エントリーポイント
    ├── config.yaml                      # 週次深掘り設定（秘匿情報なし）
    ├── config.daily-watch.yaml          # 毎日の follow-watch 用 lean config
    ├── .env.example                     # 環境変数テンプレート（Git 管理対象）
    ├── .env                             # 秘匿情報（Git 管理外・絶対にコミットしない）
    ├── .gitignore
    ├── requirements.txt                 # 本番依存
    ├── requirements-dev.txt             # 開発・テスト依存
    ├── pipeline/                        # ステージ定義
    │   ├── runner.py                    # PipelineRunner（全 Stage の統合）
    │   ├── stage_collect.py             # Stage 0: asyncio 並列収集
    │   ├── stage_rule_filter.py         # Stage 1: カテゴリ/日付/除外/差分
    │   ├── stage_metric_score.py        # Stage 2: シグナル統合スコア
    │   └── stage_llm_rank.py            # Stage 4: LLM リランク
    ├── sources/                         # Source プラグイン
    │   ├── base.py                      # AbstractSource
    │   ├── arxiv_source.py              # arXiv API
    │   ├── s2_source.py                 # Semantic Scholar
    │   └── openalex_source.py           # OpenAlex
    ├── signals/                         # 品質シグナル
    │   ├── base.py                      # AbstractSignal（batch 対応）
    │   ├── venue_signal.py              # 学会採択 (arXiv comment regex)
    │   ├── citation_signal.py           # S2 /paper/batch
    │   ├── author_signal.py             # S2 /author/batch (h-index)
    │   ├── github_signal.py             # 共有 utils.github 経由で curated map → GitHub Search → GitHub Stars (log-scale)
    │   ├── follow_signal.py             # 著者/組織ウォッチリスト (day-1 authority)
    │   └── keyword_signal.py            # match_count / 3 * 100
    ├── exporters/                       # 出力
    │   ├── base.py                      # AbstractExporter
    │   ├── csv_exporter.py
    │   ├── json_exporter.py
    │   ├── slack_exporter.py
    │   └── email_exporter.py            # SMTP + STARTTLS, HTML/plain multipart
    ├── llm/                             # Stage 4 LLM プロバイダ + 系譜関係分類
    │   ├── base.py                      # AbstractLLMProvider, PaperEvaluation, RelationClassification
    │   ├── ollama_provider.py           # ローカル無料
    │   ├── gemini_provider.py           # Gemini (無料枠あり)
    │   ├── groq_provider.py             # Groq Llama 3.3 (lineage 分類の無料第一候補)
    │   └── claude_provider.py           # Anthropic Claude（設計書の第一推奨）
    ├── scripts/                         # ビューア生成スクリプト（補助ツール群）
    │   ├── collect_conference.py        # arXiv co:"<conf>" → VenueSignal 採択抽出 → output/<conf>/papers_*.csv (arXiv自己申告のみ=部分収録)
    │   ├── collect_openreview.py        # OpenReview api2 venueid → 全採択論文 + Oral/Spotlight/Poster 区分 → output/<conf>/papers_*.csv (ICLR/NeurIPS/ICML の権威的全件収録、write_outputs を collect_conference と共有)
    │   ├── collect_cvf.py               # CVF Open Access (openaccess.thecvf.com) listing → 各論文 detail を並列 fetch (citation_* meta + abstract) → 全採択収録 (CVPR/ICCV、ECCV は ECVA で別) write_outputs 共有。CVF は oral 区分を持たないので `--oral-arxiv-query 'co:"CVPR 2025"'` で arXiv 申告 oral を overlay (oral_titles_from_arxiv)
    │   ├── collect_acl_anthology.py     # ACL Anthology XML dump (github acl-org/acl-anthology) → 本会議 long/short/main 全採択 + abstract → 収録 (ACL/EMNLP/NAACL) write_outputs 共有。同様に `--oral-arxiv-query` で oral overlay 可
    │   ├── scaffold_conference_page.py  # cvpr-2026 テンプレ → docs/<conf>/index.html (+ 空 lineage.json)
    │   ├── build_summary_csv.py         # full CSV → summary.csv (8 列 + 自動タグ)
    │   ├── build_pages.py               # summary.csv → docs/<conf>/papers.json
    │   ├── build_lineage.py             # papers.json + S2 + LLM → lineage.json (arxiv_id 必須・S2 律速)
    │   ├── build_conference_lineage.py  # Oral の title→OpenAlex 解決→参照/被引用で家系図 (S2/LLM 不要の free-tier fallback、edge は引用方向の successor ヒューリスティック) → docs/<conf>/lineage.json
    │   ├── build_deep_lineage.py        # 1 論文 × N hop BFS → docs/<conf>/deep.json
    │   ├── build_theme_lineage.py       # テーマ文字列 + S2 + LLM → docs/themes/<slug>/lineage.json
    │   ├── generate_deep_manifest.py    # docs/<conf>/deep-*.json → deep-manifest.json
    │   └── generate_themes_manifest.py  # docs/themes/<slug>/lineage.json → themes-manifest.json
    ├── models/
    │   └── paper.py                     # Paper データクラス
    ├── utils/
    │   ├── config_loader.py             # YAML + .env 統合
    │   ├── dedup.py                     # dedup + seen_ids 管理
    │   ├── rate_limiter.py              # 同期 sleep ベース
    │   ├── http.py                      # 指数バックオフ retry
    │   ├── github.py                    # 共有 GitHub 解決器（curated map + GitHub Search + Stars）
    │   ├── json_parser.py               # LLM 3段階フォールバック
    │   └── logger.py                    # 日次ローテ (7日保持)
    ├── tests/                           # pytest テスト（1,046 件 pass、2026-08-18 実測）
    │   ├── conftest.py
    │   ├── test_*.py                    # 各モジュールのユニット/統合テスト
    │   └── test_venue_stress.py         # 60 パターンで検出率 95% 以上
    ├── data/                            # 永続データ（CI でコミット）
    │   ├── seen_ids.json                # 差分更新用（Stage 1）
    │   ├── run_history.jsonl            # 実行履歴
    │   └── lineage-cache/               # S2 メタ + LLM 関係分類キャッシュ
    ├── output/                          # 日次 CSV/JSON（CI でコミット）
    │   ├── daily/                       # 通常ランの出力
    │   └── iclr-2026/                   # 学会別ランの出力
    │       ├── papers_YYYY-MM-DD.{csv,json}
    │       ├── summary.csv              # build_summary_csv.py の出力
    │       ├── oral_summaries_ja.md     # Oral 判定の入力
    │       └── run_history.jsonl
    └── logs/                            # ログ（ローカル専用）
        └── paperpilot.log*              # 日次ローテ
```

---

## 実装ルール

### エージェント動作の基本方針

- 独立した操作は**常に並列でツール呼び出し**する
- 重要な進捗・変更ファイルはサマリーとして保存し、コンテキスト圧縮後も継続可能にする
- コンテキスト上限が近づいても作業を中断しない

### 基本方針（設計原則）

- **Open/Closed 原則：** 新しい Source / Signal / Exporter / LLMProvider は、基底クラス（`Abstract*`）を継承してプラグインとして追加する。既存コードは変更しない
- **Fail-Safe：** 外部 API 障害時は該当コンポーネントをスキップしてパイプライン継続
- **設定駆動：** キーワード・カテゴリ・重み・出力先はすべて `config.yaml` で制御
- **冪等性：** 同じ config で2回実行しても `seen_ids` で差分管理され出力が重複しない
- **秘匿分離：** API キー類は `.env` のみ、`config.yaml` に**絶対に書かない**
- **1ファイル1責務：** 1モジュール1つの Source / Signal / Exporter
- **型ヒント必須：** すべての関数シグネチャに型アノテーション
- **Docstring 必須：** モジュール先頭と公開 API に何故（Why）と使い方を記載

### コーディング規約

```python
# 良い例
def enrich_batch(self, papers: list[Paper]) -> list[Paper]:
    """S2 /paper/batch で引用数を取得（最大500件/リクエスト）。"""

# 悪い例（型ヒントなし・docstring なし）
def enrich_batch(self, papers):
    pass
```

### エラーハンドリング

- 外部 API 呼び出しは必ず `utils/http.request_with_retry` を経由する
- HTTP 429: 指数バックオフ（2s→4s→8s…最大30s）を最大3回
- HTTP 5xx: 固定3秒待機を最大2回
- Timeout: 1回リトライ
- 3回失敗したら WARNING ログ出力してその件はスキップ（パイプライン全体は継続）

```python
# リトライの実装パターン
from paperpilot.utils.http import request_with_retry

resp = request_with_retry("GET", url, params=params, timeout=10)
if resp is None or resp.status_code != 200:
    return None  # Fail-Safe: 空で返して上流で継続
```

### 環境変数

`.env` ファイルから読み込む。ハードコードは絶対に禁止。

```python
# paperpilot/utils/config_loader.py が以下を自動注入
PAPERPILOT_GITHUB_TOKEN      # GitHub API レート制限緩和
PAPERPILOT_S2_API_KEY        # Semantic Scholar
PAPERPILOT_OPENALEX_EMAIL    # OpenAlex polite-pool
PAPERPILOT_GEMINI_API_KEY    # Gemini プロバイダ
PAPERPILOT_CLAUDE_API_KEY    # Claude プロバイダ
PAPERPILOT_SLACK_WEBHOOK_URL # Slack 通知
PAPERPILOT_SMTP_*            # Email 通知
```

---

## 開発ワークフロー（プランレビュー → TDD → PR レビュー）

**この順序を守ること。** 実装/レビューのタイミングで手戻りコストが 10〜100 倍変わる。

### フェーズ 0: 調査 (Research & Reuse)

`gh search repos` / `gh search code` → Context7 でライブラリ docs → npm/PyPI/crates.io レジストリ → 最後に Exa。既存実装が 80% 以上をカバーするなら採用を優先。

### フェーズ 1: プラン作成

`planner` エージェントで以下を生成:
- 変更ファイル一覧と見積もり行数
- タスク分解（`TaskCreate` で追跡可能な粒度）
- テスト計画（RED/GREEN、モック戦略、カバレッジ目標）
- 依存・リスクの明示

### フェーズ 1.5: プランレビュー（★ 着手前に必須 ★）

**コードを書く前にプランを並列レビュー**。実装後の手戻りよりコストが桁違いに安い。

走らせるエージェント（並列）:

| エージェント | 観点 |
|---|---|
| `architect` | システム設計整合性、スケーラビリティ、拡張性 |
| `code-architect` | 既存パターン遵守、ブループリントの現実性 |
| `code-explorer` | 類似/重複機能の既存確認、再利用ポイント |
| `security-reviewer` | 設計段階で混入しやすい脅威 |

チェック 10 項目:
1. 絶対ルール §1〜§13 に反していないか
2. Stage インターフェース（入出力の型）を崩していないか
3. スコアリング正規化式・重みを無断で変えていないか
4. API キーが `.env` 分離か
5. プラグインは基底クラス継承設計か
6. Fail-Safe（外部 API 障害時の継続性）が設計に入っているか
7. テスト計画の粒度・モック戦略・カバレッジ目標
8. CLAUDE.md / 設計書 / README の同時更新計画
9. `code-explorer` で既存実装と重複していないか確認済みか
10. PR 1 本で完結するか、分割すべきか

対応方針:
- **CRITICAL / HIGH** → プランを修正して再レビュー（プラン段階ループ）
- **MEDIUM** → プランに注記して TDD 開始、該当箇所で再確認
- **LOW** → そのまま進行、後段レビューで拾う

**ユーザー判断を仰ぐ**: "GO / プラン再作成 / スコープ縮小" のいずれか。

### フェーズ 2: TDD 実装

**強制サイクル**:

1. **RED** — `paperpilot/tests/test_<module>.py` を先に書き、失敗を確認
2. **GREEN** — 最小実装でテストを通す
3. **REFACTOR** — 設計原則に沿って整える
4. **カバレッジ確認** — `pytest --cov=paperpilot` で **80% 以上**（現状 91%）

独立した複数モジュールは専門エージェント（`source-agent` / `signal-agent` / `exporter-agent`）を並列起動。

### フェーズ 3: コードレビュー（commit 前）

commit する前に複数レビューアを **並列で** 起動:

```
code-reviewer        (一般品質・パターン)
python-reviewer      (PEP 8 / mypy / pythonic)
typescript-reviewer  (JS / TS、フロントエンド変更時)
security-reviewer    (OWASP Top 10 / secrets)
```

対応方針:
- **CRITICAL / HIGH** → commit 前に必ず修正
- **MEDIUM** → できる範囲で修正、残りはフェーズ 7 で issue 化
- **LOW** → 基本 issue 化（即時修正しない）

### フェーズ 4: イテレーティブ修正

CRITICAL / HIGH がゼロに収束するまで再レビュー → 修正を繰り返す。実績: 2〜6 イテレーションで収束。

### フェーズ 5: commit & push

Conventional Commits 形式で `closes #N` を含める:

```bash
git commit -m "<type>(<scope>): <subject> (closes #N)"
git push
```

`type`: `feat` / `fix` / `refactor` / `docs` / `test` / `chore` / `perf` / `ci`

### フェーズ 6: PR 前最終チェック

`paperpilot-reviewer` で 10 項目判定（**全変更で MUST BE USED**）。

### フェーズ 7: 残項目を issue 化

フェーズ 3 / 6 で「ブロッキングではないが望ましい」と判定された項目を **バッチ投入**。[Issue 作成ワークフロー](#issue-作成ワークフロー) に従う。

### フェーズ 8: PR 作成・CI・merge

`develop` へ PR → CI（test / ruff / mypy）→ merge。merge 後は bug 発生時のみ再レビュー。

### 全体タイミング図

```
[Research]
    ↓
[Plan]                     agent: planner
    ↓
[★ プランレビュー ★]       agents: architect / code-architect /
    ↓        ↑                     code-explorer / security-reviewer
    ├────────┘ findings > 0 なら再プラン
    ↓
[TDD: RED → GREEN → IMPROVE]
    ↓
[コードレビュー] ──────→   agents: code / python / ts / security
    ↓        ↑
    ├────────┘ ゼロ収束まで
    ↓
[commit (closes #N)]
    ↓
[paperpilot-reviewer 最終] 10 項目判定
    ↓
[残項目を issue 化]        バッチで gh issue create
    ↓
[PR → CI → merge]
```

### テスト実行

```bash
# 全テスト（約 6 秒）
python3 -m pytest paperpilot/tests/

# 特定モジュールのみ
python3 -m pytest paperpilot/tests/test_venue_signal.py -v

# カバレッジ付き
python3 -m pytest paperpilot/tests/ --cov=paperpilot --cov-report=term --cov-config=/dev/null

# Venue 正規表現ストレステスト（検出率 95% 以上を維持する境界テスト）
python3 -m pytest paperpilot/tests/test_venue_stress.py
```

### 外部 API のテスト方針

- **実 API を叩かない。** テスト中は必ず `unittest.mock.patch` で `request_with_retry` をモックする
- 既存のモック例は `tests/test_citation_signal.py` / `tests/test_s2_source.py` などを参照

---

## 各モジュールの実装仕様

### Paper（データモデル）

`paperpilot/models/paper.py` の dataclass。全 Stage を流通する中核エンティティ。

```python
@dataclass
class Paper:
    # 必須 (Stage 0)
    title: str; authors: list[str]; abstract: str; url: str
    published_date: date; source: str  # "arxiv" | "s2" | "openalex"

    # Stage 0 で任意設定
    arxiv_id: str | None; doi: str | None; pdf_url: str | None
    categories: list[str]; comment: str | None

    # Stage 2 で enrich
    venue: str | None; venue_tier: int; venue_score: float
    github_url, github_stars, github_score, has_code, is_official_repo
    citation_count, influential_citations, citation_velocity, citation_score
    first_author_id, author_h_index, author_score
    keyword_match_count, keyword_score

    # Stage 2 最終
    total_score: float; matched_keywords: list[str]

    # Stage 4 LLM
    llm_relevance: int | None  # 1..5 or None
    llm_summary_ja, llm_reason, llm_tags
```

### スコアリング（変更禁止）

各シグナルは 0〜100 に正規化。`weights` で重み付けした合計が `total_score`。

| シグナル | 正規化式 | デフォルト重み |
|---------|---------|--------------|
| follow | 著者完全一致=100 / 所属部分一致=50 / 不一致=0 | **3.5**（day-1 最強） |
| venue | Tier1=100 / Tier2=80 / Tier3=60 / Workshop=30 / 未査読=0 | **3.0** |
| embedding | cos 類似度 × 100（Stage 3 有効時のみ） | **2.5** |
| github | `log(stars+1) / log(10001) × 100` | **2.0** |
| citation | `min(cites/day / saturation, 1) × 100` (sat=2.0) | **1.5** |
| author | `min(h_index / 50, 1) × 100` | **1.0** |
| keyword | `min(match_count / 3, 1) × 100` | **0.5** |

理論最大値: `100 × (3.5+3+2.5+2+1.5+1+0.5) = 1400`

### Stage フロー（変更禁止）

```
Stage 0: collect (async 並列)  → dedup
Stage 1: rule_filter           → category ∧ since_date ∧ exclude_words ∧ ¬seen_ids
Stage 2: metric_score          → 各 signal.enrich_batch → total_score → top_n
(Stage 3: embedding)           → Stage 3 有効時は Stage 2 結果に embedding 重みを加算
Stage 4: llm_rank              → provider.evaluate_batch → relevance 降順 → top_n
Export                         → CSVExporter / JSONExporter / SlackExporter / EmailExporter
State                          → save_seen_ids + append_run_history
```

### Visualization 層（家系図ビュー）

配信用 Exporter とは別に、GitHub Pages 上の家系図ビューを生成する **補助パイプライン** を `paperpilot/scripts/` に置く。通常ランの後に順に実行し、`docs/<conference>/` を更新する（`develop` への push を `.github/workflows/pages.yml` がフックして自動デプロイ。`docs/**` 変更のあるコミットのみが Pages run を発火する `paths:` フィルタ済）。

```
output/<conf>/papers_YYYY-MM-DD.csv
  │
  ├─ build_summary_csv.py   → summary.csv（8 列 + 自動タグ）
  │
  └─ build_pages.py         → docs/<conf>/papers.json（一覧ビュー用）
       │
       ├─ build_lineage.py        → docs/<conf>/lineage.json
       │     │                      - Oral 全 N 本 × depth 1 の浅い家系図集
       │     │                      - S2 から references/citations 取得
       │     │                      - AbstractLLMProvider で関係分類
       │     │                      - lineage-cache/ にキャッシュして再開可能
       │     ▼
       │   docs/<conf>/lineage.html   （Topics/家系図/時系列の 3 モード切替）
       │
       └─ build_deep_lineage.py   → docs/<conf>/deep.json
             │                      - 1 本 × depth N の BFS（祖先・子孫）
             │                      - lenient classifier（rationale 空のときは
             │                        テンプレで補完、弱いエッジも残す）
             ▼
           docs/<conf>/deep.html   （tree-only の 1 本集中ビュー）

[テーマ文字列] → build_theme_lineage.py → docs/themes/<slug>/lineage.json
                  - **--primary-source openalex (post #217 default in workflows)**:
                    OpenAlex /works?search=<theme>&filter=concepts.id:...
                    → top-N seeds (paperId='openalex:W...')
                  - --primary-source s2 (legacy): keyword_expand → S2
                    /paper/search → top-N seeds (paperId=sha1 hash)
                  - 各 seed から BFS depth-N (jiez方向):
                    - openalex: → OpenAlex referenced_works / cites
                    - S2 sha1: → S2 /paper/{id}/references|citations
                  - 関係分類: contexts (S2-only) → intent map (S2-only)
                    → year/cite contrast → optional LLM
                  - OpenAlex source の edge は _intents=None / _contexts=[]
                    なので derive_relation は year/cite or LLM に fall through
generate_themes_manifest.py → docs/themes/themes-manifest.json
                  ▼
           docs/themes/index.html   （テーマピッカー + 年軸 chronological tree、
                                     Y 軸 rank-based 等間隔）
```

関係種別（LLM 分類出力）: `supersedes` / `successor` / `extends` / `ablation` / `baseline_only` / `contrasts` / `unrelated` （`unrelated` はエッジから除外）。

**重要：** scripts の LLM 呼び出しは、パイプラインと同じ `AbstractLLMProvider` 抽象を経由する（urllib 直叩き禁止、絶対ルール §11）。

### プラグイン追加手順

1. 該当する基底クラスを継承（`AbstractSource` / `AbstractSignal` / `AbstractExporter` / `AbstractLLMProvider`）
2. テストを先に書く（既存のモックパターンを参照）
3. 実装
4. `__init__.py` の `__all__` に追加
5. `pipeline/runner.py` の `_build_sources()` / `_build_signals()` / `_build_exporters()` / `_build_llm_provider()` に登録
6. `config.yaml` / `.env.example` に設定を追加

---

## フロントエンド（`docs/`）アーキテクチャと検証

設計書/パイプライン記述は Python 側に厚いが、実際のユーザー体験（学会カタログ・家系図・ランディング）は `docs/` の静的サイトが担う。ここが薄かったので明記する。

### 構成
- `docs/` = GitHub Pages 配信の静的サイト。`pages.yml` が `docs/**` を含む push で自動デプロイ（`develop` ブランチ）。本番 = `https://taichiiiiiiii.github.io/automatic-paper-search/`。
- **共有アセット `docs/assets/`**（全ページ同じファイルを共有）:
  - `style.css` — デザイントークン（`:root` の CSS custom properties）＋全コンポーネント。editorial 方向（Newsreader serif + Inter + JetBrains Mono、warm-cream OKLCH パレット）。**生の色リテラル禁止＝必ず `--color-*` / `--text-*` / `--space-*` / `--duration-*` / `--ease` / `--rel-*` トークン経由**。
  - `app.js` — 学会カタログのビューア（検索・トピックタグ/採択形式チップ・ソート・progressive reveal 30件/回・URL 状態同期・back-to-top）。`<conf>/papers.json` を fetch。
  - `conferences-index.js` — ランディングの学会一覧＋hero dateline（`conferences.json` から集約表示、論文数降順）。
  - `lineage.js` — 家系図ビューア（Topics / Tree / Timeline モード、SVG グラフ）。`<conf>/lineage.json` を fetch。
  - `theme.js` — テーマ生成フォーム＋テーマ家系図（`/themes/`）。
- **ページ**: `docs/index.html`（ランディング、ページ固有 CSS はインライン `<style>`）/ `docs/<conf>/index.html`（学会カタログ）/ `docs/<conf>/lineage.html`（家系図）/ `docs/themes/index.html` / `docs/how-it-works/`。
- **データの流れ**: `summary.csv` → `build_pages.py` → `docs/<conf>/papers.json`（**要旨は320字プレビュー**でページ <1MB gzip）＋ `docs/conferences.json`（集約 index）。

### 重要な規約
- **アセットの cache-bust バージョンは全ページで統一**: `style.css?v=N` / `app.js?v=N` を変えたら参照する全 HTML を同じ N に揃える（過去に themes だけ別バージョンでズレた既往）。一括: `grep -rlE 'style\.css\?v=[0-9]+' docs/ | while read f; do sed -i ...; done`。
- **トピックタグ分類** = `build_summary_csv.py` の `TOPIC_RULES`（~60 カテゴリの regex、title+abstract マッチ、複数タグ可）。viewer は各会議の**上位18タグ**だけチップ表示するので大規模タクソノミでも自動適応（CV 会議は CV タスク、NLP 会議は NLP タスクが出る）。greedy な語（"evaluation"/"benchmark" 動詞/"alignment"）は避け、リソース導入表現で絞る。
- **モバイル**: タグチップは ≤720px で横スワイプ1行、フォーム入力は 16px（iOS の focus ズーム防止、`!important` で component CSS を上書き）。全ページ 320/375px で横はみ出しゼロを維持。
- **a11y**: 開閉ボタンは `aria-expanded`＋`aria-controls`、件数表示は `aria-live`、focus ring は `--color-accent` で統一。

### 検証（スクリーンショット）
- **MCP playwright は使えない**（X server 不在: "Missing X server or $DISPLAY"）。node + playwright-core を headless で直叩く:
  - `executablePath: /root/.cache/ms-playwright/chromium_headless_shell-1223/chrome-headless-shell-linux64/chrome-headless-shell`、`args:['--no-sandbox']`
  - CJS: `import pkg from '/root/.npm/_npx/9833c18b2d85bc59/node_modules/playwright-core/index.js'; const {chromium}=pkg`
  - ローカル配信: `cd docs && python3 -m http.server 8137`
  - **ディレクトリ URL で開く**（`/cvpr-2026/`）。`/index.html` 直叩きは `setLastUpdated` の slug 導出が "index.html" になり最終更新が出ない
  - **node 実行後は cwd が `/root` にリセット** → `gh` は `-R taichiiiiiiii/automatic-paper-search` を明示（`gh api` は `-R` 非対応）
- frontend に Python テストは無い。ゲートは**ローカル目視＋headless スクショ＋`ui-reviewer` エージェント**。CI は `lighthouse.yml` が docs/ PR で Core Web Vitals を **warn-only** 測定（ブロックしない）。

### カタログを追加 / 更新するフロー
収集ソースは venue で使い分ける（[CI / GitHub Actions] の `conference-on-demand.yml` 解説も参照）:

```bash
# 1) 収集（どれか）
#   arXiv 自己申告（部分収録 ~30-40%、どの venue でも可）
uv run python -m paperpilot.scripts.collect_conference --conference <slug> --venue <TOKEN> --query 'co:"<Conf Year>"' --max 1600
#   権威的全件: OpenReview = ICLR/NeurIPS/ICML（Oral/Spotlight 公式ラベル付き）
uv run python -m paperpilot.scripts.collect_openreview --conference iclr-2026 --venue ICLR --venueid "ICLR.cc/2026/Conference"
#   権威的全件: CVF Open Access = CVPR/ICCV（ECCV は ECVA で別）。oral 区分が無いので --oral-arxiv-query で arXiv 申告 oral を overlay
uv run python -m paperpilot.scripts.collect_cvf --conference cvpr-2025 --venue CVPR --cvf-id CVPR2025 --oral-arxiv-query 'co:"CVPR 2025"'
#   権威的全件: ACL Anthology = ACL/EMNLP/NAACL（XML に要旨あり）
uv run python -m paperpilot.scripts.collect_acl_anthology --conference acl-2025 --venue ACL --xml-id 2025.acl --oral-arxiv-query 'co:"ACL 2025"'

# 2) summary 化 → ページ生成 → （新規なら）ページ scaffold
uv run python -m paperpilot.scripts.build_summary_csv --conference <slug>
uv run python -m paperpilot.scripts.build_pages            # --conference 無しで conferences.json も再集約（必須）
uv run python -m paperpilot.scripts.scaffold_conference_page --conference <slug> --display "<Display>" --lede "<lede>"
```

- **`build_pages --conference X` は `conferences.json` を X だけに上書きする** → 集約は必ず `--conference` 無しで再実行。
- **再収集で oral が消える罠**: CVF/ACL は oral 区分を持たないので、arXiv で先に収集した venue を再収集すると `write_outputs` が古い oral md を消し Oral=0 になる（`--oral-arxiv-query` で overlay すれば保持）。
- **無料家系図**: S2 は 429・`build_lineage.py` は arxiv_id 必須なので、OpenReview/CVF/ACL 由来（arxiv_id 無し）には `build_conference_lineage.py`（OpenAlex title 解決→参照/被引用、LLM 不要のヒューリスティック）を使う。

---

## 絶対ルール

1. **API キーは `.env` にのみ記載。`config.yaml` や `.py` ソースには絶対に書かない**
2. **`.env` は `.gitignore` で除外されている。コミット前に `git status` で確認**
3. **外部 API を叩くテストを書かない。必ずモック**
4. **既存の Stage インターフェース（入出力の型）を変更しない**
5. **スコアリングの正規化式・重みを仕様なく変更しない**
6. **Stage 1 はフィルタのみ。スコアリングを混ぜない（§4.2）**
7. **Signal は `enrich_batch` を優先（§3.2.2）。1件ずつ処理はパフォーマンス劣化**
8. **seen_ids は `{id: timestamp}` 形式。`max_age_days` でパージ**
9. **run_history.jsonl には `finished_at` / `sources_status` / `errors` を含める**
10. **Slack / Email 通知は webhook・SMTP 未設定時に no-op（pipeline を失敗させない）**
11. **`paperpilot/scripts/` の LLM 呼び出しは `AbstractLLMProvider` を経由する。`urllib` / `requests` で Groq・Gemini・Claude を直叩きしない（二重実装を避ける）**
12. **`paperpilot/scripts/` はパイプライン出力（`output/<conf>/papers_YYYY-MM-DD.csv`）のみを入力源とする。スクリプト側で arXiv / S2 を再クロールして venue / citation / authors を再取得しない（Stage 2 の成果物を信頼する）**
    - **例外（家系図構築）:** `build_lineage.py` / `build_deep_lineage.py` が引用グラフ（S2 `references` / `citations`）を取得することは必要不可欠なので許可する。ただし焦点論文の `venue` / `venue_tier` / `citation_count` / `github_stars` は `papers.json`（Stage 2 成果物）の値を優先し、S2 からは引用関係のメタデータ（paperId, 引用 paperId のタイトル等）のみを取る。
13. **家系図ビューの `docs/<conf>/lineage.json` は `build_lineage.py` が唯一の生成元。手編集禁止**
14. **テーマ家系図 (`docs/themes/<slug>/lineage.json`) は `build_theme_lineage.py` が唯一の生成元。手編集禁止**
    - **オンデマンド生成パス (post 2026-06-03 CF Worker 復活)**: ユーザーが `/themes/` のフォームに入力 → CF Worker `worker/index.ts` `POST /api/themes` → input validate + manifest dedup (raw.githubusercontent.com) + per-IP rate limit (KV、5/h) + global daily cap (KV、100/day) → GitHub Actions REST API `POST /repos/.../workflows/theme-on-demand.yml/dispatches` → `build_theme_lineage.py` → `develop` へ commit → GH Pages 自動デプロイ (`.github/workflows/pages.yml`)。フロントは Worker URL を `docs/themes/index.html` の `<meta name="paperpilot-api-base">` から読む。空なら `window.open(GitHub Issue URL)` の degraded mode にフォールバック (Worker 不通時の保険)。
    - **PAT スコープ**: Worker は `GH_DISPATCH_PAT` (fine-grained PAT, `actions:write`, repo scope) を CF Workers Secrets に保持。CF Access を解除した workers.dev URL 経由でのみアクセス可能なので、ブラウザに露出しない。
    - **degraded mode**: `paperpilot-api-base` の meta が空、または Worker が非到達 (fetch エラー) の場合、フォームは `window.open(github issue URL)` で代替し、操作不能にならない。
    - **slug 派生は 3 か所で同期**: Python `theme_slug()` (`paperpilot/scripts/_common.py`)、フロント `SLUG_RE` (`docs/assets/theme.js`)、CF Worker `themeSlug()` + `THEME_INPUT_PATTERN` (`worker/slug.js`)。`paperpilot/tests/test_worker_slug_parity.py` が **Python ↔ Worker の 3-way parity** を pin する。テーマ regex / 正規化規則を変えるときは 3 ファイル + parity テスト同時更新。
    - **入力源はテーマ文字列のみ**（`papers.json` 非依存、conference 横断）。S2 `/paper/search` で seed 論文を発見してよい（§12 の papers.json 依存ルールはこの新パイプラインに適用しない）。
    - **LLM 呼び出しは `AbstractLLMProvider` 経由（§11）**。`expand_keywords()` / `classify_relation()` ともに provider 抽象を通す。
    - **出力 path は `theme_slug()` の戻り値のみで構成**。生 `--theme` 文字列を `Path()` 構築に渡してはならない（path traversal 防止）。
    - **`docs/themes/<slug>/lineage.json` のスキーマは conference 版 `lineage.json` と互換**（`root` / `nodes` / `edges` / `meta`）。`meta.source = "build_theme_lineage.py"`、`meta.theme` / `meta.slug` / `meta.keywords` / `meta.seeds` / `meta.depth` / `meta.since_year` / `meta.generated_at` を含む。
    - **`docs/themes/themes-manifest.json` は `generate_themes_manifest.py` のみが生成**。`build_theme_lineage.py` 内では生成しない（並列実行時の race 回避）。マニフェスト生成時に `rel` 値が許可 enum (`supersedes` / `successor` / `extends` / `ablation` / `baseline_only` / `contrasts` / `unrelated`) に該当しないテーマは skip する（cache poisoning 抑止）。
    - **キャッシュ (`paperpilot/data/lineage-cache/classifications.json`) は他 lineage スクリプトと共有**。`_classify_cached` が書込前に on-disk cache を再読込してマージし、`os.replace` でアトミックに書き出すため、並列ランでも他プロセスのエントリを上書きしない。
    - **OpenAlex-primary (post #217 / PR-G, 2026-05-27 production default)**: `theme-on-demand.yml` / `regen-themes.yml` は **`--primary-source openalex`** で起動する。`discover_seeds` は OpenAlex `/works?search=...&filter=concepts.id:C41008148|C33923547|C137293760` を直接叩き、`_work_to_paper_dict` で S2-shape paper dict に変換 (paperId=`openalex:W...`)。BFS の references/citations も OpenAlex (`Work.referenced_works` の batch fetch + `/works?filter=cites:W{id}`) で完結し、S2 API は一切呼ばない。これは S2 free-tier の shared CI IP throttle と非 organizational email での key 申請拒否を恒久回避するため。`PAPERPILOT_OPENALEX_EMAIL` を設定すると polite pool (`mailto=...`) で 10 req/s + 100K/day。
    - **`--primary-source s2` (legacy fallback)**: S2 `/paper/search` を主、OpenAlex を fallback とする旧パイプライン。S2 paperId 形式 (sha1 hash) で BFS は S2 endpoints。S2 が `top_n` 未満しか返さない場合に自動で OpenAlex `/works` 検索 → DOI 抽出 → S2 `/paper/batch` で paperId 解決。`--no-openalex-fallback` で fallback 無効化 (テスト用途)。S2 API key が用意できる環境 (e.g. .edu / 独自ドメインメール) では citation contexts と intent ラベルが取れる利点があるが、workflows の default ではない。
    - **品質改善ノイズ防止 (#127 / #186 / #188 / #189)**: 5 レイヤで off-topic 論文を除外する:
        1. **S2 `fieldsOfStudy` ゲート (#188)**: `/paper/search` リクエストに `fieldsOfStudy=Computer Science,Mathematics,Linguistics` を渡し、API レベルで医療 / 生物 / 工学論文を除外。"World Model" → "Global Burden of Disease"、"Flash Attention" → 糖尿病管理論文の混入を防ぐ。
        2. **OpenAlex `concepts.id` 同等ゲート (#189 / #190)**: `discover_seeds_via_openalex` の `filter` に `concepts.id:C41008148|C33923547|C137293760` (Computer Science / Mathematics / Linguistics) を追加。S2 throttle 時の OpenAlex fallback でも同等のドメイン制約。OR syntax は `field:val1|val2|val3` 形式 (field 名を OR 値ごとに繰り返すと HTTP 400)。
        3. **Seed topic 関連度 (`_filter_topic_relevant_seeds` #127 / #186)**: 2 単語以上のテーマで substring チェック。**2 単語 → 両方必須** (CoT-COVID 誤通過 #186 で強化)、**3+ 単語 → `ceil(N×0.5)` 必須**。verbatim phrase が title+abstract に含まれれば word-by-word チェック skip (escape hatch)。RAG / MoE / BERT のような短い single-word テーマは false match 多発するため自動 skip。
        4. **Foundational ref フィルタ (`_filter_off_topic_refs`)**: BFS で取得した parent/child 候補のうち、`citationCount > 2 × max(seed citations)` かつ S2 intent に "methodology" を含まないものを除外。"methodology" 意図がある場合はそのまま採用（その citing paper の手法を本当に支えている foundational ref のため）。閾値は初期 3x から #127 followup で 2x に絞り込み。
        5. **Implementation denylist (`_is_implementation_foundation`)**: `paperpilot/data/lineage_denylist.json` に列挙された paperId / title pattern にマッチする論文（Adam optimizer / TensorFlow / PyTorch / Scikit-learn / NumPy / SciPy / Batch Normalization / Dropout / Keras / pandas 等）は methodology intent があっても**無条件で除外**。これらは「実装の foundational」であって「研究線譜の foundational」ではないため。PyTorch Geometric のような topic-specific lib は title pattern が catch しないので残る。新しい canonical lib paper を見つけたら denylist JSON に追記する。
    - **Theme alias フォールバック (#195)**: canonical テーマ名で seed=0 になる場合、`paperpilot/data/theme_aliases.json` の代替キーワードを順次試行。例: "Speculative Decoding" → "Speculative Sampling" (S2 が後者の名義で index している)。lowercase + trim でキーマッチ、最初の成功で打ち切り。
    - **Seed quality audit (#187)**: `uv run python -m paperpilot.scripts.audit_theme_seeds` で `docs/themes/*/lineage.json` を巡回、off-topic seed を検出。CI で `.github/workflows/theme-audit.yml` (#192) が `docs/themes/**` 変更 PR で自動実行 (exit 1 で job 失敗)。Viewer 側は #194 で同等 audit を走らせ stale-banner 表示。
    - **LLM rationale (`--llm-strict=ambiguous` がデフォルト)**: `theme-on-demand.yml` は **`--llm-strict=ambiguous`** を有効化。S2 intent が `_INTENT_RELATION_MAP` のキー (methodology / result / background) に一致しない edge のみ Groq (Llama 3.3 70B) で paper-specific 分類。`--llm-strict=all` は Groq free tier の **TPM 12,000 / RPD 1,000 / TPD 100,000** 制約 (2026-06-06 確認) で破綻する (~500 tokens × 25 RPM = 12,500 TPM → 429 throttle 連鎖で 15 min timeout 到達、daily 限度も同時に削り落ちる)。Paid plan で `config.yaml` の `llm.rate_limit_rpm` を 1000+ に上げてから `--llm-strict=all` を使う。`GroqProvider` 内蔵 rate limiter (default 25 RPM) は RPM 制約だけカバー、TPM は prompt サイズで間接的に制御する。**Daily 上限 (RPD/TPD) は内蔵リミッタで追跡しない**ため、複数 theme を連投すると突発的に枯渇する — empirical で free tier は 1 rolling 24h 窓に ~2-3 large theme 実行が限度。
    - **Groq 429 circuit breaker (#191)**: `GroqProvider` が連続 3 回失敗 (request_with_retry が None / 非 200 を返す) で `_quota_exhausted=True` に latch、以降の `_chat` は API call 前に None を即返却。caller (`_CachedClassifyProvider`) は S2 intent heuristic にフォールバック。これで Groq daily quota 切れでも 15 min workflow timeout-minutes で cancel されず、heuristic で完走する。成功 200 で counter リセット (transient blip で latch しない)。
    - **LLM prompt 品質保証 (#131)**: `CLASSIFY_SYSTEM_PROMPT` (`paperpilot/llm/base.py`) は LLM が heuristic template を翻訳しないように設計されている。enum 定義を短く抽象化、MUST/MUST NOT 指示で template phrasing を明示禁止、Good 例で paper-specific rationale を few-shot 提示。Token budget は ~250 tokens に抑制 (Groq TPM 制約のため)。第二防衛線として `RelationClassification.from_dict` が `_GENERIC_TEMPLATE_RATIONALES` の文字列を返した場合 None を返して heuristic フォールバックさせる。template 追加時は両方 (prompt の MUST NOT リスト + `_GENERIC_TEMPLATE_RATIONALES`) を同期更新する。
    - **classification cache 共有 (theme 品質改善の本命)**: `build_theme_lineage` は `paperpilot/data/lineage-cache/classifications.json` を build_lineage と共有。`_CachedClassifyProvider` が AbstractLLMProvider をラップし、key `f"{a.paperId}->{b.paperId}"` で hit すれば LLM call を skip。free-tier Groq の TPM 制約はあくまで「1 run あたり」の問題で、cache が複数 run に渡って蓄積するため、テーマ再生成 / 複数テーマ間で同じ (parent, child) ペアが出てくれば LLM cost ゼロで paper-specific rationale が再利用される。template entry は from_dict の rejection (#131 第二防衛線) でヒット時も拒否され heuristic フォールバック → 次回 LLM 機会あれば再分類されて cache 更新。`persist_classifications` で atomic write (build_lineage と同じ pattern)。
    - **並列 dispatch の push 競合対策**（#121 / #125）: Worker は per-IP 5/h + global 100/day で並列 dispatch を許す設計のため、複数の `theme-on-demand` run が同時刻に `develop` へ push すると 1 本以外が `! [rejected] develop -> develop (fetch first)` で discard されていた。
        - **対策**: push step を `.github/scripts/commit-and-push.sh` 経由にして 5 回 retry（`git fetch + git rebase --autostash + git push`、各失敗で `git rebase --abort` リカバリ、3-7s ジッタ付き sleep）。`COMMIT_PUSH_NO_SLEEP=1` で sleep 無効化、`COMMIT_PUSH_MAX_ATTEMPTS=N` で回数上書き、`COMMIT_PUSH_BRANCH=name` で push 先 branch 上書き。複数 stage path 受け取り対応（#123 followup）— `bash commit-and-push.sh "$msg" path1 path2 path3` 形式で `collect-weekly` / `collect-daily-watch` (push 先は `main`) も同じ retry を使う。
        - **concurrency group は採用しない**（#125 で実測検証済）。GitHub Actions の concurrency は同一 group 内で **pending を 1 件しか保持しない**（3 件目以降の dispatch が来ると古い pending を cancel する）ため、`cancel-in-progress: false` でも 5 件同時 submit では 2/5 しか実行されない。retry のみで 5 並列を実証 (`paperpilot/tests/test_commit_and_push_sh.py::test_five_parallel_runs_all_publish` が 5 ワーカー同時 push race で全件公開を pin)。
        - shell ロジックは `paperpilot/tests/test_commit_and_push_sh.py` が subprocess 経由でカバー（5 並列 race + injection 安全 + max-retry exhaustion + path 不在 / diff なし noop）。

---

## CI / GitHub Actions

定期実行のワークフロー (`.github/workflows/`):
- `collect-weekly.yml` — 土曜 07:00 JST に主要会議の論文を深掘り収集 → `paperpilot/output/` に commit
- `collect-daily-watch.yml` — 毎日 07:00 JST に follow 著者の新作を確認 → 通知のみ
- `regen-themes.yml` — 手動 `workflow_dispatch` 専用 (PR #261 で週次 cron 廃止)。LLM 契約変更や lineage 形式バンプ後にバルク再生成する break-glass
- `theme-on-demand.yml` — フォーム送信または手動 dispatch で 1 テーマだけ生成
- `conference-on-demand.yml` — 手動 `workflow_dispatch` で**新しい学会カタログ**を end-to-end 生成 (collect_conference → build_summary_csv → build_pages → scaffold_conference_page → commit → Pages)。入力: `conference`(slug) / `venue`(VenueSignal token) / `query`(arXiv `co:"…"`) / `display` / `lede` / `max`。LLM/unarXive 不要 (カタログは arXiv メタ + VenueSignal のみで構築)。**arXiv 自己申告ベースなので部分収録(採択集合の ~30-40%)**。**ICLR/NeurIPS/ICML は `collect_openreview.py`(OpenReview api2 venueid → 全採択 + Oral/Spotlight/Poster 区分)で権威的に全件収録するのが正**(当面は手動: collect_openreview → build_summary_csv → build_pages → 既存ページなら lede/footer を OpenReview 表記に手修正。専用 workflow `openreview-on-demand.yml` は未実装=follow-up)
- `data-audit.yml` — `docs/themes/*/lineage.json` 等が変わった PR/push で seed/lineage 監査
- `lighthouse.yml` — frontend 変更 PR + 月曜定例で Core Web Vitals 計測
- `pages.yml` — `docs/**` 変更で GitHub Pages へデプロイ

### 必要な GitHub Secrets

| 名前 | 用途 | 必須？ |
|------|------|------|
| `GH_PAT` | GitHub API 用 PAT（未設定時は `github.token` fallback） | 推奨 |
| `S2_API_KEY` | Semantic Scholar (`--primary-source s2` 利用時のみ。post #217 default OpenAlex では未使用) | 任意 |
| `CLAUDE_API_KEY` | 将来の Claude Provider 用 | 任意 |
| `SLACK_WEBHOOK_URL` | Slack 通知 + 失敗時通知 | 任意 |
| `PAPERPILOT_GROQ_API_KEY` | テーマ家系図の LLM 分類 (Groq) | テーマ生成に必須 |
| `PAPERPILOT_OPENALEX_EMAIL` | OpenAlex polite pool（フォールバックの安定性向上） | 推奨 |

### CF Worker (theme submission API)

`worker/index.ts` を `wrangler.jsonc` の設定で `paperpilot-themes.puuptdbkh082.workers.dev` にデプロイ。`develop` への push で CF Workers Builds (GitHub 連携) が自動 build + deploy。

**Worker 名の経緯**: 元は `automatic-paper-search` (workers.dev URL も同じ) だったが、2026-06-03 にその URL に **Cloudflare Access Application が紐付き、Worker 削除 + 再作成でも消えない** 状態が判明。Application を消すには Zero Trust Free を活性化 (規約同意 + 課金情報入力) する必要があったため、Worker 名を `paperpilot-themes` に変更して新 URL で Access binding を回避した。これは workers.dev のサブドメイン単位で Access が account に bind される仕様への workaround。

**初回 / 再構築時の手順**:

1. Worker 名が新規 (workers.dev 上で衝突なし) であることを確認。既に Access binding が存在する name は避ける。
2. KV namespace を作成: `wrangler kv namespace create RATE_LIMIT_KV` → 出た id を `wrangler.jsonc` の `kv_namespaces[0].id` に書き戻す (placeholder のままだと deploy が validate で reject される)
3. Secret を設定: dashboard の Variables and Secrets → "+ Add" → Type=Secret, Name=`GH_DISPATCH_PAT`, Value=fine-grained PAT (this repo only, **Actions: Read & write**)。CLI 派は `wrangler secret put GH_DISPATCH_PAT` でも可
4. `git push` → CF Workers Builds が build + deploy

エンドポイント:
- `POST /api/themes` — フォーム送信。`{ theme: string }` を受け、validate + dedup + rate-limit してから theme-on-demand.yml を dispatch。レスポンスは `{ ok: true, status: "queued" | "exists", slug }` または `{ ok: false, status: "invalid" | "rate_limited" | "error", message }`
- `GET /api/themes/status?theme=<raw>` — クライアント polling 用。直近の theme-on-demand.yml run を `run-name: "theme-on-demand: <theme>"` の substring match で照合し、`{ ok: true, run: { status, conclusion, html_url } | null }` を返す
- `OPTIONS /api/*` — CORS preflight。GH Pages origin (任意) を `*` で許可

`vars` (非 secret): `GH_OWNER`, `GH_REPO`, `GH_WORKFLOW_FILE`, `GH_REF` は `wrangler.jsonc` に直書き。変更が要るときは `wrangler.jsonc` を編集して push。

### unarXive DuckDB アーティファクト (PR #222 Phase J / オペレータ runbook)

PR #222 で **citation contexts** を S2 不要で取得できるが、 unarXive
2022 dataset → DuckDB の build は CI で毎回やると 10 min + 7GB DL
で workflow timeout を圧迫する。**1 回 build → GitHub Release に
artifact 上げる → workflow が DL する** 構造。

オペレータ手順 (1 回だけ):

```bash
# 1. 依存追加 (一時的、メイン pyproject.toml には入れない)
uv pip install duckdb huggingface_hub

# 2. unarXive DuckDB を build (~5 min、HF cache hit なら ~30 s)
#    DuckDB native read_json_auto + 3-col 化 + 600ch trim で
#    生 .duckdb は ~2-3 GB、.gz は ~1-1.5 GB (2 GB 上限内)
uv run python -m paperpilot.scripts.build_unarxive_index \
    --out paperpilot/data/unarxive/unarxive.duckdb

# 3. GitHub Release tag `unarxive-v1` を作って `.gz` を attach
#    生 .duckdb は uploadしない (2 GB 超 + 帯域コスト)
gh release create unarxive-v1 \
    paperpilot/data/unarxive/unarxive.duckdb.gz \
    --title "unarXive 2022 DuckDB index (CC-BY-SA-4.0)" \
    --notes "Source: saier/unarXive_citrec, built $(date -u +%Y-%m-%d). \
Citation contexts for arXiv CS papers 1991-2022-03. \
Schema: (paper_arxiv_id, label, text[600ch]). gunzip on download."
```

ライセンス: unarXive 2022 は CC-BY-SA-4.0。`paper_license` 列は
2 GB 制約のために build 時に drop 済 (audit-only で runtime 未使用)。
viewer footer に「data: unarXive 2022 (Saier et al., CC-BY-SA-4.0)」
を必ず明記すること — 列削除した分、footer 明記が attribution 唯一の手段。

artifact が無い場合:
- workflow の DL step は `continue-on-error: true` で graceful skip
- `paperpilot.utils.unarxive.is_available()` が False を返す
- `fetch_contexts()` が `[]` 返却 → year/cite + LLM fallback
- **build pipeline は壊れない** (Phase J 効果が無効化されるだけ)

更新タイミング: unarXive 2022 は 2022-03 cutoff で固定 dataset。Re-build
は基本不要。HF dataset 側に新版が出たら新 tag (`unarxive-v2` 等) で
artifact 入れ替え → workflow 内 URL も更新。

### 注意

`.github/workflows/*.yml` を push するには PAT に **`workflow` scope が必要**。
PAT 更新手順: <https://github.com/settings/tokens> → 既存 PAT を編集 → `workflow` にチェック。

---

## Issue 作成ワークフロー

レビュー（プランレビュー / コードレビュー / paperpilot-reviewer）で検出された「ブロッキングではないが望ましい」項目を issue 化する標準手順。過去実績: 13 件を 23 分でバッチ投入 (#20〜#32)。

### Step 1. 1 issue = 1 問題 に分解

関連が強い複数指摘でも、別 issue に分けて本文でクロスリンク（`#21 の続き`）。

### Step 2. タイトル

`[<カテゴリ>] <日本語サマリ>` 形式。

| 接頭辞 | GitHub ラベル |
|---|---|
| `[bug]` | `bug` |
| `[docs]` | `documentation` |
| `[refactor]` / `[consistency]` / `[lint]` | `refactor` |
| `[tests]` / `[test-quality]` | `test` |
| `[typing]` | `typing` |
| `[scripts]` / `[spec-gap]` | `enhancement` |
| `[infrastructure]` | `infrastructure` (blocked 時は `help wanted` 併用) |

### Step 3. 本文テンプレート（5 セクション・順序厳守）

```markdown
## 概要
（1-2 段落。何が起きていて、なぜ問題か）

## 背景
（該当 CLAUDE.md §N / 設計書 §N / 過去 incident を引用）

## 該当
（file:line とコードスニペット）

## 提案 / あるべき記述
（具体的な修正方針、before/after コード例）

## タスク
- [ ] 具体的アクション 1
- [ ] 必要ならテスト追加
- [ ] 必要ならドキュメント更新
```

### Step 4. 投入

```bash
gh issue create \
  --title "[refactor] foo を bar に統一" \
  --label "refactor" \
  --body "$(cat <<'EOF'
## 概要
...
EOF
)"
```

関連 issue 群は **数分以内に連続投入** する。

### Step 5. 解決時のコミット

`closes #N` 節を含める:

```
fix(typing): resolve 7 mypy errors across scripts/ and tests/ (closes #32)
refactor(scripts): dedupe slug->venue label into _common.py (closes #30)
```

複数まとめて閉じる場合: `fix: resolve issues #1-#7, #10, #13, #15, #16`

---

## よくある実装ミスと対策

| ミス | 対策 |
|---|---|
| API キーを `config.yaml` や `.py` に書く | 必ず `.env` から読み込む |
| 外部 API を叩くテストを書く | `unittest.mock.patch` で `request_with_retry` をモック |
| Stage 1 にスコアリングを混ぜる | Stage 2 の KeywordSignal に移す（§4.2） |
| Signal で 1件ずつ loop を書く | `enrich_batch` を実装してバッチ API を使う（§4.3.1） |
| テスト失敗のまま commit | `pytest` を通してから commit |
| CI で `output/` が ignore されてコミットされない | `.gitignore` で除外しない（CI が commit するため） |
| 新しい Source を追加したのに runner に登録し忘れ | `_build_sources()` に分岐追加 |
| 新しい Signal / Exporter を `__init__.py` で export し忘れ | `__all__` を必ず更新 |

---

## 仕様変更時のルール

**仕様・設計に変更が生じた場合は、このファイル（CLAUDE.md）と設計書（[`docs/design/`](docs/design/)）を必ず同時に更新すること。**

| 変更の種類 | 更新箇所 |
|---|---|
| スコアリング重み・正規化式 | CLAUDE.md「スコアリング」表、`paperpilot/config.yaml` の `weights`、設計書 Table 12 |
| Stage の入出力の型 | `pipeline/stage_*.py`、`tests/test_stage*.py`、CLAUDE.md「Stage フロー」 |
| 新 Source / Signal / Exporter 追加 | `paperpilot/<kind>/<name>.py`、`tests/`、`runner.py`、`config.yaml`、CLAUDE.md「フォルダ構成」「プラグイン追加手順」 |
| 新 LLMProvider 追加 | `paperpilot/llm/<name>_provider.py`、`tests/`、`runner._build_llm_provider()`、`config.yaml`、`.env.example`、CLAUDE.md |
| 環境変数追加 | `.env.example`、`utils/config_loader.py` の `load_config()`、CLAUDE.md「環境変数」 |
| 新しい config キー | `config.yaml`、`runner.py` の該当 builder、設計書 §5.2 |
| GitHub Actions の変更 | `.github/workflows/*.yml`、README「GitHub Actions」節、CLAUDE.md「CI / GitHub Actions」 |
| venue 検出の tier / パターン変更 | `signals/venue_signal.py`、`tests/test_venue_stress.py`、設計書 §5.3.1 |

---

## プロジェクト固有 Skills / Sub-agents

`.claude/` 配下にこのプロジェクト専用の Skill とサブエージェントを配置しています。該当タスクの時に自動で参照されます。

### Skills（必要時のみロード）

| 名前 | 配置 | トリガー |
|------|------|---------|
| `add-plugin` | `.claude/skills/add-plugin/SKILL.md` | 「新しい Source/Signal/Exporter/LLMProvider を追加して」 |
| `run-verification` | `.claude/skills/run-verification/SKILL.md` | 「テスト流して」「PR 前チェック」 |

### Sub-agents（専門サブエージェント）

| 名前 | 担当 | モデル | 自動起動トリガー |
|------|------|------|-------------|
| `source-agent` | `paperpilot/sources/` | sonnet | 新 Source 追加・arxiv/s2/openalex 改修 |
| `signal-agent` | `paperpilot/signals/` | sonnet | 新 Signal 追加・スコア正規化変更 |
| `exporter-agent` | `paperpilot/exporters/` | sonnet | 新 Exporter 追加・CSV 列拡張 |
| `test-agent` | `paperpilot/tests/` | sonnet | カバレッジ低下・新モジュール追加後 |
| `paperpilot-reviewer` | PR 前レビュー（10項目判定） | sonnet | **全ての変更で MUST BE USED** |

エージェントの実行順序・並列化ルールは `.claude/agents/agent-orchestration.md` を参照。

### 基本の呼び出しフロー

```
新機能実装
  ↓ 専門 *-agent で TDD 実装（複数なら並列起動）
  ↓ test-agent でカバレッジ補完
  ↓ paperpilot-reviewer で最終チェック
  ↓ develop へ commit & push
```

Skill / Agent を追加・変更した時は、この表と `.claude/agents/agent-orchestration.md` の分担表も更新してください。

---

## 実装ステータス

詳細な実装状況表・過去の改善履歴・既知のオープン項目は
[`docs/design/09-implementation-status.md`](docs/design/09-implementation-status.md) に移設した
（2026-06-03 時点の記録を原文のまま保持し、冒頭に 2026-08-18 実測の現況を追記）。

現況の要点（2026-08-18 実測。数値は実データを集計して確認したもの）:

- **カタログ = 10 会議 / 28,300 本**（`docs/conferences.json`、生成 2026-06-28）
- **会議家系図の実データは 2 会議のみ**（`iclr-2026` / `eccv-2024`）。残り 8 会議の `lineage.json` は ~290B の空スタブ
- **テーマ家系図は 3 本公開**（flash-attention / mixture-of-experts / vision-transformer）
- **deep tree 14 本はビューアへの導線が無く orphan**
- **`utils.js` の `?v=` が v=75(10 ページ) と v=82(4 ページ) で不統一** ＝「アセットの cache-bust 版数は全ページで統一」規約に違反中
- テストは **1,046 passed / 1 failed**（既知の pre-existing `test_theme_typography_tokens` のみ）、lint（ruff）/ 型（mypy）は clean

---

*最終更新：2026年8月18日（① CHANGELOG の完了済み履歴 20 本を `CHANGELOG-archive.md` へ無損失退避、② 本ファイルの実装ステータス章を `docs/design/09-implementation-status.md` へ無損失移設し現況を実測で更新、③ 直近出荷 #347〜#353 を CHANGELOG に反映。詳細は CHANGELOG.md ## [Unreleased] 参照）*
