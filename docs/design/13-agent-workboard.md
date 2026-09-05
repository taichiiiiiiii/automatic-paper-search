# 13. Agent Workboard — Unified Paper Discovery

- **更新日:** 2026-09-05
- **目的:** subagentが同じ境界と完了条件で作業するための短い実行台帳
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

この文書は設計を上書きしない。タスクの現在地、担当境界、検証結果だけを更新する。

## 1. Agent 運用契約

1. 担当者ごとに変更対象を先に宣言し、**所有ファイルが重ならない作業は共有 checkout でも並行してよい**。
   同じファイル、共有生成物、asset version、manifest、lockfile を触る作業は同時実行せず、owner が順序を決める。
2. 既定エフォートは **medium** とする。identity / provenance、schema migration、promotion の競合・安全性、
   セキュリティ監査など難度とリスクが高いタスクだけ **high** を選ぶ。**ultra は使わない**。
3. 2026-09-04のユーザー指示により、実装・監査は **GPT-5.6 Sol** を使う。routineなbounded taskは
   **medium**、security / provenance / schema / migration / publication-riskは **high** とし、ownerが差分、
   契約、テスト結果を独立に確認する。Qwenや別のthird-party providerへ自動fallbackしない。
4. 外部副作用は禁止する。workflow dispatch、Pages / Worker / PyPI 公開、通知、secret・branch protection・
   Cloudflare 設定変更、`develop` への push / merge はユーザーの明示承認後だけ行う。
5. title-only join、未監査 lineage の通常導線、candidate の許可 path 外コピー、secret の永続化を禁止する。
6. 完了報告には変更ファイル、実行した検証、skip、未解決リスクを含める。

## 2. 現在地

| 単位 | 状態 | ローカルで成立している内容 | 次の gate |
|---|---|---|---|
| S1 exact-SHA release | ローカル統合済み | reusable release、rollback、bot workflow の generate→promote→release、生成元 SHA 競合拒否 | Cloudflare / GitHub 外部 gate |
| D1 identity/search/quality | ローカル統合済み | source ID、28,300件 projection、search v2、detail shard、quality manifest | 承認済み入力での生成再現性確認 |
| P1 unified search/card | 検索・詳細・公開スライド読取・生成依頼consumerはローカル統合済み | 横断検索、paging/history、`?paper=`、選択時全文要旨、quality gate、review済みdeckのhash/identity検証、確認dialog、capability付きpolling、no-JS原論文リンク | live request/status Worker、no-JS公開deck link、監査済みlineage action |
| P2 lineage / theme | v1 基盤はローカル統合済み、通常表示は blocked | conference/deep/theme producer、共有 Python/Schema/JS contract、strong alias、cache/provenance v2、strict quality + byte hash gate | v2 trust contract、claim 監査、Focus View、実 artifact 再生成 |
| P3 paper slides | SD0〜SD4 review projection・VT0・selected-card・request planeの永続adapter seam・no-JS原論文リンクをローカル実装済み | closed contract、trusted PDF境界、content-addressed bundle、approved catalog、Durable coordinator、claimant lease/fence、dispatch/callback、休眠runtime/workflow、provider予算境界、reviewed artifact境界、capability付きconsumer | VT1〜VT4 + image承認/E2E、binding/live provider、no-JS公開deck link、SD4 workflow/promotion/publish |
| P4 conference release watch | 設計確定・実装前 | allowlist、公開検知、安定性 probe、candidate / promotion 契約 | read-only dry-run detector と fixture から開始 |
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

### 2026-09-05 publication review gate

- 現行treeのhost補助regression: Python **2,471 passed / 1 skipped**。skipはmacOS上で強制できない
  Linux専用`RLIMIT_AS` isolation parityであり、Linux CIでは実行対象になる。Nodeはviewer / Workerの
  **35 test files**が全てpassした。
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

既存の検索・identity・release・Replay Liteと、`検索 -> 選択論文 -> review済み公開スライド`のread-only導線は
ローカル統合済みである。一方、production生成、系譜の通常表示、request planeは未完了であり、次のキューを残す。

1. **P0: Slide workflow / activation。** approved catalog、Durable coordinator、dispatch曖昧性、claim lease/fence callback、
   runtime seam、provider予算境界、dormant workflow足場まで完了した。次は実provider adapter/価格表/registryを承認し、既存fenceの
   成功後にだけprovider stepとcandidate/status、実装済みoffline review境界をworkflowへ接続する。その後にnamespace/binding/Secrets/catalog pinの外部gateとbundle E2Eを通し、
   review済みbundle成立後にproduction APIとno-JS公開deck linkを有効化する。offline reviewの14日hard capとは別に、
   on-demand promotionはcoordinatorのcandidate TTL（既定・最大24時間）内だけ許可し、期限後は再生成する。
2. **P0: Lineage v2 trust。** `links / evidence / claims` schema、validator、fixture / calibration gateを先行し、
   監査済み claim だけを 2-hop / 15-node Focus View へ渡す。
3. **P1: Visible text VT1〜VT4。** raster/OCR core、隔離worker、production binding、digest承認imageを実装し、
   Linux / Docker Desktop E2Eとhuman citation review後だけproduction full-textを有効化する。
4. **P1: Conference release watch。** 外部状態を変更しない read-only detector / registry / fixtureを先行し、
   自動 dispatch は dry-run の観測結果と明示承認後に有効化する。

外部 API / LLM を使う実 artifact 再生成、matching human fixture 承認、workflow dispatch、
publish / deploy / push / merge は別 gate であり、ユーザーの明示承認なしには実行しない。

## 4. subagent への依頼テンプレート

```text
Repository: .
Read first: AGENTS.md, docs/design/11-target-architecture.md,
docs/design/12-implementation-plan.md, docs/design/13-agent-workboard.md
Task: <one bounded objective>
Ownership: <disjoint files/directories this agent may edit, or read-only>
Effort: medium by default; high only for task-dependent risk; never ultra
Return: findings by severity, exact files/symbols, acceptance tests, residual risks
Never: dispatch/publish/push/merge, change secrets/settings, infer paper identity by title
```

並行実装では owner が変更対象の非重複を確認する。共有生成物、asset version、manifest、lockfile の更新は
一人に集約し、統合担当が他担当の差分とテストを独立検証する。

## 5. 完了の定義

- 機能の happy path だけでなく empty / invalid / stale / network failure / concurrency をテストしている。
- 公開 JSON は schema、参照整合、決定論的順序、サイズ、quality path / byte hash binding を満たす。
- UI は canonical ID / exact strong alias だけで復元し、監査不合格データを通常導線へ出さない。
- promotion は generation base 以降の同一 path 変更を上書きしない。
- exact promoted SHA 以外を release へ渡す経路がない。
- full ruff / pytest / Node / workflow / asset / package gate の結果と skip が記録されている。
- 外部 gate が残る場合は「ローカル実装・統合完了」と「本番確認済み」を分けて報告する。
