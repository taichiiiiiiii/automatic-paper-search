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
    │   ├── github_signal.py             # PwC + GitHub Stars (log-scale)
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
    │   └── build_lineage.py             # papers.json + S2 + LLM → lineage.json
    ├── models/
    │   └── paper.py                     # Paper データクラス
    ├── utils/
    │   ├── config_loader.py             # YAML + .env 統合
    │   ├── dedup.py                     # dedup + seen_ids 管理
    │   ├── rate_limiter.py              # 同期 sleep ベース
    │   ├── http.py                      # 指数バックオフ retry
    │   ├── json_parser.py               # LLM 3段階フォールバック
    │   └── logger.py                    # 日次ローテ (7日保持)
    ├── tests/                           # pytest テスト（カバレッジ 97%）
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

## 開発ワークフロー（TDD 必須）

**この順序を守ること。**

1. **RED** — 先に `paperpilot/tests/test_<module>.py` を書き、テストが失敗することを確認
2. **GREEN** — 最小の実装でテストを通す
3. **REFACTOR** — 設計原則に沿って整える
4. **カバレッジ確認** — `pytest --cov=paperpilot` で **80% 以上**（現状 97%）
5. **コミット** — `develop` ブランチへ push、メインブランチはリリース時のみ

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
       └─ build_lineage.py  → docs/<conf>/lineage.json
            │                  - S2 から references/citations を取得
            │                  - AbstractLLMProvider で関係種別を分類
            │                  - lineage-cache/ にキャッシュして再開可能
            │
            ▼
       docs/<conf>/lineage.html   （家系図 SVG レンダリング）
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
13. **家系図ビューの `docs/<conf>/lineage.json` は `build_lineage.py` が唯一の生成元。手編集禁止**

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

### 注意

`.github/workflows/*.yml` を push するには PAT に **`workflow` scope が必要**。
PAT 更新手順: <https://github.com/settings/tokens> → 既存 PAT を編集 → `workflow` にチェック。

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

## 実装ステータス（2026-04-21 時点）

| 仕様 | 状態 |
|------|------|
| Stage 0 (async 並列収集) | ✅ arXiv / S2 / OpenAlex |
| Stage 1 (rule filter) | ✅ カテゴリ / 日付 / 除外 / seen_ids |
| Stage 2 (metric scoring) | ✅ venue / citation / author / github / keyword / follow |
| Stage 3 (embedding) | ✅ MiniLM / backend=minilm（SPECTER2/BGE は将来拡張） |
| Stage 4 (LLM rerank) | ✅ Ollama / Gemini / Claude / Groq |
| Exporters | ✅ CSV / JSON / Slack / Email |
| 差分更新 (seen_ids) | ✅ `{id: timestamp}` 日次パージ |
| GitHub Actions | ⏸️ ワークフロー作成済み、PAT の workflow scope 追加待ち（#12 / #14） |
| **ビューア一覧 (papers.json)** | ✅ `index.html` + `build_pages.py` で生成 |
| **家系図ビュー (lineage.json)** | ✅ `build_lineage.py` が `AbstractLLMProvider.classify_relation` 経由で生成。週次 CI (`collect-weekly.yml`) に統合済 |
| **Groq Provider (lineage 第一候補)** | ✅ `paperpilot/llm/groq_provider.py` (Gemini もフォールバック対応) |
| **scripts のテスト** | 🟡 `build_lineage` / `build_pages` / `build_summary_csv` は smoke test 済。`sync_to_sheets` は未対応（#24） |
| venue 正規表現検出率 | ✅ 100% (60 パターン / 目標 95%) |
| テストカバレッジ | ✅ 96% (334 tests) |

---

*最終更新：2026年4月21日（Groq Provider / classify_relation 抽象を追加、家系図ビューを週次 CI に統合、`paperpilot/scripts/*` に smoke test を追加）*
