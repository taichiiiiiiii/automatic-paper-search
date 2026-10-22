# CLAUDE.md — PaperPilot（入口。毎回読まれるので最小限）

詳細・手順・仕様・経緯は [`CLAUDE_REFERENCE.md`](CLAUDE_REFERENCE.md)（旧 CLAUDE.md の全文。必要な節だけ読む。コードやテストの「CLAUDE.md §N」は、その「絶対ルール」の番号）。設計書は `docs/design/`。

`AGENTS.md` / `PAPERPILOT_PROFILE.md` の Codex CLI + Qwen Flash/MAX routing と role 運用は別ツール向けで、Claude Code には適用しない。commit/push の承認境界は本ファイルが正本。Single-agent mode など旧 role 表は Codex CLI 運用の履歴。

## ユーザーの明示承認後だけ行う
workflow dispatch、通知、Pages / Worker 公開、secret・settings 変更、`develop` への push/merge、Cloudflare へのアップロード（プレビュー含む）、Issue/PR 作成、`docs/daily/papers.json` の削除。Cloudflare の API トークンは作成・登録しない。

## 絶対ルール（番号は固定）
1. API キーは `.env` のみ。`config.yaml` や `.py` に書かない　2. `.env` は commit しない
3. 外部 API を叩くテストを書かない。必ずモック
4〜12. Stage の入出力・スコア式と重み・`seen_ids`・`run_history`・通知の no-op・LLM は `AbstractLLMProvider` 経由・scripts は再クロールしない、など（変更する前に REFERENCE の該当ルールを読む）
13. `docs/<conf>/lineage.json` は `build_lineage.py` だけが生成。手編集禁止
14. `docs/themes/<slug>/lineage.json` は `build_theme_lineage.py` だけが生成。手編集禁止。出力 path は `theme_slug()` の戻り値のみで作る。slug 規則は Python・Worker・フロントの 3 か所を同時に更新

## 進め方
プランは着手前にレビュー → テスト先行 → commit 前にレビュー → 結果を報告して承認後に commit/push。テストは `uv run --extra dev`。仕様を変えたら設計書と REFERENCE の該当節も同時に更新。サブエージェントのモデルは `~/.claude/CLAUDE.md` と `.claude/agents/agent-orchestration.md` に従う。

## TypeScript 移行中（`feat/ts-migration`、計画は `docs/design/39`・`40`・`41`）
- **本番はまだ Python と `docs/assets/*.js`。** `apps/*` の改善は P5 の切替で初めて本番に効く
- 移行中のデータの正本は develop。新しいコードは `docs/`・`paperpilot/data/` を読むだけで、書き出しは一時ディレクトリ
- Python 版を置き換える前に `apps/pipeline/src/parity` で一致を確かめる。丸め・並び順・時刻・正規表現は `packages/core` の Python 互換関数を使う
- 安全対策は `docs/migration/safety-contracts.md` の各行をテストごと移植する
