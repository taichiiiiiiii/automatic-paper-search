# 設計書

いまの構成は TypeScript（pnpm workspace）と Cloudflare Pages / Workers（2026-10-09 に切替）。切替後の計画は [40-post-cutover-roadmap.md](40-post-cutover-roadmap.md)、系譜の公開方針と生成の信頼性は [41-lineage-publication-and-reliability.md](41-lineage-publication-and-reliability.md)。その判断材料の調査は [42（テーマ外の判定方法）](42-topic-relevance-evaluation.md) と [43（関係の分類を API で行う評価）](43-api-based-relation-evaluation.md)、データ源と利用規約は [44](44-data-sources.md)、2026-10-10 の審査と点検の記録は [45](45-lineage-second-review-2026-10-10.md)。運用の手順と記録は [`docs/migration/p5-runbook.md`](../migration/p5-runbook.md)、安全上の約束（行 ID）は [`docs/migration/safety-contracts.md`](../migration/safety-contracts.md)。

01〜38 番（Python と GitHub Pages の時代の設計書）、`docs/research/`（市場調査）、`archive/`（原本 .docx）は 2026-10-10 に削除した。39 番（移行の設計）と `docs/migration/` の p5-plan・p2-parity-gaps・p4-followups・schema-inventory（移行の計画と残作業表）も、移行が終わったので同日に削除した。コードのコメントに残る `p5-plan.md §…` などの参照は、履歴上の根拠を指す。必要なら git の履歴から取り出す（例: `git show 2ad7782:docs/design/38-unified-current-design.md`）。
