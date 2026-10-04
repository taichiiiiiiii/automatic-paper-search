# P4 移植の後始末（統合時に片付ける）

| # | 内容 | 出典 |
|---|---|---|
| 1 | `apps/pipeline/src/release/paths.ts` のパス安全化を `packages/core` に移し、catalog と release の両方から使う（PUB-05・RPL-09） | P4b part 2 |
| 2 | identity（`identity_from_url`・`normalize_alias`・`make_paper_id`）が `src/catalog/identity.ts` と `src/release/identity/*` に二重実装 → 1 つにまとめる | P4b part 2 |
| 3 | promoter の派生ビルダー呼び出し（build_pages・lineage quality・sitemap・themes manifest など）を catalog / lineage の TS 版に接続（今は未接続の場合に明示的なエラー） | P4b part 2 |
| 4 | `commitAndPush` の並列テストは同一プロセス内で直列。本当の並行は CAS 競合テストでのみ確認 | P4b part 2 |
| 5 | v1 `search-index.json` は P5 まで出力し続け、P5 で生成と参照を同時に外す | 設計書 §9.3 |
