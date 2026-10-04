# P4 移植の後始末（統合時に片付ける）

| # | 内容 | 出典 |
|---|---|---|
| 1 | `apps/pipeline/src/release/paths.ts` のパス安全化を `packages/core` に移し、catalog と release の両方から使う（PUB-05・RPL-09） | P4b part 2 |
| 2 | identity（`identity_from_url`・`normalize_alias`・`make_paper_id`）が `src/catalog/identity.ts` と `src/release/identity/*` に二重実装 → 1 つにまとめる | P4b part 2 |
| 3 | promoter の派生ビルダー呼び出し（build_pages・lineage quality・sitemap・themes manifest など）を catalog / lineage の TS 版に接続（今は未接続の場合に明示的なエラー） | P4b part 2 |
| 4 | `commitAndPush` の並列テストは同一プロセス内で直列。本当の並行は CAS 競合テストでのみ確認 | P4b part 2 |
| 5 | v1 `search-index.json` は P5 まで出力し続け、P5 で生成と参照を同時に外す | 設計書 §9.3 |
| 6 | build_summary_csv / build_pages の実データ比較（Python と完全一致を手動で 1 回確認済み）を、生成済みフィクスチャを置く形の自動テストにする（`test/collect/fixtures/e2e` と同じ方式） | P4b part 1 |
| 7 | build_pages 系の Python テスト（約 2,500 行）のうち未移植の分: CAT-04 の Oral overlay・authors 版、CAT-23 の sidecar 周りの端のケース | P4b part 1 |
| 8 | `paperLinksGate.ts` のバイト上限は見積もり。実際の上限は web の postbuild テスト（strip 後 3MB 未満）で担保している | P4b part 1 |
| 9 | identity・slug を `packages/core` へ（#2 と合わせて） | P4b part 1 |
| 10 | `conference/shared/venueTier.ts` が `collect/signals/venue.ts` の TIER 集合を複製 → venue.ts から export して複製を消す | P4c part 1 |
| 11 | `conference/shared/pyText.ts` の `html.unescape` は部分移植（名前付き実体は主要なものと Latin-1 のみ、`;` 無しの古い実体は未対応） | P4c part 1 |
| 12 | 分類キャッシュのロック: TS は O_EXCL のロックファイル、Python は flock（`.lock` を消さない）。共存期間に Python が残した `.lock` があると TS は 60 秒の stale 待ちになる。P5 で Python が消えれば解消。それまで同時実行しない | P4d-1 |
| 13 | ロックの実装が `collect/state/seenIds.ts` と `lineage/classify/lock.ts` に重複 → 共通化 | P4d-1 |
| 14 | safety-contracts.md の LLM-18 の記述が古い（今は空応答でも遮断器が作動する）。P5 の文書書き直しで直す | P4d-1 |
| 15 | safety-contracts.md の「移植先」列のパスが実際の配置（`apps/pipeline/src/...`）と違う。P5 で更新 | P4c |
| 16 | `schemas/conference-baseline-assessment-v1.schema.json` に `$id` が無く validateArtifact で引けない | P4c part 2 |
| 17 | scaffold の登録 manifest を `apps/web/lib/catalog-copy.ts` に接続 | P4c part 2 |
| 18 | `audit_lineage_quality` の百分率表示が `Math.round`/`toFixed`（Python は偶数丸め）。.5 の境目だけ表示文が違い得る → `pyRound` に置き換える | P4d-3 |
| 19 | `buildLineageCli.ts`・`buildDeepLineageCli.ts` の実行入口（`.env` と設定の読み込み）が仮。workflow から呼ぶ前に配線する | P4d-3 |
| 20 | `validateConferenceSlug` が `catalog/slug.ts`（RangeError）と `conference/shared/conferenceSlug.ts`（独自エラー）に重複（#9 と同時に片付け、LIN-11 のテストも合わせる） | P4d-3 |
| 21 | **判断待ち**: `lineage_pilot/**`・`prepare_lineage_review.py`・`ingest_lineage_review.py`（運用者向けのレビュー取り込み。公開データの生成には使っていない）を移植するか捨てるか。P5 で Python を消すので、どちらかに決める必要がある | P4d-3 |
| 22 | **判断待ち**: `build_unarxive_index.py` は DuckDB の SQL そのもの。Node の DuckDB 束縛（例: `@duckdb/node-api`）の追加承認が要る。読み取り側は「使えない」既定で移植済み | P4d-3 |
| 23 | theme が `build_lineage` 系の関数を局所コピーで持つ（`theme/node.ts`・`providerFactory.ts`・`fetchRelated.ts`・`edges.ts` の rationale 判定）。conference/deep 側は theme から import している → 共通の置き場所（`lineage/shared`）に移す | P4d-2/3 |
| 24 | LLM が返した confidence がちょうど 1.0 / 0.0 の時、edge JSON に `1`/`0` と出る（Python は `1.0`/`0.0`）。`--llm-strict` 使用時のみ。`classify.ts`・`contract/v1.ts` で `pyFloat` を使う | P4d-2 |
| 25 | `theme_slug` が Python・Worker・web・pipeline の 4 か所に独立実装 → P5 で TS の 1 か所に集約し、パリティテストを TS 内で完結 | P4d-2 |
| 26 | collect の runner に実 LLM provider / embedding encoder の生成（LLM-06 等の provider factory）を接続する。未接続の間 `llm.enabled: true` の設定は run_history に `stage4:` エラーを記録する（意図的。失敗にはしない） | P4 review 1 |
| 27 | Python との意図的な差: arXiv の `totalResults` 不正値を拒否（Python は 0 扱い）、使えない LLM/encoder と壊れた `paper_repos.json` を run_history に記録（Python は警告のみ） | P4 review 1 |
