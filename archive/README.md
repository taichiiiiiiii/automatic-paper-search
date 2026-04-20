# archive/

原本 `.docx` ファイルの保管場所。

## ファイル

- `PaperPilot_基本設計書_v2.1_FINAL.docx` — 基本設計書 v2.1（Round 2 レビュー反映版）
  - markdown 正本: [`docs/design/`](../docs/design/)
- `PaperPilot_市場調査レポート_v2.0_FINAL.docx` — 市場調査レポート v2.0
  - markdown 正本: [`docs/research/`](../docs/research/)

## 運用方針

- **編集は markdown 側で行う**（`docs/design/`, `docs/research/`）
- 変更は Git commit で追跡する
- `.docx` は履歴保全目的で保管、編集しない
- ステークホルダー向けに Word 形式が必要な場合は、markdown から pandoc で再生成:
  ```bash
  pandoc docs/design/*.md -o /tmp/design.docx
  ```
