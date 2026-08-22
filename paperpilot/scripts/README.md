# PaperPilot Scripts

`paperpilot/scripts/` には 28 本の Python スクリプトがあります。
この README は全スクリプトを目的別に整理した索引です。

実行形式は `uv run python -m paperpilot.scripts.<name>` がリポジトリの慣習です
（CLAUDE.md §パイプライン参照）。

---

## 内部モジュール（直接実行しない）

アンダースコア始まりの 2 本は `if __name__ == "__main__"` を持たず、
他のスクリプトから import して使う内部ユーティリティです。

| モジュール | 役割 |
|---|---|
| `_common.py` | `slug_to_venue_label()` / `theme_slug()` など、複数スクリプトで共有する軽量のヘルパ。重い依存（gspread / torch 等）を引かない |
| `_lineage_classify.py` | テーマ家系図のエッジ関係分類（unarXive citation context → S2 intent → year/cite の 3 段フォールバック）+ LLM キャッシュプロバイダ `_CachedClassifyProvider` |

---

## 1. 収集（Collect）

各データソースから論文リストを集め、`paperpilot/output/<slug>/papers_YYYY-MM-DD.csv`
（後段の `build_summary_csv` の入力）と、可能ならば
`oral_summaries_ja.md`（Oral/Spotlight タイトル）を書き出します。

| スクリプト | 入力 → 出力 | 外部依存 |
|---|---|---|
| `collect_conference.py` | arXiv API（`co:"<VENUE YEAR>"` コメント検索）→ `output/<slug>/papers_*.csv` + `oral_summaries_ja.md` | arXiv API。`VenueSignal` で「本当にその学会に採択された論文」だけ残す |
| `collect_openreview.py` | OpenReview v2 API（`--venueid "ICLR.cc/2025/Conference"`）→ 同 | OpenReview API。Oral/Spotlight/Poster を公式 decision ラベルから取得。ICLR/NeurIPS/ICML など |
| `collect_cvf.py` | CVF Open Access（`openaccess.thecvf.com`）→ `papers_*.csv` のみ（oral 区別なし） | HTTP + Highwire メタタグパース。CVPR/ICCV/WACV 対応。ECCV は ECVA  hosting なので対象外 |
| `collect_acl_anthology.py` | ACL Anthology XML（`acl-org/acl-anthology` GitHub ミラー）→ `papers_*.csv` のみ | HTTP + XML。Long/Short/Main volume のみ。Findings/Workshop は skip |

```bash
# 使用例
uv run python -m paperpilot.scripts.collect_openreview \
    --conference iclr-2025 --venue ICLR --venueid "ICLR.cc/2025/Conference"
uv run python -m paperpilot.scripts.collect_cvf \
    --conference cvpr-2025 --venue CVPR --cvf-id CVPR2025
uv run python -m paperpilot.scripts.collect_acl_anthology \
    --conference acl-2025 --venue ACL --xml-id 2025.acl
```

---

## 2. カタログ構築（Build pages）

収集 → 要約 → 静的 JSON → 検索索引 のパイプライン。

| スクリプト | 入力 → 出力 | 備考 |
|---|---|---|
| `build_summary_csv.py` | `output/<conf>/papers_*.csv` → `output/<conf>/summary.csv`（12 列: title/type/tags/venue/authors/arxiv_url/pdf_url/abstract/arxiv_id/citation_count/venue_tier/github_stars）。`papers_*.csv` は日付付きファイル名の最新を自動探索 | type は `oral_summaries_ja.md` との突合で Oral/Poster を判定。tags は title+abstract に対する 60 種類以上の正規表現ルール（`TOPIC_RULES`）|
| `build_pages.py` | `output/<conf>/summary.csv` → `docs/<conf>/papers.json`。`--conference` 省略時は全学会を一括再構築し `docs/conferences.json` も再集約 | 訪問者配布する JSON は 28,300 本規模なので abstract は 320 文字のプレビューに丸める |
| `build_search_index.py` | 全 `docs/<conf>/papers.json` → `docs/search-index.json`（gzip 約 0.73 MB）。`daily/` など学会でないディレクトリは除外 | エントリは `[title, conference]` の位置ペア。`docs/assets/search.js` が消費 |
| `scaffold_conference_page.py` | `docs/cvpr-2026/index.html` をテンプレートに `docs/<conf>/index.html` を生成 + 空の `lineage.json` | `--conference` / `--display` / `--lede` を指定。テンプレそのものを上書きしないよう `cvpr-2026` を渡すと拒否する |

```bash
uv run python -m paperpilot.scripts.build_summary_csv --conference iclr-2026
uv run python -m paperpilot.scripts.build_pages            # 全学会 + conferences.json 再集約
uv run python -m paperpilot.scripts.build_search_index
uv run python -m paperpilot.scripts.scaffold_conference_page \
    --conference neurips-2026 --display "NeurIPS 2026" --lede "..."
```

---

## 3. 家系図生成（Lineage）

Oral 論文の引用グラフを Semantic Scholar / OpenAlex から取得し、
LLM でエッジの関係（`supersedes` / `successor` / `extends` / `ablation` /
`baseline_only` / `contrasts` / `unrelated`）を分類します。

| スクリプト | 入力 → 出力 | 外部依存 |
|---|---|---|
| `build_lineage.py` | `docs/<conf>/papers.json` → `docs/<conf>/lineage.json`（Oral 1 件あたり最大 `TOP_PARENTS=15` + `TOP_CHILDREN=15` の BFS 深 1） | **S2 無料 API** + **LLM**（`PAPERPILOT_GROQ_API_KEY` 優先、なければ `PAPERPILOT_GEMINI_API_KEY`）。`paperpilot/data/lineage-cache/` に中間結果を永続化するため中断→再開が可能 |
| `build_conference_lineage.py` | `docs/<conf>/papers.json` → `docs/<conf>/lineage.json`（OpenAlex 限定、ヒューリスティック `successor` のみ） | **OpenAlex 無料 API のみ**（LLM 不要）。S2 無料枠を消費したくない場合の structural demo / フォールバック |
| `build_deep_lineage.py` | 単一の arXiv ID → `docs/<conf>/deep-<arxiv_id>.json`（`--depth` 段の BFS） | **S2 + LLM**。`build_lineage` と同じキャッシュディレクトリを共有 |
| `build_theme_lineage.py` | フリーテキストのテーマ（`--theme "Mixture of Experts"`）→ `docs/themes/<slug>/lineage.json`。生成後は `generate_themes_manifest.py` でピッカーを更新 | **S2 + LLM**。LLM でテーマをキーワード展開 → S2 検索 → BFS → 各エッジを LLM 分類 |

### `build_lineage.py` の実行例とパラメータ

```bash
# 環境変数読み込み（.env 推奨、gitignored）
export $(grep -v '^#' paperpilot/.env | xargs)

# スモークテスト（最初の 1 件のみ）
uv run python -m paperpilot.scripts.build_lineage --limit 1

# 全 Oral（デフォルト --conference iclr-2026）
uv run python -m paperpilot.scripts.build_lineage

# 他学会 / venue ラベル上書き
uv run python -m paperpilot.scripts.build_lineage --conference neurips-2025
uv run python -m paperpilot.scripts.build_lineage --conference neurips-2025 \
    --venue-override "NeurIPS 2025"
```

| 定数 | 既定値 | 意味 |
|---|---|---|
| `TOP_PARENTS` | 15 | 各論文あたりの祖先取り込み上限 |
| `TOP_CHILDREN` | 15 | 同、子孫 |
| `S2_RATE_DELAY` | 3.5 秒 | Semantic Scholar 呼び出し間隔 |
| `LLM_RATE_DELAY["groq"]` | 2.2 秒 | Groq 呼び出し間隔（~27 RPM） |
| `LLM_RATE_DELAY["gemini"]` | 7.0 秒 | Gemini 呼び出し間隔（~8 RPM） |
| `_CLASSIFY_ABSTRACT_TRIM`（`paperpilot/llm/base.py`） | 600 文字 | LLM に渡す abstract の上限 |

キャッシュは `paperpilot/data/lineage-cache/` に:
- `paper_<arxiv_id>.json` — S2 の論文メタデータ
- `references_<s2_id>.json` / `citations_<s2_id>.json` — 引用リスト
- `classifications.json` — LLM の関係判定結果

### コスト目安（Phase 1: Oral 13 件）

- S2 呼び出し: ~30 回（無料）
- LLM 呼び出し: ~300〜400 件
  - Groq 無料枠: **$0**
  - Gemini 課金: **~$0.10〜$0.30**

---

## 4. マニフェスト生成（Manifest）

ビューアが「どのファイルが存在するか」を把握するための索引 JSON を、
ファイルシステムの状態から再生成します。

| スクリプト | 入力 → 出力 | 備考 |
|---|---|---|
| `generate_deep_manifest.py` | `docs/<conf>/deep-*.json` → `docs/<conf>/deep-manifest.json` | `deep.html` の論文セレクタ用。各エントリ `{arxiv_id, title, filename}`。`build_deep_lineage.py` 自体は書かない（並列実行との競合を避けるため） |
| `generate_themes_manifest.py` | `docs/themes/<slug>/lineage.json` → `docs/themes/themes-manifest.json` | `docs/themes/index.html` のテーマピッカー用。各エントリ `{slug, theme, generated_at, paper_count, year_range}` |

```bash
uv run python -m paperpilot.scripts.generate_deep_manifest \
    --docs-dir docs/iclr-2026
uv run python -m paperpilot.scripts.generate_themes_manifest \
    --themes-dir docs/themes
```

---

## 5. 監査・評価（Audit / Evaluation）

家系図の品質を多面的に監査します。すべて読み取り専用で、exit 0 が「全件通過」
を表します（`eval_relation_prompt` は `--gate-macro-f1` 指定時に限り gate として機能）。

| スクリプト | 対象 | 主な指標 |
|---|---|---|
| `audit_lineage_quality.py` | `docs/*/lineage.json` + `docs/themes/*/lineage.json` | template_rationale_ratio（閾値 80% で hard fail）、short_rationale_ratio、popularity_sink_count（incoming ≥ 8）、year_reversal_count、offtopic_nonfocus_ratio（warn のみ） |
| `audit_lineage_classification_breakdown.py` | 同上 + `paperpilot/data/lineage-cache/classifications.json` | エッジを provenance（`context_pattern` / `intent_map` / `year_cite` / `foundational_allowlist` / `llm`）の 5 バケットに分類。LLM が瓶颈か、上流の allowlist/template が瓶颈かを定量化 |
| `audit_theme_seeds.py` | `docs/themes/*/lineage.json` | 各テーマの focus paper がテーマ.topic と一致するか（`build_theme_lineage` と同じ `_is_on_topic` ルール）。PR #127 以前のテーマを検出 |
| `compute_theme_quality.py` | `docs/themes/*/lineage.json` → `docs/themes/_quality.json` | ビューアが各テーマカードに品質バッジを出せるよう、per-theme の node/edge/template_ratio/popularity_sinks/year_reversals を永続化 |
| `eval_relation_prompt.py` | `paperpilot/tests/fixtures/relation_gold_set.jsonl` | `--predictor=current`（固定スナップショット、トークン消費なし）/ `--predictor=live`（LLM を実際に呼んで精度・再現・macro-F1 を測定）。`--provider={auto,groq,gemini}` |
| `eval_theme_quality.py` | 1 テーマの `lineage.json` | template_ratio / title_ref_ratio / rationale_uniqueness / both_end_ref の 4 軸で A/B/C/D を格付け。Step B の on-demand regen 後に使用 |

```bash
uv run python -m paperpilot.scripts.audit_lineage_quality
uv run python -m paperpilot.scripts.audit_lineage_classification_breakdown --json
uv run python -m paperpilot.scripts.audit_theme_seeds
uv run python -m paperpilot.scripts.compute_theme_quality
uv run python -m paperpilot.scripts.eval_relation_prompt
uv run python -m paperpilot.scripts.eval_relation_prompt --predictor=live --provider=gemini
```

---

## 6. キャッシュ保守（Cache maintenance）

LLM 分類キャッシュ（`paperpilot/data/lineage-cache/classifications.json`）と
unarXive のローカル索引を整形します。

| スクリプト | 動作 |
|---|---|
| `compact_classifications.py` | 現在の `docs/**/lineage.json` と `docs/**/deep-*.json` に現れない paperId ペアのキャッシュエントリを削除。`--dry-run` で確認のみ |
| `purge_template_classifications.py` | `TEMPLATE_RATIONALES.values()` と byte 一致する rationale を持つエントリを一括削除。PR #131 以前の LLM テンプレート残留を一掃する one-shot。冪等 |
| `build_unarxive_index.py` | HF `saier/unarXive_citrec`（~7 GB）→ DuckDB（~2-3 GB）+ `.gz`。Release asset（`unarxive-v1` タグ）には gzip のみアップロード。CI は gunzip してから利用 |

```bash
uv run python -m paperpilot.scripts.compact_classifications
uv run python -m paperpilot.scripts.compact_classifications --dry-run
uv run python -m paperpilot.scripts.purge_template_classifications
uv run python -m paperpilot.scripts.build_unarxive_index \
    --out paperpilot/data/unarxive/unarxive.duckdb
```

`build_unarxive_index` は追加依存が必要です:

```bash
uv pip install 'paperpilot[unarxive]'   # = duckdb + huggingface_hub
```

---

## 7. アセット版数同期

| スクリプト | 動作 |
|---|---|
| `sync_asset_versions.py` | `docs/assets/*.css` / `*.js` の内容ハッシュ（sha256 の先頭 12 桁）を `docs/assets/versions.json` に唯一の真実源として保持し、全 HTML の `?v=<N>` を一括書き戻し。バイトが変わった時のみ版が上がる。`--check` は書き込まずに乖離を報告して非ゼロ終了（CI 用） |
| `build_sitemap.py` | `docs/**/*.html` の実在ページから `docs/sitemap.xml` を生成（`index.html` はディレクトリ形に畳み、`404.html` は除外）。`--check` は書き込まずに乖離で非ゼロ終了。手作業だった頃に 6 URL のまま放置され会議カタログ 8 件が漏れていた（#367）ので、以後は手編集しない |

```bash
uv run python -m paperpilot.scripts.sync_asset_versions        # 書き込み
uv run python -m paperpilot.scripts.sync_asset_versions --check  # CI gate
```

---

## 8. 外部同期

| スクリプト | 動作 |
|---|---|
| `sync_to_sheets.py` | `output/<conf>/summary.csv` を Google Sheets に同期（冪等・上書き）。サービスアカウント JSON が必要。`pip install -e '.[sheets]'`（gspread + google-auth） |

### `sync_to_sheets.py` の詳細

#### 1. セットアップ（初回のみ）

##### サービスアカウントを作成

1. <https://console.cloud.google.com/> で新規プロジェクト作成
2. **APIs & Services** → **Library** で以下を有効化:
   - Google Sheets API
   - Google Drive API
3. **APIs & Services** → **Credentials** → **Create Credentials** → **Service Account**
4. 作成したアカウント → **Keys** → **Add Key** → **JSON** をダウンロード
5. JSON ファイルを安全な場所に保存（例: `~/secrets/paperpilot-sa.json`）

##### 依存パッケージインストール

```bash
pip install -e '.[sheets]'
```

#### 2. 実行

##### A. 新規 Spreadsheet を作成

```bash
export GOOGLE_APPLICATION_CREDENTIALS=~/secrets/paperpilot-sa.json
export PAPERPILOT_SHEET_SHARE_EMAIL=you@example.com  # 自分のアカウントへ共有

uv run python -m paperpilot.scripts.sync_to_sheets
# -> OK Synced 218 rows -> https://docs.google.com/spreadsheets/d/xxxxx
# -> Spreadsheet ID: xxxxx
```

出力された **Spreadsheet ID** を環境変数に保存しておくと、次回以降は同じ Sheet が更新されます。

##### B. 既存 Spreadsheet を更新（推奨）

```bash
export GOOGLE_APPLICATION_CREDENTIALS=~/secrets/paperpilot-sa.json
export PAPERPILOT_SHEET_ID=xxxxx  # 上で取得した ID

uv run python -m paperpilot.scripts.sync_to_sheets
# -> OK Synced 218 rows -> https://docs.google.com/spreadsheets/d/xxxxx
```

#### 3. オプション

```bash
uv run python -m paperpilot.scripts.sync_to_sheets \
    --csv paperpilot/output/iclr-2026/summary.csv \
    --credentials ~/secrets/paperpilot-sa.json \
    --sheet-id xxxxx \
    --tab summary \
    --title "PaperPilot — ICLR 2026 Summary"
```

| 引数 | 環境変数 | デフォルト |
|------|---------|----------|
| `--conference` | — | `iclr-2026`（`--csv` / `--title` が未指定の時にここから派生） |
| `--csv` | — | `output/<conference>/summary.csv` |
| `--credentials` | `GOOGLE_APPLICATION_CREDENTIALS` | （必須） |
| `--sheet-id` | `PAPERPILOT_SHEET_ID` | （未指定時は新規作成） |
| `--tab` | — | `summary` |
| `--title` | — | `PaperPilot — <VENUE> Summary` |
| `--share` | `PAPERPILOT_SHEET_SHARE_EMAIL` | （新規作成時のみ使用） |

##### 他学会の同期（例）

```bash
# NeurIPS 2025 の summary.csv を同期（ID は学会ごとに別 sheet を想定）
uv run python -m paperpilot.scripts.sync_to_sheets --conference neurips-2025
```

##### 自動書式

- ヘッダ行: 太字 + グレー背景 + 凍結
- `type=Oral` の行: 黄色背景でハイライト

##### CI で自動更新したい場合

GitHub Actions に追加（例）:

```yaml
- name: Sync to Google Sheets
  env:
    GOOGLE_APPLICATION_CREDENTIALS: ${{ runner.temp }}/sa.json
    PAPERPILOT_SHEET_ID: ${{ secrets.PAPERPILOT_SHEET_ID }}
  run: |
    echo '${{ secrets.GCP_SA_JSON }}' > $GOOGLE_APPLICATION_CREDENTIALS
    pip install -e '.[sheets]'
    uv run python -m paperpilot.scripts.build_summary_csv
    uv run python -m paperpilot.scripts.sync_to_sheets
```

GitHub Secrets:

- `GCP_SA_JSON` — サービスアカウント JSON（中身を丸ごと貼る）
- `PAPERPILOT_SHEET_ID` — Spreadsheet ID

---

## パイプラインの通し例（新規学会を追加する流れ）

```bash
# 1. 収集
uv run python -m paperpilot.scripts.collect_openreview \
    --conference neurips-2026 --venue NEURIPS \
    --venueid "NeurIPS.cc/2026/Conference"

# 2. 要約 → papers.json → 検索索引
uv run python -m paperpilot.scripts.build_summary_csv --conference neurips-2026
uv run python -m paperpilot.scripts.build_pages            # conferences.json も再集約
uv run python -m paperpilot.scripts.build_search_index

# 3. カタログページの足組み
uv run python -m paperpilot.scripts.scaffold_conference_page \
    --conference neurips-2026 --display "NeurIPS 2026" --lede "..."

# 4. アセット版数の整合
uv run python -m paperpilot.scripts.sync_asset_versions

# 5. (Optional) 家系図
uv run python -m paperpilot.scripts.build_lineage --conference neurips-2026
```
