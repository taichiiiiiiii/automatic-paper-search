# CLAUDE.md — PaperPilot 実装ガイド

このファイルは Claude Code が本プロジェクトを実装する際に参照する指示書です。
設計書（[`docs/design/`](docs/design/)）および市場調査レポート（[`docs/research/`](docs/research/)）と合わせて読むこと。
原本 `.docx` は [`archive/`](archive/) に保管されていますが、**編集は markdown 側で行う**ことが正。

---

## プロジェクト概要

- **目的：** AI/ML 論文を arXiv / Semantic Scholar / OpenAlex から自動収集し、品質シグナルで絞り込んだ上で **系譜（家系図）として可視化** するパイプライン
- **主要な出力：** Cloudflare Pages 上のインタラクティブ家系図ビュー（`docs/<conference>/lineage.html`）。補助出力として CSV / JSON / Slack / Email も維持
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

```bash
pip install -e '.[dev]'       # runtime + pytest + ruff + mypy
ruff check paperpilot/         # lint
ruff format paperpilot/        # format
mypy paperpilot/                # type check
pytest paperpilot/tests/ --cov=paperpilot   # test
pre-commit install             # git hook
```

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
│   ├── _headers                         # Cloudflare Pages キャッシュ / セキュリティヘッダ
│   ├── iclr-2026/                       # Cloudflare Pages 論文ビューア（家系図ビュー本命）
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
│       ├── regen-themes.yml             # 毎週日曜 09:00 JST 全テーマ再生成
│       ├── theme-on-demand.yml          # ★ オンデマンド単一テーマ生成（CF Worker から workflow_dispatch）
│       ├── lighthouse.yml               # PR ごと + 週次の Lighthouse / Core Web Vitals 測定
│       ├── data-audit.yml               # ★ PR/push 時に audit_theme_seeds + audit_lineage_quality 自動実行 → off-topic seed / 構造異常 regression を block
│       └── publish.yml                  # PyPI trusted-publisher（release 発火）
├── worker/                              # ★ Cloudflare Worker (theme submission API)
│   ├── index.ts                         # POST /api/themes ハンドラ
│   ├── slug.js                          # themeSlug() 共有 (Python と parity test)
│   ├── index.test.mjs                   # node 単体テスト
│   └── README.md                        # 設定 / デプロイ手順
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
    │   ├── build_summary_csv.py         # full CSV → summary.csv (8 列 + 自動タグ)
    │   ├── build_pages.py               # summary.csv → docs/<conf>/papers.json
    │   ├── build_lineage.py             # papers.json + S2 + LLM → lineage.json
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
    ├── tests/                           # pytest テスト（カバレッジ 91%、644 件）
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

配信用 Exporter とは別に、Cloudflare Pages 上の家系図ビューを生成する **補助パイプライン** を `paperpilot/scripts/` に置く。通常ランの後に順に実行し、`docs/<conference>/` を更新する（Cloudflare Pages が push をフックして自動デプロイ）。

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
                  - keyword_expand → S2 /paper/search → top-N seeds
                    └─ S2 が throttle / 0 件なら OpenAlex /works → S2 /paper/batch
                  - 各 seed から BFS depth-N（祖先方向）
                  - AbstractLLMProvider で関係分類
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
    - **オンデマンド生成パス**: ユーザーが `/themes/` のフォームに入力 → 同一オリジンの CF Worker `POST /api/themes` (`worker/index.ts`) → `theme-on-demand.yml` workflow_dispatch → `build_theme_lineage.py` → `develop` へ commit → CF Pages 自動デプロイ。フロントは `themes-manifest.json` をポーリングして slug 出現で redirect。Worker と静的バンドルは**ルートの単一 `wrangler.jsonc`** で共存させる（`main: worker/index.ts` + `assets.directory: docs`）。`-api` サブドメインは廃止。
    - **slug 派生はの 3 か所で同期**: Python `theme_slug()`、JS `worker/slug.js`、フロント `SLUG_RE`。`paperpilot/tests/test_worker_slug_parity.py` が parity を pin。
    - **入力源はテーマ文字列のみ**（`papers.json` 非依存、conference 横断）。S2 `/paper/search` で seed 論文を発見してよい（§12 の papers.json 依存ルールはこの新パイプラインに適用しない）。
    - **LLM 呼び出しは `AbstractLLMProvider` 経由（§11）**。`expand_keywords()` / `classify_relation()` ともに provider 抽象を通す。
    - **出力 path は `theme_slug()` の戻り値のみで構成**。生 `--theme` 文字列を `Path()` 構築に渡してはならない（path traversal 防止）。
    - **`docs/themes/<slug>/lineage.json` のスキーマは conference 版 `lineage.json` と互換**（`root` / `nodes` / `edges` / `meta`）。`meta.source = "build_theme_lineage.py"`、`meta.theme` / `meta.slug` / `meta.keywords` / `meta.seeds` / `meta.depth` / `meta.since_year` / `meta.generated_at` を含む。
    - **`docs/themes/themes-manifest.json` は `generate_themes_manifest.py` のみが生成**。`build_theme_lineage.py` 内では生成しない（並列実行時の race 回避）。マニフェスト生成時に `rel` 値が許可 enum (`supersedes` / `successor` / `extends` / `ablation` / `baseline_only` / `contrasts` / `unrelated`) に該当しないテーマは skip する（cache poisoning 抑止）。
    - **キャッシュ (`paperpilot/data/lineage-cache/classifications.json`) は他 lineage スクリプトと共有**。`_classify_cached` が書込前に on-disk cache を再読込してマージし、`os.replace` でアトミックに書き出すため、並列ランでも他プロセスのエントリを上書きしない。
    - **OpenAlex フォールバック (seed 発見)**: S2 `/paper/search` が `top_n` 未満しか返さない場合（GitHub Actions の共有 IP プールが S2 free tier に throttle される CI ステディ状態）、自動で OpenAlex `/works` 検索 → DOI 抽出 → S2 `/paper/batch` で paperId 解決にフォールバック。`/paper/batch` は `/paper/search` と別のレート枠なので throttle 同時発生確率が低い。`PAPERPILOT_OPENALEX_EMAIL` を設定すると polite pool（`mailto=...`）を使い更に安定。`--no-openalex-fallback` で明示的に無効化可能（テスト用途）。
    - **品質改善ノイズ防止 (#127 / #186 / #188 / #189)**: 5 レイヤで off-topic 論文を除外する:
        1. **S2 `fieldsOfStudy` ゲート (#188)**: `/paper/search` リクエストに `fieldsOfStudy=Computer Science,Mathematics,Linguistics` を渡し、API レベルで医療 / 生物 / 工学論文を除外。"World Model" → "Global Burden of Disease"、"Flash Attention" → 糖尿病管理論文の混入を防ぐ。
        2. **OpenAlex `concepts.id` 同等ゲート (#189 / #190)**: `discover_seeds_via_openalex` の `filter` に `concepts.id:C41008148|C33923547|C137293760` (Computer Science / Mathematics / Linguistics) を追加。S2 throttle 時の OpenAlex fallback でも同等のドメイン制約。OR syntax は `field:val1|val2|val3` 形式 (field 名を OR 値ごとに繰り返すと HTTP 400)。
        3. **Seed topic 関連度 (`_filter_topic_relevant_seeds` #127 / #186)**: 2 単語以上のテーマで substring チェック。**2 単語 → 両方必須** (CoT-COVID 誤通過 #186 で強化)、**3+ 単語 → `ceil(N×0.5)` 必須**。verbatim phrase が title+abstract に含まれれば word-by-word チェック skip (escape hatch)。RAG / MoE / BERT のような短い single-word テーマは false match 多発するため自動 skip。
        4. **Foundational ref フィルタ (`_filter_off_topic_refs`)**: BFS で取得した parent/child 候補のうち、`citationCount > 2 × max(seed citations)` かつ S2 intent に "methodology" を含まないものを除外。"methodology" 意図がある場合はそのまま採用（その citing paper の手法を本当に支えている foundational ref のため）。閾値は初期 3x から #127 followup で 2x に絞り込み。
        5. **Implementation denylist (`_is_implementation_foundation`)**: `paperpilot/data/lineage_denylist.json` に列挙された paperId / title pattern にマッチする論文（Adam optimizer / TensorFlow / PyTorch / Scikit-learn / NumPy / SciPy / Batch Normalization / Dropout / Keras / pandas 等）は methodology intent があっても**無条件で除外**。これらは「実装の foundational」であって「研究線譜の foundational」ではないため。PyTorch Geometric のような topic-specific lib は title pattern が catch しないので残る。新しい canonical lib paper を見つけたら denylist JSON に追記する。
    - **Theme alias フォールバック (#195)**: canonical テーマ名で seed=0 になる場合、`paperpilot/data/theme_aliases.json` の代替キーワードを順次試行。例: "Speculative Decoding" → "Speculative Sampling" (S2 が後者の名義で index している)。lowercase + trim でキーマッチ、最初の成功で打ち切り。
    - **Seed quality audit (#187)**: `uv run python -m paperpilot.scripts.audit_theme_seeds` で `docs/themes/*/lineage.json` を巡回、off-topic seed を検出。CI で `.github/workflows/theme-audit.yml` (#192) が `docs/themes/**` 変更 PR で自動実行 (exit 1 で job 失敗)。Viewer 側は #194 で同等 audit を走らせ stale-banner 表示。
    - **LLM rationale (`--llm-strict=ambiguous` がデフォルト)**: `theme-on-demand.yml` は **`--llm-strict=ambiguous`** を有効化。S2 intent が `_INTENT_RELATION_MAP` のキー (methodology / result / background) に一致しない edge のみ Groq (Llama 3.3 70B) で paper-specific 分類。`--llm-strict=all` は Groq free tier の TPM 制約 (6,000 tokens/min) で破綻する (~2,000 tokens × 25 RPM = 50,000 TPM → 429 throttle 連鎖で 15 min timeout 到達)。Paid plan で `config.yaml` の `llm.rate_limit_rpm` を 1000+ に上げてから `--llm-strict=all` を使う。`GroqProvider` 内蔵 rate limiter (default 25 RPM) は RPM 制約だけカバー、TPM は prompt サイズで間接的に制御する。
    - **Groq 429 circuit breaker (#191)**: `GroqProvider` が連続 3 回失敗 (request_with_retry が None / 非 200 を返す) で `_quota_exhausted=True` に latch、以降の `_chat` は API call 前に None を即返却。caller (`_CachedClassifyProvider`) は S2 intent heuristic にフォールバック。これで Groq daily quota 切れでも 15 min workflow timeout-minutes で cancel されず、heuristic で完走する。成功 200 で counter リセット (transient blip で latch しない)。
    - **LLM prompt 品質保証 (#131)**: `CLASSIFY_SYSTEM_PROMPT` (`paperpilot/llm/base.py`) は LLM が heuristic template を翻訳しないように設計されている。enum 定義を短く抽象化、MUST/MUST NOT 指示で template phrasing を明示禁止、Good 例で paper-specific rationale を few-shot 提示。Token budget は ~250 tokens に抑制 (Groq TPM 制約のため)。第二防衛線として `RelationClassification.from_dict` が `_GENERIC_TEMPLATE_RATIONALES` の文字列を返した場合 None を返して heuristic フォールバックさせる。template 追加時は両方 (prompt の MUST NOT リスト + `_GENERIC_TEMPLATE_RATIONALES`) を同期更新する。
    - **classification cache 共有 (theme 品質改善の本命)**: `build_theme_lineage` は `paperpilot/data/lineage-cache/classifications.json` を build_lineage と共有。`_CachedClassifyProvider` が AbstractLLMProvider をラップし、key `f"{a.paperId}->{b.paperId}"` で hit すれば LLM call を skip。free-tier Groq の TPM 制約はあくまで「1 run あたり」の問題で、cache が複数 run に渡って蓄積するため、テーマ再生成 / 複数テーマ間で同じ (parent, child) ペアが出てくれば LLM cost ゼロで paper-specific rationale が再利用される。template entry は from_dict の rejection (#131 第二防衛線) でヒット時も拒否され heuristic フォールバック → 次回 LLM 機会あれば再分類されて cache 更新。`persist_classifications` で atomic write (build_lineage と同じ pattern)。
    - **並列 dispatch の push 競合対策**（#121 / #125）: Worker は per-IP 5/h + global 100/day で並列 dispatch を許す設計のため、複数の `theme-on-demand` run が同時刻に `develop` へ push すると 1 本以外が `! [rejected] develop -> develop (fetch first)` で discard されていた。
        - **対策**: push step を `.github/scripts/commit-and-push.sh` 経由にして 5 回 retry（`git fetch + git rebase --autostash + git push`、各失敗で `git rebase --abort` リカバリ、3-7s ジッタ付き sleep）。`COMMIT_PUSH_NO_SLEEP=1` で sleep 無効化、`COMMIT_PUSH_MAX_ATTEMPTS=N` で回数上書き、`COMMIT_PUSH_BRANCH=name` で push 先 branch 上書き。複数 stage path 受け取り対応（#123 followup）— `bash commit-and-push.sh "$msg" path1 path2 path3` 形式で `collect-weekly` / `collect-daily-watch` (push 先は `main`) も同じ retry を使う。
        - **concurrency group は採用しない**（#125 で実測検証済）。GitHub Actions の concurrency は同一 group 内で **pending を 1 件しか保持しない**（3 件目以降の dispatch が来ると古い pending を cancel する）ため、`cancel-in-progress: false` でも 5 件同時 submit では 2/5 しか実行されない。retry のみで 5 並列を実証 (`paperpilot/tests/test_commit_and_push_sh.py::test_five_parallel_runs_all_publish` が 5 ワーカー同時 push race で全件公開を pin)。
        - shell ロジックは `paperpilot/tests/test_commit_and_push_sh.py` が subprocess 経由でカバー（5 並列 race + injection 安全 + max-retry exhaustion + path 不在 / diff なし noop）。

---

## CI / GitHub Actions

`.github/workflows/collect.yml` が毎日 22:00 UTC（07:00 JST）に実行。
結果は `paperpilot/output/` と `paperpilot/data/` に commit される。

### 必要な GitHub Secrets

| 名前 | 用途 | 必須？ |
|------|------|------|
| `GH_PAT` | GitHub API 用 PAT（未設定時は `github.token` fallback） | 推奨 |
| `S2_API_KEY` | Semantic Scholar | 任意 |
| `CLAUDE_API_KEY` | 将来の Claude Provider 用 | 任意 |
| `SLACK_WEBHOOK_URL` | Slack 通知 + 失敗時通知 | 任意 |
| `PAPERPILOT_GROQ_API_KEY` | テーマ家系図の LLM 分類 (Groq) | テーマ生成に必須 |
| `PAPERPILOT_OPENALEX_EMAIL` | OpenAlex polite pool（フォールバックの安定性向上） | 推奨 |

CF Worker 側のシークレット (`wrangler secret put`):

| 名前 | 用途 |
|------|------|
| `GH_DISPATCH_PAT` | `theme-on-demand.yml` を workflow_dispatch する PAT (`actions: write` のみ) |

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
| GitHub Actions の変更 | `.github/workflows/collect.yml`、README「GitHub Actions」節、CLAUDE.md「CI / GitHub Actions」 |
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

## 実装ステータス（2026-05-25 時点）

### パイプライン
| 仕様 | 状態 |
|------|------|
| Stage 0 (async 並列収集) | ✅ arXiv / S2 / OpenAlex |
| Stage 1 (rule filter) | ✅ カテゴリ / 日付 / 除外 / seen_ids |
| Stage 2 (metric scoring) | ✅ venue / citation / author / github / keyword / follow |
| Stage 3 (embedding) | ✅ MiniLM / backend=minilm（SPECTER2/BGE は将来拡張） |
| Stage 4 (LLM rerank) | ✅ Ollama / Gemini / Claude / Groq |
| Exporters | ✅ CSV / JSON / Slack / Email |
| 差分更新 (seen_ids) | ✅ `{id: timestamp}` 日次パージ |

### CI / ワークフロー
| 仕様 | 状態 |
|------|------|
| 週次深掘り (`collect-weekly.yml`) | ✅ uv sync 移行 (#136)、合計 3 件の startup_failure + numpy missing + empty-dir guard 修正 (#135-137)、develop push (#141) |
| 毎日 follow-watch (`collect-daily-watch.yml`) | ✅ uv sync 移行 (#142)、develop push (#141) |
| オンデマンド theme (`theme-on-demand.yml`) | ✅ `--llm-strict=ambiguous` 有効化 (#133)、timeout 15min |
| 週次 theme regen (`regen-themes.yml`) | ✅ `--llm-strict=ambiguous` (#143)、timeout 120min (#144) |
| Push race retry (`commit-and-push.sh`) | ✅ 5 回 retry + jittered sleep + multi-path 対応 (#122 / #140)、12 unit tests |
| Workflow YAML 不変条件 | ✅ `test_workflow_yaml_quality.py` (secrets-in-step-if 防止 #135) |
| Lighthouse CI (`lighthouse.yml`) | ✅ PR + 週次月曜で `treosh/lighthouse-ci-action@v12` 実行、staticDistDir で docs/ をローカル serve → 4 ページ × 3 run。`LHCI_GITHUB_APP_TOKEN` (任意) があれば PR コメント、無ければ temporary-public-storage アップロード。assert は warn-only (LCP 2.5s / CLS 0.1 / TBT 200ms / FCP 1.5s 上限) |
| Data audit (`data-audit.yml`) | ✅ PR/push 時に `docs/themes/**` / `docs/iclr-*/**` / build / audit script 変更で fire。`audit_theme_seeds` (#192) + `audit_lineage_quality` (#197) を順次実行 (両者 exit 1 で job fail)。Job Summary に各監査結果を個別 Markdown 表示 (#199) |

### ビューア
| 仕様 | 状態 |
|------|------|
| 論文一覧 (`papers.json`) | ✅ `index.html` + `build_pages.py` で生成 |
| Conference 家系図 (`lineage.json`) | ✅ `build_lineage.py` が `AbstractLLMProvider.classify_relation` 経由で生成。週次 CI 統合済 |
| Conference deep tree (`deep-*.json`) | ✅ `build_deep_lineage.py`、14 件生成済 |
| **テーマ家系図 (`themes/<slug>/`)** | ✅ Frontend form → CF Worker → `theme-on-demand.yml` の full pipeline 稼働中。19 themes 公開 |

### Theme 家系図の品質改善 (本セッションの主軸)
| 仕様 | 状態 |
|------|------|
| Foundational ref フィルタ (#127) | ✅ `_filter_off_topic_refs`、`citationCount > 2 × max(seed cites)` で除外 |
| Topic relevance seed フィルタ (#127) | ✅ `_filter_topic_relevant_seeds`、多単語テーマでタイトル/アブストラクト一致要求 |
| Implementation denylist (#128) | ✅ `paperpilot/data/lineage_denylist.json` (10 paperIds + 15 title pattern) |
| LLM strict mode (`--llm-strict`) | ✅ off / ambiguous / all、production default = ambiguous |
| Classification cache 共有 (#138/#139) | ✅ `_CachedClassifyProvider` + `paperpilot/data/lineage-cache/classifications.json` を build_lineage と共有、git 永続化 (.gitignore 個別 un-ignore) |
| Groq rate limiter (#130) | ✅ default 25 RPM、`config.yaml` の `llm.rate_limit_rpm` で paid plan 拡張可 |
| LLM prompt 品質 (#131-#133) | ✅ ~250 tokens に圧縮、MUST/MUST NOT block、`TEMPLATE_RATIONALES` 単一 source (#146) |
| Template echo reject (#132) | ✅ `RelationClassification.from_dict` が `_GENERIC_TEMPLATE_RATIONALES` の文字列を拒否 |
| 不変条件 pin (#134, #146) | ✅ prompt size / `--llm-strict` flag / template dedup の regression test 完備 |

### コード品質
| 仕様 | 状態 |
|------|------|
| ruff (lint) | ✅ 105 files clean |
| mypy (type check) | ✅ 105 files clean |
| pytest テスト数 | ✅ **644 tests pass** |
| venue 正規表現検出率 | ✅ 100% (60 パターン / 目標 95%) |
| `build_theme_lineage()` 行数 | ✅ Stage 別 helper 抽出後 238 行 (#148) |

### 既知のオープン項目
- **Bulk regen 19 themes の timeout 問題**: 60 / 120 min いずれも完走せず。S2 throttle on shared CI IP + 60s inter-theme cool-off が支配的。Matrix parallel 化が必要 (未着手)。
- **LLM rationale 累積**: classifications.json は git 永続化済、theme-on-demand と weekly cron で漸進的に蓄積。

---

*最終更新：2026年5月25日（28 PRs の品質向上 + 整理セッション完了。詳細は CHANGELOG.md ## [Unreleased] 参照）*
