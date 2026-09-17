# PaperPilot の Qwen 実装担当

## 現行方針（2026-09-12）

実装・解析・文献処理・直接必要な単体/機能テストはFlashを使用する。実装入口は `.codex/bin/qwen-implement --role backend|frontend WORKTREE`。
固定ルートは exact `qwen3.8-flash` / `qwen_token_plan` Individual Token Plan。
既存Keychain `codex-qwen-token-plan` とToken Plan Base URLを使用する。
Cloud-only、PAYGなし、ローカルFlash・別モデルへのfallbackなし。`--interactive`は拒否する。
共有queueの既定は変更せず、呼出時に `--cloud-only --cloud-model qwen3.8-flash` を指定する。
catalogは既存 `/Users/example/.local/share/qwen-flash/cloud-flash-models.json` を利用。
launcher内の旧Flash引数はqueueの入力契約に必要な変換前情報であり、実行許可ではない。
runnerが変換後のモデル・catalog・endpoint・Keychain・retryを照合し、不一致ならモデル起動前に拒否する。
この設定作業では実装・論文処理・公開・live接続確認を開始しない。以下は過去の履歴。

MAX評価の対象・1回原則・10〜20%以内の目安・最小入力・親の最終採否はAGENTS.mdを正本とする。
`qwen3.8-max` は評価専用で再実装やFlashのfallbackにしない。現在の実装launcherはFlash固定のまま。
MAX評価入口: `.codex/bin/qwen-evaluate --parent-reviewed < evaluation.json`。
親だけが条件成立時に明示実行する。`--parent-reviewed`は意図の確認でありOS上の親本人認証ではない。
入口は既存queueへ `--cloud-only --cloud-model qwen3.8-max` を渡し、read-only、effort none、
シェル/子agent/連携無効、1回・再試行なしを固定。実装launcherは変更しない。
リポジトリを作業ディレクトリとして渡さず、空の一時ディレクトリでパケットのみ評価する。
入力はUTF-8 JSON、32 KiB以内、次の6項目のみ:

```json
{"reason":"cross-module","acceptance":"受入条件","changed_files":["path/to/file.py"],"diff":"必要な差分","test_results":"関連テスト・解析結果","context":"最小の周辺コード"}
```

reasonは `major-conclusion` / `analysis-method` / `statistics-reproducibility` /
`publication-candidate` / `cross-module` / `flash-failed-twice` のいずれか。
changed_filesは1〜12件、本文各項目は最大16,000文字。未知の項目、パストラバーサル、
代表的な秘密値・履歴/全repo/大量ログの指標を拒否する。任意の秘密や偽装された全repoを
完全検出するものではないため、親が必ず送信前に確認・秘匿化し、履歴や大量ログを入れない。
評価資格・10〜20%の目安・同一変更の1回原則は親が管理し、入口は自動再実行しない。
オフライン契約検証のみ実施。実サービスの認証・read-only実行は未確認。共有設定は変更しない。

<details>
<summary>履歴・非運用・現行起動に使用禁止（旧命令・実行例を含む）</summary>

現行手順は[AGENTS.md](../AGENTS.md)と評価入口の説明を参照。

## 履歴: Single-agent mode（2026-09-08）

> 履歴・非運用・現行起動に使用禁止。現行手順は[AGENTS.md](../AGENTS.md)。

サブエージェントは使用しない。現在の親エージェントが実装・調査・自己レビューを単独で行う。
native subagentの起動/再開も、`.codex/bin/qwen-implement`による外部Qwen/Flash委譲も行わない。
以下のrouting・opt-in・依頼書は無効な履歴であり、heartbeatや過去の直接依頼を根拠にworkerを再開しない。
既存launcher/roleファイルは保持するが使用しない。共有サービスや製品内のSolモデルは変更しない。

## 履歴: サブエージェント無効化前の経路

> 履歴・非運用・現行起動に使用禁止。現行手順は[AGENTS.md](../AGENTS.md)。

更新: 2026-09-06。既定は「Flashを基本、既存サブスク内の対話中依頼だけCloudで混雑補助」。
後続の直接依頼「Qwen Cloudで実装を任せて」は今回の限定実装へCloud専用opt-inとして適用する。
backend/frontendの開発実装だけを対象とし、親・調査・レビューのGPT-5.6 Solと製品内のSol生成は変更しない。
旧Cloud固定のAGENTS.md・PAPERPILOT_PROFILE.md・role指示は原則保持し、モデル選択については最新指示と
本書の現行経路を優先する。科学仕様、著作者/モデルを封印した既存実験、費用・時間・再試行・公開の制約は変更しない。

## 現行経路: Flash優先・対話的Cloud混雑補助

> 履歴・非運用・現行起動に使用禁止。現行手順は[AGENTS.md](../AGENTS.md)。

入口は`.codex/bin/qwen-implement [--interactive | --cloud-only] --role backend|frontend /absolute/linked/worktree`。
`--interactive`は先頭の単独flagだけを受け、既定は付けない。stdinや環境変数から対話性を推測しない。

2026-09-06の後続直接依頼「Qwen Cloudで実装を任せて」に対して、今回の限定Bは先頭単独の
`--cloud-only`でexact `qwen3.7-plus`/`qwen_token_plan`を要求する。既定や過去実行のモデルは変更しない。
`--interactive`との併用・重複・後置は拒否し、環境変数や通知からこのmodeを有効にしない。
queueへは`--cloud-only codex exec <既存固定Flash argv>`を渡し、queueがCloudへ変換する。
workspace/Cloud全体1枠を即取得できなければ終了2、Flash枠の占有・health判定・fallbackは行わない。
repo lockと待機後検査、Cloud provider/catalog/予算の照合、取消/終了時の回収は維持する。
Cloud-onlyで未変換のFlash argvが返った場合も実Codex起動前に拒否する。
共有queueの配置確認と模擬回帰が終わるまで、この追加modeで実モデルを起動しない。

- 既定: `qwen38-flash-next` / `qwen_flash_local` / effort `none`でFlash枠を待つ。
- 対話中: その場の直接ユーザー依頼として親が監督する単発実装に限り、親が`--interactive`を明示する。
  Flash2枠が両方使用中、作業場所が空き、bridgeが健全、Cloud全体1枠が空き、effortがnoneのときだけ、
  共通queueが開始前に一度`qwen3.7-plus` / `qwen_token_plan`へ振り分ける。
- heartbeat・定期メンテナンス・他タスクからの通知・自動goal継続には`--interactive`を絶対に付けない。
- 一旦待機した依頼は後からCloudへ切り替えない。開始後の失敗/429/認証/通信/時間超過を理由に
  別modelで再実行しない。PAYG、購入、追加bundle、reset等の経路を増やさず、既存サブスクだけを使う。

呼出先は`/Users/example/.local/bin/qwen-implementation-queue [--interactive | --cloud-only] codex exec ...`。
入力argvは固定Flashモデル・loopback provider・`/Users/example/.codex-local-flash/models.json`を指定する。
Cloud選択時のみqueueが固定model/providerと`/Users/example/.local/share/qwen-flash/cloud-models.json`へ変換する。
HTTP/stream retriesは0、idle timeoutは600,000ms、context/compactionは32,768/24,000を維持する。
実装全体の新しい時間・再試行予算をこの変更で追加しない。別途指定された上限にはqueue待機も含める。

共通queueと共有Flash領域は設定担当が所有する。repoから編集・再起動・lock奪取・削除をしない。
queueがCODEX_HOMEとprovider認証を所有し、repo runnerはユーザーconfigもKeychainも読まない。
旧名`qwen-cloud-runner.py`は互換のため保持したが、現在は共通queueを包むrepo supervisorである。

## Repo側で維持する境界

> 履歴・非運用・現行起動に使用禁止。現行手順は[AGENTS.md](../AGENTS.md)。

- 同じrepoのcleanなlinked worktree・非保護branch・exact top level・index flags等の検査とrole別policyを維持する。
  primary/main/master/develop/detached/foreign/dirty/untrackedは拒否する。
- repo全体1 workerの非待機lockをqueue投入前に取得し、待機・再検査・実行・後片付けまで保持する。
  repoがbusyなら即停止で、Cloudへ迂回しない。共有queueのworkspace/worker lockは別に維持される。
- queueには0700 private shim directoryだけをPATHとして渡す。消えたshimを元PATH上の実Codexで代替できない。
  shimはatomic startup/cancel gateをclaimし、queue通過後の全GIT_*を除去、元tool PATHを復元する。
  事前固定したGitでclean/branch/indexを再検査し、固定安全flagsと許可されたroutingをTOMLの意味で照合後、
  事前固定した実Codexへexecする。対話flagなしのCloud、改変された費用・権限・providerを拒否する。
- queueと別sessionのworker groupも記録して取消/終了時に停止し、遅発shimはclosed gateまたは削除済み入口で拒否する。
  promptはunlink済みFD、shim/gateはprivateな一時領域だけで、終了時に回収する。耐久queueや自動再開ではない。
- 引数/UTF-8/NUL/1MiB上限、worker tool network無効、workspace-write、apps/plugins/web/subagent/analytics無効、
  親Solの全差分レビュー・検証、製品Sol/Docker/公開gateを維持する。これは全ディスクのセキュリティ隔離ではない。

## Cloud専用opt-inの適用・検証（2026-09-06）

> 履歴・非運用・現行起動に使用禁止。現行手順は[AGENTS.md](../AGENTS.md)。

### 最新の直接指示: Qwen実装とレビュー修正の反復

> 履歴・非運用・現行起動に使用禁止。現行手順は[AGENTS.md](../AGENTS.md)。

ユーザーは前回のSol切替提案を採らず、「Qwenに実装させ、レビューで不良なら再度Qwenへ修正依頼」と指定した。
実装はexact `qwen3.7-plus` / Cloud-onlyを維持し、親とSolの独立レビューで具体的な指摘をまとめて同モデルへ戻す。
正常に返却されたコードの修正依頼は、provider通信失敗の自動retryとは区別する。
作業を小さく区切り、各差分の検証と独立レビューに成功したものだけ採用する。品質不良を理由にSolでruntimeを補完しない。
HTTP/stream retry 0、共有枠の非重複、busy時の即時停止、認証・費用・公開境界は変更しない。
以下の「担当変更の判断待ち」は前回終了時の記録であり、この直接指示によりQwenで再開する。

この反復（2026-09-06〜07）で原本照合/保存の高水準APIと回答取込CLIを採用した。
独立レビューが原本FDのclose故障時の漏れを検出し、Qwenへ戻した最小修正を2件の故障回帰と再監査で確認した。
API受入29件・CLI受入19件、全体host回帰3,004 passed / 1 skipped、全体Ruff成功。
全体mypyは268 errors / 46 filesで失敗、Docker/CI実行・実source・実人手監査・公開は未完了のまま。
親は独立検証と機械適用・formatを担当し、runtimeの意味的修正はQwenへ委譲した。
CLI修正前には採用済みAPI/testを生成入力へ追加し、隔離prep commit `8705346`に固定した。
全所有workerは終了、主作業HEADと既存WIPを保持し、primary commit/pushやモデル切替は行っていない。

### これまでの採用と停止記録

> 履歴・非運用・現行起動に使用禁止。現行手順は[AGENTS.md](../AGENTS.md)。

2026-09-07の直接依頼では学会snapshot共有検査を同じ反復で採用した。初回の自律編集はpatch失敗と禁止した
依存install試行のため停止（130、install失敗・隔離差分なし）。同モデルへtoolなしのソース限定で依頼し直し、
tool 0・終了0の返却コードを形式だけ機械補正して採用した。新25件・学会関連162件・独立監査104件が成功しP1/P2なし。
全体host回帰は3,029 passed / 1 skipped、Ruff成功、全体mypyは268 errors / 46 filesで未成功。
baseline assessment本体・Docker/runtime・実source・公開は未完了。実装の意味的なSol補完や主作業commit/pushは行っていない。
所有workerは終了済み。詳細は[34 §11](design/34-conference-baseline-assessment.md#11-2026-09-07-直接依頼-qwen実装レビュー修正の反復)を参照する。

後続の直接依頼「Qwen Cloudのqwen3.7-plusサブエージェントに実装」により、内部writer hookだけの
B1aへ分割して再開した。この単位はQwenのソースと修正を親が機械適用し、関連60件と独立レビューを通して採用。
自律編集の手順違反と不正確な追加テスト案は採用せず、完全自律実装が安定したとは扱わない。
この時点では原本reader/CLIは未実装だった。最新の採用範囲・検証・残作業は[設計33](design/33-private-review-intake-cli.md)を参照する。
さらに後続の継続委譲では、private directory openerと学会更新の前年度件数検証を同じCloudで実装・限定採用した。
Solは調査/独立レビューを並行し、Cloud実装は共有枠とrepo lockに従い直列。型/fixture誤用やFD漏れを
検証で戻し、製品runtime修正もQwenから取得している。詳細は設計33と[34](design/34-conference-baseline-assessment.md)。

先の「実装を全て行ってください」では、bounded private file reader、private answer path wrapper、
A/B一致時に第三者finalの矛盾を拒否するPython/ブラウザguardをCloud生成の小単位から採用した。
Solは独立レビューと検証を担当し、親が構文末尾・テストfixtureの補正と独立回帰の追加を行った。
最終host回帰は2,956 passed / 1 skipped、Ruffは成功。全体mypyは268 errors / 46 filesで失敗し、Docker gateは未検証。
大きな接続/assessment依頼は読取反復から進まず停止。接続の単関数2案もhelper契約・原本再検査等に不備があり未適用。
最終小修正は共有Cloud枠busyで即終了2（モデル未実行）。自動再試行/別model fallbackは行わず、所有workerは終了済み。
当時は高水準の原本照合/保存接続・取込CLI・baseline assessmentが未実装で、実装担当の変更をユーザーへ確認した。
この結果はQwenの小単位採用実績であって、全機能完成・安定した自律実装・公開可能性の証拠ではない。

以下の停止・未採用記録は先の大きなB1依頼の結果であり、小さなB1a採用とは区別する。

共有担当の最終配置通知後、配置先と`staging/cloud-only-20260906`の同一bytesを親が照合した。
SHA-256は`9f526618e2ee466fb2a97d24c00b6f6d8f8ff8467fffc1fbbbe99b7e9f675e7e`。
共有担当の配置bytes試験は43件成功（実Cloudを使わないprotocol試験を含む）。
repo側は親がlauncher模擬回帰35/35、profile 3/3、`.codex` Ruff、対象3ファイルのnarrow mypy、
shell構文・diff checkを再確認し、Sol独立レビューで対象runtimeのP1/P2指摘なし。
OpenAI Docsスキルに従い、既存provider認証・retry・権限を維持してroutingだけを拡張した。

直接依頼に基づく限定B1を`--cloud-only`で開始し、queueの実受付で
`mode=subscription-cloud-only; route=cloud; model=qwen3.7-plus; automatic_retry=0`を確認した。
Qwenは原本/回答readerのソースと先行テストを返し、tool呼出し0・212.8秒・終了0だった。
親がpatch表記だけを機械正規化し、隔離先でテスト先行REDを確認したが、初版は採用不可。
fixture誤用で新21件中20失敗、Ruff8指摘・narrow mypy1指摘、path再束縛等の安全境界も不足した。
製品runtimeをSolで補完せず、具体的な修正点を同じCloudへ戻したが、ソース生成形式は拒否された。
通常の編集・テストを許す次の限定実行も資料読取22件とコンテキスト圧縮警告3件を繰り返し、編集に進まなかった。
親は上限900秒を延長せず、進行停滞を確認した165.92秒時点で所有launcherを停止、終了143・隔離先cleanを確認した。
現在workerは停止済み。初版は未採用で、後続CLIのB2も未着手。接続成功と実装成功は区別する。
主作業の全体host補助回帰は2,864 passed / 1 skipped（46.16秒）。これは初版の採用やDocker検証ではない。

## 履歴: Cloud専用opt-in追加前の適用・検証

> 履歴・非運用・現行起動に使用禁止。現行手順は[AGENTS.md](../AGENTS.md)。

共通queueは設定担当が配置済み。配置先とstagingのSHA-256はともに
`7c7d59a4e1edcc2a65d1620076a8250712175c570a3d73e633e7ac65c8973330`とread-onlyで照合した。
この版は待機前にCodex実行パスも固定し、shim削除後のPATH再探索を行わない。
queue内のspawn開始からchild代入までのsignalは記録し、代入後に転送・回収する取消強化も含む。
repo側は偽queue・偽Codex・使い捨てGit fixtureだけで準備と回帰を行う。
設定通知自体は実モデル・Cloud・製品実装再試行を開始する許可ではない。

- host補助の全体pytestは **2,864 passed / 1 skipped**（46.03秒）。skipはmacOSで強制できないLinux専用`RLIMIT_AS`。
- repository-wide Ruffと`.codex`のPython 3.11指定Ruff、runner/launcher test/profile contractの
  narrow mypy（Python 3.12 / follow-imports skip、3ファイル）、shell構文とdiff checkが成功した。
  全体型検査の既知の278 errors / 53 filesを解消した結果ではなく、Docker runtimeの証拠でもない。
- Sol独立レビューで対象runtimeの残るP1/P2指摘なし。配置済みqueueのCloud変換（同一catalogの重複とTOML正規化）、
  startup/cancel、post-wait Git gate、子group cleanupの互換性をソースで確認した。
- launcher回帰 **32/32成功**、profile contract **3/3成功**。対話flagなしのCloud拒否、同値catalog重複の許可・
  異値重複拒否、固定安全flag/retry改変拒否、待機中dirty/protected branch、Git環境変数と偽Git PATHの複合汚染、
  遅発shim取消、停止を無視する孫process、正常queue終了後の子group回収を模擬実行で確認した。
- 実queue/model起動、Keychain取得、既存workerの停止、共有設定変更、
  commit/pushは行っていない。AGENTS/PAPERPILOT_PROFILE/固定role指示/native設定は今回変更せず、既存WIPを保持した。

実機のFlash/Cloud接続、サービス側のeffort解釈、継続的な利用枠はこの模擬試験から保証しない。
対話中かどうかの判定は親の責任であり、flagは人間の監督を認証する機構ではない。
取消では所有groupへ停止signalを送り、模擬子processの終了まで確認したが、別sessionへ逃れた任意processの
封じ込めやOSが停止不能なprocessまで保証する隔離機構ではない。共有lockの奪取・削除はしない。

OpenAI Docsの[構成リファレンス](https://learn.chatgpt.com/ja-JP/docs/config-file/config-reference)にある
provider/catalog設定とHTTP/stream retry指定を照合し、元の予算・権限を維持した。
具体的な共通routingの正本は設定担当の`/Users/example/.local/share/qwen-flash/HYBRID_ROUTING.md`である。

## 履歴: 2026-09-06前半のCloud固定実装

> 履歴・非運用・現行起動に使用禁止。現行手順は[AGENTS.md](../AGENTS.md)。

以下は当時の固定経路と検証記録であり、現在の起動指示ではない。旧Flashの記録も[履歴文書](FLASH_IMPLEMENTER.md)に保持する。

### 当時の固定経路

> 履歴・非運用・現行起動に使用禁止。現行手順は[AGENTS.md](../AGENTS.md)。

- 入口: `.codex/bin/qwen-implement --role backend|frontend /absolute/linked/worktree`
- model: `qwen3.7-plus`、provider: `qwen_token_plan`、設定上のeffort: `none`
- endpoint: `https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1`、wire API: `responses`
- 認証: ユーザー設定の既存Keychain lookup descriptorだけを検証してCodexへ渡す。
  ランナーはKeychainコマンドを実行せず、キーをリポジトリ・環境変数・引数・ログへ保存しない。
- 専用Python runnerはPython 3.11+ / POSIXが必要。実行毎に0700の一時Codex homeを作り、終了時に回収する。
  元のユーザー設定・認証ファイル・Flash専用home/catalogはコピーしない。親のSol設定や共有Flashキューも変更しない。
- 接続先・認証方式の変更、未知のprovider設定、別モデルへのfallbackは拒否する。HTTP/stream自動再試行は0。

OpenAI Docsの[プロバイダー・コマンド認証](https://learn.chatgpt.com/ja-JP/docs/config-file/config-advanced)に従い、
接続設定をproject configだけへ書かず、固定モデル指定と検証済みprovider descriptorをCLIへ渡す。
認証コマンドの参照名は引数に含まれるが、秘密キー自体は取得・埋め込みしない。

### 当時の作業・安全境界

> 履歴・非運用・現行起動に使用禁止。現行手順は[AGENTS.md](../AGENTS.md)。

主checkoutの最新ランナーから、同じリポジトリに登録されたcleanなlinked worktreeを指定する。
primary checkout、main/master/develop、detached HEAD、別repo、dirty/untracked、変更を隠すindex flagsは拒否する。
Git common directoryの安定したロックファイルで、このrepoの実装workerを同時に1件へ制限する。
実行中なら待機・再試行せず終了し、親が前のworker終了と差分を確認してから次を依頼する。
ロック後にもbranch/index/dirtyを再検査する。共有Flashサービスや他プロジェクトのworkerは操作しない。

親が許可ファイル、受入条件、テストを固定し、必要な未commit入力だけを隔離先へ準備する。
通常のworktree作成だけでは未commit成果物は引き継がれない。秘密情報やデータ一式を一括コピーしない。
ワーカーはbranch操作・commit/push・依存追加・公開・実source API呼出しを行わず、親Solが全差分を再レビューする。

`workspace-write`、承認`never`、worker tool network無効、apps/plugins/web/subagent/analytics無効を維持する。
固定providerへのCodex制御通信は承認されたクラウド推論経路であり、workerツールのネットワークとは別である。
プロンプトと起動gateは、全ディスクの読取隔離や完全なセキュリティ境界ではない。
context 32,768 / compaction 24,000は保守的な実行予算で、Plusの実際の容量を確認した値ではない。
実接続の記録は末尾を参照する。設定上のeffort `none`のサービス側の厳密な解釈、
全tool互換性と継続的な利用枠を、一回の応答から保証しない。
Docker、製品API、公開の各承認gateは変わらない。

### 当時の検証

> 履歴・非運用・現行起動に使用禁止。現行手順は[AGENTS.md](../AGENTS.md)。

模擬Codex・模擬provider設定・使い捨てGit repoで、モデルと接続経路、両roleの指示、入力・worktree境界、
認証設定の拒否、排他制御、終了コード・一時home回収をオフライン検証する。

```sh
python3 .codex/tests/test_flash_launcher.py
```

テスト名の`flash`は旧入口との連続性のため残しているが、共有Flashサービスへの依存はない。
host-only `paperpilot/tests/test_agent_profile_contract.py` も現行Qwen/Solの担当分離を検査する。
モデル設定を切り替えた最初の変更では、課金を伴う推論・Keychain値取得・実API接続・commit/pushを行っていない。
設定反映とオフライン成功は、`qwen3.7-plus`が実サービスで利用できた証拠ではない。

2026-09-06の設定変更時のオフライン検証結果:

- 外部ランナー回帰 **22/22成功**、agent profile contract **3/3成功**。
  模擬workerの異常終了、公開launcher PIDへの停止と停止を無視する孫processの終了、終了143の伝播、
  一時home回収とロック再利用も確認した。shellは一時promptを開いてunlink後、Python runnerへexecする。
- 対象Ruff（host runnerはPython 3.11+）、shell構文、`git diff --check`に成功。
- runnerとprofile contractのmypy（Python 3.12 / follow-imports skip、2ファイル）成功。Python 3.11指定でpytest依存まで含めた試行は
  インストール済みNumPy stubのPython 3.12構文で停止した。プロジェクト全体の型チェック成功とは扱わない。
- 実ユーザー設定のprovider descriptorは固定endpoint / Responses / Keychain参照の検証に成功。
  参照先の秘密キーは取得せず、モデル利用枠・API互換性・生成品質は未確認。
- Solの独立レビューでも22/22・3/3と対象lint/型/構文を再検証し、残るP1/P2指摘なし。
  実Codexのオフライン設定解析も成功した。Keychain取得や推論API通信は行っていない。

### 2026-09-06 実装再開時の実接続

> 履歴・非運用・現行起動に使用禁止。現行手順は[AGENTS.md](../AGENTS.md)。

後続のユーザー依頼「実装を進めてください」を受け、固定経路で開発用のQwen推論を実行した。
短いcanaryは`QWEN_IMPLEMENTER_READY`を返して成功し、その後のソース生成にも実応答した。
これは製品内のSol生成、実論文source収集、Dockerや公開経路の実行ではない。

モデル一覧の応答形式がCodexの期待と異なるためmetadata警告が出る。推論応答は得られるが、
autonomous jobでは繰り返し読込・compactionとprocess IDの誤りがあり、安定した自律実装を確認できていない。
この依頼で起動したworkerを終了確認した後、cleanなlinked worktreeを入口に、toolを使わず
小さなソース/差分を返す依頼へ分割した。親が機械適用・全差分レビュー・テスト、別のSolが独立監査する。
生成テストにもAPI誤用があり、実行失敗をQwenへ戻して修正した。残るrace-winnerの誤path指定は
Solのレビュー指摘に沿い親が補正したが、製品runtimeはQwenの差分を維持し、別modelへのfallbackはしていない。

最初の対象は[非公開レビュー保存API](design/33-private-review-intake-cli.md)。
主checkoutではなく限定入力の準備commitだけを隔離branchへ作成し、既存の作業差分を保持した。
受入状況は同文書と[workboard](design/13-agent-workboard.md)に記録する。
保存APIの追加21件・関連129件、主作業側の全体2,864件成功（Linux専用1件skip）と独立レビューまで確認した。
CLI全体や今後の自律jobの成功を保証する結果ではない。

</details>
