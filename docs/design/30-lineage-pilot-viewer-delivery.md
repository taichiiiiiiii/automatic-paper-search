# 30. 一論文の家系図 — v2 reader と Focus View の初回接続

- **状態:** L3/L4の一論文初回範囲と検証済み入力のローカルbundle組立を実装・ローカル検証済み。2,649 passed / 1 skipped、39 Node test files、実ブラウザ確認。詳細は13に記録
- **基準:** 2026-09-05のローカル2,601 passed / 1 skipped。未commit差分を保持する
- **上位契約:** [18](18-lineage-trust-and-focus-view.md)、[28](28-next-delivery-plan.md)
- **公開境界:** 実論文の人手監査、live収集、定期実行、push/deployは含めない

## 1. 今回の成果

既存サイト内の`lineage/?paper=<canonical ID>`をv2一論文viewerの共通入口にする。
検索→既存学会カタログの選択カード→監査済みの家系図という一つの導線を作る。
既存のconference/theme/deep v1 URLやreaderを置換・推測変換せず、v2は別moduleで閉じて検証する。
合格したpilotがない間はindexを空に保ち、選択カードに利用可能な家系図リンクを出さない。
手動でviewer URLを開いても、該当する合格データがなければ操作部やグラフを表示しない。
bare routeはpaper指定が必須のため`noindex`とし、filesystemだけを根拠にsitemapへ加えない。
合格pilotのcanonical URL発見・公開は後続の専用gateとする。

Focus Viewは7 nodes / 18 claims / 1-hopの既定（2026-09-08 UI改善）、graph/list共通の選択集合、少数ずつの展開・解除、
根拠dialog、件数・除外理由、URL復元を持つ。720px以下ではlistを既定にする。
表示方式・hop以外の条件は「詳細な絞り込み」に畳み、一覧モードでは関係一覧を論文カード群より先に置く。
最初の展開操作はnode単位で最大2本の追加枝とし、祖先/後継の隠れた件数を示す。
方向別・同一nodeの複数段階展開の詳細は後続で扱い、今回の操作を無制限展開と説明しない。

## 2. Index と immutable JSON

固定URL`lineage-pilot-index-v1.json`に閉じたindexを置く。初期値はentries空のmanifestである。

```text
schema_version: lineage-pilot-index-v1
entries[]:
  paper_id: 40 lowercase hex
  conference: canonical slug
  collection_id: deep:<conference>:paper:<paper_id>
  release_id: nonempty string
  release_profile: claim-verified-pilot-v1
  artifact: {path, sha256}
  fixture: {path, sha256}
  quality: {path, sha256}
```

各pathはサイトrootからの相対pathに固定する。
`lineage-pilots/<conference>/<paper_id>/artifacts/<sha256>.json`、
同じprefixの`fixtures/<sha256>.json`、`quality/<sha256>.json`以外を認めない。
query/hash/percent escape/空segment/parent traversal/外部URLは拒否する。
同じpaper IDの重複はindex全体を拒否し、first-matchやtitle fallbackを使わない。
index上限は100 entries / 256 KiB。各artifact/fixtureは8 MiB、qualityは256 KiB、catalogは8 MiB、
一読込は最大5 fetch / 30秒、リダイレクトとhash不一致は失敗、自動retryなしとする。

選択カードはindexの該当entryから固定viewer URLだけを作り、全artifactを先読みしない。
viewerは該当する学会の実catalogからpaper IDを確認し、3 JSONの実byte SHAをindexと照合してから
v2の閉じた構造・identity・証拠・quality・人手fixtureの対応を検証する。
qualityには一つのdeep rowだけを許し、path・release・profile・件数・artifact/fixture hashがentryと一致することを要求する。
各JSONを組み立てるbackendはReplayのcanonical UTF-8 JSON + LFを使う。browserはartifact全体を再serializeして
実byte hashを置き換えない。証拠集合hashはID順のcanonical recordを使い、公開用byteの整合をfixtureで比較する。

## 3. 並行担当とmodule境界

- Core担当: `docs/assets/lineage-v2-core.js`、新しいNode契約/大規模projectionテスト、Python wrapper。
  既存`lineage-core.js`はv1のまま保つ。
- UI担当: `docs/lineage/index.html`、`docs/assets/lineage-focus.js` / `lineage-focus.css`、選択カードの最小接続とテスト。
  catalog HTMLの新module参照もこの担当が追加し、asset versionは主担当が最後に同期する。
- Backend担当: `paperpilot/lineage_pilot/`、index schema、ローカルbundle APIと対応テスト（CLIは今回追加しない）。
  indexの初期空JSONと、検証済み入力からimmutable JSONを組み立てる処理を持つ。
- 主担当: 契約統合、差分レビュー、asset version、文書、全体検証、実ブラウザでの確認。

Coreは次のpublic APIを持ち、戻り値/追加fieldの詳細は実装開始時に担当間で固定する。

```text
PaperPilotLineageV2.parsePilotIndex(value) -> validated index | null
resolvePilotEntry(index, paperId) -> entry | null
verifyPilotRelease({entry, artifactBytes, fixtureBytes, qualityBytes, catalogPaperIds})
  -> Promise<verified release | null>
resolveFocus(release, requestedFocus = null) -> node | null
readState(release, {params, prefs, mobile}) -> normalized state
writeState(url, state) -> URL
selectFocusProjection(release, state) -> projection
```

verified releaseは検証関数だけが作るdeep-frozenなcontextとし、raw objectに`verified=true`を付けて渡しても
projectionを開始できない。`entry` / `artifact` / `fixture` / `fixtureCollection` / `quality` / `qualityRow`を保持し、
`row`は`qualityRow`と同じ参照の互換aliasとする。projectionは元node/claim/evidenceを改変しない。
Python v2 validatorと同じfail-closed条件を共有fixtureで比較し、browserだけで合格条件を緩めない。
`automated-calibrated-v1`は未実装の較正を飛ばして表示する経路にしない。
検証開始時に3入力byteを同期コピーし、SharedArrayBufferを拒否する。parseとhashで別の内容を使わせない。
閉じたJSON readerは重複keyとinteger fieldのfloat表記を拒否し、日時比較はmicrosecond精度を維持する。

URLは`focus` / `view` / `hops` / `limit` / `min_conf` / `trust` / `families` / `relations` /
`evidence_sources` / `evidence_kinds` / `expanded`を正規化して保持する。値のCSVではcomma/backslashをescapeし、
`relations=`は全関係へのfallbackではなく明示的な0選択である。旧`evidence`は`source:` / `kind:`付きの
正確な値だけを受理し、不明条件を無視して検索範囲を広げない。

projectionは`focus` / `nodes` / `claims` / `genealogyClaims` / `comparisonClaims` / `hiddenBranches` /
`counts` / `exclusions` / `expandedNodeIds` / `forceList` / `statusCodes`を返す。
countsは総node・raw link・全claim・accepted全件/家系/比較・eligible・表示node/claimを分離する。
`hiddenBranches`はnodeごとのparent/child残数を持つ。除外はdecision、trust、family、relation、confidence、
evidence、hop、branch、node/claim cap、collapseの優先順で一意に集計する。
明示展開でgraphの50/80を超える場合は`forceList`を立て、20件pagingで要求した集合を確認できるようにする。
既定の未展開表示は7/18に制限し、大きい集合を無制限のSVGへ描画しない。

## 4. レビュー情報と非公開データ

今回のbundle組立はローカルの新規出力先だけを対象とし、`docs/`を自動更新・公開するCLIにはしない。
元の人手fixtureを勝手に編集/匿名化して再承認したことにしない。
レビュー資料の公開可否とredacted public projectionは別gateとして残す。
動作確認に使うreviewer名・引用・論文は明示的なsynthetic fixtureだけであり、実論文の人手監査を捏造しない。
本番indexを空から増やす前に、実sourceとの照合・二人の人手review・公開してよい資料の確認・出荷承認が必要である。

## 5. 受入条件

1. missing/invalid/duplicate index、未登録ID、不正path、非合格qualityでは非公開表示を維持する。
2. artifact/fixture/quality/catalogの不一致、UTF-8/JSON/size/timeout失敗で途中データを描画しない。
3. 1-hopと7/18上限、spine優先、決定順、除外集計、200 nodes / 1,000 claimsを固定テストする。
4. unknown/abstained/rejected、citation-onlyを家系図の線にしない。comparisonとtentativeは別扱い。
5. graph/list一致、URLとBack、20件paging、50/80描画安全上限、dialogのkeyboard/Escape/focus復帰を確認する。
6. 320/375/720/768/1024/1440pxで意図しない横overflowなし、44px以上の操作、reduced motionを確認する。
7. 原典リンク以外の通信はsame-originの固定pathのみ。外部研究データ・LLMへのlive call、push/deployは0。

これらはL3/L4のローカル実装条件であり、L2の実source収集やL5の実論文公開の完了条件を代替しない。

## 6. ローカルAPIと検証用資料

`paperpilot.lineage_pilot.build_pilot_bundle`はartifact・fixture・quality・catalog・conference・paper_idを受ける。
入力をcanonical byteからprivate snapshotへ固定し、v2検証を通した上でqualityのartifact pathだけをcontent-addressed pathへ
付け替えて再検証する。人手の判断やnotesは変更しない。戻り値はimmutableな3ファイルとtyped index entryである。
`build_pilot_index`は最大100 entryをID順に組み立て、`write_local_pilot_bundle`はfreshなローカル出力先だけに保存する。
writerはproducerが作ったbundle identityを要求し、symlink・canonical docs/data・既存出力・競合時の上書きを拒否する。
CLI、自動収集、公開promotionは追加していない。

共有のpositive fixtureは`paperpilot/tests/fixtures/lineage-pilot/positive-release/`に置く。
`test_lineage_v2_core.mjs --emit <fresh QA directory>`は200 nodes / 1,000 claimsの明示的なsynthetic資料を出力できる。
いずれも本番`docs/`にコピーせず、通常indexは空を保つ。検証用データを実論文の根拠や精度評価と説明しない。
