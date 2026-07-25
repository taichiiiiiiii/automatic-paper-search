# PaperPilot Scripts

補助スクリプト集。`paperpilot/output/` を加工して人間/外部ツールに渡せる形にします。

---

## `build_summary_csv.py` — 軽量まとめ CSV を作る

PaperPilot の出力 CSV（30+ カラム）から、見やすい 8 カラムの要約 CSV を生成します。

```bash
python paperpilot/scripts/build_summary_csv.py
# -> paperpilot/output/iclr-2026/summary.csv
```

**カラム**: `title, type, tags, venue, authors, arxiv_url, pdf_url, abstract`

- `type`: `Oral` / `Poster` （`oral_summaries_ja.md` のタイトルと突合）
- `tags`: `LLM` `VLM` `Diffusion` `Theory` ... のキーワード自動分類

---

## `sync_to_sheets.py` — Google Spreadsheet に同期

`summary.csv` を Google Sheets にアップロードします。**冪等**（同じ Sheet を上書き）。

### 1. セットアップ（初回のみ）

#### サービスアカウントを作成

1. <https://console.cloud.google.com/> で新規プロジェクト作成
2. **APIs & Services** → **Library** で以下を有効化:
   - Google Sheets API
   - Google Drive API
3. **APIs & Services** → **Credentials** → **Create Credentials** → **Service Account**
4. 作成したアカウント → **Keys** → **Add Key** → **JSON** をダウンロード
5. JSON ファイルを安全な場所に保存（例: `~/secrets/paperpilot-sa.json`）

#### 依存パッケージインストール

```bash
pip install -e '.[sheets]'
```

### 2. 実行

#### A. 新規 Spreadsheet を作成

```bash
export GOOGLE_APPLICATION_CREDENTIALS=~/secrets/paperpilot-sa.json
export PAPERPILOT_SHEET_SHARE_EMAIL=you@example.com  # 自分のアカウントへ共有

python paperpilot/scripts/sync_to_sheets.py
# -> OK Synced 218 rows -> https://docs.google.com/spreadsheets/d/xxxxx
# -> Spreadsheet ID: xxxxx
```

出力された **Spreadsheet ID** を環境変数に保存しておくと、次回以降は同じ Sheet が更新されます。

#### B. 既存 Spreadsheet を更新（推奨）

```bash
export GOOGLE_APPLICATION_CREDENTIALS=~/secrets/paperpilot-sa.json
export PAPERPILOT_SHEET_ID=xxxxx  # 上で取得した ID

python paperpilot/scripts/sync_to_sheets.py
# -> OK Synced 218 rows -> https://docs.google.com/spreadsheets/d/xxxxx
```

### 3. オプション

```bash
python paperpilot/scripts/sync_to_sheets.py \
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

### 他学会の同期（例）

```bash
# NeurIPS 2025 の summary.csv を同期（ID は学会ごとに別 sheet を想定）
python paperpilot/scripts/sync_to_sheets.py --conference neurips-2025
```

### 自動書式

- ヘッダ行: 太字 + グレー背景 + 凍結
- `type=Oral` の行: 黄色背景でハイライト

### CI で自動更新したい場合

GitHub Actions に追加（例）:

```yaml
- name: Sync to Google Sheets
  env:
    GOOGLE_APPLICATION_CREDENTIALS: ${{ runner.temp }}/sa.json
    PAPERPILOT_SHEET_ID: ${{ secrets.PAPERPILOT_SHEET_ID }}
  run: |
    echo '${{ secrets.GCP_SA_JSON }}' > $GOOGLE_APPLICATION_CREDENTIALS
    pip install -e '.[sheets]'
    python paperpilot/scripts/build_summary_csv.py
    python paperpilot/scripts/sync_to_sheets.py
```

GitHub Secrets:

- `GCP_SA_JSON` — サービスアカウント JSON（中身を丸ごと貼る）
- `PAPERPILOT_SHEET_ID` — Spreadsheet ID

---

## `build_lineage.py` — 論文の系譜（リネージ）を自動生成

任意の学会の Oral 論文について、**過去に引用した論文（祖先）** と
**この論文を引用した論文（子孫）** を Semantic Scholar から取得し、
LLM（`AbstractLLMProvider.classify_relation`）で関係種別（`supersedes` /
`successor` / `extends` / `ablation` / `baseline_only` / `contrasts` /
`unrelated`）を判定します。

入力: `docs/<conference>/papers.json`（`build_pages.py` の生成物）
出力: `docs/<conference>/lineage.json`（家系図ビュー `lineage.html` が読み込む）

### 使い方

```bash
# 環境変数読み込み（.env 推奨、gitignored）
export $(grep -v '^#' paperpilot/.env | xargs)

# スモークテスト（最初の 1 件のみ）
python paperpilot/scripts/build_lineage.py --limit 1

# 全 Oral（ICLR 2026 デフォルト）
python paperpilot/scripts/build_lineage.py

# 他学会
python paperpilot/scripts/build_lineage.py --conference neurips-2025

# venue ラベルを明示（acronym casing を保ちたい時）
python paperpilot/scripts/build_lineage.py --conference neurips-2025 --venue-override "NeurIPS 2025"
```

### 必要な環境変数

**LLM プロバイダ（いずれか 1 つ）**

- `PAPERPILOT_GROQ_API_KEY` — **推奨**、無料で 30 RPM / 14,400 RPD
  - キー取得: https://console.groq.com/keys
- `PAPERPILOT_GEMINI_API_KEY` — 1 日 20 req（無料枠が狭い）
  - キー取得: https://aistudio.google.com/apikey
  - 課金有効化で RPD を数万に拡大可

両方設定されている場合は **Groq が優先**。`--conference` ごとに LLM プロバイダは同じキーを共有します。

### パラメータ（コード内の定数）

| 名前 | 既定値 | 意味 |
|---|---|---|
| `TOP_PARENTS` | 15 | 各論文あたりの祖先取り込み上限 |
| `TOP_CHILDREN` | 15 | 同、子孫 |
| `S2_RATE_DELAY` | 3.5 秒 | Semantic Scholar 呼び出し間隔 |
| `LLM_RATE_DELAY["groq"]` | 2.2 秒 | Groq 呼び出し間隔（~27 RPM） |
| `LLM_RATE_DELAY["gemini"]` | 7.0 秒 | Gemini 呼び出し間隔（~8 RPM） |
| `_CLASSIFY_ABSTRACT_TRIM`（`llm/base.py`） | 600 文字 | LLM に渡す abstract の上限 |

S2 呼び出しのリトライ / バックオフは `paperpilot.utils.http.request_with_retry` に委譲されています（独自の `_s2_get` は薄いラッパー）。

### キャッシュ

`paperpilot/data/lineage-cache/` に:

- `paper_<arxiv_id>.json` — S2 の論文メタデータ
- `references_<s2_id>.json` / `citations_<s2_id>.json` — 引用リスト
- `classifications.json` — LLM の関係判定結果

再実行時はキャッシュを参照するため、**中断しても再開で続行**できます。
やり直したい場合はキャッシュディレクトリを削除してください。

### コスト目安（Phase 1: Oral 13 件）

- S2 呼び出し: ~30 回（無料）
- LLM 呼び出し: ~300〜400 件
  - Groq 無料枠: **$0**
  - Gemini 課金: **~$0.10〜$0.30**
