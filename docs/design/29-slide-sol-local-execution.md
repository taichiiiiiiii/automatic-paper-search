# 29. 一論文スライドのSol API接続

- **作成日:** 2026-09-05
- **状態:** S0/S1の固定profile・Sol adapter・共通service・CLIをローカル実装。mock HTTP縦断/表示確認済み。live API・review/publication・本番設定は未実施
- **対象:** [28のS0〜S2](28-next-delivery-plan.md)、ローカルCLI用の一論文・日本語・要旨版

## 1. 接続先と公式資料

ユーザー指定のSolをAPI側でも維持し、`gpt-5.6-sol`を使う。
2026-09-05に[公式モデル資料](https://developers.openai.com/api/docs/models/gpt-5.6-sol)で
ResponsesとStructured Outputs対応、標準input 4 USD / 1M tokens、output 20 USD / 1M tokensを確認した。
この値はアカウントのAPIアクセス権や課金枠の確認ではない。

方式は[Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs)に従う。
既存のchunk-summary/deck-content契約から閉じたJSON Schemaを構成し、モデル出力は既存validatorでも再検証する。
拒否、不完全出力、tool call、異なるmodel、usage欠落/不正を成功扱いにしない。

`store=false`、非background、非stream、toolsなし、truncation無効、標準service tier、reasoning mediumとする。
`store=false`だけで保存が一切なくなるとは説明しない。
[公式data controls](https://developers.openai.com/api/docs/guides/your-data)のabuse monitoringとapplication stateの違いを維持する。
このadapterはraw prompt/responseをローカルlogや成果物へ保存しない。

[公式prompt caching資料](https://developers.openai.com/api/docs/guides/prompt-caching)を確認し、
local pilotは`prompt_cache_options.mode="explicit"`かつ明示breakpointなしに固定して暗黙のcache writeを避ける。
Solのcache writeは通常input単価の1.25倍であるため、応答で`cache_write_tokens`が非0または欠損/不正なら
次のcallへ進めず失敗する。失敗した通信を未課金と推測して再実行しない。

## 2. bounded local profile

最初のlive canary候補は既存catalogの **Transformers without Normalization**（CVPR 2025）に固定する。
canonical IDは`2e768ddeb31010d467bebdd967799aae21a2380b`、sourceは`cvf`、source IDは
`Zhu_Transformers_without_Normalization_CVPR_2025_paper`。
2026-09-05に[CVFの原典ページ](https://openaccess.thecvf.com/content/CVPR2025/html/Zhu_Transformers_without_Normalization_CVPR_2025_paper.html)
の検索取得本文でtitle・著者・要旨を照合した（直接openは403）。
[著者のarXiv版](https://arxiv.org/abs/2503.10622)でもtitle・著者を確認したが、これを理由にcatalogのsource identityは変更しない。

- detail shard: `docs/paper-details-v1/2e.json`
- detail shard SHA-256: `c80bd9aee33607bebdc729a845ff3a749e262c38ebd9dac891275aaed292b436`
- abstract SHA-256: `921d7287261112eeb5501df680f8c74f3f81c50c42329d747271ce96be2880fd`
- abstract: 1,071 Unicode code points。本文の図表・実験値を生成入力へ補わない。

これはcanary対象の選定であり、生成実行、出力の内容確認、公開承認の記録ではない。
実行直前に同じcanonical IDと要旨SHAを再確認し、変更があれば対象を再凍結する。

profile名は`sol-abstract-local-v1`とし、model・adapter型・価格snapshotはコード所有のregistryで結合する。
利用者入力から任意endpoint、providerクラス、model、promptを組み立てない。
APIキーは`PAPERPILOT_OPENAI_API_KEY`または`OPENAI_API_KEY`の環境変数だけで受け取り、設定JSONやCLI引数には置かない。

| 条件 | 初期上限 |
|---|---:|
| 1回の実行対象 | canonical paper ID 1件 |
| coverage/language | `abstract_only` / `ja` |
| generation calls | 2 |
| 合計input tokens | 120,000 |
| 合計output tokens | 6,000 |
| 1 call output tokens | 4,000（chunk summaryは既存2,000） |
| wall time | 180秒 |
| 1 job 金額 | 1 USD |
| pilot実行回数/日 | 当初1件。live canaryを個別に記録 |
| 自動retry/fallback | 0 |

価格snapshotは2026-09-05確認版、2026-09-12 00:00:00 UTCに失効する短期profileとする。
expiry以降は新価格を確認してregistry/configを更新するまで実行しない。
cached-input割引を予算の必要条件にしない。reasoning tokensを含めAPI報告のoutput tokensで精算する。
課金のexactly-onceは主張せず、HTTP応答喪失時も自動再実行しない。

この日次1件は初期canaryの運用上限であり、CLIにWorkerのcoordinator quotaが自動適用されるという意味ではない。
複数人や無人の定期実行に開放する前に永続quotaを接続する。今回のlocal profileを本番request planeへ自動登録しない。

## 3. adapterとserviceの分担

- adapter: 固定HTTPS endpointへの一回の送信、closed request、usage/request hashの返却、redacted error。
  redirect、環境proxy/netrc、任意URL、tool応答を許さず、request/response byte・wall timeを制限する。
- token事前計算: 純ローカルで保守的に見積もる場合はexact tokenizerとは呼ばず、wire envelope/schemaも予算へ含める。
  実usageが予約上限を超えた場合は次のcallへ進めず、超過を正しく失敗として記録する。
- registry/profile loader: adapter型、model、価格hash、固定上限、時刻を既存`prepare_provider_execution`で照合する。
- service: catalog/detailからexact IDの入力を解決し、generator→provisional→preview bundleへ接続する。
- CLI: requestとoutput先を解釈し、固定profileをloaderへ渡す。キー未設定・価格失効などは送信前に停止する。

testはfake transport→本物のadapter→PreparedProviderExecution→本物のgenerator→rendererまで通す。
fake providerを使えるproduction flagや、環境変数による任意registry拡張を作らない。
APIキーとlive canaryが未確認の間は「mock transportで接続済み」と報告し、「実論文をAPIで生成済み」と報告しない。

## 4. reviewと成果物

freshな一時directoryへ`index.html`、`deck.json`、manifest、full-SHA CSS/JSをatomicに出力する。
既存directoryやsymlinkを上書きしない。previewには未レビュー・要旨のみの表示を残す。
各主張を同じdetail shardと要旨SHAへ遡れるようにし、review前のartifactをPagesへ配置しない。
人のapproved review recordがある場合だけ既存SD4のローカルreviewed bundleへ進める。

## 5. 検証

- key/profile/価格/入力不正はtransport call 0。
- 正しいmock responseで2 calls、citation付きprovisional、開けるpreview bundle。
- 429、5xx、timeout、redirect、oversize、拒否、不完全JSON、余分なtool output、usage不正で再試行0。
- model/input hash不一致、secret-shaped output、予算超過を既存generatorへ正しく伝える。
- output競合、symlink、path escape、fixture registry混入を拒否し、途中成果物を公開しない。

この文書の数値はlocal pilot用の上限であり、日次20-jobの本番API設定やDocker実imageの検証を代替しない。

## 6. ローカル実装の入口と現在の制限

- CLI module: `paperpilot.scripts.generate_paper_slides`。`--paper-id`と未作成の`--output`が必須。
  `--profile`の既定値は同梱の`paperpilot/data/sol-abstract-local-v1.json`。
  実行profileを外部JSONで指定しても、任意のmodel・論文・価格・上限へ差し替えることはできない。
- 初回pilotは本節で固定した論文IDと日本語のみ。共通serviceには別の承認済みexecutionを接続できるが、
  CLIのproduction flagでfixture providerや任意registryを有効にする経路はない。
- `--docs-root` / `--catalog` / `--detail-dir` / `--asset-dir`はローカル入力位置の指定。
  source ID・canonical ID・detail shard/要旨SHAに加え、固定したtitle/全authors/landing URL/PDF URLの
  照合を迂回しない。別catalogの同じIDに違う論文情報を付けても送信前に拒否する。
- 出力は`index.html`、`deck.json`、`manifest.json`、`assets/`。bundle rootをHTTP server rootとして表示する。
  file URLだけでCSS/JSを読めるとはしない。既存directory、symlink、途中失敗時の上書きは拒否する。
- stdoutはhash・coverage・review状態・actual token数・call数・時間・`cost_micro_units`。
  このprofileの1 micro-unitは0.000001 USD。事前のUTF-8 byte予約とAPIのactual usageは別物として扱う。
  cached inputの割引は計上額に反映しないため、この値は固定価格での保守的な予算計上であり請求実額の証明ではない。
  通信結果を失った実行を「無料」「未課金」と推定して再試行しない。
- Responsesのreasoning itemは[公式の応答形式](https://developers.openai.com/api/docs/guides/reasoning)に合わせ、
  未要求のsummaryを表示・保存せず、空summaryのmetadataと単一assistant JSON応答だけを許可する。
  正規の`encrypted_content`は全応答byte上限内で受け入れて破棄し、log/成果物/次のrequestに残さない。

local bundleの確定にはmacOS/Linuxのatomic no-replace操作を使い、同時に作られた空directoryも上書きしない。
必要なprimitiveがない環境では通常renameへ降格せず失敗する。DNS後のTCP接続、TLS、各送信、response読取も
同じdeadlineの残時間を使う。

主担当がmock HTTPから生成されたbundleを実ブラウザで開き、CSS/JS、要旨のみ/未レビュー表示、
slide移動、引用リンクと戻り先のhash/focus、320pxでの横overflowなしを確認した。
mockの本文はテスト用であり、Solが実論文の要約を生成した例や内容品質の評価ではない。

実APIの応答model表記、アカウントの利用権・課金、出力内容は未確認。API keyは未設定である。
Docker phase 1にはcredential付きnetworked operator targetがまだないため、このCLIを既存の
network無効`ops`で実行可能とは案内しない。正規のDocker実行target/image承認後にlive canaryへ進む。
