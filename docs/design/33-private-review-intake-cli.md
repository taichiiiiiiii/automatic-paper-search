# 33. 家系図レビュー回答の非公開取込CLI

- 作成日: 2026-09-06
- 状態: 限定A、B1の原本/回答reader・全byte照合・保存前後再検査・高水準接続、B2の取込CLIをローカル採用。旧初版の却下記録は保持し、実人手監査・第三者final・公開・Docker稼働は未完了。
- 正本: [31](31-private-review-and-conference-candidates.md)、[32](32-local-update-and-review-intake.md)
- 限定A/Bの実装: `qwen3.7-plus`。[現行共通経路](../QWEN_IMPLEMENTER.md)で実装とレビュー指摘の修正を依頼した。
  設計・独立レビュー・採用判断はSol。各単位の著作者・実行記録は保持する。

## 対象

`python -m paperpilot.scripts.ingest_lineage_review`を実装した。
既存準備CLIと同じartifact/catalog/candidate/source bytes・識別子・作成日時に加え、
配布した3原本のdirectory、返却されたA/B回答コピー、取込日時、新規private出力先を指定する。
少なくとも一方の回答を必須とし、もう一方の欠損はpendingとして保持する。

保存原本を直接bundleとして復元せず、元入力から同一process内で`prepare_blind_review`を再実行する。
生成されたcoordinator/A/Bの3ファイルと保存原本を全byte比較し、一つでも違えば取込前に拒否する。
回答の検証・pending/complete/disagreement判定は既存pure intake APIへ委譲する。

最初の限定Aは`review_io.py`と`test_private_review_intake_io.py`だけを変更する。
原本/回答readerと新しいCLI・その直接テストは後続の限定Bに分ける。
既存factory・回答検証・schemaの条件は弱めない。既存のprivate directory writerを内部で共有し、
新writerはbundleと回答bytesからpure intakeを呼び直してから保存する。
呼出側が直接構築した結果objectや任意bytesを検証済みとして受け取らない。

## 非公開境界

原本は絶対・非Git・no-symlink・現在ユーザー所有の0700 directory内の固定3ファイルだけ。
各ファイルはregular/0600とし、descriptorを固定したbounded readで変更を検出する。
回答も非Gitの現在ユーザー所有0700親配下から読み、group/otherへの公開、symlink、特殊file、
サイズ超過、読み取り中の変化を拒否する。

出力は新規0700 directoryの`intake.json`（0600）一つだけ。
既存出力を上書きせず、親のidentity/権限変化、競合する作成者、失敗時の後片付けは既存writerと同じ条件で検査する。
原本directory配下を出力先にする指定も拒否し、3原本の検査後に4件目のentryを加えることを防ぐ。
pathの別表記だけで回避されないよう、正規化したpathと固定したdirectory identityを照合する。
stdoutはstatus・候補数・両者回答数・pending数・不一致数・結果hashの6項目に限定する。
stderrは固定error codeのみで、path・回答・確認者名・抜粋・論文metadataを出さない。

結果に残るのは回答原本のhashであり、回答コピー全体は複製しない。
運用者は元入力・配布原本・実回答コピーを別の非公開領域に保持する必要がある。
`complete`は取込上の回答一致であって、実在の本人・独立性・原典確認・第三者裁定の認証ではない。
artifact/監査fixture/quality/publicationの4認可は常にfalse。

## 受入と次のgate

TDDで正常3状態、原本byte改変、回答改変、source-less unknown、引数誤り、privacy/size/symlink/FIFO、
出力競合・parent swap・権限拡大・write failure cleanup、ログ非開示と既存準備CLIの互換性を検査する。
親が全差分と実行結果を再確認し、Solが独立監査する。host補助テストとDocker稼働確認は区別する。
保存API採用時にAPIの利用境界を文書化し、CLI採用後にREADMEのコマンド利用方法と
build-only wheel同梱検査を追随する。

実人手による原典照合・裁定・focus labels、実source収集、trusted state、Docker承認image/runtime、
定期更新や公開の有効化は対象外。人手の回答をAIが代作したものを実記録として扱わない。

## 実行準備

### 最新: Qwen実装→レビュー→Qwen修正の反復（2026-09-06〜07）

- ユーザーはSolへの実装切替ではなく、Qwenへ具体的なレビュー指摘を戻す反復を指定した。
  exact Cloud `qwen3.7-plus`を維持し、親/独立レビュアーが先行検証・差分監査を担当した。
- `write_private_review_intake_from_paths`を採用。factoryの3原本と全byte一致、各file/directoryのfingerprint、
  取込直前と保存前後の再照合、原本が出力ancestorへrenameされた場合の拒否を既存helperで接続した。
  pure intakeは1回だけで、結果の4認可は常にfalse。返却値は保存先Pathではなく`PrivateReviewIntake`。
- 親の独立受入24件はAPIなしで全RED。追加3件を含む27件が成功後、独立監査で原本FDのclose初回故障時の漏れを発見。
  正常/回答errorの2回帰を追加してREDを確認し、Qwenの最小cleanup修正でGREEN、再監査P1/P2なし。
  最終API受入29件、readerを含む62件、主作業の保存境界を含む95件が成功した。
- 新CLIは既存prepare parserと単値flag検査を再利用する。既存prepareの挙動を変えず、同じ元入力read/factory生成を
  新CLIで1回実行し、高水準APIへ回答pathを渡す。回答なしを全read前に拒否し、成功は6項目JSON、失敗は固定codeだけ。
  親の独立19件はmoduleなしで全RED、QwenのAPI名/summary/型注釈修正後にGREEN。prepare/API込み75件、独立監査P1/P2なし。
- Qwenの修正稿が探索を反復した試行は所有workerを停止（130）し、採用済みAPIと受入検証を生成用sourceへ補充した。
  準備commitは隔離branchの`8705346`だけ。runtimeの意味的修正はQwenへ戻し、親は機械適用・formatと独立テストを担当した。
- build-only workflowへQwen生成の3行（CLI同梱1件とprepare/ingestのwheel help検証2件）を追加。
  契約テストRED→関連13件成功、ローカルwheel build成功。wheel展開先だけからPaperPilotをimportして両CLIのhelp成功・
  tests非同梱を確認した。この起動検証は既存host依存を利用しており、CIのclean依存installやDocker runtime gateの証拠ではない。
- 作業記録は`/private/tmp/paperpilot-complete.Jqix6V`、候補は同親の`intake`、生成入力は`source`。
  最終host全体回帰は3,004 passed / 1 skipped（46.50秒、Linux専用RLIMIT_AS）、全体Ruff・対象format・diff check成功。
  全体mypyは268 errors / 46 files / 279 source filesで未成功。対象runtime/独立テスト4ファイルのnarrow mypyは成功した。
  実人手回答・実source API・公開・Docker起動・primary commit/pushは行っていない。

以下は各実行時点の履歴であり、「未実装」はその時点の状態を示す。現在の採用範囲は冒頭と上記を正とする。

- 隔離先: `/private/tmp/paperpilot-qwen-delivery.sykVdz/lineage`
- branch: `codex/qwen-plus-implementation-20260906`
- 準備HEAD: `a7b3091`。主作業の未commit入力を選別し、隔離先だけに準備用commitを作成した。
- 既存入力の補助回帰: 108 passed。主作業の成果物・既存worktreeは保持した。
- Qwenの短い接続確認は`QWEN_IMPLEMENTER_READY`を返して成功、ファイル変更なし。
  モデル一覧の形式に関するmetadata警告は出たが、指定モデルの推論は応答した。
  この確認だけではコード変更・tool利用・実装品質の成功とはしない。

## 限定Aと残作業

`write_private_review_intake(bundle, output_dir, *, answered_reviewer_a_bytes,
answered_reviewer_b_bytes, incorporated_at)`は、同一process内でfactory生成したbundleと
回答bytesを再検証し、`PrivateReviewIntake`を返す。結果を直接渡すAPIではない。
固定`intake.json`のみを新規private directoryへ保存し、元の3原本writerとatomic保存処理を共有する。
低水準APIは両回答Noneをpendingとして許容するが、CLIでは少なくとも一方を必須にする。
入力検証の`ReviewIntakeError`と保存境界の`ReviewIOError`は別型のまま保持し、後続CLIで双方を
固定codeだけへ変換する必要がある。

Qwenの自律tool実行は繰り返し読込・compactionや実在しないprocess IDへのwaitで進行が停滞した。
この依頼で起動したworkerだけを停止し、設定/modelを変えず、Qwenが小さなソース差分を返し、
親が`apply_patch`で適用する単位へ分割した。生成したテストのAPI誤用は実行・レビューで検出し、
Qwenへ修正を返した。最後に残ったテストのrace-winner誤path指定は、Solのレビュー指摘に沿い
親が3行を補正した。製品runtimeの実装はQwenの差分を維持し、format以外の書換えはしていない。
生成直後の成果や終了codeだけを採用成功とは扱わない。

追加21件と既存108件の関連テスト、対象Ruff/format、`review_io.py`のnarrow mypyが成功した。
主作業側の全体回帰も **2,864 passed / 1 skipped**。skipはmacOSのLinux専用`RLIMIT_AS`。
Solの独立レビューでは追加テストを含め必須指摘なし。factory呼出し1回、noreplace完了後の
parent swapでも交換先の内容を保持して所有出力だけを回収することを別途probeした。
全体mypyの既存エラーは未解消で、今回のnarrow検証を全体成功へ読み替えない。
実行は合成fixtureによるhost補助検証であり、実人手の回答、実source APIやDocker実稼働の証拠ではない。

残る限定Bは、保存3原本の安全な再読込と全byte一致、回答のprivate bounded read、
原本配下への出力拒否（alias/identityを含む）、CLI引数・6項目summary・安全なstderrである。
限定Aだけでは、disk上の原本から取込までの一連のCLI操作はできない。

## 限定Bの実装前確定事項（2026-09-06）

後続の直接依頼「Qwen Cloudのqwen3.7-plusサブエージェントに実装」を受け、B1をさらに分割する。
最初のB1aは既存writer内部の禁止ancestor identityと保存前後callbackだけを対象にする。
新しいprivate helperのテストは合成bytesで行い、bundle/回答readerやCLIはまだ接続しない。
既存public writerの引数・既定動作は不変。Qwenが先行テストとruntimeを編集し、親が全差分を再検証・独立監査する。
この部分の成功だけでB1全体・原本読込・取込CLIを完成扱いにはしない。

次のB1b-1はprivate `_open_private_review_directory(path, *, invalid_code)`だけに限定する。
absolute/no-dotdot/no-symlink/non-Gitのdirfd traversalとfinal uid/0700を検査し、返却FDはcaller所有。
物理解決せず保持したpathは後続readerの再open/identity比較に使う。現段階ではパス再束縛やfile読込は未接続。
unsupported platform codeは保持し、他のpath/helper失敗は指定された固定codeへ閉じる。

### B1b-2の採用（全実装の直接依頼・2026-09-06）

同じ依頼の後続で、`_read_private_answer(path)`もQwenの単関数生成から採用した。
absolute/no-dotdotのpathを検査し、既存private directory/file helperを使って正確なbytesを返す。
サイズ/変更/unsupportedの固定codeを保持し、正常close前の故障時にも所有FDをfinallyで回収する。
親が独立verificationとして新12テストを作成し、12 failedからreader21件込み33 passedを確認した。
Ruff/narrow mypyとSol独立レビューに必須指摘なし。既存writerの引数や公開機能は変わらない。
原本比較・保存callback接続は後続であり、このwrapperだけでは取込CLIは使用できない。

- Qwen Cloud `qwen3.7-plus`の生成・修正sourceから、borrowed directory FDを維持する
  `_read_private_review_file`と8項目のfile fingerprint helperを追加した。
  private記録は`/private/tmp/paperpilot-complete.Jqix6V`、検証候補は同親の`intake`。
- current euid/exact0600/regular/nlink1、cap+1、file pre/post/named fingerprint、
  読込前後のcaller-visible directory再openとfull fingerprintを検査する。自分が開いたFDだけ回収する。
  原本を複数回読む高水準callerは、別途最初のdirectory fingerprintを保存し、呼出間も比較する必要がある。
- 初版の存在しないOS API、次版のplaceholder上書き/構文不良は却下した。関数単体の再生成と
  exact型/effective UID条件を同じCloudから取得し、既存helperを維持して機械適用した。
  最後の回答の不適切な`self._fail`行は採らず、既存`_fail`と生成条件だけを用いた。
  親は生成テストのsame-byte置換、parent swap、write/restore、post-stat故障fixtureとformatを補正した。
- 新21件は未実装状態で21 failed、候補で関連69件、主作業で準備CLIを含む96件成功。
  Ruff/narrow mypy/diff check成功。独立監査P1/P2なし。
  別probeで実cap+1読込、ancestor symlink/Git、全internal open/close故障点の固定code、
  FD差分0とborrowed FD維持を確認した。これら深いprobeの永続回帰化は残る。
- reader採用後の全体host回帰は2,939 passed / 1 skipped（47.49秒、Linux専用`RLIMIT_AS`）。
  全体型負債/Docker gateの成功とはしない。高水準接続のまとめ依頼は28件以上の読取から編集に進まず、
  所有workerを201.16秒で停止（143）、source worktree clean/lock解放を確認した。製品実装の採用は0件。
  回答path wrapperは上記の別単位で採用済み。原本比較と保存callback、CLIは未実装。
- 続く高水準接続の単関数生成は2案とも未適用。初案は既存APIへの引数・戻り値・保存先の誤り、
  修正案もprivate helperの迂回、原本名の誤り、FD漏れ、取込前の原本再検査不足等が残った。
  最終の小修正は共有Cloud枠busyで即終了2となり、モデルを実行していない。再試行/fallbackをせず停止した。
  source worktreeはclean、所有worker残存なし。Solでruntimeを補完せず、担当変更の判断はユーザーへ返す。
  本項の読込helperと第三者final整合性guardを統合後、主作業のhost全体回帰は2,956 passed / 1 skipped。
  全体型検査は268 errors / 46 filesで未成功。公開・実回答・実source・pushは行っていない。

### B1b-1の採用（サブエージェントへの継続依頼）

- 最新の直接依頼でQwen Cloud `qwen3.7-plus`へ実装を委譲。親とSol独立レビューを並行した。
  private記録は`/private/tmp/paperpilot-qwen-directory.BWItDp`。必要な検証済み入力だけを準備したlinked worktreeを使い、
  primaryのHEAD/既存WIPや共有queue設定は変更しない。準備commitは隔離branchのみ。
- 初回はソース返却指定に反してtool編集し、runtime追加後にテストpatch形式エラーを反復したため、
  142.98秒で所有workerを停止（143）。その後は同じCloudから小さな修正/テストを取得した。
  親はコードの機械適用と、生成テストの固定code・macOS物理temp親・mode/祖先symlink fixtureを補正した。
- helperは絶対・no-dotdot・no-symlink・全ancestor非Gitのdirfd traversalとfinal uid/exact0700を検査する。
  返却pathはlexicalのまま、FD所有権はcallerへ移譲する。file bytesの読込やpath再束縛の検査はまだ行わない。
- Git helper由来エラーの固定codeへの変換漏れと、close失敗時に旧FDが追跡から外れるP2を独立検証で発見。
  修正もQwenへ戻し、所有FDのlist追跡・close成功後だけ追跡解除・失敗時の逆順best-effort cleanupを採用した。
- 新15件は旧コードでRED、適用後は関連75件成功。Ruff/narrow mypy成功。
  最終独立レビューにP1/P2なし。全open故障点、close処理前故障、UID不一致、unsupportedの別probeで
  固定code/FD差分0、unsupported時open 0回を確認した。これら深い故障注入の永続回帰テスト化は残作業。
- 次は返却pathとFDを利用したbounded file read、named-entry/fingerprint比較、原本の再束縛とwriter callback接続。
  新CLI・README利用方法の追加、実回答/実source、Docker稼働、公開はまだ行っていない。
  学会側の同時採用分を含む主作業の全体host回帰は2,918 passed / 1 skipped、Ruff・変更runtimeのnarrow mypy成功。

### B1aの採用（後続の直接Qwen Cloud指定）

- exact `qwen3.7-plus`/既存Token Plan/effort none/Cloud専用で実行。依頼と応答は
  `/private/tmp/paperpilot-qwen-writer-hooks.pCHd2U`に保持した。共有queue/config/model/認証は変更しない。
- 自律編集はpatch構文に失敗しshell書込へ迂回したため、親が162.84秒で停止（終了143）。
  新テストだけが生成され、runtime未変更。以後はQwenが小さなソースを返し、親が`apply_patch`で適用した。
  コード生成の各修正は同じCloudで正常終了し、別modelへのfallbackではない。
- 初回runtime差分のanchor検査漏れ、phase2 callbackでのFD回収漏れ、error code、precommitの
  `require_absent`誤りをレビューで戻し、修正もQwenから取得した。親は関数/3行の機械適用、
  import整形・unused除去・テスト名/説明を実際の検査内容へ合わせる編集だけを行った。
- `_open_output_parent`と全reopenに`forbidden_ancestor_identity`を渡し、anchorを含む各dirfdで照合する。
  `_write_private_files`の`revalidate_callback`はtemp作成前・rename直前・保存後の3段階。
  callback失敗は既存の所有物限定cleanup内で処理する。既存2public writerの引数・既定動作は不変。
- 先行REDは10 failed / 2 passed。適用後の新12件＋既存48件は60 passed、対象Ruffとruntime narrow mypy成功。
  主作業へ取込後の全体host補助回帰は **2,876 passed / 1 skipped**（46.37秒）。skipはLinux専用`RLIMIT_AS`。
  `.codex`をPython 3.11指定に分けた全体Ruff、runtime narrow mypy、diff checkも成功した。
  全体mypyの既存278 errors / 53 filesやDocker runtime gateが解消した証拠ではない。
  Sol独立監査はruntime P1/P2なし。別のinline probeで実root/中間ancestor、全3回のidentity転送、
  callback時点、各phaseのexact code/entry完全cleanup/FD増加0、rename直前の競合winner保持を確認した。
- 生成された通常テストは再openや競合の深い検証まで網羅していない。追加回帰テストのCloud生成案は
  構文・device/inodeの取り違え・誤path・例外型の誤りがあり、実行・採用せず応答記録だけに保持した。
  上記inline probeの永続的な回帰テスト化は残作業。初期12件の名前で深い検証まで済んだと主張しない。
- このhookはまだ原本readerから呼ばれていない。B1bでprivate read/原本path再束縛とcallbackを接続し、
  B2でCLIを実装する。実人手回答・実source API・公開・Docker稼働確認・commit/pushは対象外。

- 新規高水準APIは`review_io.write_private_review_intake_from_paths(bundle, original_review_dir,
  output_dir, *, answered_reviewer_a_path, answered_reviewer_b_path, incorporated_at)`。
  CLIが元入力からfactoryを一度実行し、APIはそのbundleを再検証する。disk原本からbundleを復元しない。
- `--original-review-dir`、`--reviewer-a-answer`、`--reviewer-b-answer`、`--incorporated-at`を
  既存prepare CLIの入力flagへ追加する。回答は少なくとも一方を入力open前に必須検査し、単値flagの重複・略記を拒否する。
- 原本/回答はabsolute・no-symlink・non-Gitとし、親directoryはcurrent uid/0700、fileはcurrent uid/regular/0600、
  hardlinkは`st_nlink != 1`なら拒否する。0400なども今回は拒否し、運用者が非公開コピーを0600で用意する。
  原本は固定3名・各既存cap（coordinator/blind pack）、回答は`MAX_ANSWER_BYTES`を用い、cap+1までのreadに限定する。
- directoryとfileのFDを固定する。read前後のfstatに加え、最終entryのdevice/inodeを再照合し、
  同名置換・directoryの名前/identity/uid/mode変化を拒否する。原本3件は再生成byteと完全一致が必要。
- 原本directory FDは保存完了まで保持する。出力は正規化pathの配下判定だけでなく、writerの初回/再open時の
  **全ancestor**を原本のdevice/inodeと比較して拒否する。precheck後のrename-swapも拒否対象とする。
  保存helperへ内部の禁止ancestor/原本再検査を渡せる最小拡張を行い、commit前後に検査し、失敗時は所有出力だけを回収する。
  既存の2 writerの引数・成功動作・競合保護は維持する。
- pure intakeは高水準API内で一度呼び、既存atomic保存helperを使う。CLIは結果を再計算せず、返却値から
  `status/candidate_count/dual_reviewed_count/pending_count/disagreement_count/result_sha256`の6キーだけを出す。
- 安全code: 両回答なし`answer_missing`、原本privacy/構造`original_review_invalid`、byte不一致`original_bundle_mismatch`、
  原本read/identity変化`original_review_changed`、回答privacy/構造`answer_input_not_private`、回答超過`answer_size`、
  回答read/identity変化`answer_input_changed`、原本配下出力`output_original_review_forbidden`。
  既存factory/intake/output codeは保持し、CLIの予期しない失敗だけ`review_intake_failed`に閉じる。
- 実装所有は`review_io.py`、新`ingest_lineage_review.py`と対応する新2テストのみ。
  TDDで3状態・source-less unknown・privacy/置換/rename-swap/ログ非開示を検証し、親が主作業側で再実行する。
  READMEとbuild-only package同梱契約は採用後に更新する。実回答/外部API/公開/依存追加/Docker実行は含まない。

### 限定Bの実行記録

- ユーザーの直接依頼「進めてください」を受けて新規の限定実装を開始。二つのSol調査/事前監査で契約を確定した。
- 隔離先は`/private/tmp/paperpilot-review-cli.GZfTSV/implementation`、branchは
  `codex/private-review-cli-20260906`、準備HEADは`48aad92607b735be415cbe7f062d2e63515444ad`。
  既存保存APIと必要なテスト/運用文書だけを選別し、129件の前提テスト・対象Ruff・narrow mypy成功後に
  隔離branchへ準備用commitを作成した。主作業developのHEADと既存WIPは変更しない。
- 依頼書は同一private親の`task.md`。親が監督する単発依頼として`--interactive`を明示し、共通queueは
  `qwen38-flash-next`/Flashを選択した。待機込み15分を上限とし、失敗時に別modelへ自動fallbackしない。
  受付・turn開始と4件のread-only shell callを確認したが、コード/テストは返却されなかった。
- 900.08秒で今回所有するlauncherへSIGTERMを送り、終了143を確認した。隔離先のstatus/diffはcleanで、
  準備HEADからのruntime/test変更は0件。TDDのRED/GREENや新機能の検証に到達したとは扱わない。
  最初の資料path誤りを含む読取操作はあったが、この記録だけで応答遅延の原因を断定しない。
  再試行・Cloud/Solへのfallback・共有サービス変更・他worker停止は行っていない。
- 主作業側は設計33とworkboardだけを更新し、README・package契約への新CLI記載は実装採用まで保留した。
  当時はSolへの引継ぎを確認したが、後続の直接回答はQwen Cloud指定だった。製品実装・実回答取込・公開を完了扱いにしない。

### 後続の直接Cloud指定（初版却下・修正実行停止）

- ユーザーの「qwencloudでzissouwomakasete」を受け、既存サブスクのexact `qwen3.7-plus`へ限定して新規依頼した。
  自動fallbackではなく、Cloud専用opt-inの共有配置とrepo側35件の模擬回帰・独立レビュー後の明示実行である。
- 同じcleanな準備worktree/HEADを再確認し、B1（readerと保存接続）とB2（CLI）へ分割した。
  B1依頼書は`/private/tmp/paperpilot-cloud-intake.4jKCLR/task-io.md`。
  Qwenはtoolを使わずテストpatch・runtime patchを返し、親が先行テストのREDから機械適用・検証する契約。
- 実queueの受付はCloud専用/qwen3.7-plus/retry 0。待機込み900秒、失敗時の再試行・他modelへのfallbackなし。
  初回は212.8秒・終了0、tool呼出し0で2ファイルのソースを返した。回答はpatchの行prefix等がないため、
  親が構文のみ機械正規化して隔離先へ先行テスト→runtimeの順に適用した。
- 先行REDは新APIのimport失敗。初版適用後は新21件中20失敗/1成功で、多くが原本/outputを事前mkdirしたfixture誤用。
  Ruffはunused import7件と未定義monkeypatch1件、narrow mypyは`callable`型の誤用1件。
  既存対象121件は成功したが、新しいpath正規化/再束縛/保存後cleanupの欠陥もあり、初版は主作業へ採用しない。
- 修正は同じCloudモデルへ限定し、元のclean準備HEADから別の隔離先
  `/private/tmp/paperpilot-cloud-intake.4jKCLR/correction`（`codex/private-review-cloud-correction-20260906`）で依頼。
  privateな`task-correction.md`に検証失敗と具体的な安全要件を渡した。正常応答後のコード修正依頼であり、
  provider失敗の自動retryやSolへのruntime実装fallbackではない。B2 CLIは未着手。
- ソース生成形式の修正依頼は8.25秒・終了0で拒否回答となり、コード変更はなかった。
  モデルは「toolを使わず生成する条件」を実装・検証手順と矛盾すると判断した。
  直接ユーザー指定の実装範囲は維持し、同じcleanな隔離先で通常の編集・テストを許す限定B1へ手順を変更した。
  `task-autonomous.md`に所有2ファイル、既存venvの補助検証、具体的な修正点、900秒上限を固定した。
  モデル・認証・費用・公開の許可は拡張せず、親/Solの採用前監査を維持する。
- 通常実行でも同じ資料読取とコンテキスト圧縮を繰り返し、22件のread-only command・圧縮警告3件、
  file change 0だった。親が進行停滞を確認し、165.92秒時点でこのlauncherへTERM、終了143を確認した。
  900秒の上限到達とは区別する。隔離先のstatus/diffはclean、修正版のRED/GREENは未達。
  元の初版2ファイルは先の隔離先に却下資料として保持し、主作業runtimeには反映していない。
  Cloud実接続・初回ソース返却は確認できたが、安定した自律修正やB1完成は確認できていない。
  全worker停止済みで、別modelへのfallback・再開予約・commit/push・実source/実回答・Docker/公開はしていない。

学会更新側は別担当が並行調査した。次の小単位はCLIではなく、前年度のpublished state/catalogと
件数比率を結びつけるpure assessmentを推奨する。CLI化にはstate/snapshotの安全な逆変換契約が必要で、
任意整数のbaselineやcaller指定のreadyを信頼して接続しない。今回はこの別単位を実装済みとはしない。
