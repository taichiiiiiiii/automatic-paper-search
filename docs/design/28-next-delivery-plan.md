# 28. 次期開発計画 — 実際に使える検索・家系図・スライド

- **作成日:** 2026-09-05
- **状態:** 検索facet、L0/L1、一論文L3/L4とlocal bundle、L2a非公開資料・L2b回答取込pure API、S0/S1ローカル生成経路、C0〜C2/C3a候補・C3b/C4a限定dry-runをローカル実装。実source・通常表示・公開と区別し、検証結果は13へ記録
- **基準コミット:** `cd8f28c11c88b48c604bb936b5b0e500d9347b46`（develop / Pages 配信確認済み）
- **上位設計:** [11](11-target-architecture.md)、既存の実装契約は [12](12-implementation-plan.md) と [14〜27](README.md)
- **実行台帳:** [13-agent-workboard.md](13-agent-workboard.md)

既存基盤を使い、次は「利用者が一つの目的を最後まで達成できること」を出荷単位にする。
優先するのは、ユーザーが指摘した家系図の根拠と見やすさ。その横でスライドの一論文生成と学会更新を進める。
この計画だけで既存の品質判定、本文利用条件、本番APIを変更しない。契約を変える箇所は先に明記してレビューする。

初回変更では、家系図の契約をsynthetic fixtureで検証し、実論文の人手ラベルは作成していない。
続く[30](30-lineage-pilot-viewer-delivery.md)で一論文のv2 viewerとカード導線を接続したが、公開indexは空のままである。
スライドは[29の固定Sol profile](29-slide-sol-local-execution.md)とmock HTTPで生成・表示まで接続した。
学会のregistry/取得/安定判定はfixture検証までであり、live観測・schedule/applyは無効のままである。
さらに[31](31-private-review-and-conference-candidates.md)で未監査のA/B確認資料を作るCLIと、
安定snapshotのpure catalog候補を追加した。[32](32-local-update-and-review-intake.md)では回答取込pure APIと
catalog/全文要旨の差分確認・未適用planを実装した。実回答のprivate保存CLI・実source照合・前年度baseline・
actual staging/日付/共有projectionはまだ残る。
以下の表は以後の依存順も含む計画であり、全行の完了を意味しない。

## 1. 現在地と、維持する構成

| 機能 | 基準コミットで確認できる状態 | 利用者の目的に対して残るもの |
|---|---|---|
| 検索 | 10学会・28,300件、タイトル/著者/タグ、ページ送り、論文選択・全文要旨・原論文リンクを公開 | 固定クエリによる実用評価。要旨全文・日本語の概念検索は未提供 |
| 家系図 | identity・証拠hash・品質ゲートと既存viewerはある。通常表示の監査合格は0件 | 関係ごとの根拠、v2信頼判定、絞った表示、実例の監査と公開 |
| スライド | 構造化生成・検証・Web表示・レビュー・依頼APIの部品がある | 実provider、workflow接続、公開済みdeck、本文の可視文字検証 |
| 学会更新 | 手動収集とcandidate生成・競合拒否・Pages公開の部品がある | 新年度の公式公開検知、完全取得判定、安定確認、定期実行 |
| 実行環境 | Docker設定と事前検査は実装。現行CIはhost uvで動作 | 実image検証とDocker CI移行 |

Pages公開成功と全機能の本番稼働は別である。学会カタログの表示日付は全10件とも2026-06-28であり、
2026-09-05のサイト配信で論文データが新しくなったわけではない。

サイトは一つのままとし、入口は既存トップの検索とする。
`検索 → 論文を選択 → 概要を読む / 家系図を辿る / スライドを開く・依頼する` を同じ論文IDで接続する。
別のモード選択サイト、全面SPA化、リポジトリ分割、DBの全面置換は今回の範囲に含めない。

## 2. 公開する価値と順序

| レーン | 最初の成果 | 次の成果 | 完了を判断する実例 |
|---|---|---|---|
| L: 家系図（最優先） | 1起点の新しいper-paper系譜をFocus Viewで確認する | 監査済み対象を順次増やす | 検索から到達し、線を選ぶと根拠箇所へ移れる |
| S: スライド（並行） | 1論文の要旨版をローカル生成し内容を確認する | review後のサイト公開、公開依頼API、PDF本文・ページ引用付きの全文版 | 命令から生成、レビュー、公開、再閲覧まで段階的に一巡する |
| C: 学会更新（並行） | 1学会の公式一覧を完全取得し、更新候補を作る | 安定確認後の定期更新 | 同じ一覧は変更なし、公開後の変更だけを反映する |
| X: 実行・検証（横断） | Dockerで同じfixtureとテストを実行できる | 検証一致後にCIを順次移行 | Linuxと開発機で必要な検証・成果物hashが一致する |

表の順序は価値の優先順位であり、全レーンを直列に待たせるものではない。
学会更新は家系図・スライドの生成を待たず公開できる。全文スライドのOCRも要旨版の読み取りを待たせない。
人手確認を待つ間は、担当を他の実装・fixture検証へ回す。

## 3. L — 根拠が分かり、読み切れる家系図

### 利用者に見せるもの

- 初期表示は選択論文を中心に最大2-hop・15-node・18-claim。追加分は明示操作で展開する。
- 「引用した」という観測事実と「後継・拡張である」という判断を分ける。比較対象を祖先へ混ぜない。
- 各線の詳細に関係種別、短い理由、原典リンク、ページ/節などの位置、確認状態を出す。
- 根拠が足りない候補は断定せず、通常の家系図から外す。除外件数と理由を確認できるようにする。
- 狭い画面では関係一覧を既定にし、グラフと一覧で同じ関係集合を扱う。

### 実装単位

| ID | 対象・担当境界 | 依存と受入条件 |
|---|---|---|
| L0 | [18](18-lineage-trust-and-focus-view.md)の監査profile整理、pilot対象・評価fixture定義 | 実在するcanonical IDを固定。引用事実/系譜判断/不明を分離。人の正解ラベルをAIが代作しない |
| L1 | v2 Schema、Python validator、quality producer | `links/evidence/claims`、個別review・証拠hash、root、DAG、時系列を検証。v1を推測変換しない |
| L2 | evidence収集とdecision ledger、非公開review用出力 | 一つのpilotだけ生成。証拠のない旧rationaleを再利用して関係を承認しない |
| L3 | companion `docs/assets/lineage-v2-core.js`の純粋projectionとJS reader | 30の一論文範囲をローカル検証済み。既存v1 readerは変更しない。上限、追加展開、安定順序、除外集計をfixtureで検証 |
| L4 | 選択カードと新しい共通`lineage/?paper=`を接続 | 30の初回範囲をローカル検証済み。キーボード、戻る、URL復元、320px、空/失敗状態、graph/list一致。既存deep/conference/theme置換は後続 |
| L5 | pilot監査、quality/artifactの同時公開 | 原典を確認したreviewとpilot profileの全必須gate成立後のみ検索導線へ出す。較正は理由付きN/A。legacy artifactを一括で合格にしない |

L0では、既存18の「標本不足でもclaim-specific verifiedは許す」と「collection全体の較正gate」の境界を先に明文化する。
小規模pilotは、次の二つの明示的なrelease profileで区別する。

- `claim-verified-pilot-v1`: 全候補を独立した二人がmodel予測と互いの回答を見ずに確認し、全 edge を
  その二人とは異なる第三者が final review する。一致時は同じ4判断項目を確認し、不一致時は第三者が裁定する。
  通常表示する全claimは`accepted + verified`に限定し、machine-only / `corroborated`を含めない。
  exact-version relationも初回pilotでは同じ人手確認を要求する。agreementも既存18の基準で確認する。
  intake の `complete` だけでは自動認可せず、`focus_labels` は別の明示入力として要求する。一致時の二者回答と
  第三者 final review の一致をPython validator・ブラウザreaderの両方で検査する。この内部整合検査は本人性の認証ではない。
- `automated-calibrated-v1`: 既存18の標本数、Wilson下限、ECE/Brier、coverage等の条件を維持する。

初回v2 validatorはpilotのみの出荷判定を実装する。`automated-calibrated-v1`の実slice較正が未実装の間は、
任意の集計scalarを渡しても`ready/passed`を許可しない。

前者でもidentity・証拠・review・DAG・時系列・hashの検証を省かない。AI subagent二体の評価を人手二人分と数えない。
pilot profileの較正は`not_applicable`と理由を記録し、合格と偽装しない。UIには人手確認済みの試験公開と明示し、
「精度95%」などの保証を付けない。現行quality schemaへそのまま新状態を書き足さず、v2の閉じた契約で扱う。
このprofileをSchema/validator/quality readerまで整合させるまでは、既存18の出荷gateを維持する。

review前に候補の母集団、producer version、入力snapshot、選択順を凍結する。
`candidate_count = accepted + unknown + abstained + rejected` とledger coverage 100%を要求し、
通った候補だけを後から母集団として記録しない。
L4はcanonical `paper_id`でv2 quality row/manifestを一意に解決し、pilot対象・profile・宣言hashが一致した場合だけ導線を出す。
取得は認可されたmanifest内のpathに限定し、artifactとreviewの実byte/hashを照合してから描画する。
非pilot、v1、不明profile、欠損、不一致は閉じ、title/legacy fallbackで別の対象を表示しない。

pilot対象は既存catalogからcanonical identityと一次資料への到達性を確認して選ぶ。最初の目標は6〜12件の根拠付き関係であり、
目標数のために弱い関係を追加しない。review用資料を先に作り、人が確認する負担も検証する。
機械分類を広げる段階では18のfrozen評価、独立した人手ラベル、Wilson下限・較正・coverageを実装する。
旧artifact全体の移行監査と、新しい小規模pilotの公開を区別し、未監査の旧475 edgeを新profileで救済しない。

## 4. S — 一論文のスライドを最後まで作る

### S-A: 要旨版の縦断実装

最初は日本語・一論文・検証済み要旨からのWebスライドに固定する。
`paper_id → catalog/detail → 既存generator → 検証済みprovisional JSON → preview HTML` の薄い実行入口を一つ作り、
CLIとエージェントからの命令は同じ処理を呼ぶ。previewはローカル一時領域に置き、内容確認後に公開接続へ進む。
previewはfull-SHA CSS/JSを解決できる一時bundleまたはlocal serverで表示する。HTML一枚だけを渡して表示済みとはしない。
内容は背景、問い、方法の概要、主張、制約、原典を基本とし、
要旨にない実験値、比較結果、図を補わない。カード・確認画面・deckに「要旨のみ」を表示する。
これは本文版の代替完成宣言ではなく、生成・レビュー・公開の接続を確認する限定版である。

| ID | 対象・担当境界 | 依存と受入条件 |
|---|---|---|
| S0 | pilot論文ID、provider/model/価格snapshot/予算の実行profile | 開発担当のSol指定と、アプリが呼ぶAPIのモデル契約を区別する。per-jobの金額/token/call上限と、pilot全体の日次実行回数/総額を別に具体化 |
| S1a | `paper_slides/provider_execution.py`周辺の実adapter | 既存の予算ledger・contract・cache keyを使う。mockで成功/timeout/不正出力/予算超過。新規の永続cacheは作らない |
| S1b | 共通service/生成CLI/ローカルpreview | S1a後。既存catalogとdetailから入力を構成し、最初のlive canaryは1論文 |
| S2 | SD4のprovisional→reviewed bundleローカル接続 | 原典と各主張を照合できるreview一式を先に作る。review moduleへnetwork/repository I/Oを混ぜない |
| S3 | public index再構成、CAS promotion、exact-SHA release、trust root/選択カード/no-JS | 同じpaper IDでreview済みdeckを開き、原典へ戻れる。HTML/JSON/manifest hashの不一致は拒否 |
| S4 | dormant workflow、Worker coordinator、callback、runtime binding | S1a〜S3の一巡後に一般依頼を接続。重複依頼・応答喪失・再起動で二重生成/課金を起こさないfenceを検証 |

要旨版のpilotは既存の2段階生成に合わせ最大2 provider calls、自動retry/fallbackなしを実行profileに固定する。
全ての非title bullet/noteをabstract citationへ結び付け、page citationを捏造しない。
unknown ID、要旨不足、未承認/期限切れ価格、予算超過はprovider呼出前に停止する。
本番のretry方針はproviderのidempotency/課金仕様を確認して17と実コードを揃える。
ローカルCLIにWorkerの20-job/日quotaが自動で効くとはしない。S0でpilotの実行回数・費用記録と停止条件を決める。
review資料は同じdetail shardと要旨SHAから原典を照合できるようにし、raw abstract/prompt/responseを別artifactへ複製しない。

生成は自動、一般公開は当面人のレビュー後とする。
依頼者には「生成中」「確認待ち」「公開済み」「失敗」を区別して示す。
request-plane candidateの実効期限は24時間以下という[27](27-paper-slide-request-plane-production.md)の契約を維持し、
レビューが間に合わない場合は期限切れとして扱う。期限を延ばして公開を成立させない。
定常運用でレビューが滞る場合は受付件数を下げる。自動公開は品質の実測を得た後の別設計にする。

### S-B: 本文版

[22](22-slide-visible-text-verifier.md)のVT1〜VT4を進める。
PDFの描画結果をOCRし、ページ番号付きの本文を隔離workerから取得して既存generatorへ渡す。
Docker image、可視/不可視文字のfixture、resource limit、Linux CI/Docker Desktop E2E、原典ページとの人手照合を満たしてから
`full_text`を有効にする。本文が使えない場合は17のpolicyが許すエラーだけ要旨版へ明示降格する。
許可するstable error codeのcode-owned allowlistは本文接続前に固定する。
identity不一致、秘密検出、予算超過、不正出力などは別経路へfallbackせず失敗にする。
図表の再現、PPTX/PDF出力、任意PDF upload、会話しながらの編集は、本文版成立後の候補とする。

## 5. C — 1学会から始める自動更新

対象は[19](19-conference-release-watch-contract.md)のOpenReview系allowlistから1学会。
実際の年度、source ID、受付期間、基準件数は公式資料を確認してregistryへ固定する。
現在の`collect_openreview.py`は途中失敗時にpartial rowsを返すため、公開候補用に完全取得を要求するadapterを別に設ける。

| ID | 対象・成果物 | 受入条件 |
|---|---|---|
| C0 | `conference-sources-v1` registry/schema、bounded edition planner | 1 venue、初期apply=false。任意URL、未知adapter、範囲外年度、入力によるgate緩和を拒否 |
| C1 | strict OpenReview adapterと固定response fixture | 全pagination完了・全rowのvenueid/ID/title/authors確認後だけsnapshot。未知decisionを集計。部分取得、上限、重複/競合は公開候補にしない |
| C2 | fingerprint、observation、pure stability reducer | 異なるrunで時間を離した同一fingerprintを2回確認。v1は2回固定とする。縮小/ID消失は異常として保持 |
| C3 | catalog candidate、identity/search/details、source quality/run manifest | source件数と公開件数が一致、ID解決100%、fingerprintとreadiness観測時刻へhashで結合。再実行で同じbytes |
| C4 | read-only dry-run workflowと運用summary | fixture検証とlive観測を別に記録。何を何件更新するか、失敗理由、source日時を確認できる |
| C5 | state CAS、promotion、定期実行、release後の状態確定 | 各retryでbase→latestの対象path競合を再確認。shared projectionを最新tipで再生成。成功したexact SHAだけ公開 |

C1はcanonical landing/PDF URL、固定HTTPS host、redirect・暗黙proxy/netrc・private-addressの拒否と、
最大page/総byte/job deadlineをfixtureで確認する。同じfingerprintでは日付だけの再生成をしない。
sourceの`observed_at`、catalog内容が変わった日時、サイト配信日時を別に管理する。
一時エラーや未公開/変動中では既存catalogを保持する。catalog更新で家系図やスライド生成を必須にしない。
既存scaffoldとの互換で空lineage stubを置く場合も、qualityは`unavailable/unknown`のままとする。

C0で19の設定可能な`stable_probe_count`と本文の「2回」の不一致を解消する。
C5では「promotion済みSHA」と「Pages確認済みSHA」を分け、配信後のstate保存だけが失敗した場合に
同じfingerprintを再収集・再生成せず照合/復旧できる規則を加える。
promotion時に`promoted_sha`を保持し、Pages smokeとmarker一致後だけ`pages_confirmed_sha`とpublished fingerprintを確定する。
release/state保存の失敗は同じfingerprint・promoted SHA・markerを照合して再releaseまたはstate確定へ進め、矛盾時は停止する。
workflow実装と本番schedule/apply有効化を分け、まずapply=falseで検証する。live dry-runの確認と対象範囲の承認後に本番を有効化する。
既存promoterは各retryで対象path競合を再確認している。watch統合ではpush race後に同一path変更が入るfixtureを加え、
その場合に再生成要求で止まることを確認する。
APIの現行仕様、利用条件、更新間隔は実装前に一次資料で確認し、旧文書のAPI v1/料金の記述を根拠にしない。

## 6. 検索と実行環境の並行作業

### 検索の評価を先に固定する

- 既知タイトル、部分タイトル、著者、タグ、概念クエリ、見つからない入力を含む固定集合を作る。
- corpus/index SHA、query intent、期待canonical IDs、判定対象pool、曖昧ケースの扱いを固定する。
  queryごとのprecision@kは上位k内の適合ID数/実際に返したID数、recall@kは同適合ID数/既知の適合ID総数とする。
  結果0件・正解0件の扱いは評価仕様で分け、MRRも報告する。未判定poolを含む概念検索の値を全catalogの再現率とは呼ばない。
- 既知タイトルは期待IDがtop 1、既存の部分タイトル/著者/タグはtop 5を既存11の基準で確認する。
- 概念クエリと日本語入力は現行で解けると仮定せず、未対応・失敗例も評価結果に残す。
- 最初のUI改善は既存indexのfieldを使う学会・年・発表種別の絞り込みとする。新しいindex schemaは不要であり、
  URL共有・戻る・20件paging・0件状態、facet precision 100%、重複ID 0を確認する。
- recall、precision、重複率、source coverage、取得byte、端末条件付きlatency、API costを報告する。
- その結果から「要旨検索」「日英用語展開」「semantic search」の次の一つを選ぶ。評価前に検索基盤を総入替えしない。
- 家系図/スライドは全結果への常設ボタンを増やさず、選択論文の操作として統合する。

### X — DockerとCIの実稼働

1. [26](26-docker-first-execution.md)を基に、具体的なbase/engine/tool version、digest、platform、検証コマンドの組を準備する。
   checked-in placeholderは実imageではない。取得・buildの前に実行する対象を確定する。
2. `docker/paperpilot-compose`でPython/Node/previewを検証し、host CIとfixture出力・skip inventoryを比較する。
3. 一致したtargetからshadow CI、本番CIへ順に移す。PDF workerは独立境界のままとする。
4. `tests.yml`のpytest二重実行と任意依存skipを整理し、1回の実行結果と意図したskipの一覧で判定する。
   Actions実行環境の廃止予定警告は、採用versionを確認して固定値・wrapper・テストを同じ変更単位で更新する。
5. mypyの環境問題と既存errorを再現・分離し、変更モジュールから型検査を成立させる。型検査成功を未実施で申告しない。

既存theme APIのKV quota競合は独立した運用課題として残す。theme依頼の利用拡大やlive status復旧の前に、
原子的なquota/cacheを接続して検証する。Paper Slide用coordinatorが存在するだけでtheme APIも解決済みとはしない。

## 7. 最初に着手する3作業と担当

| 並行枠 | 最初の依頼 | その枠の次の依頼 |
|---|---|---|
| Backend / provenance | L0のpilot・review profile設計改訂 | L1 contract → L2とclaim監査用出力 |
| Backend / slides | S0の具体profile → S1a adapter → S1b一論文実行入口 | S2/S3の一件レビュー・公開接続、次にS4 |
| Backend / sources | C0の1学会registry → C1 strict detector | C2/C3の状態機械とcandidate |
| 主担当 | 契約統合、検索評価定義、Xの実image検証準備、独立レビュー | frontend担当へL3/L4またはS3を空いた枠で割当 |

上表は初回設計時の担当分割である。当時の実装担当はGPT-5.6 Sol / mediumを基本としたが、
2026-09-05の開発経路変更後の新規jobへこの旧モデル指定を適用しない。現行の実装経路・effortは
`AGENTS.md`と[13の運用契約](13-agent-workboard.md)を正本とし、Flash障害を理由にSolへ自動切替しない。
[32](32-local-update-and-review-intake.md)の2件は初回429停止後、2026-09-06にこの会話のユーザー直接指定
「qwenなしでSolで進めてください」を優先してSolで実装・ローカル統合した。永続のagent設定は変更していない。
調査・独立レビューは主担当を含め最大4枠、mediumまたはリスクに応じたhighとし、ultraは使わない。
共有`lineage-core.js`、`style.css`、生成manifest、asset versions、lockfile、workflowは
同時編集せず主担当が統合順を決める。各依頼は所有ファイル、入力fixture、受入条件、未検証項目を持つ。

## 8. 完了の報告方法

各機能は「契約」「ローカル実装」「実sourceによるE2E」「本番公開」の四つを分けて報告する。
テスト件数や部品数だけで機能完了とはしない。次の実例を提示できることを出荷の根拠にする。

- 家系図: 実論文の検索URL、監査済みの関係、開ける原典根拠、狭い画面で読める表示。
- スライド: 実論文IDとcoverage、review済みdeck URL、引用箇所、失敗/期限切れ/重複依頼時の結果。
- 学会更新: source fingerprint、2回の観測、更新差分、no-op結果、公開済みSHA、異常時に保持したcatalog。
- 実行環境: 使用imageのdigest/platform、実行した検証、skip理由、同一fixtureの出力比較。

live実行に必要なprovider/予算/image/人手レビューなどは、担当が具体案・確認資料を準備した時点で扱う。
実装の進行と外部実行の結果は13へ記録し、この設計書だけで未実施の設定変更・生成・公開を完了扱いにしない。
