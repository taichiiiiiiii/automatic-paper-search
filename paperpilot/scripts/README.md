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
export PAPERPILOT_SHEET_SHARE_EMAIL=your-email@gmail.com  # 自分のアカウントへ共有

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
| `--csv` | — | `output/iclr-2026/summary.csv` |
| `--credentials` | `GOOGLE_APPLICATION_CREDENTIALS` | （必須） |
| `--sheet-id` | `PAPERPILOT_SHEET_ID` | （未指定時は新規作成） |
| `--tab` | — | `summary` |
| `--title` | — | `PaperPilot — ICLR 2026 Summary` |
| `--share` | `PAPERPILOT_SHEET_SHARE_EMAIL` | （新規作成時のみ使用） |

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
