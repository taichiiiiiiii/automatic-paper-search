# 35. 検索・Focus View の導線改善

## 次の5単位（ユーザー指定順）

1. 初期1-hop/最大7論文へ縮小、上限の明示的拡張と先行/発展/比較の読み分け。
2. 関係一覧に根拠の解釈文と信頼段階を表示。監査を省略・偽装しない。
3. 検索結果を残す詳細ダイアログ。既存catalogを同一originのiframeで再利用し、閉じると元の検索に戻る。
   modifier付きリンク・通常リンクfallbackを維持し、新しいsource/APIアクセスは増やさない。
4. 学会一覧を準備中の系譜より前に移し、準備中領域を小さくする。
5. スライドの閲覧/依頼/準備/処理/エラー状態を言葉で明示する。依頼受付のゲートは緩めない。

2026-09-08。親が単独で実装・自己レビューする限定UI改善。

検索の対象（タイトル・著者・タグ、2文字以上）と未対応の全文検索を入力の説明へ関連付ける。
検索後の論文選択→家系図/スライドの導線を短い開閉式ガイドで示し、公開準備中を明記する。
Focus Viewの非表示状態に検索への復帰リンクを置く。横に広いグラフをキーボードでスクロール可能にし、
関係一覧への切替案内、長い文字列の折返し、focus-visibleを補う。

検索アルゴリズム・graph投影/本数上限・監査/公開ゲートは変更しない。テストを先行追加し、既存viewer回帰、
ブラウザの検索結果/空結果/非表示状態、狭いviewport、asset同期を確認する。公開・pushはしない。

## 実装・検証結果

検索ヘルプと開閉式の次操作ガイド、0件時の再検索案内、Focus Viewの復帰リンク・グラフ操作説明・
tabindex・focus-visible・長文折返し・見出し行間を追加した。検索順位や監査の判定ロジックは未変更。
4件のテストを失敗から成功へ進め、viewer・共通shellを含む152件が成功。対象Ruffとasset同期・diff checkも成功。
CSS/search.jsのversionは公式同期scriptで更新し、参照HTMLも同期した。

ローカルブラウザで検索結果（diffusion 4,181件の候補）、0件の案内、375px幅での折返し、
Enterによるガイド開閉・家系図非表示画面から検索への復帰を確認。viewport overrideは解除した。
公開pilotが空なので実グラフの描画・キーボードスクロールは実画面未検証。監査済みデータを偽装していない。
今回全体pytest/型チェックは再実行しておらず、既存の全体mypy未成功は解消を主張しない。commit/pushなし。

## 5単位の実装（後続依頼）

1. 初期1-hop/7論文に変更。明示URL/設定は尊重し、5〜50論文の上限入力と範囲選択を用意。
   先行→発展の向きと比較線の読み方を表示する。先行/発展ごとの専用レーンは未実装。
2. 関係一覧にrationaleをtextContentで表示し、verified/corroborated/tentativeを日本語化。
   解釈を事実と混同させず、既存の根拠・監査ダイアログを維持する。
3. 全検索結果一覧の通常クリックで同一originのcatalogをnative dialog内に表示。
   親の検索条件/ページ/scrollを変更しない。閉じるとtriggerへfocusを戻してiframeを破棄する。
   外部origin・不正path/ID/queryはinterceptしない。modifierクリック/未対応browserは通常リンクのまま。
   iframe内Escapeも親へ伝える。候補comboboxは従来どおり直接遷移する。
4. 学会一覧を系譜の準備中表示より前へ移動。準備中領域の余白を縮小。
   CSSのdisplay:gridがhiddenを上書きする既存不具合も修正する。
5. スライドの閲覧可能・依頼可能・処理中・人手review待ち・エラー・利用不可を言葉で表示。
   既存のエラー理由/再試行可否/公開検証/生成受付ゲートを維持する。

専用Node検証でdetailのURL制約・modifier fallback・親URL不変・close/Escape・focus復帰を確認し、
viewer回帰で200-node/1,000-claimデータと新しい7論文上限、解釈/信頼ラベルを検査した。
Macロックのため、この変更群の実ブラウザ・スマートフォン幅・iframe内部の実操作は未確認。
前節の実ブラウザ確認をこの変更群へ流用しない。公開pilotは引き続き空、Docker/公開/commit/pushなし。

最終host補助の全体pytestは3,119 passed / 1 skipped（47.34秒、Linux専用RLIMIT_AS）。
末尾のhidden修正は別途landing/UIの23件で成功。全体Ruff（paperpilot）・asset同期・diff check成功。
全体mypyは今回再実行していない（既知268件の解消を主張しない）。ブラウザ再検証はMac解除後に行う。

## 2026-09-08 定期照合・詳細ダイアログの追加レビュー

Macロックが継続し実画面確認は再開できない。先にread-only差分レビューで見つかった、iframe内の
子ダイアログのEscapeを親が奪う問題と、閉じた旧iframeの遅延load/keydownが再表示後の親へ影響する問題を
テスト先行で修正する。専用レーン追加はこの修正の後へ残す。Gitはdevelop/CD8F28C、staged空、
local trackingとの差分0/0だがremote最新確認ではない。混在WIP・型検査未成功・実画面未検証のためcommit/pushしない。

追加テストで子dialogのEscape問題を再現してから修正し、旧frameのload/keydown/timeoutはactive frameとの一致を要求した。
遅延closeも新しいopenを破棄しない。関連154件、paperpilot全体Ruff、asset同期・diff checkは成功。
全体mypyを再実行し268 errors / 46 files / 284 source filesで未成功を確認。今回全体pytestは再実行せず、
前回3,119 passedは履歴として保持する。設計索引へ35を追加し、workboardのbaseline未接続の記述を整理した。
README利用方法・AGENTS・共有設定・公開データは変更していない。専用レーンと実画面確認は引き続き未完了。

## 2026-09-08 19:48 JST 定期照合・論文カードの方向別区分

残作業を一度にgraph座標まで変えず、まず「表示中の論文」を中心・先行・発展・比較・その他/要確認の区分へ整理する。
表示投影内のacceptedかつverified/corroboratedなgenealogyだけを方向付きにたどる。年・タイトルから関係を推測せず、
comparisonやtentativeを継承経路へ混ぜない。中心との比較は直接のcomparisonだけを対象とし、
方向が両方に到達する防御ケースはその他へ置く。ノードを重複表示せず元の投影・本数上限・監査条件は維持する。
graph専用レーンと実画面確認は別の未完了項目。テスト先行で方向・逆向き・比較・要確認・決定性・全件一意を確認する。

カード区分を実装し、方向付き到達・比較分離・rejected/tentative/範囲外endpointの除外・順序不変・入力非変更を検証した。
入れ子変更で展開後のfocus復帰が失敗する回帰を検出し、子孫カードから同じnode IDを探すよう修正して成功した。
host補助の全体pytestは3,119 passed / 1 skipped（50.52秒、Linux専用RLIMIT_AS）。末尾の整形後もNode検証は成功。
paperpilot全体Ruff・asset同期・diff check成功。mypyは前回268件未成功を継続課題として保持（今回は再実行せず）。
Macは今回もロックされ実画面検証不可。READMEは追加された区分の利用説明のみ更新し、workboardへ35を登録した。
staged空、developのlocal tracking差分0/0（fresh remoteではない）。既存混在WIPを保持し、commit/pushなし。

## 2026-09-08 21:52 JST 定期照合・graph配置の入力境界

方向別カードの検査をgraphの配置関数と比較すると、後者は非tentativeだけを条件にし、accepted判定と
明示的な信頼段階の制限を持っていなかった。通常の検証済み投影では除外済みだが、配置関数単体でも
rejectedや未知の信頼段階が世代順位へ影響しないようテスト先行で揃える。公開条件の緩和ではない。

不正な関係によるx座標差をテストで再現し、acceptedかつverified/corroboratedなgenealogyだけに限定して修正。
関連viewer/UI/core 41件とpaperpilot全体Ruff・asset同期・diff check成功。全体pytest/mypyは今回は再実行していない。
Macロックは再確認して継続中。graph専用レーンの実装・実画面検証は未完了であり、既存型エラー268件も未解消。
staged空、developのlocal tracking差分0/0（remote最新確認ではない）。README/AGENTSは変更せず、commit/pushなし。

## 2026-09-08 23:54 JST 実ブラウザ検証の再開

Macロックが解除され、既存localhostプレビューで新UIを確認できた。diffusionの全結果4,181件・1ページ目から
AAAIの選択論文を詳細dialog内で表示し、親URLのquery/page不変、Escapeでcloseして同じ結果linkへfocus復帰を確認。
学会一覧のhiddenもアクセシビリティツリーで反映された。これはdesktopの確認で、狭幅と実pilot graphは未確認。

新規UI課題: 埋込catalogの固定filter toolbarと自動scrollが競合し、初期表示で選択論文のタイトルが隠れる。
次の優先単位はembedded detailで見出しを確実に見せること。graph専用レーンより先にこの実画面課題を修正する。
APIを有効化しないlocal環境ではスライド公開検証エラーの案内を確認したが、production障害の証拠ではない。
今回runtimeは変更せず、文書索引の08〜34という古い範囲を08〜35へ更新。README/AGENTS/公開物は変更しない。

関連41件・paperpilot全体Ruff・asset同期・diff check成功。全体pytest/mypyは再実行せず、既存型エラー268件は未解消。
staged空、混在WIPと未完了UIを保持しcommit/pushなし。remote最新確認も行っていない。

## 2026-09-09 01:56 JST 選択論文のスクロール位置

選択カードのscrollIntoView(start)が高さ可変のsticky filter-barを考慮していなかった。
固定pixel値やiframe専用の複製viewは作らず、配置直前にbarの実高を測り16pxの余白を加えたscroll-margin-topを設定する。
検索選択・通常catalogの同じ配置関数を修正し、0/100/240pxのbar高でmargin設定がscrollより先に行われるテストを追加する。

関連viewer/UIテスト40件・paperpilot全体Ruff・diff check成功。asset同期によりapp.jsはv101。
localhostの実ブラウザでdiffusion検索の先頭論文を開き、固定toolbarの下にタイトル・著者・選択状態が
隠れず表示されることをdesktop screenshotで確認した。狭幅の詳細dialog、graph専用レーン、既存型エラーは未完了。
全体pytest/mypyは今回は再実行していない。混在WIPを保持しcommit/pushなし。

## 2026-09-09 04:00 JST 定期照合・狭幅の詳細確認

Git status・unstaged diff・staged（空）を確認。前回の続きとしてlocalhostの検索詳細を375×812で検証した。
desktopからの幅変更と、狭幅で閉じて再度開く両ケースでタイトル・著者がtoolbarに隠れず表示された。
閉じる操作で元の結果linkにfocus復帰し、親URLのq=diffusion&page=1も維持された。検証後viewportをresetした。
workboardの一括した「実画面確認は未完了」を、確認済みの検索詳細と未確認の実pilot graphに分けた。

関連viewer/UI/core 41件、paperpilot全体Ruff、asset整合、diff check成功。runtime・README・AGENTSは今回変更なし。
全体pytest/mypyは再実行せず、既存mypy 268件は解消扱いにしない。developの混在WIPを保持しcommit/pushなし。
remote最新確認は行っていない。次はgraph専用レーンの設計・テスト・実装と、その画面検証。科学的公開承認は別途必要。

## 2026-09-09 06:01 JST 配置処理の循環防御

status/diffと空のstagedを確認。専用レーン着手前の配置レビューで、DAG処理に残る循環ノードへ
外部からの辺だけで途中のrankが付くことを発見した。「残留循環は第一層」という実装コメントと矛盾する。
小さな先行修正として、外部root→循環→後続のfixtureで回帰を再現し、未処理ノードはrankを0へ戻す。
通常DAGの順位、監査・公開gate、カード区分は変えない。これは専用レーン実装の完了ではない。

回帰テストでx=355（期待105）の失敗を再現後、残留indegreeがあるノードのrankをリセットして成功。
入力順を逆転しても同じ配置になることと既存DAGの前後関係を確認した。関連41件・Ruff・diff check成功、
asset同期でlineage-focus.js v9へ更新。今回は実graphのブラウザ検証・全体pytest/mypyは未実施。
README/AGENTS・公開データは変更せず、混在WIPと既存型エラー268件を保持。commit/pushなし、remote最新確認なし。

## 2026-09-09 08:03 JST 定期照合・専用レーンの実装条件

Git status/diffとstaged空を確認。設計18のURL表に旧既定2-hop/15本が残っていたため、
現行parseViewStateの1-hop/7本へ修正した。利用仕様は既存実装のままなのでREADMEは変更しない。

次の実装単位は描画座標と区分ラベルのみとする（以下は未実装の設計）。

- 分類は既存nodeLanesを共用する。先行・中心・発展を左から並べ、比較とその他は下側の独立した帯に置く。
- 継承領域の内部はlayeredLayoutの順位を保つ。比較を先行研究の第一世代として置かない。
- 分類の優先順位は既存カードと同じ。先行かつ発展に到達する防御ケースはその他へ置き、ノードを重複させない。
- 座標計算を純粋関数として切り出し、positionsと区分ラベル位置、必要なwidth/heightを返す。
  全ノードを一度だけ配置し、空区分は省略、区分間の余白とノード矩形の非重複を保証する。
- SVGの区分名はtextContentで描画。既存のnode/claim ID、監査詳細、キーボード操作を維持する。
  projection、公開条件、50 nodes/80 claimsの上限、mobile既定listは変えない。
- テスト先行で単一node、前後枝、比較のみ、その他のみ、循環、順序反転、最大50本、入力非変更を確認する。
  続いてmock DOMの描画と監査操作を検証し、最後に明確にsyntheticと示した非公開fixtureでdesktop/375pxを確認する。
  公開pilot indexを埋めたり実論文の監査承認を捏造して画面を出したりしない。

関連41件・Ruff・asset整合・diff check成功。前回の循環防御も回帰テストに含む。
今回はruntime変更なし、全体pytest/mypyは未再実行。既存型エラー268件と実graph画面検証は未解消。
混在WIPを保持しcommit/pushなし、remote最新確認なし。AGENTSは変更しない。

## 2026-09-09 10:04 JST 専用レーン座標の純粋関数

status/diff・staged空を照合後、前節の最初の実装単位としてlaneLayoutを追加した。
nodeLanesで区分し、先行/中心/発展には区分内layeredLayout、比較/その他には下側3列の帯を使う。
positions・labels・width/heightを返し、入力や公開projectionは変更しない。
テスト未実装エラーを先に確認後、前後順位・比較分離・空/単一/50本・矩形非重複・領域内配置・
順序反転・入力非変更・循環区分を検証した。SVG描画への接続はまだ行っていないため、ユーザー表示は従来のまま。

次の単位はrenderGraphへの接続、SVG区分ラベルと監査/キーボード回帰、非公開synthetic fixtureの画面確認。
README/AGENTS/公開データは今回変更しない。混在WIP・既存型エラー268件を保持しcommit/pushなし。

関連41件・Ruff・asset整合・diff check成功。循環テスト追記後もNode検証成功。lineage-focus.jsはv10。
全体pytest/mypy・実画面・remote最新確認は今回は未実施。自己レビューでは区分内順位と矩形境界を確認した。

## 2026-09-09 12:06 JST レーンの描画接続

Git status/diffとstaged空を照合し、前節の座標をrenderGraphに接続した。
テスト先行で区分ラベル欠落を再現後、SVGの区分名・viewBox・全nodeのtransformをlaneLayoutに合わせた。
ラベルはtextContentとcurrentColorで描画し、既存node ID・claim ID・監査操作は変更しない。
READMEは追加されたグラフの読み方1文のみ追記、workboardの実装状況を更新。AGENTSと公開データは変更なし。

関連41件・Ruff・diff check成功。asset同期はJS v11/CSS v7で、参照するHTMLも同期した。
自己レビューで描画座標の接続、既存nodeのtabindex、監査操作回帰を確認した。
実ブラウザでの線とラベルの重なり・狭幅・比較帯は未検証で、完成/公開済みとは扱わない。
全体pytest/mypy・remote最新確認は今回は未実施。既存型エラー268件と混在WIPを保持しcommit/pushなし。

## 2026-09-09 14:08 JST 全体回帰と画面検証の配信境界

status/diff・staged空を照合。公開indexはentries空のまま保持した。
既存test_lineage_focus_app.mjsのfixtureFetchを調べ、画面確認用の読み取り専用localhost配信に必要な対応を整理した。
通常のHTML/assetsはdocsから、indexとlineage-pilots配下はtests/fixtures/lineage-pilot/positive-releaseから、
synthetic-pilot/papers.jsonだけは同fixtureのcatalog.jsonから配信する。
実装するサーバーは127.0.0.1限定、許可パス以外を拒否し、画面にsyntheticテストである旨を常時示すこと。
docsへのfixtureコピーや公開index変更、検証処理の無効化は不要。配信サーバーと実画面確認はまだ未実装・未実施。
既存positive-releaseだけで比較帯や最大本数まで検証したと主張しない。それらは追加の合成ケースが必要。

通常mypyはPython 3.10 targetとNumPy stubの3.12構文の不一致で停止。
補助のmypy --python-version 3.12 paperpilotでは268 errors / 46 files / 284 source filesを再確認した。
設定変更によるエラー隠しは行わない。README/AGENTS・runtime変更なし。commit/pushとremote最新確認なし。

host補助の全体pytestは3,119 passed / 1 skipped（45.96秒、Linux専用RLIMIT_AS）。
Ruff・asset整合・diff checkも成功。これはDocker runtimeの検証完了を意味しない。

## 2026-09-09 16:09 JST ローカル合成プレビューと初回graph確認

status/diffとstaged空を照合し、前節の配信をtests/viewer/lineage_preview.pyに実装した。
起動は `.venv/bin/python -m paperpilot.tests.viewer.lineage_preview`、127.0.0.1:8766限定。
許可パスからだけ読む。ディレクトリ一覧・任意repoファイル・encoded traversalを拒否し、書込みAPIは設けない。
合成テストの警告をHTMLに加え、検証後の修正で専用CSSによるsticky表示も追加した（最終sticky表示自体は未目視）。

localhostブラウザで既存fixtureの5資源検証を通過し、2ノードの中心→発展レーン、矢印、区分名が
重ならず表示されることをdesktopで確認した。科学的承認の証拠ではない。
比較帯・多数ノード・375px・実キーボード監査操作はまだ未確認。プレビューの戻りリンク先は配信対象外。
起動した8766サーバーは検証後停止。公開indexと公開データは変更しない。

関連51件・Ruff成功、preview単体mypy（Python 3.12）成功。最終CSS追加後もpreview 10件・Ruff・単体mypy成功。
全体pytest/mypyは今回は未再実行（前回全体3,119件成功、型268件未解消）。README/AGENTSは変更せず、
混在WIPを保持しcommit/pushなし。remote最新確認なし。次は追加した警告と狭幅、監査操作を実画面で検証する。

## 2026-09-09 18:12 JST 狭幅・監査ダイアログ検証

status/diffとstaged空を照合後、前回の合成プレビューを再起動した。
375×812、明示view=graphで横スクロール領域とスクロール後のsticky警告を目視確認。
監査詳細を開くと、観測リンク・引用位置・解釈の内容が狭幅内で折り返された。
Escapeで閉じ、元の「拡張の監査詳細を開く」へfocus復帰することをDOM読取りで確認した。
SVG lineへのPlaywright clickはtimeoutしたが、native accessibility clickでは正常に開いた。
これはキーボードだけで開く操作の検証ではなく、Enter/Spaceで開く操作は引き続き未確認。

viewportはresetし、8766の検証サーバーを停止。runtime・README・AGENTS・公開データは今回変更なし。
比較帯・多数ノードの実画面確認は次の未完了項目。既存型エラー268件は未解消、全体pytest/mypyは未再実行。
混在WIPを保持しcommit/pushなし、remote最新確認なし。

関連51件・Ruff・asset整合・diff check成功。確認範囲は上記の2ノード合成fixtureに限定する。

## 2026-09-09 20:14 JST キーボード監査操作

status/diffと空stagedを照合し、前回の続きとしてlocalhost合成プレビューを起動した。
desktopの初期focusからTabを13回押してSVGの「拡張の監査詳細を開く」へ到達。
Enterでdialog.open=true、Escapeで閉じ、Spaceでもopen=trueになることを実ブラウザで確認した。
最後のEscapeでopen=false、同じ監査ボタンへfocus復帰を確認。DOM書換えや直接handler呼出しは使っていない。
8766サーバーを停止した。runtime・README・AGENTS・公開データの変更なし。

未完了は比較帯・多数ノードの実画面検証。今回の2ノード確認をそれらの代替とはしない。
既存型エラー268件は未解消（全体pytest/mypyは今回は再実行せず）。混在WIPを保持しcommit/pushなし。
remote最新確認も未実施。

関連51件・Ruff・asset整合・diff check成功。今回は検証結果の文書更新のみ。

## 2026-09-10 00:16 JST 50ノード混在配置の回帰

status/diffとstaged空を再確認し、前回途中だった多数ノードの配置テストを完成した。
従来の50本ケースはほぼ孤立ノードだったため、中心1・先行15・発展15・比較10・要確認9の
合成projectionを追加。全50本の一意配置、全矩形の非重複と領域内配置、入力反転時の決定性、
入力非変更、縦に長い継承領域より下へ比較帯が置かれることを確認した。
これは座標計算のテストであり、線や文字の重なり・実ブラウザの多数論文検証を代替しない。

関連51件・Ruff・asset整合・diff check成功。runtime・README・AGENTS・公開データ変更なし。
既存型エラー268件は未解消、全体pytest/mypyとremote最新確認は未実施。混在WIPを保持しcommit/pushなし。
次は比較を含む非公開の合成データを画面検証へ接続する。実論文の監査や公開承認は追加しない。

## 2026-09-10 04:17 JST 定期照合と追加fixture経路の確認

最新heartbeatに合わせてstatus/diff・空staged・developを確認。workboardの一括した「新graph未検証」を
2ノードで確認済みの範囲と、比較帯/多数ノードの未検証範囲へ修正した。
関連51件・Ruff・asset整合・diff check成功。runtime・README・AGENTS・公開データは変更なし。

追加fixtureは既存test_lineage_pilot_bundle.pyの_inputs/_buildと、test_lineage_v2_contract.pyの
_artifact/_fixture/_quality/_rebind_qualityが参照候補。ただし前者は既存2ノードを読み直すだけで、
比較データ生成器ではない。新比較claimに対応するevidence/fixture/qualityとhashを一緒に構築・検証してから
build_pilot_bundleで束ねる必要がある。JSONの手修正や検証の無効化だけで画面を出さない。
この調査で追加fixtureを生成・画面確認したわけではなく、引き続き次の実装単位とする。

全体pytest/mypyは今回は未再実行、既存型エラー268件未解消。混在WIPを保持しcommit/pushなし。
remote最新確認なし。02:17の通知について独立した検証成功の記録は作らず、今回の確認結果だけを記録する。

## 2026-09-10 06:18 JST 比較bundleの生成検証

status/diff・空stagedを確認。既存positive-releaseのコピーを使う比較専用の合成テストを追加した。
最初のclaimをcomparison/contrastsへ変え、同じテスト用review/adjudicationのgold labelと
artifact/fixture hash、qualityの継承/比較件数を一貫させ、通常build_pilot_bundleで受理されることを確認。
生成はテストのメモリ内だけで、既存fixture・公開index・科学的監査の実記録は変更していない。
プレビューへの比較データ切替と実画面確認は未実装。次はこの生成をテスト用helperにまとめ、
localhostプレビューだけから利用する。多数ノードの実画面確認も別途残る。

runtime・README・AGENTS変更なし。混在WIPを保持しcommit/pushなし。remote最新確認と全体pytest/mypyは未実施。
既存全体型エラー268件は未解消で、今回の追加テストが全体型検査に与える影響も未計測。

関連75件・Ruff・asset整合・diff check成功。公開条件の緩和は行っていない。

## 2026-09-10 08:20 JST 比較fixtureの否定ケース

status/diffとstaged空を照合し、前回の比較bundleテストに監査ラベル不一致ケースを追加した。
claimとreviewはcomparison/contrastsだがadjudicationだけgenealogy/extendsのままの合成入力を使い、
hashをすべて再計算しても通常build_pilot_bundleが拒否することを確認した。
単なる古いhashによる失敗ではなく、意味上の不整合が受理されないことを検証する。
関連76件・Ruff・asset整合・diff check成功。runtime・README・AGENTS・公開データ変更なし。
比較プレビューへの接続と実画面確認、多数ノード画面確認は未完了。全体pytest/mypyは今回未再実行。
型検査は既存268件に加えて最近のテスト変更分が未計測。混在WIPを保持しcommit/pushなし、remote最新確認なし。

## 2026-09-10 10:21 JST 追加テストの型回帰修正

status/diff・空stagedを照合後、mypy --python-version 3.12 paperpilotを再実行した。
比較テストのobject添字アクセス6件により274 errorsへ増加していたため、list/dictの実行時assertで
JSON型を確認してからアクセスするよう修正。無条件castやignoreによる抑制は追加しない。
再検査は268 errors / 46 files / 286 source filesで、追加6件は解消したが全体型検査は未成功。
対象bundleテスト25件・Ruff・diff check成功。runtime・README・AGENTS・公開データは変更なし。
関連viewer等を含めた76件とasset整合も成功。
比較データのプレビュー接続と多数ノード実画面確認は未完了。全体pytestとremote最新確認は未実施。
混在WIPを保持しcommit/pushなし。

## 2026-09-10 12:22 JST 比較プレビューの配信接続

status/diff・空stagedを確認。比較bundle生成をbuild_synthetic_comparison_bundleへ抽出し、
開発専用previewに--comparisonを追加した。起動時に通常検証を通ったbundleだけをメモリで保持し、
indexとcontent-addressedな3資源を配信する。catalogは既存合成fixtureを使い、公開ファイルは書き換えない。
previewはテストmoduleのhelperを使うためpytest等の開発依存が必要で、製品runtimeとして扱わない。
既存の監査不一致拒否テストを維持し、配信資源からcontrastsを読めるテストを先に追加して確認した。
実ブラウザで比較を表示する際はfamilies=genealogy,comparisonの明示または比較checkboxを有効化する必要がある。
今回は画面検証までは未実施。多数ノードの画面確認も引き続き残る。

関連77件・Ruff・asset整合・diff check成功。全体mypy（Python 3.12指定）は268件のまま未成功。
README/AGENTS・公開データ変更なし。全体pytest・remote最新確認は未実施、混在WIPを保持しcommit/pushなし。

## 2026-09-10 14:24 JST 比較プレビューで判明した投影制約

status/diff・staged空を照合後、--comparisonでlocalhost検証した。
familiesにcomparisonを明示しても保存済みrelationsにcontrastsがなく、最初は関係タイプで除外された。
詳細条件の「対照」をUIから有効化するとeligibleは1件になったが、表示は1ノード/0関係、除外は枝の折り畳み1。
コード確認で比較はselectedNodesの両端が既に存在する場合だけ追加されることを確認した。
そのため比較だけでつながる論文が候補に入らず、今回の比較専用fixtureでは比較帯は描画されない。

新しい優先課題: 比較明示時の中心論文に直接つながる比較対象を、本数・関係数上限内で追加する設計を検討する。
既存の投影契約はselected nodes間のみとしているため、単なる座標修正とは分離し、設計18とcross-runtime
テストの整合を確認してから変更する。nodeLanesの比較区分と現在の投影条件の不一致を解消する必要がある。
今回runtime・README・AGENTS・公開データ変更なし。比較帯の実画面成功とは扱わない。
関連77件・Ruff・diff check成功。全体pytest/mypy・remote最新確認は未実施、型268件は未解消。
8766サーバー停止、混在WIPを保持しcommit/pushなし。

## 2026-09-10 16:26 JST 直接比較対象の投影修正

status/diff・staged空を照合。比較のみ・limit=5の合成テストで0件になる失敗を再現し、
中心へ直接接続する比較claimを既存選択の後に追加するよう変更した。比較6件・全体claim上限を維持し、
新規nodeはnodeLimitを守る。比較を再帰走査せず、genealogyを優先する。公開検証・filter条件は変えない。
設計18のselected nodes限定条件とREADMEの外部表示説明を更新し、asset同期でcore v4にした。
既存の両端選択済み比較は展開後のnode数を減らさないよう従来どおり追加可能とする。
実画面の比較帯確認は次の作業。全体型エラー268件は未解消。AGENTS・公開データ変更なし。
関連cross-runtime/契約/viewer/UI 76件・Ruff成功。比較のみの直接接続、limit=5、連鎖なしをテストで確認。
全体pytest/mypy・remote最新確認は未実施、混在WIPを保持しcommit/pushなし。

## 2026-09-10 18:27 JST 比較帯の実画面確認

status/diffとstaged空を照合後、--comparisonプレビューを起動し、URLへfamilies=comparisonとrelations=contrastsを明示。
実ブラウザで2/2論文・1/1関係、中心と比較対象の別区分、破線の対照関係が表示されることを確認した。
前回の「比較だけの論文が表示されない」問題はこの合成ケースで解消した。
新たな視覚課題: 縦の比較線が「比較対象（継承とは別）」の見出しを横切る。表示成功とレイアウト完成を区別し、
次は区分見出しの背景/描画順または線の経路を調整して可読性を確認する。多数論文と比較帯の375px確認も残る。
今回はruntime・README・AGENTS・公開データ変更なし。検証後8766サーバーを停止した。
関連77件・Ruff・asset整合・diff check成功。今回の目視確認はdesktopの比較2ノードに限定する。
全体pytest/mypy・remote最新確認は未実施。型268件未解消、混在WIPを保持しcommit/pushなし。

## 2026-09-10 20:29 JST 区分見出しの描画順修正

status/diff・staged空を確認。見出しが線より前に描画されていることをテストで再現し、
SVGの区分名を最後に描画するよう変更。文字の周囲に背景色の6px strokeを先に描くことで、
線が文字を横切る箇所を隠す。pointer-events:noneで下の監査操作を妨げない。
ノード座標や投影、監査条件は変更せず、文字可読性のみの限定修正とした。
関連52件・Ruff・diff check成功、asset同期はfocus JS v12/CSS v8。
最終見た目は未再検証で、線経路そのものの交差を解消したとは扱わない。多数ノード・比較375pxも残る。
README/AGENTS・公開データ変更なし。全体pytest/mypy・remote最新確認は未実施、型268件未解消。
混在WIPを保持しcommit/pushなし。

## 2026-09-10 22:30 JST 比較見出しの再検証

status/diff・空stagedを照合し、--comparisonをlocalhostで起動。
desktopと375×812で中心/比較対象の2ノード、破線、見出しを確認した。
文字の縁取りで区分名が読める。線経路は依然見出し位置を通るため、経路分離を実装したとは扱わない。
viewportをresetし8766サーバーを停止。runtime・README・AGENTS・公開データ変更なし。
多数論文の線/文字重なりは未検証。全体pytest/mypy・remote最新確認は未実施、型268件未解消。
関連52件・Ruff・asset整合・diff check成功。
混在WIPを保持しcommit/pushなし。

## 2026-09-11 00:32 JST 大規模合成データの準備

status/diff・空stagedを照合。既存test_lineage_v2_core.mjsの--emit機能を発見し、
mktempで作ったGit外の /tmp/paper-lineage-large.WMFzvA へ200ノード/1,000claimの合成releaseを出力した。
同スクリプトの35検証が成功し、index/catalogとhash付きartifact/fixture/qualityの5資源を確認。
これにより新しい架空監査データを手作業で増やす必要はない。公開docsは変更していない。
次はpreviewへ明示fixtureディレクトリ指定を追加し、synthetic-large/papers.jsonをcatalogへ対応させる。
指定ディレクトリ外の配信を拒否し、通常release検証とsynthetic警告を維持すること。
今回まだ配信・多数論文の実画面確認は行っていない。一時フォルダーは次回検証用に保持する（OS削除時は再生成可能）。
runtime・README・AGENTS変更なし、commit/pushなし。全体mypy・remote最新確認は未実施、型268件は未解消。

host補助の全体pytestは3,132 passed / 1 skipped（47.20秒、Linux専用RLIMIT_AS）。
Ruff・asset整合・diff check成功。Docker runtimeの検証済みという意味ではない。

## 2026-09-11 02:33 JST 明示fixtureディレクトリの配信

status/diff・空stagedを照合し、previewに--fixture-dirを追加した。--comparisonとは排他的。
既知のsynthetic-pilot/synthetic-largeの単一indexのみ受け付け、index検証、参照3資源のhash照合、
解決後のディレクトリ包含と各8MiB上限を確認する。catalogを学会pathへ対応させ、メモリから5資源だけを配信する。
HTML/assetsは従来のdocsから読み、完全なrelease検証はブラウザ側でも継続する。
テスト先行で未実装を確認後、既存fixtureの5資源・catalog非直接公開を検証した。
今回大規模データの起動・画面確認までは未実施。次は前回の/tmp/paper-lineage-large.WMFzvAを指定して確認する。
preview 12件・Ruff成功、全体mypyは268 errors / 46 files / 286 filesで増加なしだが未成功。
関連viewer/UIを含む53件とasset整合も成功。
README/AGENTS・公開データ変更なし。全体pytestとremote最新確認は未実施、混在WIPを保持しcommit/pushなし。

## 2026-09-11 04:35 JST 大規模releaseの画面検証

status/diff・staged空を確認後、前回の200ノード/1,000claimディレクトリをpreviewへ指定した。
ブラウザのrelease検証を通過し、limit=50/hops=3で16/200論文・18/894関係を表示。
関係上限876件除外が表示され、50本を実描画したわけではない。
desktop screenshotでノード自体は区分されたが、線が別カードを通過し、ラベルも密集することを確認した。
また中心と共有する後続へつながる別の先行論文等が「その他・要確認」に入り、分類不能と信頼不足の混同が残る。
次の改善は区分名を信頼段階と分離すること、線をカードに重ねない経路/強調表示を設計すること。
初期7本の制限は維持し、拡張画面が読みやすくなったとは主張しない。狭幅の多数論文は未確認。
関連53件・Ruff・asset整合・diff check成功。
8766サーバー停止。runtime・README・AGENTS・公開データ変更なし。
全体pytest/mypy・remote最新確認は未実施、型268件未解消。混在WIPを保持しcommit/pushなし。

## 2026-09-11 06:36 JST 関係区分と信頼段階の分離

status/diff・staged空を照合後、「その他・要確認」を「その他の関連論文」へ変更した。
テスト先行で旧ラベルを検出し、graphとカードで共用するnodeLanesのラベルを修正。
画面説明とREADMEに、区分は信頼段階ではなく各関係の詳細で根拠/信頼段階を確認することを追記した。
分類ロジック・投影・公開検証は変更しない。線がカードを横切る問題は別の未完了項目。
関連53件・Ruff・diff check成功、asset同期でfocus JS v13。今回の文言変更後の実画面は未確認。
AGENTS・公開データ変更なし。全体pytest/mypy・remote最新確認は未実施、型268件未解消。
混在WIPを保持しcommit/pushなし。

## 2026-09-11 関係線のカード回避（順次修正）

次の順序で改善する: (1) 無関係なカードを横切る線、(2) 線同士と関係ラベルの密集、
(3) 多数論文の狭幅表示とキーボード再検証。科学的根拠や公開ゲートは変更しない。

第1段階として、表示ノードから作る有限グリッド上を探索し、カードに余白を取った
直交折れ線へ変更。矢印はカード境界で止め、監査詳細用の操作領域にも同じ経路を使う。
到達できない異常配置ではカードを貫く直線に戻さない。関係一覧のデータは維持する。
途中カード回避・決定性・入力非変更のテストを先に追加し、未実装の失敗を確認後に実装。
50論文の混在配置では全49関係が経路を持ち、無関係なカードに交差しないことを検証した。

関連pytest 53件・Ruff・diff check成功。asset同期でfocus JS v15。
localhostの合成比較2論文と、大規模200論文中10論文/18関係の実画面を確認。
カードを避ける経路は確認できたが、共有経路とラベルの重なりは残り、第2段階で扱う。
今回の狭幅・実キーボード再検証、全体pytest/mypyは未実施。既知の型エラー解消は主張しない。
公開データ・AGENTSは変更せず、混在WIPを保持。commit/pushなし。

## 2026-09-11 08:43 JST ラベル重複抑制と文書照合

status/diff/stat・空stagedを確認。進捗表の比較帯・大規模表示の未検証という古い記述を修正した。
関係ラベルは長い経路区間から配置候補を試し、カード・区分見出し・既存ラベルの
保守的な矩形と重なる場合は別区間へ移す。置き場がない場合は文字だけを省略する。
線の操作領域・監査詳細・関係一覧は維持し、要確認の関係は操作領域の読み上げにも明記。
画面ヘルプとREADMEに省略の意味を記載。公開データや科学的判定の変更はない。

テスト先行で未実装の失敗を確認し、重複・カード回避を追加。関連53件・Ruff・diff check成功。
asset同期はfocus JS v16。大規模合成releaseの10論文/18関係をdesktopで表示し、
関係操作18件を保持したまま表示ラベルが15件となることと配置を確認した。
線同士の共有経路と線が文字位置を通る問題は残る。これは完全な配線分離ではない。
狭幅・変更後の実キーボード検証、全体pytest/mypy・remote最新確認は今回未実施。
既知の型268件は未解消扱い。AGENTS変更なし、混在WIPを保持してcommit/pushなし。

## 2026-09-11 10:45 JST ラベル配置の回帰検証

status・diff/stat・空stagedを照合。前回の実装に対し、最長区間がカードで塞がれた場合の
別区間への配置、経路入力の非変更、空経路、上端/左端へのはみ出し防止をテストへ追加した。
Nodeのviewer契約・Ruff・asset整合チェック成功。runtime・README・AGENTSは変更していない。
線同士の重なり、右端/下端のラベル境界検証、狭幅・実キーボード再検証は未完了。
今回mypyとremote最新確認は実施していない。混在WIPと既知の型エラーを保持し、commit/pushなし。

host補助の全体pytestは3,133 passed / 1 skipped（45.92秒、Linux専用RLIMIT_AS）。
Ruff・asset整合・diff checkも成功。Docker runtimeの検証済みという意味ではない。

## 2026-09-11 12:47 JST ラベルの右端・下端境界

status/diff/stat・空stagedを照合。前回残した右端/下端の境界について、はみ出す候補を
拒否するテストを先に追加し、旧実装の失敗を確認した。描画側からSVGのwidth/heightを渡し、
ラベル矩形が四辺の内側に収まる候補のみ採用する。境界と一致する候補は許容する。
既存の別区間探索と文字のみ省略する挙動、線の監査操作は変更しない。
関連53件・Ruff・diff check成功。asset同期はfocus JS v17。
READMEは既存のラベル省略説明で足りるため変更なし。AGENTS・公開データ変更なし。
今回の実画面、全体pytest/mypy、remote最新確認は未実施。全体pytestの直近実績は前節を参照。
線同士の重なり、狭幅・実キーボード再検証、既知の型エラーが残る。commit/pushなし。
