# 13. Agent Workboard — Unified Paper Discovery

現行ルーティングはAGENTS.mdを正本とする。実装・解析・文献処理・必要テストはFlash、条件付き評価のみMAX、最終採否は親Codex。以下のSingle-agent modeや旧role表は履歴であり、現行方針を上書きしない。設定変更だけではworker起動・外部操作を許可しない。

- **更新日:** 2026-09-08
- **目的:** 現在の担当が境界と完了条件を確認する実行台帳（旧subagent運用履歴を保持）
- **設計の正本:** [`11-target-architecture.md`](11-target-architecture.md)
- **実装契約の正本:** [`12-implementation-plan.md`](12-implementation-plan.md)
- **P2 wire contract:** [`14-lineage-contract-v1.md`](14-lineage-contract-v1.md)
- **R0 Replay contract:** [`15-replay-lite-contract.md`](15-replay-lite-contract.md)
- **P2T Theme migration:** [`16-theme-lineage-migration.md`](16-theme-lineage-migration.md)
- **Paper slide contract:** [`17-paper-slide-deck-contract.md`](17-paper-slide-deck-contract.md)
- **Paper slide SD1:** [`20-slide-sd1-implementation.md`](20-slide-sd1-implementation.md)
- **Paper slide SD2:** [`21-slide-sd2-implementation.md`](21-slide-sd2-implementation.md)
- **Paper slide visible text:** [`22-slide-visible-text-verifier.md`](22-slide-visible-text-verifier.md)
- **Paper slide SD3:** [`23-slide-sd3-projection.md`](23-slide-sd3-projection.md)
- **Paper slide SD2 repair:** [`24-slide-sd2-adversarial-repair.md`](24-slide-sd2-adversarial-repair.md)
- **Paper slide search/action:** [`25-slide-search-action-contract.md`](25-slide-search-action-contract.md)
- **Docker-first execution:** [`26-docker-first-execution.md`](26-docker-first-execution.md)
- **Paper Slide request plane production:** [`27-paper-slide-request-plane-production.md`](27-paper-slide-request-plane-production.md)
- **Lineage trust / Focus View:** [`18-lineage-trust-and-focus-view.md`](18-lineage-trust-and-focus-view.md)
- **Conference release watch:** [`19-conference-release-watch-contract.md`](19-conference-release-watch-contract.md)
- **次期開発計画:** [`28-next-delivery-plan.md`](28-next-delivery-plan.md)
- **Local Sol slide profile:** [`29-slide-sol-local-execution.md`](29-slide-sol-local-execution.md)
- **Lineage pilot viewer:** [`30-lineage-pilot-viewer-delivery.md`](30-lineage-pilot-viewer-delivery.md)
- **Private review / conference candidates:** [`31-private-review-and-conference-candidates.md`](31-private-review-and-conference-candidates.md)
- **Local diff / private intake plan:** [`32-local-update-and-review-intake.md`](32-local-update-and-review-intake.md)
- **Private intake storage / CLI:** [`33-private-review-intake-cli.md`](33-private-review-intake-cli.md)
- **Conference baseline assessment:** [`34-conference-baseline-assessment.md`](34-conference-baseline-assessment.md)
- **UI/UXと論文カード区分:** [`35-ui-ux-navigation-polish.md`](35-ui-ux-navigation-polish.md) — 検索詳細・状態表示・方向別区分・graph専用レーンをローカル実装。検索詳細と合成比較2ノードはdesktop/375pxで確認済み。大規模合成releaseのdesktop表示でカード回避経路を確認。ラベル重複抑制を実装中。線同士の重なり、多数ノードの狭幅表示、変更後のキーボード再検証は残る。

この文書は設計を上書きしない。タスクの現在地、担当境界、検証結果だけを更新する。

<details>
<summary>履歴・非運用・現行起動に使用禁止</summary>

現行手順は[AGENTS.md](../../AGENTS.md)と[Qwen実装・MAX評価入口](../QWEN_IMPLEMENTER.md)。

## 1. Agent 運用契約

### 履歴: Single-agent mode（2026-09-08）

ユーザーの最新指示によりサブエージェントを使用しない。`.codex/config.toml`の`agents.enabled = false`を設定し、
現在の親エージェントが実装・調査・自己レビューを単独で行う。外部Qwen/Flash workerも起動しない。
以下の旧運用契約、各設計書のQwenへの依頼予定、過去の独立agent監査要件より本方針とAGENTS.mdを優先する。
未完了作業は以後単独で進める。前年度baseline照合・pure ratio API・report Schema/exportはローカル実装済み（設計34 §12）。
trusted state/CAS・workflow・公開接続は未完了。実人手監査・公開承認・Docker gateは変更しない。
設定変更は本プロジェクトのみ。グローバル設定、共有サービス、製品内の生成モデルは変更しない。

### 履歴: 無効化前の運用契約

1. 担当者ごとに変更対象を先に宣言し、**所有ファイルが重ならない作業は共有 checkout でも並行してよい**。
   同じファイル、共有生成物、asset version、manifest、lockfile を触る作業は同時実行せず、owner が順序を決める。
2. nativeの調査・独立監査は **medium** を既定とし、identity / provenance、schema migration、promotion の
   競合・安全性、security / publication-riskなど難度とリスクが高いタスクだけ **high** を選ぶ。
   外部Qwen実装は設定上 **none** で小分けし、ownerが差分全体を独立レビュー・再検証する。**ultra は使わない**。
3. 2026-09-06の既定方針として、backend/frontend開発実装は **Flash優先**、既存サブスク内の
   **対話中依頼だけqwen3.7-plusで混雑補助**とする。前半のCloud固定指定より新しい方針であり、
   AGENTS等の旧モデル記述は保持して運用文書で優先関係を明示する。
   主checkoutの`.codex/bin/qwen-implement [--interactive | --cloud-only] --role backend|frontend /absolute/linked/worktree`に
   限定課題を渡す。既定はFlash待ちで、直接ユーザー依頼を親が監督する単発実装だけ明示flagを許す。
   heartbeat・通知・自動goal継続ではflag禁止。開始前一度の共通queue振分以外でmodelを切り替えない。
   native実装roleは使わず、cleanなlinked worktreeでrepo専用ロックを保持して1件ずつ実行する。
   待機後の再検査、固定安全flags、既存予算・retry=0を維持し、共通queue/Flashサービスは設定担当だけが所有する。
   親・調査・独立監査の **GPT-5.6 Sol** と製品内Sol生成経路は維持し、別model/providerへ自動fallbackしない。
   運用手順・専用ランナー実接続の検証状態は[`../QWEN_IMPLEMENTER.md`](../QWEN_IMPLEMENTER.md)を参照する。
   設定通知・queue配置・オフライン試験を、実モデル起動の許可やcanary/製品機能の成功とみなさない。
   後続の直接指定「Qwen Cloudで実装を任せて」は今回の限定Bへ`--cloud-only`で適用する。
   exact Plus/既存Token Planのみで即受付できなければ停止し、Flashへfallbackしない。既定・無人実行の権限は拡張しない。
   この切替より前の2026-09-06の[32](32-local-update-and-review-intake.md)の限定2実装では、この会話のユーザー直接指定
   「qwenなしでSolで進めてください」を優先してSolへ分担した。AGENTS・共用サービス・モデル設定自体は変更していない。
4. 外部副作用は禁止する。workflow dispatch、Pages / Worker / PyPI 公開、通知、secret・branch protection・
   Cloudflare 設定変更、`develop` への push / merge はユーザーの明示承認後だけ行う。
5. title-only join、未監査 lineage の通常導線、candidate の許可 path 外コピー、secret の永続化を禁止する。
6. 完了報告には変更ファイル、実行した検証、skip、未解決リスクを含める。


</details>

## 2. 現在地

| 単位 | 状態 | ローカルで成立している内容 | 次の gate |
|---|---|---|---|
| S1 exact-SHA release | developからPages配信・smokeを実確認済み | reusable release、生成元 SHA 競合拒否。rollbackとbot経路はローカル検証済み | rollback/bot経路の実運用、残るCloudflare / GitHub設定確認 |
| D1 identity/search/quality | 静的projectionを公開済み | source ID、28,300件 projection、search v2、detail shard、quality manifest | 新しいsource snapshotによる更新検証 |
| P1 unified search/card | 検索・詳細は公開済み。追加facetはローカル検証済み。slide依頼・読取は無効 | 横断検索、学会/年/種別facet、paging/history、`?paper=`、選択時全文要旨、quality gate、review済みdeckのhash/identity検証、確認dialog、capability付きpolling、no-JS原論文リンク | 追加facetの公開、live request/status Worker、公開deck/trust root、監査済みlineage action |
| P2 lineage / theme | 一論文reader/Focus View/local bundle、L2a資料準備・L2b回答取込CLI/原本照合/非公開保存をローカル検証。実データの通常表示はblocked | v2検証、15/18/2-hop、根拠dialog、selected-card導線。A/B資料作成と回答取込CLI、pending/complete/disagreement取込、private atomic保存、bounded reader・原本再検査接続。A/B一致と第三者finalの矛盾をPython/JSで拒否。回答一致でも公開非認可 | L2実source収集・原典照合、二人の実人手監査・第三者final・focus labels・公開可否確認、L5実pilot。既存v1全面移行 |
| P3 paper slides | 既存SD0〜SD4部品に加え、Solの一論文ローカル生成経路をmock HTTPで縦断検証済み | closed contract、trusted PDF境界、bundle/review/public index、request planeの永続adapter seam、no-JS原論文リンク。追加の固定Sol profile/API adapter/service/CLIは未レビューpreviewのみ | Docker networked operator/image、live canary、人手review・公開deck/trust root、production binding/workflow。全文版はVT1〜VT4後 |
| P4 conference release watch | C0〜C2、C3a候補、C3b/C4a限定pure dry-runをfixture検証。snapshot共有検査をQwen実装・独立監査済み。定期実行/applyは無効 | registry、strict OpenReview、fingerprint、二回安定観測。candidate再検査、既存catalog/search/details互換、ID差分・全文要旨・4 outcomeと未適用plan。readinessを付与しないsnapshot共有seam | 前年度state/catalog結合・ratio assessmentと初年度人手dry-run、staging/日付/共有projection、C4 CLI/workflow、C5 trusted state/CAS/promotion/release、live観測と有効化 |
| S2 workflow/PyPI | ローカル統合済み | weekly changed-only candidate、部分失敗可視化、PyPI build-only | 承認後の CI / PyPI 外部 gate |
| R0 Replay Lite | ローカル統合済み・独立セキュリティ監査済み | canonical JSON/gzip、closed manifest、secret/path/size gate、network-free atomic replay、95 focused tests、release wheel assertions と利用文書 | R1/S2 workflow 配線は別単位 |
| X1 Docker-first | phase 1 static contractをローカル実装済み | digest/platform/tool preflight、分離target、read-only/non-root runtime policy、28 contract tests | approved image取得、build/runtime smoke、CI shadow gate、workflow移行 |

P1 の横断検索対象は現在 `title + authors + tags` であり、abstract全文検索や semantic search ではない。
検索結果から生成を直接 dispatch せず、`?paper=<paper_id>` で対象を確認した選択カードだけに paper action を出す。

Theme生成の `GET /api/themes/status` は、非原子的なKVカウンタでPAT付きGitHub APIを保護できないため、
常にCORS/no-store付き503を返す休眠状態にした。完了判定は従来どおり公開`themes-manifest.json`のpollingで継続し、
live workflow statusはatomic quota/cache境界を実装・検証するまで有効化しない。

### P2T 実装記録

- theme producer は canonical strong alias だけで focus identity / dedup を行い、alias conflict と seed 欠落を拒否する。
- conference/deep/theme の分類 cache と structured provenance は v2 identity に移行し、legacy・expired・failure・
  provider/model/version/evidence 不一致を hit にしない。
- 共有 validator と JSON Schema、`lineage-core.js`、theme consumer は strict v1 と quality row の path / SHA-256
  binding を要求し、first-focus fallback と legacy relation consumer を通常経路から除いた。
- bounded theme consumer は Qwen medium が実装し、owner が差分と focused test を独立検証した。
  SOL high の独立監査で security / fail-closed / contract parity を確認し、指摘を反映済みである。
- 既存公開 conference / deep / theme の quality row は **すべて fail-closed** のままであり、通常導線へ戻していない。
  外部 API / LLM を使う再生成と matching frozen fixture の人手承認は、別途明示承認された作業である。

### Replay Lite R0 実装記録

- `run-manifest-v1` の runtime validator と JSON Schema、deterministic canonical byte / gzip、保存 byte SHA-256、
  bounded secret/path/size/depth 検証を実装済みである。
- registered `identity-lite-v1` projector だけを network-free で実行し、全 output hash 一致後だけ sibling temp tree を
  atomic publish する。preflight / replay failure 時は repository、fixture、state、output tree を変更しない。
- missing / expired / hash / size / dependency / output mismatch と network violation は stable error code で分離した。
- 95 focused tests、独立セキュリティ監査、build-only release の wheel 内容 assertion、clean wheel CLI smoke、
  README / script documentation までローカルで成立している。workflow 接続、upload、公開は実施していない。

### Paper Slide ローカル実装記録

- `schemas/slide-deck-v1.schema.json`、`paperpilot/paper_slides/contract.py`、公開 API、full-text / abstract-only /
  invalid fixture、`paperpilot/tests/test_slide_deck_contract.py` を実装済みである。
- trusted envelope の exact hash、page / chunk / PDF binding、言語別 `ja | en` 固定 label / limitation、safe URL / path /
  plain text、secret scan、任意 JSON に対する bounded total validation を fail closed で検証する。
- review は candidate / PDF hash と `generated_at <= reviewed_at <= review_as_of` に結び、lineage の
  `corroborated` は current calibration と独立 source-work 証拠を要求する。
- canonical catalog identityからのsource resolver、IP-pinned SSRF-safe bounded fetch、pypdf低レベルnormalization、
  Linux subprocess isolation、SD0向けPDF/chunk hash・page anchor bindingを実装した。production package rootは
  in-process parserを公開せず、isolated entry pointを公開する。ただしpypdfだけではglyph visibilityを証明できないため、
  実PDFの非空textは`page_text_visibility_unverifiable`で拒否し、render/OCR verifierまでfull-text chunkを作らない。
- isolationはLinuxのresource limits、bounded pipes、empty environment、private cwd、process-group killを使う。
  socket/DNS・process API拒否はPython audit hook/runtime guardであり、kernel/seccomp sandboxではない。
  macOSその他は制限なし実行へ降格せずfail closedにする。
- extraction/isolation focused **93 passed / 1 skipped**、Ruff、型/境界mutation、全catalog **28,300 / 28,300**
  dry resolutionを確認した。crop外、long run、極小font/CTM/Tz、同色textはproduction chunkへ入らない。
  skipはmacOS上のLinux専用isolation parity testである。
- SD2 backend、SD3 renderer/public index、VT0、selected-card read-only public-slide integrationはローカル実装済みである。
  SD3 bundleは一つの検証済みasset snapshotから全deck HTML / JSON、full-SHA CSS / JS、256 shards、manifestを
  一度だけ生成し、128 MiB aggregate ceiling内のimmutable exact bytes mappingとして返す。SD4が別供給するreview recordも
  `paper-slide-review-record-v1` canonical bytesのfull SHA pathへ結び、旧deck-ID-only review URLは拒否する。
  SD4のoffline境界はcanonical provisional bytesとapproved review recordをcandidate/PDF/deck/time/checklistへ再結合し、
  reviewed deck、決定論HTML、content-addressed review record、public index入力を一つのimmutable resultとして返す。
  trusted contextはfield単位でdeep snapshotし、同一checkoutでdeck/HTML/assetsを再現できないindex buildはfail closedにする。
  ただしlive PDF/LLM、VT1〜VT4とimage承認/E2E、production request/status binding、no-JS公開deck link、
  workflowでのreview取得、promotion/publish/deployは未実施・未実装であり、production end-to-end slide generationは未完了である。
- 2026-09-04にS4C request/status契約を整合した。request POSTは毎回freshな`request_id`と独立`status_cap`を返し、
  statusはclosed bodyと`Authorization: PaperSlide <status_cap>`を使うPOSTだけとする。`request_id`単独は権限ではない。
  同一paper/languageのactive jobはatomic coordinatorで共有する一方、
  request record/capabilityはbrowser requestごとに分離する。pure HTTP boundary、atomic in-memory coordinator fixture、
  Worker entrypointのdependency-injection seam、selected-card request/polling consumerを実装し、security/a11y監査を反映した。
  approved catalog producer/adapterは全28,300件を一論文一recordで決定論的に構成し、現行PDF byte digestがないため
  `abstract_only`だけをeligibleにする。single named Durable Object向けservice/clientはserver clock、atomic dedup/claim、
  rate/cost、queued/candidate/request TTL、bounded physical cleanupを所有する。dispatchは204/明確な4xx/不確定を分離し、
  timeout時は同じqueued jobへjoinして自動再送しない。別Secret `PAPER_SLIDE_WORKFLOW_CLAIMANT_KEY`からdispatch 6入力と
  GitHub run identityをHMAC-SHA256した256-bit claimant tokenはhashだけを永続化し、generation付き15分lease、同token/bodyの
  response-loss再確認、明示操作だけのgrace後reclaim、`running/generating` permanent fenceをatomicに扱う。tokenはworkflow
  output/logへ出さず、通常workflowは自動reclaimしない。fence後crashは自動再実行せず、明示reconciliationへ閉じる。
  authenticated callbackと公開APIを分離した休眠runtime/workflow足場も実装したが、provider stepは未接続である。provider境界は
  exact adapter型・価格snapshot hash・job予算・単一ledgerを固定し、registry承認済みexecutionから既存generatorを一度だけ
  起動できる。SD4 offline review/public projection境界も実装し、公開誤許可につながるHigh / Mediumがないことを独立監査した。
  本番registryは空である。production injection、namespace/binding/migration、catalog配置/pin、live provider/
  Secrets、deployは未接続である。
- build-time no-JS fallbackは10学会・全28,300件の原論文リンクを決定論的・atomicに生成する。review済みpublic bundleが
  まだ存在しないため公開deck linkはfail closedで出力せず、production API baseとmanifest trust rootも`null`を維持する。

## 3. Full integration gate 結果

### 2026-09-07 直接依頼: Qwen実装→レビュー→やり直し

- [34](34-conference-baseline-assessment.md) unit 1のsnapshot共有検査だけを採用した。実装はexact Qwen Cloud
  `qwen3.7-plus`、親とSolは検証・独立レビューを担当し、意味的なruntime補完は行っていない。
- 初回の自律編集はpatch失敗・禁止した依存install試行のため停止（130）。install失敗・隔離差分なしを確認し、
  同Qwenのtoolなしソース限定依頼でやり直した。tool 0・終了0のコードを形式だけ機械補正して適用した。
- 独立テスト25件、主作業の学会関連162件、独立監査側104件が成功。既存の5出力SHA、error順序、
  minimum/readiness・公開境界は不変でP1/P2なし。対象2ファイルのnarrow mypy/formatと全体Ruff、asset同期も成功。
- 最終host全体回帰は3,029 passed / 1 skipped（45.75秒、Linux専用RLIMIT_AS）。全体mypyは268 errors /
  46 files / 280 source filesで未成功。Docker/CI runtime・実source・公開の成功ではなく、primary commit/pushなし。
- 次のunit 2（前年度registry/state/catalog結合）のbounded依頼書は
  `/private/tmp/paperpilot-candidate-seam.XgSffu/baseline-validation-brief.md`に準備し、要点を設計34へ反映した。
  baseline/assessment本体は未実装。全所有worker終了、共有設定・AGENTS・既存WIPを保持した。

### 最新の定期照合: 2026-09-07 02:06 JST

- `develop` / HEAD `cd8f28c`、staged差分なし。既存の混在WIPは保持し、原本照合・回答取込CLIの採用記録と実装を再照合した。
- 直近機能・package境界・学会count guardのhost補助125件、全体Ruff、関連4ファイルのnarrow mypy、asset同期・diff checkは成功。
  全体mypyは268 errors / 46 files / 279 source filesで未成功のまま。全体pytestの3,004件成功は前回直接依頼時の記録で、今回は再実行していない。
- 残作業一覧の古い型エラー件数と設計33冒頭の未実装時の表現を整理。続きは設計34の既存validator再利用と4つの依頼単位を具体化した。
  snapshot共有範囲とminimum/readinessの分離、初回のfloat丸め互換、固定depth capが未導入であることを明記した。
  heartbeatから対話中Cloud起動を推測せず、実装モデルの変更・Cloud実行・README/AGENTS変更はしていない。
- 作業未完了と全体型検査失敗のためcommit/pushなし。ローカルtracking refとの差は0/0だが、remoteのfresh状態を確認した証拠にはせず、push判断にも使わない。

### 2026-09-06〜07 Qwenの実装・レビュー・差し戻しを反復

- ユーザー指示に従いQwen Cloud `qwen3.7-plus`を維持し、Solへのruntime実装切替は行わない。
  生成案の問題を具体化し、同モデルへ修正を戻して検証に通った差分だけ採用した。詳細は[33](33-private-review-intake-cli.md)。
- 原本照合と保存の高水準API、回答ファイル取込CLIを採用。独立検証はAPI29件・CLI19件。
  APIではclose初回故障時のFD漏れを独立レビューで検出し、Qwen修正・追加2件RED→GREEN・再レビューで解消。
  CLIは引数/bytes/summary/安全errorを検査し、準備CLIを含む75件成功、独立レビューP1/P2なし。
- build-onlyのwheel同梱とhelp検証3行もQwenから取得し、既存workflowへ機械適用。境界契約はRED→13件成功。
  wheel buildとwheel由来コードだけの両CLI help成功・tests非同梱を確認。host既存依存を用いた起動確認であり、
  CI clean install、Docker image/runtime、実人手監査・実source収集・公開の成功ではない。
- 全体mypyは268 errors / 46 files / 279 source filesで未成功。今回のruntimeと独立テスト4ファイルのnarrow mypyは成功。
  最終host全体回帰は3,004 passed / 1 skipped（46.50秒、Linux専用RLIMIT_AS）。全体Ruff・対象format・asset同期・diff checkは成功。
  主作業のHEAD/既存WIPを保持し、primary commit/pushは行っていない。既存の未完了項目は引き続き残る。

### 2026-09-06 全実装の直接依頼（検証済み小単位を順次統合）

- Qwen Cloud `qwen3.7-plus`へ実装を一つずつ委譲し、Solは調査・独立レビュー・検証を並行した。
  repo/shared Cloud枠は重ねず、private作業記録は`/private/tmp/paperpilot-complete.Jqix6V`へ保持。
- [33](33-private-review-intake-cli.md)にbounded file readerとprivate answer path wrapperを採用。
  file readerの新21件/関連96件、answer wrapperの新12件/関連33件、Ruff/runtime narrow mypy成功。
  両方とも独立監査P1/P2なし。深いFD/cap/ancestor probeの永続回帰化は追加課題として保持する。
- A/Bが一致した際に第三者finalの異なる判断を無視する誤受理を再現し、Python/ブラウザ双方へ同じ4項目の検査を追加。
  Qwenの新5件は4 failed/1 passedから成功し、Pythonだけの段階でbrowser parityもREDを確認。
  両側適用後36件、主作業のbundle/viewerを含む75件成功。独立probeでhash再束縛後のquality/producer/JS拒否も確認した。
  親はQwen出力の末尾quote/paren欠落を構文補完、テストset期待を補正し、quality/producerとcross-runtimeの独立回帰を補強した。
  schema・合成fixtureのbyteは変更せず、asset同期scriptでversions/HTMLを整合した。公開は行っていない。
- 原本比較/保存接続とbaseline assessmentの大きなCloud依頼は読取反復から編集に進まず、所有jobを停止した。
  その試行を実装成功と扱わず、接続は単関数へ再分割した。baselineは未実装、candidate/dry-runの`not_checked`は不変。
- 接続の単関数生成も2案とも既存helper契約・原本再検査・FD回収等の不備で未適用。
  最終の小修正は共有Cloud枠busyで即終了2、モデル未実行。再試行/fallbackをせず停止し、所有worker残存なし、
  source worktree cleanを確認した。Solによるruntime補完は行わず、残りの実装担当変更はユーザー判断を待つ。
- 最終統合後の全体host回帰は2,956 passed / 1 skipped（46.50秒、Linux専用`RLIMIT_AS`）。
  reader段階の2,939 passed / 1 skippedは途中結果として保持する。
  全体Ruffは`.codex`をPython 3.11指定に分けて成功。Docker image/runtime/CI gateは未検証。
- 全体型検査を`.venv/bin/mypy --python-version 3.12 paperpilot`（mypy 2.3.1）で確認し、最終結果は268 errors / 46 files / 276 source filesで失敗。
  途中結果269 errors / 47 files / 275 source filesから、関連テストの型絞り込み1件を補正した。
  旧278/53は過去の記録であり、環境/コマンド依存の総数を固定gate値にしない。大半はJSON境界の型絞り込みとテスト型負債。
  直接関連する既存intakeテストへ`b is not None`検査を1行追加し、そのテストとruntimeのnarrow mypyは成功した。
  この限定補正を全体型負債の解消とはしない。主checkoutの既存WIP、AGENTS、archive原本を保持し、commit/pushは行っていない。

### 2026-09-06 サブエージェントへの継続委譲（2小単位を採用）

- 実装はQwen Cloud `qwen3.7-plus`/既存Token Planへ1件ずつ委譲。Solの調査・独立レビューは並行した。
- 家系図: [33](33-private-review-intake-cli.md)のB1b-1 private directory openerを追加。
  新15件・関連75件、最終独立レビュー成功。原本/回答file readerやCLIはまだ接続していない。
- 学会更新: [34](34-conference-baseline-assessment.md)の既知P2を修正。
  前年度件数をNoneまたはplain int0〜25,000へ限定し、bool/巨大整数を安全に拒否する。
  新27件＋stability10件、主作業の関連123件成功。比率計算とcandidate/dry-runの未認可gateは不変。
- 自律編集の停止と生成案の誤りは各設計文書へ記録した。製品runtimeの修正もQwenから取得し、
  親は機械適用・テストfixture補正・全差分/検証結果の再確認を担当した。全体完成や自律実装の安定性とは区別する。
- 実source/実回答、定期更新、Docker稼働、公開、primary commit/pushは行わない。深いFD/race probeの永続回帰化は残る。
- 取込後の全体host pytestは **2,918 passed / 1 skipped**（46.03秒、skipはLinux専用`RLIMIT_AS`）。
  repository Ruff（`.codex`はPython 3.11指定）、変更runtime2ファイルのnarrow mypy、diff check成功。
  既知の全体型エラーとDocker runtime未検証は解消した扱いにしない。今回のworkerはすべて終了済み。

### 2026-09-06 後続Qwen Cloud直接指定のB1a（内部writer hookのみ採用）

- ユーザーの`qwen3.7-plus`サブエージェント指定を受け、原本reader/CLIまで含めず内部writer hookへ細分化。
  Qwenの自律編集手順違反を停止後、同じCloudが生成した関数・修正を親が機械適用した。
- 全ancestorの禁止identity照合、保存前後callback、失敗時の所有出力cleanupを追加。
  新12件を含む関連60件・対象Ruff/narrow mypy成功、Sol独立レビューでruntime P1/P2なし。
  深いrace/FD検査は独立inline probeで成功したが、その永続回帰化は未完了。追加生成テストの不良案は却下した。
  主作業の全体host pytestは2,876 passed / 1 skipped（Linux専用制約）、Ruffとruntime narrow mypy成功。
- 原本/回答reader・CLIは未実装。既存public writerは互換のまま、外部仕様を増やしていないためREADMEは変更しない。
  詳細は[33](33-private-review-intake-cli.md)。主作業の既存WIPと未解消の全体型検査/Docker gateは保持する。

### 2026-09-06 直接Cloud指定の限定B1（初版却下・修正実行停止）

- ユーザー回答はSolへの引継ぎではなくQwen Cloud指定だった。共有Cloud専用経路の配置を確認し、
  repo側の専用flag・未変換Flash拒否を実装。親のlauncher35/35・profile3/3・対象Ruff/narrow mypy・
  shell/diff check成功とSol独立レビュー（対象runtimeのP1/P2なし）の後、新規の直接監督実行を開始した。
- 実queueでCloud専用、`qwen3.7-plus`、retry 0の即受付を確認。B1は原本/回答readerと保存接続だけを
  Qwenがテストpatch・runtime patchとして生成し、親がRED→適用→検証する。B2のCLIは未着手。
  初回は212.8秒・終了0で応答したが、新テスト20失敗と安全境界の不足で採用不可。同じCloudへ修正を戻した。
  ソース生成形式の拒否後、通常編集の限定実行も資料読取22件・圧縮警告3件を反復し、編集0のため
  親が165.92秒で停止（終了143）。修正先clean、全worker停止済み、主作業runtime未採用、B2未着手。
  詳細とprivate依頼書の場所は[33](33-private-review-intake-cli.md)。実装採用・Docker・公開とは区別する。

### 2026-09-06 回答取込CLIの限定B（設計完了・実装時間上限で停止）

- ユーザーの直接依頼で[33](33-private-review-intake-cli.md)の原本/回答readerとCLIを着手。
  Solの並行調査/事前監査で高水準API、exact0600/nlink1、同名file置換検出、writer内部の原本ancestor identity拒否、
  原本の保存前後再検査と所有出力の回収、6キーsummary/固定error codeを確定し、実装依頼書へ固定した。
- cleanなlinked worktree `/private/tmp/paperpilot-review-cli.GZfTSV/implementation`を用意。
  必要な既存入力の129テスト、対象Ruff/narrow mypy成功後に隔離branchだけへ準備commit `48aad92`を作成した。
  developのHEAD `cd8f28c`と既存WIP、既存のworktree/workerを保持した。
- 対話中の単発実装として共通queueへ依頼し、Flash `qwen38-flash-next`が即受付。
  4件の読取操作後もコード/テスト返却がなく、待機込み900.08秒で今回のlauncherを終了143として回収した。
  隔離先status/diffはclean、新runtime/test差分なし。新CLIのRED/GREEN・採用・機能検証は未達である。
- 今回の製品側変更はなし。設計33と本記録のみ更新し、README/package同梱の変更は採用まで保留。
  自動retry/model fallback、共有設定/サービス変更、主作業commit/push、実source/実回答、Docker/公開は未実施。
  当時Solへの引継ぎを確認したが、後続回答は上記のCloud指定。無回答を承認にした実行ではない。

### 2026-09-06 共通queue接続・オフライン検証完了（実モデル未起動）

- 設定担当から最新ユーザー承認と起動APIを受領し、repo launcherをFlash固定argv＋共通queueへ接続した。
  通知から実モデル・Cloud・製品実装を再開せず、偽queue/偽Codex/使い捨てGit fixtureだけで検証した。
  AGENTS/PAPERPILOT_PROFILE/固定role指示/native設定と既存WIPは保持する。詳細は[現行運用文書](../QWEN_IMPLEMENTER.md)。
- `--interactive`は既定無し・先頭単独flag。repo排他をqueue待機全体に適用し、private shimで待機後の
  worktreeと受信argvを再検査する。Cloud認証は共通queue所有で、repoはuser config/Keychainを読まない。
- 模擬cancelで、shim削除後のPATH fallbackから実Codexが起動するraceを再現した。queue用PATHをshim directoryだけに
  限定して修正。startup/cancelのatomic gate、事前固定したGitと全GIT_*再除去、別sessionのworker停止を追加した。
  これらはworker prompt単独の保証ではなくローカルsupervisorの回帰対象とする。
- 最終launcher **32/32**、profile contract **3/3**、全体host補助pytest **2,864 passed / 1 skipped**（46.03秒）。
  skipはmacOSのLinux専用`RLIMIT_AS`。split Ruff、対象3ファイルのnarrow mypy、shell構文、diff checkも成功。
  全体mypyの既知278 errors / 53 filesを解消した証拠や、Docker runtimeの検証ではない。
- Sol独立レビューで対象runtimeの残るP1/P2指摘なし。同値/異値catalog重複、Git環境変数＋偽Git PATH＋dirtyの
  複合回帰を追加し、配置済みsourceのCloud変換もfixture設定によるpure関数評価で照合した。
  共通queue最終SHA-256 `7c7d59a4e1edcc2a65d1620076a8250712175c570a3d73e633e7ac65c8973330`はstaging/配置先一致。
  待機前executable固定とspawn/child代入間の取消強化をread-onlyで確認した。
- 今回の変更はrepo launcher・テスト・運用文書の7ファイルだけ。主作業commit/push、製品API、Docker、公開、
  Keychain取得、共有ファイル変更、実モデル起動や既存worker停止は行っていない。製品の未完了gateは不変。

### 2026-09-06 定期メンテナンス（05:52 UTC起動）

- developのstatus/diff/staged diffを確認。HEAD `cd8f28c`は`ls-remote`で確認したGitHubのdevelop refと一致し、
  staged変更・現在ブランチの未push commitはない。複数単位の未完了・未追跡差分は保持した。
- [19](19-conference-release-watch-contract.md)の状態欄とR2に、実装済みのC3b/C4a限定pure差分確認を反映した。
  前年度baseline assessmentは[34](34-conference-baseline-assessment.md)の設計案段階、
  [33](33-private-review-intake-cli.md)の保存APIは実装済み・原本/回答readerとCLIは未実装の区別を再確認した。
- 新規P2課題を[34 §9](34-conference-baseline-assessment.md#9-後続-gate-と未決事項)に記録した。
  `observation_from_detection`の前年度件数にboolを渡すと受理され、極端な整数ではraw `OverflowError`になる。
  親と独立担当がsynthetic入力で再現し、bounded plain-int検証・safe error・0/上限の互換確認を次の限定修正へ残した。
  assessmentの出所照合とは別課題であり、runtime/testは今回変更していない。
- 関連host補助テスト **168 passed**、製品側Python3.10とhost専用`.codex`側Python3.11のRuff、
  `review_io.py`/`review_intake.py`/`dry_run.py`のnarrow mypy、`git diff --check`が成功。
  全体pytestと全体mypyは今回再実行していない。直近の全体pytest **2,864 passed / 1 skipped**と
  全体mypyの既存 **278 errors / 53 files**は履歴として保持し、対象型検査を全体成功としない。
- READMEの利用方法・外部仕様に新しい変更はなく、README・AGENTS等の指示ファイル・実装は変更しない。
  未追跡の実装を前提とする文書と既存の未完了差分が混在し、独立したcommit単位に整理できていないため
  commitしない。未push commitもないためpushしない。Qwen実行、Docker、製品API、公開操作は行っていない。

### 2026-09-06 Qwen再開・非公開回答の保存API

- [33](33-private-review-intake-cli.md)を限定A（保存API）と限定B（private reader/CLI）に分け、Aを採用した。
  `write_private_review_intake`はfactory bundleと回答bytesから再検証して固定`intake.json`だけを保存する。
  arbitrary result/bytesを信頼せず、directory0700/file0600、非Git、新規のみ、parent identity、noreplace、
  失敗cleanupを既存3原本writerと共有する。回答一致は監査・公開の認可ではない。
- `qwen3.7-plus`の実接続とソース生成が成功した。自律tool jobは繰返し読込/compaction等で停止し、
  Qwenから小さなソース差分を受け親が機械適用する単位へ分割。runtimeはQwen、設計・レビューはSolを維持した。
  Qwen生成テストのAPI誤用を実行で検出して差し戻し、残るrace-winnerの誤pathはレビューに沿い親が補正した。
  モデル一覧metadata警告と自律実装の安定性は[運用記録](../QWEN_IMPLEMENTER.md)に残す。
- 追加 **21 passed**、既存を合わせた関連 **129 passed**。主作業側の全体host補助回帰は
  **2,864 passed / 1 skipped**（45.64秒）。skipはmacOSのLinux専用`RLIMIT_AS`で、Docker gateではない。
  対象format/runtime narrow mypy成功。Ruffは製品側Python3.10と`.codex`側Python3.11に分けて全件成功した。
  既定Python3.10で単一実行したRuffはhost専用2ファイルの`tomllib` import順だけに診断を出すため、
  その実行を成功と扱わない。全体mypyの既存278 errors / 53 filesは未解消・今回再実行なし。
- Solがruntimeと追加テストを独立レビューして必須指摘なし。独立選択 **76 passed**、factory呼出し1回と、
  noreplace完了直後のparent swapで所有出力だけを回収し交換先sentinelを保持する追加probeも成功した。
- 学会側は[34](34-conference-baseline-assessment.md)の前年度state/catalog結合を別担当が設計しただけで、
  baseline assessmentを実装済みにせず、既存`previous_edition_ratio: not_checked`を維持する。
- 原本のprivate再読込・byte照合・原本配下への出力拒否・回答reader・CLIは未実装。
  実source収集、実人手監査、Docker、定期更新/apply、公開、主作業commit/pushは実施していない。

### 2026-09-06 学会更新差分と家系図回答取込（ローカル）

- [32](32-local-update-and-review-intake.md)の2 pure APIをSolで並行実装し、主が統合。先行テストのREDと
  GREENを確認し、両方を別担当が独立監査した。UTF-8/不正型/control、回答外形の先行拒否を修正済み。
  本人性・実際の盲検性をJSONだけで証明せず、公開関連の全認可はfalseを維持する。未解決P1/P2はない。
- 新規直接/統合 **89 passed**。対象coverageは学会93%、回答取込90%。全体host補助regressionは
  **2,843 passed / 1 skipped**（最終再実行47.71秒）、skipはmacOSのLinux専用`RLIMIT_AS`。
  Node **39 test files**、repository-wide Ruff、対象7 Python filesのformat、2 runtime modulesのnarrow mypyはpass。
  全体型検査は既存 **278 errors / 53 files**（270 files対象）で、今回の新規診断は解消した。
- sdist/wheel/Twine、2 runtime modulesの実byte同梱・tests除外、build-only workflowの必須同梱検査はpass。
  offline/no-depsで隔離targetへinstallし、`-I -S`実プロセスでcheckoutではなくinstalled moduleから両APIをimportした。
  依存は既存環境を利用しており、fresh依存install・Docker runtimeの証拠ではない。
  asset/sitemap 12 URL/diff checkもpass。利用者向け外部仕様を変えないためREADMEはこの単位では変更しない。
- 実source・実人手回答・保存CLI・staging/共有projection・本番有効化は後続。全体型検査未達と既存の未完了差分を
  保持し、commit/pushは行っていない。AGENTS・共用Flash設定、Docker image/runtime、外部生成・公開も変更していない。

### 2026-09-05 定期メンテナンス（13:54 UTC起動）

- develop の status/diff/staged diff と remote の develop ref を確認。HEAD は引き続き `cd8f28c`、
  remote と一致し、staged変更・現在ブランチの未push commit はない。未完了の作業差分は保持した。
- 28の旧Sol実装指定を履歴と明記して現行AGENTS/13へ参照を統一し、設計目次を32まで更新。
  32にmacOSのUnicode正規化によるarchive表示差の注意を追記した。原本文書の移動・削除は行っていない。
- 全体host補助テスト **2,754 passed / 1 skipped**（49.77秒）。Ruff・asset同期・sitemap 12 URL・
  diff check はpass。全体型検査は既知の **278 errors / 53 files**（264 files対象）を再確認した。
- L2b/C3bは未実装、Flash 429停止とSol切替確認待ちは不変。実装jobの再起動・README/エージェント指示の
  変更・Docker/公開は行っていない。未完了差分と型検査未達のためcommit/pushせず、次期実装を完了扱いにしない。

### 2026-09-05 差分確認・回答取込の次単位（実装経路429で停止）

- [32](32-local-update-and-review-intake.md)で C3b/C4a の pure dry-run と L2b の private intake を限定設計し、
  Sol による実装前レビューを完了。新規 runtime は各1モジュール、直接テストと親の統合テストで検証する。
- 現行 Flash 経路用に登録済み worktree を二つ準備した。対象の未 commit ソース/指示/直接テストだけを
  明示複製し、conference の50テスト、lineage の28テストと各 Ruff を通してから準備用のローカル commit を作成。
  主作業 develop の commit/push、既存変更の巻戻し、AGENTS/runnerの変更はしていない。
- 主作業で前提の105テストが pass。新規統合5テストは runtime 未実装による import failure の RED を確認。
  build-only 配布検査に新2モジュールの同梱要求を追加し、workflow contract は RED 後 **13 passed**。
  本体が未実装で終わったため新規統合テストは一時領域の `parent-tests/` に退避し、今回だけの同梱要求は
  取り下げた。既存31のmodule同梱要求・テストは保持した。
- Flash は共用キュー待機後、両 job とも初回 `429 Too Many Requests` で終了1。worktree は変更なしであり、
  本体実装や接続成功とは扱わない。待機中に得た設計修正を反映するため、自分の未起動待機だけを一度取消して
  再投入した。他プロジェクトの実行中 worker は維持し、provider変更・自動fallbackは行っていない。
  今回2件に限定した Sol への切替をユーザーへ確認中。実装を起動したままの残プロセスはない。
- 新規の既知事項: 現行 fixture は全 edge の第三者裁定と focus labels を必須にするが、設計18/28の
  「不一致時の裁定」と不整合。intake は判断一致でも fixture/quality/publication を認可しない。
  学会の paper-links renderer の6,000件/3MiB上限と C3 の25,000件上限も公開接続前に解消・検証が必要。
- 保存 CLI、actual staging/global projection、trusted state/CAS、実 source、人手回答、Docker/公開は未着手。
  再開用の依頼書・linked worktree・先行テストは `/private/tmp/paperpilot-next-delivery.fXNT9g` に保持し、
  [32](32-local-update-and-review-intake.md)へ再開手順を記録した。今回の機能完成とは説明しない。
- 退避後の主作業全体を再検証し、**2,754 passed / 1 skipped**（45.25秒）、repository-wide Ruff、
  `git diff --check` が pass。skip は macOS の Linux 専用 `RLIMIT_AS`。全体型検査・Docker・公開は今回実行していない。

### 2026-09-05 非公開review資料と学会候補（ローカル、公開前）

- [31](31-private-review-and-conference-candidates.md)のL2a/C3aを実装した。前回からのdirty差分と別設定タスクの
  AGENTS/Flash runner変更、無関係なWord文書は保持した。AGENTS自体の編集、commit/push/deployは行っていない。
- 家系図は未監査v2 artifact・実catalog・閉じた候補母集団・原典snapshotの実byteを固定し、全候補のledgerと
  二人分のblind packetを作る。機械判断はcoordinatorだけに残し、回答・独立性の申告・人名・確認日時はnull。
  根拠のないunknown/abstainedも母集団から落とさない。completed human fixture/quality/indexは生成しない。
  sourceのhash一致はsource identity・抜粋の実在・PDF可視文字を証明しない旨を各資料へ明示する。
- CLIはローカルregular fileだけを読み、source/hash/identity・サイズ・読み取り中の変更を検査する。
  Git外の既存0700親ディレクトリ内へ、0700の新規出力と0600の3 JSONをdirfd/no-follow/no-replaceで確定する。
  親の入替・権限拡大・既存出力・symlink/FIFOを拒否し、失敗時は自分の一時ファイルだけを回収する。
  Linux/macOSの必要機能がない環境は、弱い代替動作をせず入出力前に拒否する。
- 学会C3aはsnapshotのfingerprint/native ID/URL、全件投影、未知decision/重複titleの集計、最低件数、
  公開済みID集合の保持を再検証する。candidate行・全文要旨・summary CSV・local report・hash bindingはimmutable。
  前年度baselineと初年度人手dry-runがないため、それらのgateは`not_checked`を維持し、公開権限はfalseとする。
  旧CSVで著者名を誤分割する`,`/`;`は拒否する。lossless JSON stagingは後続の制限として明記した。
- 主担当の独立3テストで、実adapter/reducerから既存catalog・identity・search・256 detail shardsまでを通した。
  同名別IDのOral/Poster、Unicode著者、previewと全文要旨、順序不変、観測日固定をsynthetic入力で確認した。
- 独立レビューで見つかったREADY後の再probe誤拒否と過大なcount-gate表現、private packetのslug上限/Schema不一致、
  factory bundleのcontainer改変時の未捕捉例外を修正した。private領域の再監査は55 tests passで、対象内に
  未解決P1/P2なし。Python 3.10は構文/API確認であり、実3.10/Windows/Dockerでの実行確認ではない。
- 最終host補助regressionは **2,754 passed / 1 skipped**（46.33秒）。skipはmacOS上のLinux専用`RLIMIT_AS`。
  **39 Node test files**、repository-wide Ruff、今回のPython **9 files**のformat、**4 runtime files**の
  narrow mypy、asset/sitemap/lock/diff checksがpass。画面コードは今回変更していない。
- `mypy paperpilot --no-site-packages`でtestsも含む全264 source filesを確認すると、既存領域に **278 errors / 53 files**。
  今回追加したruntime/testには診断0で、全体型検査は未達である。過去に記録したimport先中心の54 errorsと
  今回のtests込み全体checkは対象範囲を区別し、全体が54件だけだとは説明しない。
- sdist/wheel/Twine、4 runtime modulesのwheel実byte一致・tests除外、隔離targetへのoffline/no-deps installを確認。
  checkoutのeditable importが混ざらない`-I -S`の実プロセスで、インストール済みCLIからsynthetic資料を作成し、
  3 JSON/0700/0600/回答nullを検証。再実行は`output_exists`で失敗し、先のbyteを保持した。
  これは依存のfresh install・Docker runtimeの証拠ではない。検証資料は`/private/tmp/paperpilot-review-qa.47VY47`の私有領域だけに置いた。
- 実sourceの収集・本文照合、二人の人手回答・裁定・回答取込、公開可否確認、L5、C3 staging/C4/C5、定期実行、
  live slide/API、承認済みDocker image/runtimeは残る。本番lineage indexの空配列と休眠設定は維持した。

### 2026-09-05 一論文の家系図接続（ローカル、公開前）

- [30](30-lineage-pilot-viewer-delivery.md)のbounded milestoneを実装した。既存v1 reader/deep/themeを置換せず、
  共通`lineage/?paper=`、strict v2 reader、selected-card限定のindex lookup、local pilot bundle APIを接続した。
  公開`lineage-pilot-index-v1.json`は空であり、実論文の表示認可は増やしていない。
- producerはprivate入力snapshot、実catalog、全候補review・hashを検証し、immutableな3 JSONを作る。
  fresh出力だけのwriterはsymlink/canonical docs/data/既存出力・race上書き・手作りbundleを拒否する。
  CLI・live収集・人手承認・公開promotionは追加していない。
- JS readerは実byte SHA、private brand、整数token、Unicode/alias、microsecond日時、候補全件・Cohen κを検証する。
  独立監査で検出したBufferSource書換え競合、DOI正規化、URL aliasの曖昧性・重複条件を修正した。
  独立監査の追加 **1,739 rebound payload mutation** ではPython拒否・browserのみ受理は0件。
  最終bounded auditでintroduced P1/P2は残っていない。
- Node core **33 tests**で200 nodes / 1,000 claims、決定順、15/18/2-hop、追加枝、graph safety/list移行、
  graph/list共通集合、明示的な空条件を検証。主担当は生成元の異なる小・大synthetic fixtureを実ブラウザで確認した。
  大fixtureの初期 **15論文/18関係** → 2回の追加 **19/22**、一覧 **20+2件**、折り畳みで **15/18**へ戻る。
- ブラウザでカード→viewer→Back、選択解除でリンク消去、未監査indexの非表示、根拠条件の明示解除による0件を確認。
  根拠dialogの表示、Tab循環/Escape/起点復帰、中心変更と見出し、paging/展開後のfocus復帰を確認した。
  QAで発見したhidden dialog、期限切れloading、focus喪失、矢印端点、一覧の表示順を修正し回帰テストを追加した。
- 320/375/720/768/1024/1440pxで横overflow 0、詳細条件を開いてもselectは44px以上。
  モバイルでは詳細条件を畳み、関係一覧を論文カード群より先に表示する。reduced-motionはCSS対応を確認したが、
  OS設定を切り替えた実動作確認は行っていない。no-JSは静的非表示契約の確認である。
- 最終host補助regression: **2,649 passed / 1 skipped**（48.92秒）。skipはmacOSのLinux専用`RLIMIT_AS` parity。
  repo内 **39 Node test files**、repository-wide Ruff、対象Python **12 files**のformat、
  新package/v2 validator/sitemapの **4 source files**のnarrow mypyはpass。
  通常mypy全体の既存54 errorsを解消したとはしない。
- asset同期・sitemap check・lock check・diff checkはpass。bare viewerはquery必須のnoindexとしてsitemapに追加しない。
  sdist/wheel/Twine、4 runtime moduleのwheel byte一致・tests除外、隔離package targetからのimport、
  実producerによる共有3 fixture byte再現とfresh local writerを確認した。依存は既存venvでありfresh依存installではない。
- Docker/image/Linux no-replace runtime、外部研究API・LLM生成、実人手監査、commit/push/deployは実施していない。
  並行した別設定タスクのFlash開発ランナー/AGENTS等の差分も保持したが、その実接続canaryの成功とは無関係である。

### 2026-09-05 次期実装のローカル確認（公開前）

- P1検索は学会・年・発表種別のfacetを既存rankingの前に適用する。URL共有、20件paging、Back、
  filter変更時のpage reset、0件でも条件を保持する解除操作、不正/重複URL条件の拒否を実装した。
  2文字未満・初回表示・focusだけではindexを取得しない既存境界を維持する。
- 主担当が実ブラウザで390px/320px、44pxのselect、横overflowなし、filter後のfocus保持、
  paging後の見出しfocus、Backの条件/件数復元を確認した。不正な重複facetは0件へ閉じ、明示解除で復帰する。
- frozen検索評価は10学会・28,300件、index SHA
  `c6d5ef4e8e2d95d1fd61dd520521e5bc4c57f1ebad40edb1df213e0dcf64812b`に固定。
  8 query中6件の限定された判定済みtop-k poolでprecision/recall/MRRは各1、facet precision 1、重複ID率0。
  これはcatalog全体の再現率やsemantic search品質ではない。残りは非該当例1件と日本語未対応例1件で、
  日本語の0件を成功指標へ加算しない。source coverage 10/10、API cost 0 USD。
  indexは6,633,612 bytes、全ID shardsは1,225,735 bytes（inventory計7,859,347 bytesであり1操作の転送量ではない）。
  Node 20.20.2 / darwin arm64 / warm parsed indexで8 query直列rankingは325.48 ms、
  fixture/catalog I/O込みの評価全体は378.68 ms。公開endpointのlatencyは未測定。
- C0〜C2はregistry/schema、strict OpenReview取得、canonical fingerprint、別runで2回の安定観測を実装。
  不完全取得、未知decision、重複ID、公開済みcatalogの縮小/ID消失、bounded retry・時間/byte上限をfixtureで検証した。
  独立レビューの4指摘を修正し、再レビュー対象59 testsがpass。applyとICLR registryはdisabledを維持し、
  live sourceの完全取得・有効年度設定はまだ確認していない。candidate/workflow/CAS/定期実行は後続である。
- L0/L1の新v2契約は既存v1を推測変換せず、artifact/fixture/qualityの全payloadとhash、candidate全件の対応、
  実catalog集合、root/focus、引用/claimの証拠方向、DAG、時系列、固定した二人の人手reviewを検証する。
  relation/supportのCohen κを再計算し、未定義値や単なる一致率で較正を代用しない。
  focused 27 testsに全pathの型置換・結合payloadの再hashを含め、主担当の追加3,036 mutationも全て通った。
  synthetic fixtureの合格は実論文の人手監査ではなく、表示認可0件と未監査475 edgeのblockを維持する。
  `automated-calibrated-v1`の出荷は実slice較正が実装されるまで拒否する。
- S0/S1は固定Sol profile、2 calls上限のadapter、canonical catalog/detail入力、共通service、生成CLI、
  provisional preview bundleを接続した。mock HTTPから本物のgenerator/rendererを通し、主担当がブラウザで
  CSS/JS、要旨のみ/未レビュー表示、slide移動、引用/戻るのhashとfocus、320pxを確認した。
  mock本文は内容品質の証拠ではない。実API、review record、本番registryへの登録・公開は未実施。
  独立レビューの5指摘（正規API応答、metadata/URL pin、全通信deadline、no-replace確定、cache-write課金）を
  修正し、対象4 test filesの再レビュー40 passed。対象範囲に残るP1/P2はない。
- 最終host補助regression: **2,601 passed / 1 skipped**（82.17秒）。skipはmacOS上で強制できない
  Linux専用`RLIMIT_AS` parityのみ。Node **36 test files**、repository-wide Ruff、変更/追加Python **25 files**の
  format、追加 **11 modules**のnarrow mypy（`--follow-imports=skip --no-site-packages`）、diff checkはpass。
  通常mypyは既存`paper_slides/contract.py` / `review.py`の54 errorsを報告しており、全体型検査の成功とはしない。
- asset version/`uv lock --check`、最終sdist/wheel build、Twine、wheelのcode/profile実byte一致・tests除外、
  isolated package targetからの生成CLI helpはpass。runtime依存は既存venvを使用し、fresh dependency installではない。
  今回の検証はDocker runtime/Linux syscallの実行証拠ではない。Linuxのno-replace経路はLinux CIで別途確認する。
- 今回差分のcommit/push、外部APIでの生成・収集、workflow dispatch、Secret設定、deployは実施していない。
  Solの一時的な利用上限エラー後は同じモデルで再開し、別model/Qwen/追加credit/resetは使用していない。
  既存の無関係なuntracked Word文書は変更・削除・stageしていない。

### 2026-09-05 publication review gate

- 基準コミット`cd8f28c`のhost補助regression: Python **2,472 passed / 1 skipped**。skipはmacOS上で強制できない
  Linux専用`RLIMIT_AS` isolation parityであり、Linux CIでは実行対象になる。Nodeはviewer / Workerの
  **35 test files**が全てpassした。
- Pagesのexact-SHA remote smokeは、成功時とSHA不一致時の双方で一時領域を回収する回帰テストを追加した。
- repository-wide Ruff lint、変更・新規Python **110 files**のformat check、`git diff --check`:
  pass。workflow YAMLと公開/Schema/data JSONのparse、変更shellの`bash -n`、frontend / Worker JSの
  `node --check`もpassした。
- `uv lock --check`、asset version、sitemap、Identity Lite、search v2、lineage qualityの決定的`--check`:
  pass。Identity / searchは **28,300 / 28,300**、sitemapは表示eligible 0件を反映した **12 URL**、
  lineage qualityは19 `ready/failed` + 8 `unavailable/unknown`で、表示認可は **0件**である。
- fresh sdist / wheel、Twine、hash固定runtime依存のclean venv install、wheel package / CLI / Replay help:
  pass。approved Docker image digestが未確定のため、Docker build/runtime gateは未実施である。
- セキュリティと公開境界の独立再レビューでは、今回差分に起因するpush blockerは0件。既存
  `POST /api/themes`のKV limiterが非原子的であるため、PAT付きGitHub runs APIを読むtheme statusは
  引き続き固定503とし、完了判定は公開manifest pollingだけに限定する。
- UI公開境界の独立再レビューでは、initial / no-JS / quality取得失敗で監査待ちだけを表示し、未適格
  artifactを取得せず、controls / gallery / exportを操作・accessibility treeから閉じることを確認した。
  320px Chromiumで横overflowなし。現物eligibleが0件のため、合格後の正方向はconference / deep / themeの
  synthetic ready+passed/hash一致actual-init契約で検証した。

### 2026-09-05 incremental focused gate

- 以下は各コマンドを実行した時点の記録であり、後続変更を含む現行treeのpass件数を表すものではない。
- repository-wide host auxiliary regression: **2,416 passed / 2 skipped**、Ruff: pass、`git diff --check`: pass。
  skipは任意のunArXive依存buildとmacOS上のLinux専用`RLIMIT_AS` parity
- workflow scaffold / provider execution / workflow YAML / release contractのPython focused tests: **84 passed**
- workflow / provider / generatorのsecurity cross-audit: **114 passed**、未解決High / Mediumなし
- workflow callback: **17 passed**、Durable coordinator: **33 passed**
- actual Durable serviceを使うrequest-plane local integration: **6 passed**。public reserveからdispatch、同時POSTのatomic dedup、
  claim応答喪失replay、provider fence、validating、awaiting_review、browser status / capability分離 / second claimant拒否までをfixtureで確認
- pytestのWorker suite inventory: **17 passed**
- SD4 review単体: **19 passed**、contract / renderer / public index込み **158 passed**。candidate/review/hash/path/timeの再結合、
  trusted context deep snapshot、immutable-checkout consistencyを確認し、公開誤許可につながる未解決High / Mediumなし
- Paper Slide host auxiliary regression: **831 passed / 1 skipped**。skipはmacOS上のLinux専用`RLIMIT_AS` parityであり、
  checked-in digestが未承認のためDocker runtime / production gateの証拠とはしない
- 対象workflow script/testのRuff: pass。外部dispatch、provider call、Secret設定、deployは未実施

### 2026-09-04 full gate

- Ruff: pass。変更範囲のformat checkもpass。repository全体のformat checkは既存123ファイルの未整形を検出するため未達
- final host regression: Python **2,299 passed / 2 skipped**、Node **27 suites**。
  skipは任意のunArXive依存build testとmacOS上のLinux専用resource-limit parity test
- Docker phase 1 static contract: **28 passed**。approved image pull/build/container runtimeは未実施
- agent profile contract: **3 passed**。実装roleの`gpt-5.6-sol / medium / full access`と全roleの`no ultra`を固定。
  2026-08-31T17:43:40Z（JST 2026-09-01）のQwen canaryはHTTP 429で、2026-09-04以降は使用しない
- workflow YAML 12件、shell 4件、公開 JSON 27件、asset version、`uv lock --check`、`git diff --check`: pass
- 通常mypyはsite-package NumPy stubのPython 3.12構文をPython 3.10 targetでparseできず停止。`--no-site-packages`では
  変更4ファイルに新規errorはなく、既存`paper_slides/contract.py`の52 errorsだけを報告
- Identity Lite: **28,300 / 28,300**、search v2: **28,300**、sitemap: 16 URL
- lineage quality: 19 `ready/failed` + 8 `unavailable/unknown`、**表示認可 0件**。未監査 artifact は全て fail closed
- fresh sdist / wheel、Twine、fresh venv install、`paperpilot --help`、Replay CLI help: pass
- Browserによるローカル目視smokeはICLR 2026のselected cardとno-JS一覧で実施した。desktopと320px幅で
  horizontal overflowがなく、選択状態とfail-closed slide statusを確認し、no-JS一覧は5,351 title linkを表示した。
  production APIは無効なため、実request dialogとlive statusの目視E2Eは未実施である

2026-09-05に`484e876`と`cd8f28c`をユーザー承認の下でdevelopへpushし、後者のTests・Pages validate/build/deploy/smokeと
公開URLのexact-SHA一致を確認した。検索・identityの静的成果物は公開済みである。
productionスライド生成、系譜の通常表示、request plane、学会の定期更新、Docker runtimeは未完了である。

### 次の並行キュー（初回ローカル実装の後）

次期案は[28-next-delivery-plan.md](28-next-delivery-plan.md)へまとめた。既存契約を変更する箇所は実装前に明示改訂し、
この台帳だけを根拠に品質gateを緩めない。

1. **最優先: L2 家系図の実例→L5。** 一論文reader/Focus Viewとlocal bundle組立は[30](30-lineage-pilot-viewer-delivery.md)
   の初回範囲、[31](31-private-review-and-conference-candidates.md)のpending資料作成CLI、
   [32](32-local-update-and-review-intake.md)のpure回答取込は実装した。
   [33](33-private-review-intake-cli.md)の原本/回答reader・全byte照合・安全な保存API・取込CLIも実装した。
   次は承認された実在canonical pilotのsource収集・原典照合を行い、実資料・回答を裁定へ接続する。
   二人の実人手reviewと資料の公開可否確認後だけindexを増やす。方向別の複数段展開、既存v1の全面移行、
   475 edge全体の監査と機械分類の較正は別段階とする。
2. **並行: Sのlive canary準備→S2/S3。** 29の固定一論文profileとAPI key、credential付きDocker operator/imageを確認する。
   価格profileの期限は2026-09-12 UTCなので、失効後は公式価格を再確認する。実生成・原典照合と人手review後に静的公開し、
   その後に一般依頼APIを有効化する。全文版はVT1〜VT4とimage/E2E後である。
3. **並行: C3残部/C4 学会更新candidateとdry-run。** 31でpure候補と既存catalog/identity/search/details互換を検証した。
   32で既存catalog/全文要旨のpure差分確認と未適用planも検証した。34の前年度baseline結合・pure ratio API・report Schemaは実装済み。
   次はtrusted state/来歴とratio gateの接続、初年度人手dry-run、staging/日付/共有投影とローカル実行CLIを進める。
   公式sourceのlive観測でregistryを確定し、C5のtrusted state/CAS/復旧/定期実行はその後に進める。
   家系図/スライド生成を更新の前提にしない。
4. **横断: 検索の次の改善とX実行環境。** 今回の限定評価を拡張し、要旨検索・日英用語展開・semantic searchの次の一つを選ぶ。
   Dockerの具体image/tool/platformと検証手順を準備し、実行一致を確認してからCIを移行する。
   型検査の既存エラーは対象範囲を明示して別単位で解消する（2026-09-07のtests込み全体checkは268 errors / 46 files）。

人手レビューをAIが承認済みに見せない。live実行のprovider/予算/image等は担当が具体的な確認資料を準備してから扱う。
既に与えられたユーザーの承認はその対象範囲で有効だが、今回の次期設計だけで新しい外部実行や公開を開始しない。

<details>
<summary>履歴・非運用・現行起動に使用禁止</summary>

現行手順は[AGENTS.md](../../AGENTS.md)と[Qwen実装・MAX評価入口](../QWEN_IMPLEMENTER.md)。

## 4. subagent への依頼テンプレート

```text
Repository: .
Read first: AGENTS.md, docs/design/11-target-architecture.md,
docs/design/12-implementation-plan.md, docs/design/13-agent-workboard.md
Task: <one bounded objective>
Ownership: <disjoint files/directories this agent may edit, or read-only>
Effort: native investigation/review medium or risk-based high; external implementation none; never ultra
Return: findings by severity, exact files/symbols, acceptance tests, residual risks
Never: dispatch/publish/push/merge, change secrets/settings, infer paper identity by title
```

並行実装では owner が変更対象の非重複を確認する。共有生成物、asset version、manifest、lockfile の更新は
一人に集約し、統合担当が他担当の差分とテストを独立検証する。


</details>

## 5. 完了の定義

- 機能の happy path だけでなく empty / invalid / stale / network failure / concurrency をテストしている。
- 公開 JSON は schema、参照整合、決定論的順序、サイズ、quality path / byte hash binding を満たす。
- UI は canonical ID / exact strong alias だけで復元し、監査不合格データを通常導線へ出さない。
- promotion は generation base 以降の同一 path 変更を上書きしない。
- exact promoted SHA 以外を release へ渡す経路がない。
- full ruff / pytest / Node / workflow / asset / package gate の結果と skip が記録されている。
- 外部 gate が残る場合は「ローカル実装・統合完了」と「本番確認済み」を分けて報告する。
