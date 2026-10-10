# 40. 切替後の設計とロードマップ

- 作成: 2026-10-10（切替の翌日）
- 前提: 39 番（移行の設計、2026-10-10 に削除）の移行（P0〜P5）は 2026-10-09 に完了。手順と記録は [`p5-runbook.md`](../migration/p5-runbook.md)
- この文書の役割: 切替後に何を、どの順で、どの条件で進めるかを決める。39 は移行の設計として残し、以後の計画はここで管理する

## 1. 現状（2026-10-10 実測）

### 1.1 構成

```text
ブラウザ ──読み取り──> Cloudflare Pages「paperpilot」（https://paperpilot.pages.dev、静的サイト）
   │
   └─POST /api/themes─> Worker「paperpilot-themes」（Hono + KV + Durable Object の上限カウンタ）
                           └─ workflow_dispatch ─> GitHub Actions（生成 → promote → release）
                                                       └─ data/ を develop に commit ─> Pages に公開
旧 https://taichiiiiiiii.github.io/automatic-paper-search/ ── 転送 ──> 新サイトの同じパス
```

- コード: pnpm workspace（`apps/web`・`apps/api`・`apps/pipeline`・`packages/core`）。Python は無し（`.codex/` の補助スクリプトのみ）
- データ: `data/{published,state,inputs,config}`（約 217 MB、git 管理）
- 公開: Node 版の 6 段リリース（validate → build → admit → deploy → smoke → record）。戻しは `pages-rollback.yml`

### 1.2 数字

| 項目 | 値 |
|---|---|
| 学会カタログ | 10 学会、約 28,300 本。データの日付は **2026-06-28** |
| テーマ | 4（flash-attention・graph-neural-network・mixture-of-experts・vision-transformer） |
| 系譜の品質状態（`lineage-quality-v1.json`） | 学会 10（`unavailable` 8・`ready+failed` 2）、deep 14（`ready+failed`）、テーマ 4（`ready+failed`）。**公開できる系譜（`ready+passed`）は 0 件** |
| 定期実行 | 無し。`collect-weekly`・`collect-daily-watch` の cron は 2026-06-04 に意図的に止めた（#245）。今の定期実行は `lighthouse`（週 1）だけ |
| 秘密 | Worker: `GH_DISPATCH_PAT`（2027-01-07 失効）。GitHub: `PAPERPILOT_GROQ_API_KEY`、environment `cloudflare-pages-deploy` に Cloudflare の 2 つ。S2・OpenAlex・Gemini・Claude・Slack の鍵は未設定（コードは任意扱い） |

### 1.3 いま利用者から見えるもの / 見えないもの

- 見える: 横断検索、学会別の一覧と論文詳細、仕組みのページ
- 見えない: 系譜（全部が品質監査で止まっている）、テーマ投稿フォーム（公開できる系譜が 0 件のあいだは出ない作り）

**PaperPilot の差別化である「系譜」が、今は 1 件も利用者に届いていない。** 切替後の最大の課題はここ。

## 2. 設計方針

### 2.1 引き続き守るもの（38 番までの決定のうち、今も有効なもの）

1. ユーザー向けは 1 サイト。論文を中心にし、学会・テーマ・検索・系譜は入口またはビューとして扱う
2. 静的サイト（読み取り）と Worker（変更操作だけ）の分離。ブラウザは外部 API や Actions を直接呼ばない
3. 生成と公開の分離。生成物は検証・監査・テストを通ってから公開する（promote が公開先の tree 自身のテストを流す）
4. 系譜は fail-closed。`ready + passed` だけを通常の棚に出す。空の系譜を実データとして扱わない
5. リポジトリは分割しない。R2・D1 などへの早期移行もしない（§4 の条件を満たすまで）
6. workflow の dispatch・公開・秘密の変更・develop への merge は、ユーザーの承認を経て行う（定期実行の再開を含む）

### 2.2 切替で変わったもの

- 実行環境の正本は **Node 22 + pnpm**（Docker-first・`uv` は廃止）
- 品質ゲートは `tests.yml`（biome・typecheck・全 test）・`data-audit.yml`・`lighthouse.yml` と、リリース内の validate/smoke
- develop にブランチ保護は無い。必須チェックは強制されていない（R0 で設定する）

## 3. ロードマップ

期間は目安。各段の「完了条件」を満たしてから次へ進む。☐ はユーザーの作業か承認。

### R0 安定化（観察期間、〜2026-10-16 頃）

切替で入れた仕組みを固め、戻しが要らないことを確かめる。

| # | 作業 | 完了条件 |
|---|---|---|
| R0-1 | 観察: 本番の 6 段リリースと Worker の状態を毎日確かめる（`pages`・`tests`・`/api/health`・Pages の deployment） | 1 週間、失敗なし（または原因が特定され直っている） |
| R0-2 | レビューで「低」とした残り 3 件を直す: `pagesApi` が一覧の 1 ページ目で探すのをやめる、`cloudflare-pages-production` environment に develop だけの branch policy、`S2_API_KEY` と `PAPERPILOT_S2_API_KEY` の名前の不一致 | 修正が develop に入り、契約テストが緑 |
| R0-3 | 負荷時の timeout（spawn する test の 5 秒上限）を見直し、全体実行で落ちないようにする | 手元の全体実行（`pnpm -r test`）が 3 回続けて緑 |
| R0-4 | GitHub Actions の Node 20 非推奨への対応（checkout・setup-node・upload/download-artifact・deploy-pages を Node 24 対応版に、SHA 固定のまま上げる） | 警告が出ない。全 workflow の契約テストが緑 |
| R0-5 | develop の保護: 必須チェック `tests / test`・`data-audit` を設定（Actions の bot による promote push は許可したまま） | ☐ 承認後に設定し、promote が通ることを確認 |
| R0-6 | ☐ Search Console に新しい sitemap を登録 | 登録済み |
| R0-7 | 観察が済んだら `feat/ts-migration`・`p5/consolidate` を削除 | 削除済み |

### R1 運用の自動化と鮮度（10 月下旬〜11 月）

学会カタログが 6 月で止まっている。鮮度の約束と実運用を一致させる。

| # | 作業 | 完了条件 |
|---|---|---|
| R1-1 | ☐ 鮮度の方針を決める（§5 判断 1）: 定期収集を戻すか、「スナップショット」と明示し続けるか | 決定 |
| R1-2 | 戻す場合: `collect-weekly` を dispatch で 1 回流して結果を確かめ、問題が無ければ cron を入れる。必要な鍵（S2・OpenAlex）を ☐ 登録 | 2 回続けて自動で緑、公開まで通る |
| R1-3 | 各学会・テーマの snapshot date を画面に出す（鮮度の表示） | 全ページで日付が見える |
| R1-4 | Durable Object を `migrations` から `exports` 形式に移す（Worker を旧版へ戻せる期間が終わってから。39 の注意） | 移行後も `/api/health`・上限カウンタが動く |
| R1-5 | 期限の管理: PAT（2027-01-07 失効）の更新手順を手順書に書き、失効 2 週間前に知らせる仕組みを置く | 手順と通知がある |

### R2 系譜を公開できる状態にする（11 月〜12 月、最優先の価値）

| # | 作業 | 完了条件 |
|---|---|---|
| R2-1 | なぜ全部 `failed` なのかを、監査項目ごとに洗い出す（`artifact_contract_v1` ほか、どの check が何件落ちているか） | 一覧と、直せるもの／人手が要るものの区別 |
| R2-2 | 機械的に直せる失敗（契約違反・古い schema）を直し、作り直す | 該当 check が通る |
| R2-3 | ☐ 人手監査のパイロット: テーマ 1 つ（例: flash-attention）の関係 6〜12 件を根拠つきで確認し、監査 fixture に記録する | 1 テーマが `ready + passed` になる |
| R2-4 | 最初の 1 件を公開: 系譜ページとテーマ投稿フォームが出ることを本番で確認 | 利用者が系譜を 1 つ見られる。フォームから依頼が通る |
| R2-5 | 監査の手間を減らす: 機械分類の較正（`automated-calibrated-v1` の実測）を検討 | 方針の決定 |

#### R2 の途中経過（2026-10-10）

- **R2-1 の結果**: 28 行すべてが `golden_fixture`（人手監査の記録が 0 件）で止まっている。そのうえで、27 行は成果物が古い形式（`lineage-artifact-v1` でない、edge に `relation`・provenance が無い、focus に `seed_paper_id` が無い）。deep 14 本は manifest も古い形式。学会 8 つは系譜が空。形式の上で最も近いのは `graph-neural-network`（v1 で、孤立ノード 6 件だけ）だった
- **R2-2（済）**: テーマ生成で、どの edge にもつながらない focus 以外のノードを捨てるようにした。`graph-neural-network` の成果物も同じ処理で 26→20 ノードにした。人手監査の記録は `min(20, ノード数)` 件の異なるノードを必ず含むようにした（空のラベルで通ってしまう抜け穴を塞いだ）。いま `graph-neural-network` で通っていないのは `golden_fixture` だけ
- **ただし中身はテーマから外れている**: 20 ノードのうち GNN と言えるのは約 8〜9 件（グラフ信号処理・DeepWalk・LINE・Geometric Deep Learning・GCN と GNN のサーベイ・SuperGlue）。残り約 11 件（SLAM、SfM、ScanNet、SuperPoint、LoFTR、音声認識、機械翻訳、拡散モデルのサーベイ等）は、focus に選ばれた SuperGlue（GNN を使う特徴点マッチング）から引用をたどって広がったもの。関係はすべて「引用と年の差から後継と推定」、確信度は一律 0.7。監査基準（テーマ外 1 割以下）に対して約 55% で、**正直に監査すれば不合格**。公開しない
- **R2 の見直し**: 人手監査の前に、生成の質を上げる必要がある（クラス B）。次の作業を R2-3 の前に入れる
  - R2-2b: テーマから外れる原因を直す。focus の選び方（題名に語が入っているだけの論文を避ける）と、引用をたどる範囲（テーマとの関連が弱いノードを入れない）
    - **R2-2b の実装（2026-10-10、未マージ）**: `apps/pipeline/src/lineage/theme/topicScope.ts` を追加。(1) seed の順位に「題名がテーマそのものか／手法の一部として使うだけか（with/using/via …）」の重みを掛ける、(2) root は「テーマが主題の seed」→「テーマ内ノードとの edge 数」の順で選ぶ（GNN は SuperGlue → GNN サーベイ）、(3) BFS は「題名・要旨・TL;DR にテーマ語（別名、`theme_aliases.json` の `_topic_terms`、複数形・頭字語を含む）がある」「foundational allowlist」「テーマ内ノード 2 件以上から引用でつながる」のどれかを満たす候補だけを入れる（`--topic-min-support`、`--no-topic-gate`）、(4) 年と引用数だけの推定（`year_cite`）は `citation_heuristic`・`successor`・確信度 0.4 に落とし、`contrasts` は LLM か引用文脈の分類からしか出さない。オフライン評価 `evalTopicDriftCli.ts` で、公開中の成果物に入場条件を当て直すと GNN 20→8、MoE 39→11、ViT 44→34、FlashAttention 15→3 ノード（成果物に残る TL;DR と edge だけで判定するので、実際の再生成より厳しめ）
  - R2-2c: 4 テーマを新しい生成で作り直す（`regen-themes` を dispatch。系譜は fail-closed のままなので公開には出ない）
  - その後に R2-3（人手監査）。私が根拠つきの判定案を作り、ユーザーが確認する
- 残しておく注意: 不完全な取得で作り直したとき（`--allow-incomplete` なし）、前回あった孤立ノードが消えることで「縮んだ」と判定され、公開が止まることがある。安全側に止まるだけなので、今は直さない

- **R2-2c 1 件目（2026-10-10、run 37963889302）**: `Graph Neural Network` を新しい生成で作り直し、本番まで通った。11 ノード・17 edge で、テーマ外は 1 件（ResNet のサーベイ）だけになった。root は GNN のサーベイ。ただし **Groq が `401`（鍵が無効）** で、LLM の分類は 1 件も使えていない。edge はすべて `citation_heuristic`（0.4）。鍵（`PAPERPILOT_GROQ_API_KEY`、2026-05-09 登録）の作り直しが、残り 3 テーマの作り直しと人手監査の前提になる

### R3 学会の自動更新（12 月〜2027 年 1 月）

- OpenReview（ICLR・NeurIPS・ICML）の新しい回の検知 → dry-run の差分確認 → 承認後に反映、の流れを作る（`conference-on-demand.yml` を土台にする）
- 前年比のチェック（baseline/ratio）を反映の条件に入れる
- 完了条件: 新しい回が出てから、承認 1 回で一覧に載る

### R4 検索と使い勝手（R1〜R3 と並行）

- 固定クエリでの検索評価（precision@k・MRR）を作り、順位づけの変更をそれで判断する
- 狭い画面での系譜表示（R2 で公開が始まってから）

### R5 拡張の判断（2027 年 1〜3 月）

§5 の判断 3〜5 を、R2・R3 の結果を見て決める。

## 4. 構成を変える条件（今はやらない）

| 案 | 始める条件 |
|---|---|
| 独自ドメイン（`/api/*` を同じサイトに置き CORS をなくす） | ログインを入れる、または外部に案内を始める |
| D1（依頼の進捗 API） | テーマ依頼が週 10 件を超える、または状態の問い合わせが要る |
| R2（大きいデータを git の外へ） | `data/` が 1 GB を超える、または clone が遅くて困る |
| ログイン・マルチユーザー | 個人ごとの設定・保存の要望が出る |

## 5. 判断をお願いしたいこと

1. **鮮度**: 学会の定期収集を戻すか（戻すなら頻度と、鍵の登録）。戻さないなら「6 月時点のスナップショット」と明示する
2. **系譜の公開基準**: 人手監査（R2-3）を誰がどれだけやるか。私が根拠を集めて下書きし、最終確認をユーザーがする形を提案する
3. **独自ドメイン**: 取るか（§4）
4. **論文スライド**: 39 で削除した機能を作り直すか
5. **`AGENTS.md`・`.codex/`・Qwen 関係の文書**: 2026-10-11 に削除と決定し、削除した。規約は CLAUDE.md に一本化（絶対ルール 17〜19）
