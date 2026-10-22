# PaperPilot

旧 CLAUDE.md の全文は [`CLAUDE_REFERENCE.md`](CLAUDE_REFERENCE.md)。必要な節だけ読む。コードやテストの「CLAUDE.md §N」は、その「絶対ルール」の番号。

## コマンドとツール
- Python（現行の本番）は **uv**（pip 不可）。lint: `uv run ruff check paperpilot/`（push 前必須。pytest は import-sort を拾わない）
- テスト: `uv run --extra dev pytest paperpilot/tests/`（約 27 秒）。単一: `uv run --extra dev pytest paperpilot/tests/test_venue_signal.py::<テスト名> -q`。素の `uv run pytest` は不可（システムの pytest に落ち、duckdb の有無で件数がずれる）
- `mypy` は現環境で INTERNAL ERROR（既存の不具合）。走らせない
- TypeScript（`feat/ts-migration`）は **pnpm 10.34.6**（npm 不可）、Node 22 以上。corepack が使えないときは `npx --yes pnpm@10.34.6 …`
  - 全体: `pnpm test` / `pnpm typecheck` / `pnpm lint`（Biome）。単一: `pnpm --filter @paperpilot/pipeline exec vitest run test/x.test.ts`（パッケージ名は `@paperpilot/{web,api,pipeline,core}`）

## 落とし穴
- **本番はまだ Python と `docs/assets/*.js`。** `apps/*` の改善は P5 の切替で初めて効く。`develop` への push は Worker と Pages を自動デプロイするので、移行作業は `feat/ts-migration` で行う。新しいコードは `docs/`・`paperpilot/data/` を読むだけで、書き出しは一時ディレクトリ
- `docs/<conf>/lineage.json` は `build_lineage.py` だけが、`docs/themes/<slug>/lineage.json` は `build_theme_lineage.py` だけが生成する。**手編集禁止**。出力 path は `theme_slug()` の戻り値のみで作る。slug 規則は Python・Worker・フロントの 3 か所とパリティテストを同時に更新
- `?v=` は `sync_asset_versions.py` が管理する。手で書き換えない
- API キーは `.env` のみ（`config.yaml` や `.py` に書かない）。`.env` は commit しない。外部 API を叩くテストは書かず、必ずモックする
- `AGENTS.md` / `PAPERPILOT_PROFILE.md` の Codex CLI + Qwen routing は Claude Code には適用しない（Single-agent mode などは履歴）
- 次の操作はユーザーの明示承認後だけ: workflow dispatch、通知、Pages / Worker 公開、secret・設定変更、`develop` への push/merge、Cloudflare へのアップロード、Issue/PR 作成。Cloudflare の API トークンは作成・登録しない

## 規約
- 絶対ルール 4〜12（Stage の入出力型・スコア式と重みは変えない、`seen_ids` / `run_history` の形式、LLM は `AbstractLLMProvider` 経由、scripts は再クロールしない、など）は REFERENCE。変える前に読む。仕様を変えたら設計書も同時に更新
- 進め方: プランを着手前にレビュー → テスト先行 → commit 前にレビュー → 結果を報告し、承認後に commit/push
- 新しい Source / Signal / Exporter / LLMProvider は基底クラス（`Abstract*`）を継承して追加する。既存コードは変えない。型ヒントと Docstring（Why）は必須
- TS 版: 丸め・並び順・時刻・正規表現は `packages/core` の Python 互換関数を使い、Python 版を置き換える前に `apps/pipeline/src/parity` で一致を確かめる。安全対策は `docs/migration/safety-contracts.md` の各行をテストごと移植する

## 背景（なぜそうしているか）
- 系譜（家系図）は、論文間の引用関係を LLM で意味分類して可視化するもの（`supersedes` / `successor` / `extends` / `ablation` / `baseline_only` / `contrasts`）
- 表示してよいのは、品質監査に通った系譜だけ（fail closed）。判定は緩めない。人が確認した記録（golden fixture）が無いと通らない
- 運用コストは ¥0〜¥1,500/月が目標。無料枠の中で動かす

## 完了の定義
Python は ruff と pytest、TS は `pnpm typecheck` / `pnpm test` / `pnpm lint` が通ること。結果・skip・残リスクを報告する。計画は `docs/design/39`・`40`・`41`
