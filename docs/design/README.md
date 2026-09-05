# 基本設計書

PaperPilot — AI/ML 論文自動収集・品質フィルタリングシステム

**Version 2.1（Round 2 レビュー反映版） · 2026-04-05**

> 原本 `.docx` からの移行完了。変更は Git commit で追跡してください。
> 旧版は [`archive/`](../../archive/) に保存してあります。

## 変更履歴

| 版   | 日付       | 変更内容                                              |
|------|------------|-------------------------------------------------------|
| v1.0 | 2026-04-05 | 初版作成                                              |
| v2.0 | 2026-04-05 | レビュー指摘全 14 件を反映（P0: 3, P1: 5, P2: 6）     |
| v2.1 | 2026-04-05 | Round 2 レビュー指摘 11 件を反映（P1: 4, P2: 7）      |

> ## ⚠️ 01〜07 は陳腐化しています（2026-08-20 実測・#360）
>
> **v2.1（2026-04-05）時点の設計のままで、実装から約 4.5 か月ぶん乖離しています。**
> 実測監査で **33 件の食い違い**（高 16 / 中 13 / 低 4）を確認しました。
> 2026-08-20 時点の実装基準線は [09-implementation-status.md](09-implementation-status.md)、
> 2026-08-30 以降の実行状況と次キューは [13-agent-workboard.md](13-agent-workboard.md) です。
> 01〜07 を読むときは各ファイル冒頭の警告も確認してください。
> 08〜27 は後続文書です。09 は基準線、10 はフェーズ 1 の判断履歴、11〜27 は目標設計・実装契約・現在地です。

## 目次

- [~~システム概要とアーキテクチャ~~](01-overview.md) 🔴 **中身は overview ではありません**（§5.6 run_history / venue_cache の断片。本来の §1/§2 はリポジトリに存在しない・#360）
- [モジュール設計](02-modules.md)
- [各 Stage 詳細設計](03-pipeline.md)
- [データ設計](04-data.md)
- [外部 API インターフェース仕様](05-apis.md)
- [シーケンス設計](06-sequences.md)
- [運用（NFR・テスト・CI）](07-operations.md)
- [リネージ機能ロードマップ](08-lineage-roadmap.md)
- [実装ステータス](09-implementation-status.md) — 2026-08-20 時点の実装基準線
- [サイト再設計 — 方式の決定](10-site-redesign.md)（#355・2026-08-19）
  — §8 にフェーズ 1 の出荷実績（2026-08-19 本番公開・決定からの乖離 2 件）、§9 にフェーズ 2 の入力と制約
- [目標アーキテクチャ](11-target-architecture.md)（2026-08-30）
  — 1 サイト、検索優先の文脈ビュー、Identity / Replay Lite、最小公開ゲート、価値順の実装ロードマップを決定
- [実装計画 — Unified Paper Discovery](12-implementation-plan.md)（2026-08-30）
  — 変更ファイル、公開 schema、失敗条件、RED→GREEN の受入テストまで固定した実装用の正本
- [Agent Workboard](13-agent-workboard.md)（2026-08-30）
  — subagent / model の担当境界、エフォート配分、現在地、次の並列キュー
- [Lineage Artifact v1 Contract](14-lineage-contract-v1.md)（2026-08-30）
  — P2 producer / quality / viewer が共有する seed、provenance、deep manifest の wire contract
- [Replay Lite R0 Contract](15-replay-lite-contract.md)（2026-08-30）
  — canonical byte、run manifest、短期 artifact 検証、network-free fixture replay の実装契約
- [Theme Lineage P2T Migration](16-theme-lineage-migration.md)（2026-08-30）
  — theme identity/provenance、quality hash gate、legacy artifact の fail-closed 移行契約
- [Paper Slide Deck v1 実装契約](17-paper-slide-deck-contract.md)（2026-08-30）
  — 選択論文から trusted OA PDF、ページ引用付き構造化 deck、レビュー、exact-SHA 静的公開までの実装境界
- [Lineage Trust と Focus View 契約](18-lineage-trust-and-focus-view.md)（2026-08-30）
  — 引用事実と系譜判断を分離する v2、監査・較正 gate、2-hop / 15-node の段階表示を決定
- [Top Conference Release Watch 契約](19-conference-release-watch-contract.md)（2026-08-30）
  — 上位学会の公開検知、安定性確認、候補生成、exact-SHA 公開までの自動更新境界
- [Paper Slide SD1 実装記録](20-slide-sd1-implementation.md)（2026-08-31）
  — canonical PDF resolver、SSRF-safe bounded fetch、Linux isolated extraction、SD0 integrity bindingの実装境界と検証結果
- [Paper Slide SD2 ローカル実装記録](21-slide-sd2-implementation.md)（2026-09-01）
  — citation-preserving階層要約、closed provider出力、prompt injection境界、budget/cache key。offline backend実装済み
- [Paper Slide visible-text verifier 実装設計](22-slide-visible-text-verifier.md)（2026-09-01）
  — VT0 contract実装済み。最終描画pixelからのOCRを行うVT1〜VT4とfull-text再有効化gateは未完了
- [Paper Slide SD3 deterministic projection](23-slide-sd3-projection.md)（2026-09-01）
  — 検証済みdeck JSONから作る決定論的・アクセシブルなWebスライドrenderer/public indexをローカル実装済み
- [Paper Slide SD2 adversarial repair](24-slide-sd2-adversarial-repair.md)（2026-08-31）
  — SD2独立監査で再現したprovenance、cache、grounding、mutable provider境界の修正brief
- [Paper Slide search/action integration](25-slide-search-action-contract.md)（2026-09-01）
  — public index、`?paper=`選択card、capability付きrequest/status consumer、no-JS原論文fallbackをローカル実装済み
- [Docker-first execution contract](26-docker-first-execution.md)（2026-09-01）
  — Dockerをcollector/test/site previewの正本、uvをlock/build補助に限定。static contract 28 passed、実image runtimeは未実施
- [Paper Slide request plane production boundary](27-paper-slide-request-plane-production.md)（2026-09-04）
  — approved catalog、Durable Object、dispatch曖昧性、atomic workflow claim、休眠runtimeとproduction activation gate

---

# 0. 改訂サマリー

本版（v2.0）はレビューで検出された全14件の指摘事項を反映した改訂版である。修正箇所は本書全体にわたり、オレンジ色の背景（【v2.0修正】表記）でハイライトされている。
## 0.1 P0（重大）修正一覧

| # | 指摘 | 修正内容 | 該当セクション |
|---|---|---|---|
| P0-1 | API呼び出し800回/実行のボトルネック | Signal.enrich_batch()にバッチAPI対応を追加 | §3.2.2, §4.3 |
| P0-2 | Signal.enrich()が1件ずつの設計 | AbstractSignalにenrich_batch()を追加、バッチ処理をデフォルトに | §3.2.2 |
| P0-3 | APIキーがconfig.yamlに直書きリスク | APIキーは環境変数/.envに限定。config.yamlから認証情報を完全除去 | §5.2, §5.3(新設) |

## 0.2 P1（設計懸念）修正一覧

| # | 指摘 | 修正内容 | 該当セクション |
|---|---|---|---|
| P1-1 | total_scoreの値域不整合 | 全シグナルを0〜100に正規化統一、値域定義表を追加 | §4.3.4 |
| P1-2 | 初回実行時プロファイル未存在 | 3つのフォールバック（スキップ/CLI生成/キーワード簡易生成）を定義 | §4.4 |
| P1-3 | Stage 0の並列化方式が未定 | asyncio + aiohttp を標準方式として明記 | §4.1 |
| P1-4 | LLM JSON出力のパース戦略不足 | 3段階フォールバックパース戦略を追加 | §4.5.2(新設) |
| P1-5 | Stage 1にスコアリングが混在 | キーワードブーストをStage 2に移動 | §4.2, §4.3 |
| P1-6 | Paperデータクラスにcomment欠落 | commentフィールドを追加 | §3.2.1 |

## 0.3 P2（不足仕様）修正一覧

| # | 指摘 | 修正内容 | 該当セクション |
|---|---|---|---|
| P2-1 | ログ設計の詳細が未記載 | ログ設計セクションを新設 | §8.1(新設) |
| P2-2 | seen_idsパージ戦略が未定義 | 日付ベースパージ＋形式変更を定義 | §5.4(新設) |
| P2-3 | venue_cache更新タイミング不足 | イベント駆動＋キャッシュ有効期限30日に変更 | §5.5(新設) |
| P2-4 | PwC APIエンドポイント仕様未記載 | リクエスト/レスポンス例を追加 | §6.3(新設) |
| P2-5 | GitHub Actionsワークフロー未設計 | ワークフローYAML設計を追加 | §11(新設) |
| P2-6 | GitHub Actionsの堅牢化 | rebase追加、秘匿名変更、webhook存在チェック | §11 |
