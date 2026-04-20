# 7. シーケンス設計

## 7.1 正常系シーケンス（v2.1復元）
**【v2.0修正】 **v2.0で欠落していた正常系シーケンス図（件数遷移付き）を復元。バッチAPIに合わせて更新。

```
User/Cron  →  collector.py  →  PipelineRunner
                                    │
                                    ├─→ Stage 0: Collect（async並列）
                                    │      ├─→ ArxivSource.afetch()    → 150件
                                    │      ├─→ S2Source.afetch()        → 200件
                                    │      └─→ dedup()                 → 350件（重複除去後）
                                    │
                                    ├─→ Stage 1: RuleFilter（純粋フィルタ）
                                    │      ├─→ category_filter()       → 280件
                                    │      ├─→ date_filter()           → 250件
                                    │      ├─→ exclude_words()         → 230件
                                    │      └─→ seen_ids_filter()       → 200件
                                    │
                                    ├─→ Stage 2: MetricScore（バッチAPI）
                                    │      ├─→ VenueSignal.enrich_batch()    1回（ローカル）
                                    │      ├─→ CitationSignal.enrich_batch() 1回（S2 /paper/batch）
                                    │      ├─→ AuthorSignal.enrich_batch()   1回（S2 /author/batch）
                                    │      ├─→ GitHubSignal.enrich_batch()   3回（PwC + GraphQL）
                                    │      ├─→ KeywordBoost.enrich_batch()   1回（ローカル）
                                    │      ├─→ compute_total_score()
                                    │      └─→ top_n(80)              → 80件
                                    │
                                    ├─→ Stage 3: Embedding
                                    │      ├─→ encode(abstracts)
                                    │      ├─→ cosine_similarity(profile) × 100
                                    │      ├─→ add_to_total_score()
                                    │      └─→ mmr_rerank(30)         → 30件
                                    │
                                    ├─→ Stage 4: LLMRank
                                    │      ├─→ batch_evaluate(5件×6回)
                                    │      ├─→ parse_llm_response()（3段階パース）
                                    │      └─→ top_n(10)              → 10件
                                    │
                                    └─→ Export + State Save
                                           ├─→ CSVExporter.export()
                                           ├─→ SlackExporter.export()
                                           ├─→ save_seen_ids()
                                           └─→ append_run_history()
```

## 7.2 処理時間見積り（v2.0修正版）
**【v2.0修正】 **Stage 0の並列化、Stage 2のバッチAPI化により、合計処理時間を7〜10分→2〜3分に短縮。

| Stage | 処理件数 | API呼び出し回数 | v1.0時間 | v2.0時間 |
|---|---|---|---|---|
| Stage 0 | — | 15回（並列実行） | 45秒 | 15秒 |
| Stage 1 | 350→200件 | 0回 | < 1秒 | < 1秒 |
| Stage 2 | 200件 | 【v2.0変更】約10〜15回 | 5〜8分 | 30〜60秒 |
| Stage 3 | 80件 | 0回（ローカル推論） | 10〜30秒 | 10〜30秒 |
| Stage 4 | 30件 | 6回（5件/バッチ） | 20〜40秒 | 20〜40秒 |
| Export | 10件 | 1〜2回 | < 1秒 | < 1秒 |
| 合計 | — | 約30〜35回 | 7〜10分 | 2〜3分 |