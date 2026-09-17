# 32. 学会更新の差分確認と家系図回答の取込

- 作成日: 2026-09-05
- 状態: 2026-09-06に限定2機能をローカル実装・統合・独立レビュー済み。回答保存CLIは後続の[33](33-private-review-intake-cli.md)で採用。実source、人手監査、staging、公開は未完了。
- 前提: [31](31-private-review-and-conference-candidates.md) の C3a と L2a。
- 今回の実行担当: この会話のユーザー直接指定「qwenなしでSolで進めてください」を優先し、限定2機能はSolが実装・独立レビューする。AGENTS.md・共用Flash・モデル設定自体は変更しない。
- 禁止: 人手回答の代作、実 API/LLM 呼出、秘密情報の読取、Docker image の選択/取得、定期実行の有効化、公開、push。

## 1. 学会更新 C3b/C4a の限定単位

新規 pure module `paperpilot/conference_watch/dry_run.py` と直接テストを追加する。
入口は型付き edition/readiness/snapshot と既存 catalog の実 byte とし、内部で C3a の
`build_catalog_candidate` を再実行する。呼出側から候補や ready フラグを無検証では受け取らない。

既存 catalog の strict JSON、件数・サイズ上限、native ID/URL/paper ID の一致、重複 ID を検証し、
入力 byte の hash を固定する。既存 edition 専用であり、空 catalog による新学会作成は受けない。
候補を既存 papers.json 形式へ投影し、title ではなく paper ID で
追加・削除・変更・不変を比較する。削除を含む計画は blocked として残し、公開を許可しない。
比較結果のログ用レポートは ID・件数・変更フィールドだけとし、タイトル・要旨・著者を含めない。

全文要旨の比較をプレビューの比較と区別する。既存の全文データは対象 edition と
`papers:[[paper_id,full_abstract],...]` を持つ閉じた `conference-current-details-v1` envelope で渡す。
catalog と ID 集合が完全一致し、各要旨から作る preview が catalog と一致することを検査する。
これは公開 detail shard や永続 state の真正性を証明する入力ではない。
既存の全文データを供給しない場合は未検査と記録し、
プレビュー一致だけから全体の no-change を断定しない。既存 stage-2 metric を source の欠損値で
黙って落とすことも変更として記録する。

結果は削除ありなら `blocked`、catalog byte または全文要旨の差分があれば `changes_detected`、
差分がなく全文未確認なら `indeterminate`、両方を確認して完全一致なら `no_change` とする。
順序・整形だけの変更は byte 差分として区別し、論文 metadata の変更件数には含めない。
元 byte の hash を保持するため、入力の整形が変わればレポート全体の byte も変わる。
staging の候補 path を示すのは `changes_detected` の場合だけとする。

dry-run は catalog 16 MiB / 25,000 件、title 2,048 文字、author 512 文字の限定 profile とする。
C3 の上限より小さいため、既存入力だけでなく新候補にも同じ制約を適用し、次回読めない候補を返さない。
現行 paper-links renderer の 6,000 件 / 3 MiB 制約も公開接続時の未解決事項である。

戻り値は immutable な report と未適用 staging plan、および候補 byte である。
前年度件数の比率、初年度人手確認、信頼できる永続状態、latest tip の競合確認、scaffold、
カタログ日付・共有検索/詳細の再生成、promotion はこの段階で未接続と明示する。
既存 summary CSV を保存するだけでは source 観測日を conferences.generated へ反映できないため、
架空の dated CSV を作って解決したことにしない。

受入: 決定論、順序不変、入力不変、同名別 ID、追加/削除/field 変更、全文末尾の変更、
全文未提供、壊れた JSON/重複 key/ID 不一致/サイズ超過、全公開 gate false、既存データ無書込。

## 2. 家系図 L2b の限定単位

新規 pure module `paperpilot/lineage_pilot/review_intake.py` と直接テストを追加する。
L2a factory が同じ process 内で作った `PrivateReviewBundle` を検証してから、
その配布原本と実際に返された回答コピーを hash・slot・全候補 ID で照合し、
未回答・回答済み・二者不一致を coordinator 向けに整理する。

API は `ingest_blind_review_answers(bundle, *, answered_reviewer_a_bytes,
answered_reviewer_b_bytes, incorporated_at)` とする。直接構築・復元した bundle は拒否する。
回答欄だけを全 null に戻した canonical byte が配布原本と完全一致することを要求する。
回答コピーの空白や key 順序は許すが、回答以外の値・型・候補順序・件数の変更は拒否する。
各回答は strict UTF-8 JSON、16 MiB、深度64まで。UTF-16、duplicate key、NaN は拒否する。
回答欄は9キーの全 null または型付き完了の二択で、relation/family は両方 null を許す。
片側でも未回答があれば全体は `pending` とし、既に判明した二者不一致も別に保持する。
両側が全候補を回答し判断4項目が一致したときだけ intake の `complete` とする。

配布時の機械判断非開示、二人の別回答、回答時刻、独立性の自己申告を検査するが、
JSON や名前だけで実在の人や本人性・実際の独立性を証明したことにしない。
null を既定の肯定へ変えず、回答欠損・unknown を保持し、関係の不一致を自動裁定しない。
完成済みの v2 audit fixture/quality/public index は作らない。

現行 v2 fixture validator/schema に合わせ、全 edge に reviewer A/B と異なる第三者の final review を要求する。
A/B 一致時は同じ4判断項目の確認、不一致時は第三者裁定とし、回答一致だけから第三者回答を補完しない。
`focus_labels` も edge review や model 出力から導出せず、別の明示入力として扱う。一致時の二者回答と
第三者 final review の一致をPython validator・ブラウザreaderで検査するが、本人性を認証したとは扱わず、
intake の `complete` を fixture・quality・公開の自動認可に用いない。
`audit_fixture_authorized`、`artifact_update_authorized`、`quality_authorized`、
`publication_authorized` は常に false で、本人性・盲検の真実性は未認証と記録する。

回答 import の詳細キーと受入ケースは設計レビュー後、実装依頼書に固定済みである。
非公開の保存 CLI は pure API の検証後の別単位として[33](33-private-review-intake-cli.md)で採用し、既存ファイルを上書きしない。
この CLI は source/artifact/catalog/candidate と作成時刻を保存原本どおりに再読込して
同じ process 内で L2a bundle を再生成し、配布原本の3ファイルとも byte 比較してから呼び出す。

## 3. 実装と検証の境界

各実装担当は登録済みの別 worktree・非保護ブランチで実行する。
必要な未 commit ソース/テスト/指示だけを厳選し、親が準備用ローカル commit を作って clean にする。
主作業の develop の変更、別設定タスクの AGENTS/runner、archive 原本は保持する。
Flashを使用する場合は共有キューで実装を一つずつ実行する。今回は上記のユーザー直接指定に基づき、
非重複の2機能をSolで並行実装する。共有サービスや永続のagent設定は変更しない。

テストを先に用意し、RED/GREEN を記録する。親が完成差分の全文を読み、対象 pytest、Ruff、
型検査、既存互換/安全性テストを再実行する。host の補助検証は Docker 稼働確認とは区別する。
新規 CLI/外部仕様を追加した場合だけ README を更新し、結果・未検証項目を 13 に残す。

## 4. 初回Flash実行の履歴とSolでの再開

実装前の Sol レビューで上記 API・境界を確認した。Flash は共用キュー待機後、両 job とも
初回に `429 Too Many Requests` で終了1となり、ファイル変更なしを確認した。
この確認はランナーと同じ `core.precomposeunicode=false` の Git status による。
macOS の既定設定では、追跡済み archive の NFD ファイル名が NFC の未追跡名として表示されることがある。
その表示だけを根拠に別の文書が追加されたと判断せず、原本を移動・削除しない。
これは PaperPilot 専用経路の実装成功ではなく、コード品質や model 自体の原因を推測しない。
自動的な Sol/cloud fallback、provider変更、他プロジェクトの worker 停止は行っていない。

- 一時領域: `/private/tmp/paperpilot-next-delivery.fXNT9g`
- conference linked worktree: `conference`、branch `codex/conference-dry-run-20260905`、準備 commit `13d3236`
- lineage linked worktree: `lineage`、branch `codex/lineage-review-intake-20260905`、準備 commit `8836d3d`
- 機能範囲・API・受入条件は `conference-task.md` と `lineage-task.md` に固定済み。
- 親の統合テスト5件は `parent-tests/` に退避。両新moduleの未実装による RED を確認済みで、
  実装が採用されるまで主作業の test collection には含めない。
- 新module同梱を要求する build-only workflow/test の変更も未実装のため主作業から取り下げた。
  既存の31の変更は保持している。採用時にこの2 module の同梱チェックを追加する。

2026-09-06の再開では両worktreeがcleanで、準備済みruntime/schema/test入力が主作業とbyte一致することを確認した。
この会話のQwenなし・Sol指定を優先して上記の二つを並行実装する。先行5テストは主作業へ戻して
module未実装のREDを確認済み。完成差分を採用してGREENになるまでcommit/pushしない。

## 5. 2026-09-06 ローカル実装の結果

- `conference_watch/dry_run.py` と `lineage_pilot/review_intake.py`、直接テストを主作業へ採用した。
  親の接続テストは既存catalog loader・Identity Lite・searchとの互換、全文末尾だけの変更、
  根拠なしunknown候補の保持、整数/booleanの原本改変、通信/ファイル/別process I/Oなしを検査する。
- 学会更新は4 outcomeを分離し、削除ありはblocked、全文未提供ならno-changeを断定しない。
  入出力両方の限定profile、UTF-8/重複key/非有限値/Unicode control/native identityを検査する。
  6候補payload→report→planの一方向hash bindingを固定し、未適用planに公開認可を付けない。
- 回答取込はfactory brandが最初のgateで、response以外の改変をnull masking後のcanonical byteで拒否する。
  独立レビューの指摘により、JSON parse後の外形・件数・候補形をdepth/canonical走査より前に検査する順序へ修正し、
  5ケースのRED/GREENで確認した。本人性・盲検性は自己申告であり、回答一致も人手監査や公開承認の代わりではない。
- 親は完成runtime/testの全文を読み、別担当が独立監査した。非回答scalar 67箇所と候補順序の改変は全拒否、
  学会catalog 15項目とdetail envelopeの異常型も安全な例外へ閉じる。今回範囲に未解決P1/P2はない。
- 新規直接/接続テストは **89 passed**。対象runtimeのcoverageは学会 **93%**、回答取込 **90%**。
  全体host補助regressionは **2,843 passed / 1 skipped**。skipはmacOSのLinux専用`RLIMIT_AS`。
  Node **39 test files**、repository-wide Ruff、対象7 Python filesのformat、2 runtime modulesのnarrow mypyはpass。
  全体型検査は既存領域の **278 errors / 53 files**（270 files対象）であり、今回追加の診断は0。
- sdist/wheel/Twineに成功し、新2moduleの実byte一致とwheelのtests除外を確認した。
  build-only workflowの必須同梱チェックへ2moduleを追加した。配布物は
  `/private/tmp/paperpilot-local-intake-qa.cQSwAM/dist`。fresh依存installやDocker runtimeの検証ではない。
  offline/no-depsで隔離targetへinstallし、`-I -S`実プロセスでinstalled moduleから両APIをimportする検査もpassした。
- asset/sitemap/diff checkはpass。READMEの利用方法・外部仕様とAGENTS等の設定はこの単位では変更していない。
  既存差分を保持し、commit/push、実source/API/LLM呼出、Docker image操作、定期実行・公開の有効化は行っていない。

回答原本を安全に再読込してfactoryを再生成するprivate保存CLIは後続の33で実装・検証した。
残るのは学会の前年度baseline/ratio・staging/カタログ日付/共有projectionの接続である。実人手の原典確認・裁定・focus labels、trusted state/CAS、
approved Docker image/runtimeは引き続き別gateとする。linked worktreeは実装原本として保持しているが、
回答取込には主作業側のレビュー修正があるため、今後は主作業のコードを正本とする。
