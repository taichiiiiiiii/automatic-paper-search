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
