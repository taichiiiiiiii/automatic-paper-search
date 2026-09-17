# 31. 非公開の家系図レビュー準備と学会更新候補

- 状態: L2a private資料作成CLIとC3a pure候補をローカル実装・検証済み。2,754 passed / 1 skipped。詳細は13の実行台帳
- 作成日: 2026-09-05
- 上位契約: [18](18-lineage-trust-and-focus-view.md)、[19](19-conference-release-watch-contract.md)、[28](28-next-delivery-plan.md)
- 対象外: 人手回答の代作、公開認可、live収集、LLM課金、Docker image取得、workflow dispatch、commit/push/deploy

## 1. L2a: 人が確認できる資料を作る

完成済みの監査fixtureを入力に要求する既存pilot bundleとは別に、未監査のv2候補と原典snapshotから
二人分の独立した確認資料を作る。入力artifact・実catalog・候補母集団・各sourceの実byteを固定し、
hash、identity、引用方向、候補全件の対応を検証する。候補母集団は閉じた
`lineage-candidate-universe-v1`入力を用い、候補ID・端点・evidence参照とartifact ledgerの全件対応を要求する。
検証失敗時に一部候補だけを採用しない。

初回APIはローカルbyteのみを受け、収集はしない。原典snapshotとのhash一致は出典の真実性や
本文の視認性を証明しない。PDF extraction/OCRや原典照合、関係の判断は別の作業である。
既に人手確認したように見えるclaim、review binding、verified/corroborated入力は拒否する。
machine-onlyのaccepted/unknown/abstained/rejectedは候補として保持するが、すべてtentativeであることを要求する。

確認者A/Bに渡す資料には論文identity、原典リンク、根拠位置、抜粋、引用した側/された側を含める。
機械のrelation/family/decision/score/rationale、他の確認者の回答を渡さない。候補の内部IDは
opaqueなreview IDへ対応付け、母集団の詳細や機械の予測はcoordinator専用ledgerに隔離する。
回答欄・確認者名・日時・独立性の自己申告はすべて未入力とし、二人が確認済みとは記録しない。

出力はpending専用のimmutable bytesとする。v2監査fixture、quality、公開indexは生成しない。
確認資料の配布・人手回答の取込・不一致の裁定・public redaction/promotionは後続段階である。
保存経路を追加する場合は新規の非公開ローカル出力先だけとし、既存ファイルやdocs/dataを上書きしない。

受入条件: 同じ入力で同じbyte、入力不変、全候補の保持、A/Bの同じ資料、機械予測の漏れなし、
回答null、source/candidate/artifact/catalogのhash結合、不正JSON/重複/欠損/サイズ超過/先行reviewの拒否。

## 2. C3a: 安定確認済み一覧から更新候補を作る

OpenReviewの正規化済みsnapshotを再検証し、既存catalogの入力形式へ決定論的に投影する。
二回の安定観測・source fingerprint・edition/source/件数/ID集合の結合を要求する。
callerが指定したreadyやpaper IDを無条件に信用せず、identityとfingerprintを再計算する。
重複ID、source URL不一致、公開済みIDの消失・件数縮小は候補全体を拒否する。
未知decisionは19と既存adapterに従い件数を報告し、highlightへ推測変換しない。
この段階の型付きreadiness入力は認証済みの永続stateを証明しない。C5の取得・CAS・公開認可は別途必要である。

候補にはsource観測時刻、件数、identity解決数、重複title件数、各生成byteのhashを結ぶ。
機械分類の家系図やスライド生成をcatalog候補の前提にしない。
返すのはimmutableなローカル候補であり、state変更・共有search/details再生成・既存catalog上書き・
既存promotion manifestへの自動接続・定期実行はしない。この単位をC3/C4全体完了と説明しない。

受入条件: 順序不変、metadata変更の検知、canonical ID/URL/decision、全件の投影、hash一致、
不十分/失敗/古い観測、source再取得時の変化、縮小・重複の拒否、network/filesystem副作用なし。

## 3. 担当と検証

- L2担当: 新しいreview preparation module、対応schemaと直接テスト。
- C3担当: 新しいconference candidate moduleと直接テスト。
- 主担当: 非重複境界の維持、独立diff review、必要なCLI/出力接続、統合テストと文書。
- 独立レビュー: provenance、blind projection、pending/public分離と候補のgateを重点確認する。

この会話のユーザーによる「QwenなしでSol」の指定を優先する。現在の別設定作業のAGENTS/runner変更は
保存し、この実装のために書き換えない。短いhost補助checkをDocker runtime成功とは扱わない。
実装中に別設定タスクから、以後の新規実装はFlash・既存Sol作業は完了まで維持する指示を受けた。
この単位は既存担当のまま完了させ、新しい実装jobや設定変更を追加していない。

## 4. ローカルの確認資料作成

`python -m paperpilot.scripts.prepare_lineage_review --help`で引数を確認できる。
Dockerは26の承認済みimage/runtime gate成立後に用い、このCLIのhost補助検証だけで移行完了とはしない。

| 引数 | 入力 |
|---|---|
| `--artifact` | 未監査のdeep v2 artifact。canonical UTF-8 JSON + LF |
| `--catalog` | focusを含む実catalog。通常の整形済みJSONも受け、入力byteのhashを保持 |
| `--candidates` | `lineage-candidate-universe-v1`。artifactと全候補が一致するcanonical JSON |
| `--source-snapshot` | `source-snapshot:<ref>=<local path>`。複数指定可。根拠のないunknown/abstainedだけの場合は省略可 |
| `--conference`, `--paper-id` | 学会slugとcanonical paper ID。catalogのnative identity・focus aliasと照合 |
| `--fixture-id`, `--created-at` | 資料IDとtimezone付き作成時刻。artifact生成以前の日時は拒否 |
| `--output` | Git外の新規絶対path。親は既存で、現在ユーザー所有の0700ディレクトリ |

入力はregular fileだけとし、symlink、特殊file、読み取り中の変更、上限超過を拒否する。
ファイルを扱うCLIはLinux/macOS専用で、必要なno-follow機能のない環境は入出力前に明示的に拒否する。
この制限を弱めてWindowsで直接実行せず、Dockerの承認済み実行環境を用いる。pure byte APIは別境界である。
出力フォルダーは0700、各JSONは0600とし、既存出力を置換しない。
終了時に表示するのはpending、件数、hashだけで、引用・回答・原典byteや秘密情報をlogへ出さない。

出力は次の3ファイルであり、公開用artifact/fixture/quality/indexではない。

- `coordinator.json`: 管理担当者専用。入力hash、全候補、機械の判断、A/B資料のhashを保持する。
- `reviewer-a.json`: 確認者Aだけへ渡す資料。根拠と空欄の回答templateを含む。
- `reviewer-b.json`: 確認者Bだけへ渡す同じ根拠資料。Aの回答は含めない。

coordinatorや元artifact、もう一人の回答を確認者へ配布するとblind条件を満たせない。
AIによる資料検査を、人間が原典を確認した記録へ置き換えてはならない。
抜粋と原典byteの紐付けはhash固定だけであり、source identity・抜粋の実在・PDFの可視文字を証明しない。
確認者はURL/論文IDで原典を開き、引用方向と根拠位置を確認してから関係を判断する。
「引用している」と「後継・拡張である」は別の問いとし、不足時は断定しない。

配布した原本はhash確認用に保持する。回答を記録する際は別のコピーで管理し、入力待ち専用の
`lineage-blind-review-pack-v1` Schemaに回答済み資料を合格させようとしない。
回答の取込、独立性の実確認、第三者裁定、v2監査fixtureへの変換はまだ実装対象外である。
人手確認後も、公開可能な資料の確認とL5の品質・公開gateを別に通す。

## 5. 学会更新候補の受渡し

`paperpilot.conference_watch.candidate.build_catalog_candidate(edition, readiness, snapshot)`は、
型付き候補行・全文要旨・既存reader向けsummary CSV・source check report・hash bindingを返す。
source観測日を固定し、再実行した日の壁時計でcatalogの日付を変えない。
同名論文はnative IDで区別し、title照合で発表区分やidentityを移し替えない。
未知decisionの件数は残し、highlightとは表示しない。
旧CSV readerは著者の`,`/`;`を分割するため、これらを含む著者名は候補全体を拒否して誤った著者配列を作らない。
lossless JSON stagingの接続までは、このCSV互換上の制限が残る。

`source_quality.status=local_checks_passed`はこのローカル候補の検査結果だけを意味する。
run bindingの`trusted_persistent_state_proof`、`promotion_authorized`、`publication_authorized`はfalseである。
既存のpromoterへ渡せる公開許可manifestではない。C4のstaging/差分確認、C5のtrusted state/CASと
live観測・定期実行は引き続き別の未完了作業である。
前年度件数の入力がまだないため、`minimum_absolute`だけを合格とし、`previous_edition_ratio`と
`first_edition_human_dry_run`は`not_checked`のままにする。これらを省いた本番公開は認可しない。
