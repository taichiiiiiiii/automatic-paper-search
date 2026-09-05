# 27. Paper Slide request plane production boundary

- **更新日:** 2026-09-05
- **状態:** local adapters / producer / claimant lease / authenticated callback / HMAC claimant・provider fenceの休眠workflow足場 / provider予算境界まで実装・focused検証済み。本番entrypoint、binding、実provider stepは未接続
- **上位契約:** [`17-paper-slide-deck-contract.md`](17-paper-slide-deck-contract.md)、[`25-slide-search-action-contract.md`](25-slide-search-action-contract.md)

この文書は、検索画面から一論文のスライド生成を依頼するrequest planeを、本番へ接続する直前の実装境界まで固定する。
外部設定や公開を認可する文書ではない。`worker/index.ts` はruntime adapterを注入せず、`wrangler.jsonc`にも
Paper Slide用Durable Object class / migration / bindingはなく、browserの`PAPER_SLIDE_API_BASE`も`null`である。
この三つを同じactivation gateで変更するまでproduction routeは404のままである。

## 1. site構成

公開サイトを二つに分けず、既存のPaperPilotを一つの入口にする。

```text
GitHub Pages: 検索・選択カード・review済みdeckのread plane
        │ POST（paper_id / ja / autoのみ）
        ▼
Cloudflare Worker: request/statusとworkflow callbackのAPI plane
        │ atomic reserve / claim / status
        ▼
single Durable Object: capability hash、dedup、rate/cost、TTLのcorrectness plane
        │ new jobだけworkflow_dispatch
        ▼
GitHub Actions: source解決・生成・検証・candidate作成
        │ human review + exact-SHA promotion/release
        └──────────────────────────────► 同じGitHub Pagesへ静的公開
```

モード選択専用サイトや総合トップを別に作らない。既存トップと検索カードが入口であり、スライドは選択済み論文の
actionとして表示する。生成中candidate、PDF、抽出本文、prompt/responseはPagesへ置かない。

## 2. local component boundary

| component | local responsibility | production state |
|---|---|---|
| approved catalog producer | 28,300件のcatalogとfull-abstract shardから、一論文一recordのimmutable snapshotを決定論的に作る | 実snapshot未配置、pin未承認 |
| catalog adapter | code-owned pin、manifest hash、record hashを検証し、APIへclosed eligibility/job keyだけ返す | binding未接続 |
| public request API | exact origin/body、fresh request capability、rate gate、atomic reserve、new jobだけdispatch | entrypoint injectionなし |
| durable coordinator | server clock、single-active-job、request別capability hash、日次new-job上限、claimant lease/fence、TTL、bounded physical cleanup | wrapper/binding/migration未接続 |
| dispatch adapter | fixed GitHub HTTPS endpointへ6 fieldだけ送信し、結果を`accepted/rejected/uncertain`へ分類 | production token/runtime未接続。workflow fileは休眠 |
| workflow callback API | Bearer認証、claimant token、generation付きatomic claim、server-timestamped claim-bound status update | entrypoint seamのみ。secret未設定 |
| dormant runtime composer | 上記bindingとsecretをexact projectionから組み立てる | `worker/index.ts`から未使用 |
| provider execution boundary | exact adapter型・価格snapshot hash・job予算をcode-owned registryで承認し、一つの累積ledgerから既存generatorを一度だけ実行する | registryは空。live adapter/価格未承認 |
| SD4 offline review boundary | canonical provisionalとapproved reviewを再検証し、review record・reviewed deck・HTML・index入力をimmutable exact bytesへ投影する | workflow review取得、CAS promotion、release未接続 |
| dormant workflow scaffold | dispatchのexact 6入力、HMAC claimant、同bodyのbounded claim再確認、provider fence primitiveをclosedに検証する | callback origin/config SHA pinは`null`、registryは空、Secrets/provider stepなし。誤dispatchはclaim前に閉じる |

approved catalogはPDF byte digestをまだ持たないため、現行producerはfull-textを主張せず、検証済みfull abstractの
SHA-256を使う`abstract_only`だけをeligibleにする。provider/modelはcache identity用の明示configであり、
provider adapterや価格表の実行認可ではない。

## 3. dispatch and idempotency

外部HTTP timeoutを「未送信」と断定しない。

```text
reserve new job
  ├─ GitHub 204                         → accepted、queuedを維持
  ├─ 明確な4xx rejection               → failed + request revoke、503
  └─ timeout/network/redirect/5xx等     → uncertain、queuedを維持、202

same keyの再request
  └─ existing queued jobへjoinし、dispatchしない

workflow start
  ├─ atomic claim=true  → generation付き15分pre-provider lease
  │    ├─ resolving/fetching/extracting → 同claimantだけheartbeat/status可
  │    └─ running/generating update     → atomic provider fence
  │                                      fence成功後だけprovider実行可
  └─ claim=false        → duplicate/late/unknownとしてprovider実行禁止

claim response loss
  └─ 同じ256-bit claimant token + generation 0のexact bodyで再確認

pre-provider workflow loss
  └─ 通常workflowは自動reclaimしない。固定6時間grace後の明示操作だけ
     expected generation + 別tokenで最大1回（generation 2）reclaim可

provider fence後のloss
  └─ lease/reclaimは永久に無効。provider停止/完了を確認してから
     administrative reconciliationでfailedへ閉じる

claimされないqueued job
  └─ 900秒でfailed/retryableへ遷移
```

claimant tokenは別Secretの`PAPER_SLIDE_WORKFLOW_CLAIMANT_KEY`からHMAC-SHA256で導出する。
domain-separated canonical bytesにはdispatchのexact 6入力とGitHubのrepository / repository ID / workflow ref /
run ID / workflow SHAを含め、`run_attempt`は含めない。これにより同じrunの再実行・step retryは、初回claimの
応答喪失を同じtokenと同じ`lease_generation=0, reclaim=false`のbodyで最大3回まで確認できる。
tokenはworkflow output、log、artifact、status responseへ出さず、通常workflowは自動reclaimを要求しない。

したがって`queued`は「coordinatorに予約され、dispatch結果がacceptedまたは不確定」を表す。GitHubで実行開始が
確認できるのはatomic claim後の`running`だけである。callback statusの`updated_at`はworkflow bodyから受け取らず、
Worker / Durable Object側の時計に結び付ける。

この方式は自動的な二重dispatchを防ぐが、外部送信や外部providerの厳密なexactly-onceを主張しない。workflowは
provider callより前にclaimと`running/generating` fenceを必須化し、claim falseまたはfence不確定なら何も生成せず
終了しなければならない。同じclaimant tokenを並列processへ共有してはならない。

## 4. persistence and cost bounds

- request attempt: 既定2件/時/IP、global 200件/時
- status attempt: 既定12件/分/IP、global 60件/分
- new underlying job: 20件/UTC日。deduplicated aliasは消費しない
- request capability: logical TTLは最大24時間、永続値はhashだけ
- queued dispatch: 最大900秒。期限後はretryable failure
- pre-provider claim lease: 最大900秒。初回response lossは同tokenで確認するがgeneration 0では延長しない
- expired lease reclaim: 6時間grace後の明示操作、別token、最大1回。provider fence後は不可
- request-plane review candidate / preview status: 最大24時間（環境設定で短縮可）
- offline review artifact: hard maximum 14日。ただしon-demand promotionの実効期限は上記coordinator TTLを優先し、
  期限切れjobのartifactは公開せず新しいrequestから再生成する
- job/cache: 固定30日retentionとbounded ringで物理削除

rate window、request expiry、job retentionは新しいstorage keyを無制限に作らない。上限値は環境設定で下げられるが、
コードのhard maximumを超えて引き上げられない。Workers KVの独立get/putはdedupや予算の正しさに使わない。

## 5. activation gates

次を全て満たすまでproduction request planeを有効化しない。

1. **ローカル足場済み:** dormant `paper-slides-on-demand.yml`のHMAC claimant、generation付きclaim、
   `running/generating` fence、claim済みscaffoldの失敗closeはfocused test済み。provider command / stepはまだ存在せず、
   activation時は明示承認したbounded adapterをfence成功後にのみ追加する
2. provider adapter、model、価格snapshot、job/call/token/cost上限を同じreview単位でcode-owned registryへ承認する
3. approved catalog snapshotをread-only bindingへ配置し、exact pinをcode reviewする
4. module内で実装済みの`DurableObject` wrapperをproduction entrypointからexportし、新規SQLite-backed namespace、
   migration、bindingを設定する
5. GitHub dispatch token、coordinator update token、workflow callback token、HMAC用
   `PAPER_SLIDE_WORKFLOW_CLAIMANT_KEY`をそれぞれ別のSecretとして設定する
6. callbackのcode-owned origin pinとSecretを設定し、generic browser CORSから分離したwrong auth/unknown routeを同じclosed responseにする
7. bundle / local Worker emulatorでconcurrent request、timeout、restart、lost claim response、lease reclaim、provider fence、double workflowをE2E検証する
8. Dockerのapproved image digest、Linux isolation、visible-text gateを通す。未達なら`abstract_only`だけに固定する
9. 実装済みSD4 offline review境界へhuman review recordを供給する。promotion前にcoordinatorの
   `awaiting_review → publishing`を原子的に確認し、期限切れなら公開せず、新しいrequestへ閉じる。
   成功時だけcandidate promotion、exact-SHA Pages release、rollback、smokeを接続する
10. 最後に`worker/index.ts`のproduction runtime adapter注入、`wrangler.jsonc`のDurable Object
    class / migration / binding、browserの`PAPER_SLIDE_API_BASE`を同じrelease gateで有効化する

Cloudflareの現行要件に合わせ、新規Durable Object namespaceは
[SQLite-backed storage](https://developers.cloudflare.com/durable-objects/reference/durable-objects-migrations/)を使い、
deployed classは`cloudflare:workers`の
[`DurableObject` base class](https://developers.cloudflare.com/durable-objects/api/base/)を継承する。
設定だけを先に追加して休眠routeを誤って有効化しない。

## 6. subagent task boundaries

- catalog producer / adapter、coordinator、dispatch、callback、runtime composition、workflowは別ownerにする
- `worker/index.ts`、`wrangler.jsonc`、workflow、Secrets、public API baseはintegration ownerだけがactivation gateで扱う
- callback/DO変更はhigh、通常のfixture/CLI配線はmedium。Qwenは使わずSOLをtask riskに応じて使う
- 各ownerはfocused tests、closed negative cases、secret non-leak、`git diff --check`と残る外部gateを報告する
