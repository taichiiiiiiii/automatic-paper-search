# 順次改善の実行状況（2026-09-12）

## 最新採用: キーボード中心切替失敗時のnull参照防止

運用更新後、線強調の停滞checkpointとは別の仮説を実行した。
仮説: focus-onlyのキー操作でprojectionが失敗すると、claim不在なのに
`claim.dataset`へ進むためTypeErrorになる。関係操作をclaim存在時に限定すれば、
既存の安全なエラー表示を維持できる。

固定資料は既存positive-release合成fixtureと`node:intentionally-missing`。
実在論文のデータや証拠は取得・変更していない。
Flash（qwen3.8-flash、cloud-only、effort none、transport retry 0）は
`/tmp/paperpilot-keyboard.PZUZRl/worktree`で実装と回帰テストを担当。
初回Nodeテストは成功。新規テストを旧実装へ適用して
`Cannot read properties of null (reading 'dataset')`を再現後、
`else if (claim)`の1行guard追加で同じNodeテストが成功した。

受入条件と証拠:

- Enter/Spaceの無効focusで例外なし、安全なエラー表示を保持（固定テスト）。
- 有効focusのEnterと有効claimのSpace操作を保持（固定テスト）。
- 375px実画面: EnterでSynthetic Childへ中心切替、Tabで線へ移動、Spaceで監査詳細、
  Escapeで元の線へfocus復帰。body scrollWidth364 / viewport375。
  polylineへのPlaywright直接pressはタイムアウトしたが、実Tab/Space操作で確認した。
- 全体pytestは同じhost補助環境で変更前3,136 passed/1 skipped（46.81秒）、
  変更後3,136 passed/1 skipped（46.05秒）。新規JS assertionsは既存pytest wrapper内で実行。
  スキップはLinux専用RLIMIT_AS。Node構文、asset整合、diff check成功。
- 出典URL・evidence・claim・projection・CSS変更なし。asset同期でJS v18、
  versions.jsonとlineage/index.htmlのみ生成更新。READMEの外部仕様変更は不要。

親Codex判定: この低リスクな1モジュールの例外防止候補をローカル採用。
科学的な結論・引用精度・解析方法に触れないためMAX採用gate対象外。
MAX起動問題を直した、線の重なりを改善した、全5項目を完了したとは主張しない。
異常focusの実DOM生成は通常画面では行わず、その経路は固定テストで検証。
Docker本番検証・全体型エラー解消・実論文の人手監査は未実施。
公開/commit/pushなし、既存WIP保持。検証タブ・viewport override・previewサーバー終了。
「レビュー可能な改善候補1件」の成功条件に達したため本実験を停止する。

## MAX起動失敗の確定原因と再開条件

読み取り調査で、`.codex/bin/qwen-evaluate` は実行環境からPATHを除外して
request.jsonへ保存し、shimでもその環境へ置換した後に実Codexをexecすることを確認。
実 `/opt/homebrew/bin/codex` のshebangは `#!/usr/bin/env node`、Nodeは
`/opt/homebrew/bin/node`。そのためNodeを探索できない。既存のMAXテストは
絶対Python shebangのfakeを使い、この起動方式をカバーしていなかった。
修正候補はqueue用shim探索環境と実CodexのNode探索環境を分離し、
env-node形式のoffline fixtureで回帰確認すること。広い環境継承で秘密を渡さない。
これは調査結果と修正案であり、launcher修正・MAX再評価はまだ行っていない。
同一UI仮説のFlash admitted回数2回とMAX試行1回は実績として保持する。
現行運用はAGENTS.mdを正本とし、固定回数上限ではなく、新しい原因証拠なしに
同じ失敗が2回続いたcheckpointを棄却する。MAX起動失敗は高リスク候補の採用を
保留するが、別の低リスク仮説の実装やGoal全体を止める理由にはしない。

## 過去の線強調checkpointの経緯（非運用の試行記録）

以下の「1回限り」「再試行禁止」「実装前」「未検証」は各試行時点の記録。
現時点の採用結果は冒頭、実行条件はAGENTS.mdを参照する。

## ユーザーの「再度行ってください」による2回目

新しいclean worktree `/tmp/paperpilot-focus-retry.FdQ5a3/worktree` でFlashを起動。
cloud-only / qwen3.8-flash / automatic_retry=0を確認。baseline Node契約は成功したが、
限定したread指示でも編集前にcontext圧縮と再探索が始まったため親が停止。
session28344 exit130。JS/CSS/テストの3つのSHA-256は前回同様に原本と一致、変更なし。

同じ問題2回の条件でMAX評価を1回だけ試行。差分なし、対象名は予定ファイルであると
明記した小さい評価packetを親が確認し、秘密・実論文資料を含めず送った。
queueはqwen3.8-maxをadmitしたが `env: node: No such file or directory` でexit127。
評価本文は得られていない。原因の詳細を断定せず、評価launcherの実行環境が次の調査対象。
再試行・fallback・共有設定変更なし。primaryのUI修正は未実装で採用不可。
この2回は実装前停止であり、有効な改善実験の失敗回数には算入しない。

次回用の限定タスクを `/tmp/paperpilot-focus-ui.4anBja/task-v2.md` に準備した。
描画・イベント・監査dialogの関数範囲を明示し、全ファイル再読を禁止、
編集前にcontext圧縮した場合は再探索でなく不足情報を報告して停止する。
受入条件（重なった関係の強調、キーボード同等性、全claim保持）は縮小していない。
この準備ではworker再起動・primary実装修正は行っていない。

当時の状態: 調整元の8枠更新通知と「今この1回」の明示許可後、Flash workerが
cloud-only / qwen3.8-flash / automatic_retry=0で起動成功。以下のbusy記録は履歴。
worker task ID `01a09551-6231-73f2-abe1-9a3f66c4abf1`。
その後、同じファイルの読み直しとcontext圧縮が繰り返され、修正に進まなかったため
親がSIGINTで中止（session 79698、exit 130）。実装・採否はまだ未完了。
開始前と中止時のJS/CSS/テストのSHA-256が3件とも完全一致し、実装修正がないことを確認。
これは改善しなかった有効な実験ではなく、実装前のworker停滞として記録する。
自動再試行・別モデルfallbackなし。次回は同じUI受入条件を維持しつつ、
必要な関数範囲と小さい編集単位を明示して全ファイル再読の反復を避ける。

## 現在の残作業

ユーザー指定順で進める。CSV・キーボード例外防止の採用は、以下全体の完了ではない。

1. 家系図UI: キーボード例外防止は採用済み、375pxの合成少数論文は操作確認済み。
   関係線の追いやすさ・大規模狭幅表示・全キーボード経路は未完了。
2. 原典と人手による関係確認: 未着手。科学的承認をエージェントが代行しない。
3. 固定クエリの検索評価: 未着手。
4. スライド依頼→生成→レビュー→再閲覧: 未着手。
5. 学会の実データ確認と承認済みDocker環境検証: 未着手。公開やimage取得の承認は別。

## 履歴: 第1段階の準備と停止理由

現在のFocus Viewと契約18を確認。既存の
`node paperpilot/tests/viewer/test_lineage_focus_app.mjs` は成功した。
重なった関係線を操作中に両端と一緒に強調する改善をFlashへ依頼する準備を完了。
これは完全な幾何学的配線分離とは区別し、実ブラウザで改善を確認してから採否を判断する。
狭幅・実キーボード確認はまだ未実施。

専用のclean worktree:
`/tmp/paperpilot-focus-ui.4anBja/worktree`（branch `codex/focus-ui-20260912`）。
限定タスク文書: `/tmp/paperpilot-focus-ui.4anBja/task.md`。
共有launcherから起動を試みたが、`cloud-only subscription slot is busy; no wait or fallback`
でexit 2。実装workerは起動しておらず、バックグラウンドで待機してもいない。
現在のCloud-only・自動再試行禁止ルールを維持し、別モデルへ切り替えていない。
再開時は枠の利用可否を確認し、明示的な再試行指示のもと同じ限定タスクから再開する。
primaryの実装・公開データ、provider設定、秘密情報は変更なし。commit/pushなし。

## 履歴: 開始許可後の再確認

調整元から明示的な開始許可を受領して1回再試行したが、同じbusy拒否で終了した。
生存PID 95563 / 95585がcloud lockを開いており、そのcwdはSignate/Nedo。
調整元にも共有1枠の利用順調整を依頼済み。PaperPilotの実装プロセスは未起動であり、
自動待機キューへ登録されたとは扱わない。

継続時のhost補助チェックは
`python -m pytest -q paperpilot/tests/test_lineage_v2_viewer_core.py paperpilot/tests/viewer/test_lineage_focus_route.py paperpilot/tests/test_lineage_preview.py`
で28 passed（0.70秒）。実装前ベースラインの証拠であり、UI改善後の合格ではない。
実画面での狭幅・キーボード比較とFlash実装は依然未完了。

## 履歴: 実装前の375px画面確認

既存lineage_previewの`--comparison`をlocalhost:8766で使用し、合成2論文/1比較関係を表示。
375×812で関係一覧を明示選択し、根拠ボタンをEnterで開く→閉じるボタンにfocus→
Escapeで閉じる→元の根拠ボタンへfocusが戻ることを実ブラウザのAX状態で確認。
body scrollWidth=364 / viewport=375、dialog width約327.6。画面画像でも一覧の
折返しとフォーカス枠を確認した。この条件で横はみ出しはなかった。
保存済み表示条件を使用しているため、初回mobile既定表示の検証とはしない。
大規模グラフ・線強調の変更後比較・全キーボード経路は未検証。
synthetic-onlyの表示であり、実論文の根拠承認ではない。
viewport overrideを解除し、検証タブとローカルサーバーを終了した。
cloud枠は確認時点で同じNedoのPID 95563/95585が保持。実装再起動はしていない。
