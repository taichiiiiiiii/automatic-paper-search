# 25. Paper Slide search/action integration contract

- **更新日:** 2026-09-05
- **状態:** public index、SD4 offline review projection、selected-card integration、request/status consumer、approved catalog、永続coordinator、claimant lease/fence、dispatch、workflow callback、休眠runtime/workflow、provider予算境界、no-JS原論文リンクはローカル実装・fixture検証済み。productionはAPI base/trust rootとも`null`で、binding/live provider、no-JS公開deck link、production review済みartifactは未配置
- **親設計:** [`11-target-architecture.md`](11-target-architecture.md)、[`17-paper-slide-deck-contract.md`](17-paper-slide-deck-contract.md)
- **前提:** 既存のsearch v2と`?paper=<paper_id>`選択状態を再利用する

スライドを別サイトや別モードに分けず、一本の導線 **「探す → 論文を選ぶ → 内容をつかむ → 原論文で確認」** に統合する。
検索結果一覧から生成を直接開始せず、canonical `paper_id`で選ばれた論文カードだけに状態と操作を表示する。

## 1. user-visible states

表示状態は次のclosed enumとする。表示用文言をserverやLLMから受け取らず、browser側の固定辞書で出す。
これはAPIの`status`をselected card向けに縮約した表示状態である。`running | validating | publishing`は
`generating`へ、`failed | rejected | expired`は`failed`へ写像し、API responseに`state=generating`を作らない。

| state | 意味 | selected cardの操作 |
|---|---|---|
| `unavailable` | source/abstract/license等の入力条件を満たさない | disabled、理由カテゴリと原論文link |
| `requestable` | 生成依頼可能だがartifactなし | 「スライド案を作る」。確認dialog後のみPOST |
| `queued` | 依頼受付済み | request IDに紐づくstatus、重複POST禁止 |
| `generating` | offline candidate生成中 | progressを段階表示、キャンセル可能とは称さない |
| `awaiting_review` | provisional candidateあり、未公開 | 未レビューであることだけ表示。artifact/linkは公開しない |
| `published` | review済みexact deckが公開済み | 同一site内のdeckを開く |
| `failed` | 今回の依頼が失敗 | safe category、再試行条件、原論文link |

`failed`を`requestable`へ自動変換せず、request単位の結果と現在の可用性を分けて表示する。
abstract-onlyで生成する場合は、確認dialog、進行中、deckの全てで「要旨のみから作る」を明示する。

## 2. public read artifact

公開サイトが読むのはreview済みdeckだけを列挙したsharded indexとする。

```text
/automatic-paper-search/paper-slides-v1/index/<paper_id first 2 hex>.json
  schema_version: paper-slide-public-index-v1
  entries[]:
    paper_id
    language: ja | en
    deck_id
    deck_path
    deck_json_path
    deck_sha256
    html_sha256
    coverage: full_text | abstract_only
    reviewed_at

/automatic-paper-search/paper-slides-v1/manifest.json
  schema_version: paper-slide-public-manifest-v1
  manifest_path
  shards[256]: prefix, path, sha256, entry_count
```

- shardは`paper_id`昇順、同じpaper/languageは一件だけ。promotion時にCASで置換する
- production baseはコード所有の`/automatic-paper-search`だけとする。`deck_path`は
  `/automatic-paper-search/paper-slides-v1/decks/<deck_id>/<deck_sha256>-<html_sha256>.html`、
  `deck_json_path`は同revisionの`.deck.json`だけで、前者のresponse bytesを`html_sha256`、後者を
  `deck_sha256`で照合する
- provisional、reviewer ID、request ID、provider request ID、raw prompt/text、capabilityを含めない
- browserはindexのhash/source-of-truth manifestを検証できない場合、`published`へfail-openしない
- title-only、URL類似、配列位置だけでpaperへjoinしない
- index builderはprojection objectやcaller提供hashを入力にしない。各reviewed candidateと、開始時にbuilt-in immutable
  mapping/valueへdetachしたtrusted contextからdeck validationとpublic renderを毎回再実行し、entryと両hashを再導出する
- shardは全体10,000 entry、1 shard 8 MiBをhard maximumとする。`reviewed_at`は実在するUTC RFC 3339日時、
  小数秒最大6桁、全体20〜27 bytesだけを許可する
- `00`〜`ff`の256 shardを空でも必ずcanonical生成する。manifestはprefix順に全shardの固定path、byte SHA-256、
  entry countを持ち、256 KiBをhard maximumとする。browserはcode-owned expected manifest hashとの不一致、manifest欠落、
  shard欠落/hash不一致を「0件」と解釈せずfail closedにする
- builderの返り値はaggregate sizeを制限したimmutable exact-file bundle（256 shard、manifest、全deck HTML / JSON、
  full-SHA CSS / JS bytes）とし、integration ownerはそのmanifest SHA-256をbrowserが読むcode-owned trust rootへ固定する。
  manifest自身の自己申告hashだけを信頼せず、同一content-addressed pathの上書きを許さない
- review recordはSD4が別途供給するが、deck HTML / JSONが持つlinkはcanonical review-record bytesのfull SHA-256を
  pathへ含める。旧deck-ID-only pathやcontext/hash/binding不一致はpublic projection前にfail closedとする

## 3. selected-card behavior

1. existing `?paper=<paper_id>`をexact IDで解決する
2. paper detail shardとpublic slide index shardを独立に読み、失敗を混同しない
3. reviewed entryがあれば`published` linkを最優先する
4. entryがなければlocal eligibility projectionを表示するが、最終認可はWorkerが再検証する
5. request操作後だけstatus pollingを開始する。通常検索中はWorkerへrequestしない

一覧cardに常時大きなCTAを置かない。選択cardの「概要／関係／スライド」actions内に配置し、keyboard操作後は
状態headingへfocusを移す。戻る操作で検索条件・page・選択前scrollを復元する。

## 4. request boundary

Worker API契約は`POST /api/paper-slides`を所有する。browserから受けるclosed bodyは次だけとする。
現在はdependency-injected handler、Worker entrypoint seam、approved catalog、永続coordinator、dispatch、
authenticated workflow callback、HMAC claimant・provider fenceを持つ休眠runtime/workflow足場まで実装済みで、
production注入とbinding/providerへの接続は後続gateである。

```json
{"paper_id":"40 lowercase hex","language":"ja","coverage_preference":"auto"}
```

- URL、title、authors、abstract、PDF、provider/model、prompt、budgetをbrowserから受けない
- Workerはapproved catalog snapshotのexact `paper_id`を再解決し、生成workflowへsource identityだけ渡す
- origin allowlist、body/content-type/size、rate limit、daily cost ceiling、idempotencyを全てserver側で検証する
- approved catalog adapterは、source/PDFまたはabstract、coverage、language、deck/profile、extractor、provider/model、
  prompt/schema/license-policy versionを含むcanonical materialから導出した64桁lowercase hexの`job_key`を渡す
- 成功時は、POSTごとにfreshな`request_id`と、それとは独立した128-bit以上の`status_cap`を一度だけ返す。
  どちらにもpaper ID、email、IP、時刻などを埋め込まない。`request_id`単独は権限として扱わない
- 同じpaper/languageのactive jobは新しい有料jobを作らず共有する。ただし先行request自体を返さず、POSTごとに
  独立したrequest record、`request_id`、`status_cap`を発行し、`deduplicated=true`でjob共有だけを示す
- active jobのlookup/createは一つのatomic coordinator abstractionを通す。productionはDurable Objectまたは
  D1 transactionを使い、Workers KVの`get`→`put`を重複課金防止のcorrectness boundaryにしない
- 既定2 request/時/IP、20 new underlying jobs/UTC日とし、deduplicated aliasは日次job数を消費しない
- browserへGitHub token、workflow run ID、artifact URL、private preview capabilityを返さない

成功responseは`Cache-Control: private, no-store`とし、closed bodyを返す。

```json
{
  "ok": true,
  "status": "queued",
  "request_id": "paper-slide-...",
  "status_cap": "bearer secret returned once",
  "paper_id": "<40 hex>",
  "deduplicated": false
}
```

`status_cap`は同一tabの`sessionStorage`に必要な期間だけ保持する。URL、query、path、request JSON、cookie、
`localStorage`、history、DOM、analytics、run name、object key、logへ複製しない。

ローカルtestでは実workflowをdispatchしない。dispatchがtimeout等で不確定な場合はqueued jobを維持して自動再送せず、
同じkeyの再requestをそのjobへjoinさせる。queued jobは900秒でretryable failureになる。休眠workflow足場は別Secret
`PAPER_SLIDE_WORKFLOW_CLAIMANT_KEY`からdispatchのexact 6入力とGitHub run/job identityをHMAC-SHA256し、`psct_`付き
256-bit claimant tokenを決定論的に導出する。同じrunの再実行でもtokenを変えず、初回claim応答が不明な場合だけ同じ
`lease_generation=0, reclaim=false` bodyをboundedに再送する。tokenはoutput/logへ出さない。generation付きatomic claim後、
15分のpre-provider lease内に`running/generating`をatomic commitできた一件だけがproviderへ進める設計である。
fence後はtimeout reclaimせず、crash時はproviderの停止/完了確認後に明示reconciliationする。現行workflowにprovider
command / stepはなく、callback/config/registry pinもclosedである。live binding、実provider、Worker deployは後続gateである。

## 5. status boundary

statusは`POST /api/paper-slides/status`で取得する。bodyは次のclosed objectだけとし、同じrequestの
`Authorization: PaperSlide <status_cap>`を必須にする。

```json
{"request_id":"paper-slide-..."}
```

success responseは[`17-paper-slide-deck-contract.md`](17-paper-slide-deck-contract.md) §9のclosed envelopeに統一する。
API fieldは`state`ではなく`status`を使い、次だけを返す。

```text
ok, request_id, paper_id,
status: queued | running | validating | awaiting_review | publishing | published | failed | rejected | expired,
phase: resolving_source | fetching | extracting | generating | validating | awaiting_review | promoting | deploying | smoke | null,
coverage: full_text | abstract_only | null,
deck_id, preview_available, preview_expires_at, public_url, message_code, updated_at,
retryable: terminal statusだけのboolean
```

- `running/validating/awaiting_review/publishing`に進捗率を捏造しない。完了stepのclosed `phase`だけを表示する
- capability不正、unknown/revoked/expired requestは同じ404相当・closed body・bounded timing classとし、
  `request_id`だけではpaper/requestの存在を確認できない
- `rejected | expired`ではpreview/object accessを即時revokeするが、request alias自体はTTLまでterminal statusを返す。
  明示revokeされたaliasはunknown/wrong capability/期限切れaliasと同じ404にする
- status APIもIP/global rate limitと短いcacheを持ち、GitHub APIをpollごとに呼ばない
- pollingはvisibility-aware exponential backoff、最大時間、`AbortController`を持ち、page離脱で止める
- `public_url`が出てもsame-originのstatic reviewed indexと一致するまで通常公開linkへ昇格しない

## 6. UI and accessibility gates

- JSなしでも「原論文を読む」を利用可能にする。公開済みdeck linkはreview済みpublic bundleとの統合後に同じfallbackへ出す
- button/link/disabledの役割を混ぜず、loading/error/state changeを`aria-live=polite`で通知
- confirmationにはcoverage、機械生成、review前は公開されないこと、概算待ち時間/費用カテゴリを表示
- 320px、200% zoom、keyboard-only、screen reader、reduced motion、slow/error/empty stateをfixtureでtest
- 同じtabの再loadやBack/Forwardでは`sessionStorage`のrequest ID/capabilityを復元できるが、複数tabへcapabilityを
  暗黙共有しない。二重clickや複数tabから別requestが作られてもatomic coordinatorがunderlying active jobを一件に保つ
- unsafe textを`innerHTML`へ入れず、server messageをそのまま表示しない

## 7. implementation slices

| slice | owner files | 完了条件 |
|---|---|---|
| S4A public index | schema、Python validator/projector、fixture/test | reviewed exact hashだけを公開indexへ投影 |
| S4B selected action | `catalog-core.js`/`app.js`、viewer tests、page generator | `?paper=`選択時だけclosed stateを表示 |
| S4C Worker fixture API | pure validator/response/status/coordinator-interface modulesとNode tests | network/dispatchなしでrequest/status/capabilityとatomic job共有契約成立 |
| S4R offline review | `review.py`、contract/renderer/public-index tests | canonical candidateとapproved reviewからimmutable public projectionを構成 |
| S4D integration | generated HTML、asset version、docs | search→selected→published deck linkのoffline smoke |

共有asset、`versions.json`、generated conference HTML、Worker entry pointは各slice完了後にintegration ownerだけが更新する。

S4AとS4Bのread-only部分はローカル実装済みである。browserはmanifestとshardだけでなく、選ばれたentryのexact
`deck.json`とHTML response bytesもbounded streamで取得し、same-origin/no-redirect/final URL、両SHA-256、paper/deck/
language/coverage/review bindingを確認してからだけ`published`を表示する。code-owned manifest pinは現在`null`であり、
実公開artifactがない状態では意図的に`unverified`となる。S4Cのcontract、HTTP boundary、approved catalog
producer/adapter、Durable Object service/client、dispatch/callback/runtime、HMAC claim/fenceのdormant workflow足場、
provider registry/価格/累積予算のclosed boundaryと、selected-cardの生成依頼dialog/request/status consumerはローカル実装・
fixture検証済みである。一方、provider stepは未接続であり、
`PAPER_SLIDE_API_BASE=null`のためproduction CTAは表示されず、namespace/binding/migration、catalog配置/pin、live provider/
Secrets、no-JS公開deck link、実promotionは未接続である。
本番境界は[`27-paper-slide-request-plane-production.md`](27-paper-slide-request-plane-production.md)を参照する。

## 8. completion boundary

S4のローカル完了は、検索から安全にスライド状態へ到達できることを意味する。live LLM、実workflow dispatch、
private preview storage、human review、promotion、Pages/Worker deployは別の明示承認gateであり、未実施ならそう表示する。
