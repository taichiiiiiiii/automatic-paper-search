# 17. Paper Slide Deck v1 実装契約

- **更新日:** 2026-09-05
- **状態:** SD0・SD1・SD2 backend・SD3 renderer/public index・SD4 offline review projection・VT0・selected-card integration、S4C request/status、approved catalog producer/adapter、永続coordinator、claimant lease/fence、dispatch/callback、休眠runtime/workflow、provider予算境界、no-JS原論文リンクはローカル実装・fixture検証済み。production APIとpublic manifest trust rootはfail closedのままで、VT1〜VT4、image承認/E2E、binding/live provider、no-JS公開deck link、workflow review/promotion/publish系は未実装または未検証
- **対象:** 選択論文からの引用付き要約スライド生成、検証、レビュー、静的公開
- **上位設計:** [`11-target-architecture.md`](11-target-architecture.md)
- **既存実装契約:** [`12-implementation-plan.md`](12-implementation-plan.md)、
  [`14-lineage-contract-v1.md`](14-lineage-contract-v1.md)、
  [`15-replay-lite-contract.md`](15-replay-lite-contract.md)

この文書は、論文カードまたは明示的な agent command で選んだ一論文から、NotebookLM に似た
「内容をつかむためのスライド」を生成する producer、Worker、validator、review、viewer の共有契約である。
論文本文を再配布する機能、任意 URL の取得サービス、ユーザー PDF の保管サービスではない。

---

## 1. ユーザーに提供する結果

```text
選択済み論文カード / agent command
  → Worker が request を検証・重複排除・予算確認
  → GitHub Actions の非同期 job
  → trusted OA PDF 解決・bounded fetch
  → ページ番号付き text extraction
  → page-cited slide-deck-v1 生成
  → secrets なしの strict validation
  → provisional candidate（非公開）
  → human review record
  → HTML deck を exact promoted SHA から Pages 公開
  → 将来: 同じ JSON から PPTX / PDF を追加投影
```

MVP の主成果物は same-origin の静的 HTML deck である。PPTX / deck PDF は `slide-deck-v1` の
consumer として後から追加し、LLM に別内容を再生成させない。全面 SPA、常時稼働 backend、第二の公開サイトは
導入しない。

スライド生成は一論文単位の明示操作である。CTA 実装後は、上位学会の自動収集で新しい catalog row が追加され、
canonical `paper_id` と trusted OA PDF を解決できれば、その論文カードは自動的に CTA の対象になる。
収集時に全論文の deck を一括生成または事前計算してはならない。

---

## 2. 現在あるものと不足しているもの

### 2.1 再利用する既存機構

- catalog row は `paper_id`、`source`、`source_id`、`pdf_url`、abstract を持ち、全文 abstract は
  `paper-details-v1` shard から選択時に取得できる
- `?paper=<paper_id>` で同じ選択論文を復元できる
- LLM provider abstraction と provider / model の識別機構がある
- Pages を read plane、Worker `/api/*` を write request plane、GitHub Actions を生成 plane とする
- Worker の request ID、KV rate limit、status polling、workflow dispatch の実装例がある
- candidate の検証、fresh-tip promotion、exact-SHA Pages release、Replay Lite の canonical hash がある

### 2.2 SD0 ローカル実装済み

- closed JSON Schema: `schemas/slide-deck-v1.schema.json`
- 標準ライブラリだけで動く runtime contract: `paperpilot/paper_slides/contract.py` と公開 API
  `paperpilot/paper_slides/__init__.py`
- full-text / abstract-only / unresolved citation fixture と
  `paperpilot/tests/test_slide_deck_contract.py` の正負・境界テスト
- trusted envelope の exact hash、page / chunk / PDF hash binding、言語別 `ja | en` 固定 coverage label / limitation、
  safe URL / same-origin path / plain text、secret scan を fail closed で検証
- 任意 JSON 値を例外なく bounded に扱う total validator、review 時刻の
  `generated_at <= reviewed_at <= review_as_of`、lineage の独立 source-work 証拠を検証

SD0 は artifact の構造・provenance・安全境界を定めるローカル基盤であり、論文から実際に deck を生成・表示する
end-to-end 機能ではない。

### 2.3 SD1 ローカル実装済み

- [`20-slide-sd1-implementation.md`](20-slide-sd1-implementation.md) に、canonical source resolver、
  IP-pinned SSRF-safe bounded fetch、page-aware extraction、Linux subprocess isolation、SD0向けPDF/chunk
  integrity bindingを実装した
- resolverは公開catalog **28,300 / 28,300** 行をnetworkなしでcanonical解決する
- fetch testはfake DNS / fake pinned transportだけを使い、live PDF fetchは実施していない
- isolationはLinuxでresource limitとprocess boundaryを必須にし、macOSその他ではfail closedにする。
  Python audit hook / runtime guardによるnetwork・process API拒否はkernel/seccomp sandboxではない
- SD0+SD1 focused gateは **251 passed / 1 skipped**。skipはmacOS上のLinux専用isolation parity testである

SD1は論文本文を安全境界内で取得・抽出し、SD0のcitation contextへ結び付ける基盤である。LLM生成、HTML表示、
非同期request、review、公開を含まず、end-to-endのスライド機能ではない。

### 2.4 現在の追加実装と残る gate

SD2 offline backend、SD3 deterministic renderer / public index、VT0 visible-text contract、選択済み論文カードから
review済み公開deckを読み取るread-only integrationはローカル実装済みである。公開状態はmanifest、shard、deck JSON、
HTMLのexact hashとidentity bindingを検証できた場合だけ表示する。

S4Cはpure request/status contract、dependency-injected HTTP boundary、in-memory fixtureに加え、approved catalog
producer/adapter、single named Durable Object向けcoordinator service/client、generation付きclaimant leaseとprovider fence、
GitHub dispatch adapter、authenticated workflow callback、HMAC claimantとfenceを持つ休眠runtime/workflow足場まで実装した。provider側も
exact adapter型、価格snapshot hash、hard ceiling以下のjob予算、一つの累積ledger、一回限りの既存generator実行を
ローカル境界として実装した。selected-cardの確認dialog、request、capability付きstatus polling、同一tabのsession復元、
公開index再検証もローカル実装した。SD4 offline境界はexact canonical provisional bytesとapproved review recordを再検証し、
review record、reviewed deck、決定論HTML、public index candidateをimmutable resultへ投影する。trusted contextをdeep snapshotし、
同じcheckoutでdeck / HTML / assetsを再現できないindex buildは公開前に拒否する。
ただしproductionではAPI baseとpublic manifest trust rootを`null`に固定しており、生成CTAと公開deck読取は意図的に
fail closedである。build-time no-JS fallbackは全28,300件の原論文リンクを提供するが、review済み公開deckがないため
deck linkはまだ出力しない。

残る未実装・未検証は次である。

- VT1〜VT4とimage digest承認、Linux / Docker Desktop E2E。完了までproduction full-textはblocked
- production entrypointへのruntime注入、SQLite-backed Durable Object binding/migration、catalog object配置とcode-owned pin
- dormant workflowの本番接続、production provider/価格表/registry、実dispatch/callback、private preview
- review済みartifactをno-JS fallbackへ結ぶ公開deck link
- workflowでのreview取得、promotion / publish / deploy と外部設定
- PPTX / deck PDF exporter

現行 Stage 4 は abstract の先頭 500 文字から日本語 3 行要約を作る契約であり、論文全文の要約として
再利用してはならない。既存 CSV / JSON / Slack / Email exporter も slide exporter ではない。

---

## 3. スコープと非スコープ

### 3.1 MVP

- 公開 catalog に存在する canonical `paper_id` 一件を入力にする
- source-specific resolver が認める trusted HTTPS host の OA PDF だけを取得する
- PDF が利用可能ならページ引用付き full-content deck、利用不能なら明示的な abstract-only deck を作る
- 6〜10 枚を既定、12 枚を hard maximum とする
- provisional candidate を非公開の短期 Actions artifact に保存する
- human review 後の deck だけを静的 Pages へ exact-SHA publish する
- 公開 viewer は HTML、download は元論文リンクと provenance JSON を提供する

### 3.2 非スコープ

- client が送る任意 URL の取得
- PDF upload、非公開論文、購読契約内 PDF、認証付き source
- raw PDF、抽出全文、LLM request / response の Git commit または Pages 配信
- 論文の原図・表・スクリーンショットの自動転載
- video / audio narration、共同編集、一般ユーザーによる review 承認
- catalog 全件の bulk precompute

ユーザー PDF upload を将来追加する場合は、private object storage、malware scan、暗号化、署名 URL、
所有権確認、retention / delete、認可を別 ADR で決定する。GitHub Pages と Git commit はその保管先にしない。

---

## 4. 入力と source 解決

### 4.1 public request

```json
{
  "paper_id": "40 lowercase hex",
  "language": "ja",
  "coverage_preference": "auto"
}
```

- top-level object は closed とし、未知 key を拒否する
- `paper_id` は公開 `papers.json` / identity projection の一意な row に解決する
- browserの`language`はMVPでは`ja`に固定する。agent commandの`ja | en`は同じservice validatorの別の
  trusted invocation profileとして扱い、public requestの列挙を暗黙に広げない
- `coverage_preference`はMVPでは`auto`だけとする。producerがコード所有の
  `deck_profile=research-brief-v1`へ解決し、prompt、model、URL、slide count、deck profileをclientに指定させない
- agent command も同じ service 関数と validation を通し、Worker を迂回して任意 URL を渡さない
- title-only join、first match、別 row の `paper_id` と `pdf_url` の組合せは禁止する

### 4.2 trusted PDF resolver

resolver は catalog の `source` / `source_id` から source-specific canonical PDF URL を構成または検証する。
client の `pdf_url` は入力として受け取らない。v1 registry は `arxiv | openreview | acl_anthology | cvf` の
明示 adapter だけとし、unknown source は PDF unavailable とする。

各 adapter は次を返す。

```json
{
  "source": "arxiv",
  "source_id": "2601.01234",
  "landing_url": "https://arxiv.org/abs/2601.01234",
  "pdf_url": "https://arxiv.org/pdf/2601.01234",
  "access": "open_access | unknown | restricted",
  "license": "declared SPDX/URL or unknown",
  "license_evidence_url": "https://... or null"
}
```

`open_access` は「再配布自由」を意味しない。license が `unknown` でも、取得が適法な公開 PDF であれば
内部要約入力にできるが、原図・長い引用・抽出本文を公開してはならない。`restricted` は取得しない。

### 4.3 SSRF-safe fetch

- scheme は `https` のみ、userinfo、fragment、非既定 port、IP literal を拒否する
- hostname は adapter ごとの exact allowlist とし、suffix 部分一致を使わない
- redirect は自動追従せず、各 hop を同じ規則で再検証し、最大 3 hop
- DNS 解決結果が loopback、link-local、private、multicast、reserved、metadata range を含めば拒否する
- DNS 解決後に接続先を固定し、Host / TLS hostname と検証済み host を一致させる。実装環境で固定できなければ
  その adapter を fail closed にする
- connect / read / total timeout、最大 response byte、Content-Length、streaming 実 byte をすべて制限する
- status 200、許可 Content-Type、PDF magic `%PDF-` の全てを要求する
- proxy 環境変数、`.netrc`、cookie、認証 header を使わない
- URL、response body、redirect location を公開 error や run name に含めない

既定上限は PDF 32 MiB、redirect 3、fetch total 60 秒である。上限は config で小さくできるが、
public request から変更できない。

---

## 5. 抽出契約

PDF は Actions の job-local temporary directory にだけ保存する。実装済みSD1 isolationはLinux subprocessで
wall timeout、memory / CPU / file / fd制限、bounded pipeを適用し、終了時にPDFと抽出全文を破棄する。
Python audit hookとruntime guardでsocket/DNS・process escape APIを拒否するが、kernel network namespaceやseccompを
提供するものではない。Linux以外は`isolation_platform_unsupported`でfail closedとする。

- 最大 128 pages、暗号化 PDF は拒否、page count を取得できない PDF は拒否
- 抽出 text は最大 1,500,000 Unicode code points、page ごと 100,000、chunk は最大 64
- page number は PDF の物理 page を 1 起点で保持する。印刷ページ番号を推測しない
- chunk は page を跨がず、`chunk_id`、`page`、正規化 text の SHA-256、section hint を持つ
- duplicate / invisible / control text、極端な反復、埋込ファイル、JavaScript、外部 link action を入力から除く
- `pypdf` text extractionは人間に見えることの証拠ではない。crop/media不一致、clip/alpha状態、境界外originを
  fail closedにしても、glyph runのpage外延伸、極小font/CTM/Tz、同色foreground/background、後続paint occlusionを
  証明できないため、render/OCR visibility verifierが入るまで非空PDF textを
  `page_text_visibility_unverifiable`で拒否する
- OCR は現時点で行わない。visibility未検証または本文抽出量が閾値未満ならPDF successや`full_text`にせず、
  policyが許すcatalog abstractだけの別経路を`abstract_only`として扱う
- extractor name / version / options、PDF byte SHA-256、抽出成功・失敗 code を provenance に残す

raw chunk text は LLM 入力に必要な間だけ保持できるが、Git、Pages、cache、log、job summary、review recordへ
保存しない。診断には byte/page/chunk count、hash、stable error code だけを使う。

---

## 6. LLM 生成と prompt injection 境界

PDF text、title、authors、abstract、citation context はすべて untrusted data として明示的な data delimiter 内へ入れる。
本文中の命令、URL、tool call、secret 要求、出力形式変更要求には従わない。

- model の tool / browsing / code execution / remote image 機能を無効にする
- provider へ secret、repository path、Worker token、他ユーザー request を渡さない
- 長文は page-aware chunk summary → paper-level outline → slide composition の bounded 階層処理にする
- 各中間 claim は参照 `chunk_id` を失わず、最終 bullet / note は citation ID を必須とする
- 「系譜由来の位置づけ」と「論文本文の主張」を混ぜず `content_origin=lineage | paper` で区別する。
  v1 は外部背景知識のsource/citation契約を持たないため、`background` bulletを生成しない
- model の JSON は untrusted とし、closed schema、型、長さ、列挙、参照整合を runtime validator で検証する
- parse / schema / citation failure を自由文補完で修復しない。bounded retry 後は失敗または abstract-only にする

model に最終 artifact の identity / provenance envelope を自己申告させない。model output は slide content、
citation reference、limitations のcandidateに限定し、producerがcanonical catalog、resolver、extraction manifest、
実行configから `paper_id / coverage / source / generator / input_sha256 / generated_at` を注入する。最終validatorは
そのtrusted envelopeのcanonical SHA-256をcontextで受け取り、artifact側から再計算した値とのexact matchを要求する。
PDF chunk contextも元PDF SHA-256を持ち、別PDFのchunkとsource metadataを組み合わせられないようにする。

full-content と表示できるのは trusted PDF の取得・抽出が成功し、最終 deck の cited claim が抽出 chunk に
全て解決した場合だけである。PDF が無い、取得失敗、scan PDF、上限超過、抽出不足の場合は catalog の
full abstract だけを入力にできるが、`coverage.kind = "abstract_only"` とし、cover、固定 header、download metadata、
カード CTA 完了表示の全てに「要旨のみから生成。論文全文の要約ではありません」と表示する。

---

## 7. `slide-deck-v1` wire contract

正本は canonical UTF-8 JSON で、top-level と全 nested object を closed schema とする。

```json
{
  "schema_version": "slide-deck-v1",
  "deck_id": "sd1-<64 lowercase hex>",
  "paper_id": "<40 lowercase hex>",
  "language": "ja",
  "deck_profile": "research-brief-v1",
  "coverage": {
    "kind": "full_text",
    "label": "公開PDF本文から生成",
    "page_count": 14,
    "extracted_page_count": 14
  },
  "source": {
    "title": "...",
    "authors": ["..."],
    "landing_url": "https://...",
    "pdf_sha256": "<64 hex>",
    "access": "open_access",
    "license": "unknown",
    "license_evidence_url": null,
    "fetched_at": "2026-08-30T00:00:00Z"
  },
  "generator": {
    "producer": "paperpilot.paper_slides",
    "version": "1",
    "extractor": "name:version",
    "provider": "provider",
    "model": "model",
    "prompt_version": "paper-slide-v1",
    "schema_version": "slide-deck-v1"
  },
  "slides": [
    {
      "slide_id": "s01",
      "kind": "title | problem | method | evidence | limitations | conclusion | context",
      "title": "...",
      "bullets": [
        {"text": "...", "citation_ids": ["c01"], "content_origin": "paper"}
      ],
      "visual": {"kind": "none | generated_diagram", "alt": "...", "spec": "..."},
      "speaker_notes": [{"text": "...", "citation_ids": ["c01"]}]
    }
  ],
  "citations": [
    {
      "citation_id": "c01",
      "source_kind": "pdf_page",
      "page": 3,
      "chunk_id": "p003-c02",
      "chunk_sha256": "<64 hex>",
      "source_anchor": "https://...#page=3"
    }
  ],
  "limitations": ["機械生成された要約であり、原論文の確認が必要です。"],
  "review": {"status": "provisional", "review_record": null},
  "generated_at": "2026-08-30T00:00:00Z",
  "input_sha256": "<64 hex>"
}
```

### 7.1 必須不変条件

- `deck_id` は canonical input / producer contract の hash から決定し、同じ入力では同じ ID
- `paper_id / coverage / source / generator / input_sha256 / generated_at` はtrusted envelope hashと一致する
- slide は 2〜12、`slide_id` と `citation_id` は一意で昇順
- title slide を除く全 bullet と factual speaker note は 1 件以上の citation を持つ
- citation は存在する抽出 chunk と page に一致し、同じ chunk SHA-256 を持つ
- `abstract_only` の citation は `source_kind=abstract`、`page=null`、`chunk_id=abstract`
- coverage label は `full_text=公開PDF本文から生成`、
  `abstract_only=要旨のみから生成。論文全文の要約ではありません` の固定値とし、limitationsにも固定警告を必須化する
- PDF citationのpageはtrusted `page_count` を超えず、chunkのPDF SHA-256はsource PDF SHA-256と一致する
- lineage context の citation は `source_kind=lineage_assertion`、`page=null` とし、監査済み
  `lineage-artifact-v2` のsame-origin path、accepted `claim_id`、artifact byte SHA-256、quality row byte SHA-256を持つ。
  PDF / abstract citation namespaceへ偽装せず、v1 edgeを推測変換しない
- lineage claimは`claim_family=genealogy`に限定し、`corroborated`はcurrent `calibration_id`、
  `calibrated_probability >= 0.70`、独立evidence 2件以上をtrusted contextで満たす。`verified`を自己申告で作らない
- citation の短い表示 anchor は許可するが、抽出本文や長い quote を artifact に含めない
- visual は原論文の画像 URL / base64 / SVG / HTML を保持しない。MVP は `none` または text spec から作る
  same-origin の単純 diagram に限定する
- URL は resolver が確定した `landing_url`、`license_evidence_url`、page anchor だけ
- provider / model / prompt / schema / extractor version、input hash を省略しない
- runtime validatorは任意のJSON値に対するtotal functionとし、parse前byte上限、depth/container上限、
  malformed typeをstable errorへ変換する。invalid inputをcanonical化して再走査しない
- `review.status=reviewed` は有効な review record と reviewer がなければ設定できない
- JSON は [`15-replay-lite-contract.md`](15-replay-lite-contract.md) §3.1 の canonical byte 契約で保存する

JSON Schema は `schemas/slide-deck-v1.schema.json`、runtime validator は標準ライブラリで共有実装する。
HTML / 将来の PPTX / PDF consumer は schema を緩めたり欠損 citation を推測してはならない。

---

## 8. provisional、review、公開契約

自動 validation は安全性・構造整合の gate であり、内容の正確性を保証する human review ではない。

1. `provisional`: strict validation 済みの機械生成 candidate。Actions の短期 artifact にだけ置き、Pages、Git、
   search index、public manifest へ含めない
2. `reviewed`: reviewer が引用先ページ、主要 claim、coverage label、著作権表示を確認し、closed review record を作る
3. `published`: reviewed candidate と review record を fresh `develop` tip へ適用・再検証し、promoted exact SHA を
   reusable Pages release へ渡し、post-deploy smoke が成功した状態

review record は `deck_id`、candidate JSON SHA-256、PDF SHA-256、opaque reviewer ID、reviewed_at、判定、固定 check list、
短いsanitized reasonを持つ。reviewer IDはemail形式を許さず、record pathはdeck IDとcanonical record SHAから決定する。
`approved | rejected | needs_changes` のうち `approved` だけ publish できる。raw text、引用文、
reviewer のメールアドレス、自由形式の個人情報は保存しない。
`reviewed_at`は実在するUTC日時のRFC 3339表現だけとし、小数秒は最大6桁、全体は20〜27 bytesに固定する。
public record bytesは`schema_version=paper-slide-review-record-v1`を含むclosed mappingをUTF-8 canonical JSON
（key順、compact separator、末尾LF一つ）へ変換したものだけを正本とし、そのfull SHA-256をpathへ含める。

公開 artifact は次に限定する。

```text
docs/paper-slides-v1/decks/<deck_id>/<deck_sha256>-<html_sha256>.deck.json
docs/paper-slides-v1/decks/<deck_id>/<deck_sha256>-<html_sha256>.html
docs/paper-slides-v1/index/<paper_id-prefix>.json
docs/paper-slides-v1/manifest.json
docs/assets/paper-slides.<asset_sha256>.css
docs/assets/paper-slides.<asset_sha256>.js
docs/paper-slides-v1/reviews/<deck_id>/<review_record_sha256>.json
```

公開 `deck.json` の `review.review_record` は上記same-origin content-addressed review record pathとする。validatorは
context key、canonical record full SHA-256、path、candidate/PDF/reviewer/decision/time/checklist/reasonを全て再照合する。
旧`reviews/<deck_id>.json`は拒否する。review record はprovisional candidate JSONのSHA-256に結び、公開 deck は
review metadataを加えた後に再canonicalize・再検証する。
GitHub project Pagesの公開URLはすべてコード所有のbase
`/automatic-paper-search`を先頭に持つ。deck HTML / JSON は canonical deck hash と rendered HTML hash の組を
filenameへ含め、CSS / JS はasset bytesのfull SHA-256をfilenameとSRIへ含める。従って同一pathのbyteを後から
差し替えず、旧revisionもappend-onlyに保持する。review recordはSD4が別のreviewed artifactとして供給し、SD3の
projection bundleには含めない。domain rootの`/paper-slides-v1`へは出力しない。
indexは空prefixを省略せず`00`〜`ff`の256 shardを常に生成する。`manifest.json`は各shardのcanonical path、
SHA-256、entry countをprefix順に全件保持し、存在しない/未配置のshardと正当な空shardを区別するtrust rootとする。

HTML は `deck.json` の決定論的 projection とし、inline script、remote script、remote font、remote image、
untrusted HTML を含めない。全 model text を text node として escape し、keyboard navigation、print CSS、
320px、reduced motion、citation focus / back navigation、abstract-only persistent label を満たす。

NotebookLM に近い即時体験には、生成済み provisional を **request-scoped bearer capability** で返す。
このサイトには利用者認証がないため「依頼者本人だけ」とは称さず、有効な capability を保持するブラウザだけが
期限内に閲覧できるものとする。`request_id` はrequest単位のopaqueな相関識別子であり、権限として使わない。
POST 時に128-bit以上の独立乱数 `status_cap` を一度だけ返し、request storeにはそのhashだけを保存する。capabilityをURL、
GitHub run name、object key、ログ、analytics、例外、HTMLへ入れない。

公開 Pages と分離した private object storage には strict validation 済みの `deck.json` と決定的 HTML だけを置く。
bucketのpublic domain / LIST / direct GETを無効にし、Worker bindingだけから取得する。object keyは利用者入力、
`paper_id`、`deck_id`から推測できない128-bit以上の乱数とする。既定のlogical TTLは24時間で、Workerは
server-side `expires_at` 後を必ず拒否する。storage lifecycleとorphan sweeperは最大48時間以内に物理削除し、
`rejected | expired` はrequest recordを即時revokeしてobjectを削除キューへ入れる。lifecycle遅延を閲覧許可に使わない。

previewはcapabilityをURL queryへ載せず、POST交換で10分の `HttpOnly; Secure; SameSite=Strict` preview cookieを発行する。
cookie署名は version、HTTP method、route、opaque object key hash、request scope、deck digest、expiry、nonce、key ID の
canonical encodingをHMACし、constant-time比較とkey rotationを行う。未知key IDはfail closedとする。preview responseは
`Cache-Control: private, no-store`、`X-Robots-Tag: noindex, nofollow`、`Referrer-Policy: no-referrer`、
`X-Content-Type-Options: nosniff`、`frame-ancestors 'none'`を含むCSPを返し、shared cache、analytics、service worker、
remote assetを使わない。platform access logでもquery/full URL、cookie、capability、object keyをredactする。
raw PDF、抽出全文、prompt / response は保存しない。

preview は常時「未レビュー・自動生成」と表示し、公開・共有完了を意味しない。人手承認済み deck だけを Pages へ
promote する。private storage binding、署名 secret、Worker route の作成は外部設定を伴うため、ローカル実装と分け、
明示承認後に行う。public Pages URL を「仮置き非公開」の代用にしない。

---

## 9. Worker API と job status

Worker は API-only を維持し、次を追加する。

```text
POST /api/paper-slides
POST /api/paper-slides/status
POST /api/paper-slides/preview-session
GET  /api/paper-slides/preview/<opaque-session-id>
```

POST success は HTTP 202 とする。

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

POST responseとstatus responseは `Cache-Control: private, no-store` とし、許可したPages originだけをCORSで返す。
`status_cap` は `Authorization` headerで渡し、query、path、cookie、request JSONへ複製しない。ブラウザでの再開が必要な間だけ
同一tabの `sessionStorage` に保持し、localStorage、history、DOM、analytics、run name、object key、logへ保存しない。
request storeにはcapability hash、request scope、expiry / revocation、underlying job keyだけを持つ。
`request_id`は相関識別子に限り、単独ではstatus、preview、paper/requestの存在を読めない。

status response は closed object とし、未完了を HTTP error にしない。

```json
{"request_id": "paper-slide-..."}
```

上記bodyと `Authorization: PaperSlide <status_cap>` を `/status` と `/preview-session` のPOSTで使う。
preview-session successはclosed responseとpath-scoped cookieを返し、pathのopaque ID自体は権限にしない。

```json
{
  "ok": true,
  "request_id": "paper-slide-...",
  "preview_path": "/api/paper-slides/preview/<opaque-session-id>",
  "preview_expires_at": "2026-08-30T00:10:00Z",
  "message_code": "PAPER_SLIDE_PREVIEW_READY"
}
```

```json
{
  "ok": true,
  "request_id": "paper-slide-...",
  "paper_id": "<40 hex>",
  "status": "running",
  "phase": "extracting",
  "coverage": null,
  "deck_id": null,
  "preview_available": false,
  "preview_expires_at": null,
  "public_url": null,
  "message_code": "PAPER_SLIDE_EXTRACTING",
  "updated_at": "2026-08-30T00:00:00Z"
}
```

### 9.1 状態機械

```text
queued → running → validating → awaiting_review → publishing → published
   └──────────────→ failed
awaiting_review → rejected | expired
publishing → failed
```

- APIの`status`は`queued | running | validating | awaiting_review | publishing | published | failed | rejected | expired`の
  closed enumとする。selected cardは`running | validating | publishing`を表示用`generating`へ、
  `failed | rejected | expired`を表示用`failed`へ写像し、API responseに別の`state` fieldを作らない
- `phase`: `resolving_source | fetching | extracting | generating | validating | awaiting_review | promoting | deploying | smoke`
  またはactive phaseがないときの`null`
- `coverage`: validation 後だけ `full_text | abstract_only`
- `deck_id`: strict validation 後だけ返す
- `preview_available`: strict validation済みprovisionalが未失効・未revokeのときだけtrue。status responseに
  preview URLやobject keyは入れず、`preview-session` のPOST交換を明示操作で行う
- `public_url`: post-deploy smoke 成功後の `published` だけ返す。コード所有base配下のsame-origin reviewed pathに限定し、
  browserはstatic reviewed indexとの一致を確認するまで通常公開linkへ昇格しない
- `failed | rejected | expired` は retryable boolean と stable `message_code` を返し、raw exception、URL、provider body、
  GitHub run ID、secret、stack trace を返さない
- statusはcoordinator内のrequest aliasとcapability hashをexactに照合し、GitHub run name / run IDを認可や公開responseに使わない
- `queued` はcoordinator予約済みを表し、dispatchは`accepted`または結果不確定の可能性がある。atomic workflow claim後の
  `running`だけが生成開始を表す。`awaiting_review`は生成成功、`published`は公開成功を意味し、同義にしない
- status / preview-session POSTもper-IP / global rate limitを持つ。capability付きresponseのbrowser/CDN shared cacheは
  常に禁止し、内部の非秘密request record読取だけを短時間cacheできる
- capability不正、未知request、revoke済み、object不在は同じHTTP status、closed body、bounded timing classで返し、
  request / deck / previewの存在を区別させない
- preview cookieを発行するPOSTはPagesのexact Origin、`Sec-Fetch-Site: same-origin`、one-time nonceを要求し、
  GETはそのcookie、session path、expiry、request scope、deck digestを検証する。cookie方式のCSRFを許可しない

同一 cache key の `awaiting_review | published` request は新規 LLM job を dispatchしない。ただしunderlying deck/jobだけを
共有し、POSTごとに新しいrequest record、`request_id`、capability、preview sessionを発行する。先行requestの識別子や
capabilityを後続利用者へ返さない。
`failed | rejected | expired` の retry は新しい request ID を発行する。

active jobのlookup/createとrequest recordのjob bindingは、一つのatomic coordinator abstractionで直列化する。
production bindingはDurable ObjectまたはD1 transactionとし、Workers KVの独立した`get`→`put`を
重複課金防止、single-active-job、idempotencyのcorrectness boundaryに使わない。同時POSTはそれぞれfreshな
request record、`request_id`、独立`status_cap`を得るが、coordinatorが返す同じunderlying jobだけを共有する。
S4Cはこの境界のpure interface、fixture、永続coordinator service/client、状態遷移testまで実装した。live binding、
GitHub workflow/provider、Worker deployは後続gateである。

S4C fixtureでは、approved catalog adapterが§11.3の全canonical cache materialから導出した64桁lowercase hexの
`job_key`を渡す。既定上限は2 request/時/IP、20 **new underlying jobs**/UTC日であり、deduplicated aliasは日次job数を
消費しない。`rejected | expired`はpreview/object accessを即時revokeする一方、同じrequest capabilityによる最小status
aliasはrequest TTLまでterminal responseを返す。明示的にrequest aliasをrevokeした後はunknown、wrong capability、
期限切れaliasと同じclosed 404にする。生成failure codeとHTTP transport error codeは別のclosed enumとして扱う。

dispatchは204だけを`accepted`、明確な4xxだけを`rejected`、timeout / network / redirect / 5xxを`uncertain`とする。
`uncertain`を自動retryせず、同じqueued jobへjoinさせる。queued jobは900秒でretryable failureへ失効する。
workflowはprovider call前にauthenticated callbackからatomic `claimJob`を実行し、`claimed=false`なら生成せず終了する。
休眠workflow足場は別Secret `PAPER_SLIDE_WORKFLOW_CLAIMANT_KEY`とdispatchのexact 6入力、GitHubのexact run/job identityを
domain-separated HMAC-SHA256へ固定し、`psct_`付き256-bit claimant tokenを決定論的に導出する。`run_attempt`を含めないため、
同じrunの再実行は初回claim応答喪失を同じtoken/bodyでboundedに確認できる。tokenはoutput/logへ出さず、通常経路は
`lease_generation=0, reclaim=false`だけをclaimし、明示reconciliation以外の自動reclaimを行わない。
`running/generating` updateが`updated=true`を返した後だけproviderへ進めるfence primitiveも実装済みだが、現行workflowに
provider command / stepはなく、callback origin、provider config、adapter registryのcode-owned pinもclosedである。
詳細とactivation gateは[`27-paper-slide-request-plane-production.md`](27-paper-slide-request-plane-production.md)を正本とする。

---

## 10. workflow、promotion、exact-SHA publish

`paper-slides-on-demand.yml` は theme workflow の code path を直接再利用せず、共有するのは検証済みの
underlying job ID / correlation、candidate packaging、promotion CAS、reusable exact-SHA releaseという
orchestration primitiveに限定する。browser request IDとcapabilityはworkflowへ渡さない。
現行fileはclaim/fence/安全なfailure closeまでの休眠足場だけで、provider生成、candidate、review、promotion、releaseのstepを
まだ持たない。以下はactivation後もjob権限を分離するための目標構成であり、現在の実行可能経路ではない。

```text
generate (secrets: source/LLM only, contents:read)
  → validate (secretsなし、candidate read-only)
  → await/verify review record
  → promote (contents:write、許可 path限定、fresh-tip CAS)
  → release (contents:read + pages permissions、exact promoted SHA)
  → smoke
```

- generate job は Pages deploy、repository write、review status 変更をしない
- validate は schema、runtime contract、citation refs、coverage label、license policy、HTML projection byte、secret scan、
  size / path / symlink を検査する
- candidate は 14 日以内の Actions artifact。PDF と抽出 text は candidate package に含めない
- 14日はoffline validator / Actions artifactのhard maximumである。on-demand productionではcoordinatorの
  `candidateTtlSeconds`（既定・最大24時間、設定で短縮可）をより厳しいreview/promotion期限として使う。
  期限後のoffline projectionを旧jobへ再接続せず、新しいrequestから再生成する
- promote allowlist は対象 deck directory、review record、対象 manifest shardだけ。共有 manifest は最新 tip から再生成
- generation base 以降に同じ deck / manifest path が変わった場合は上書きせず bounded retry または fail
- release は [`12-implementation-plan.md`](12-implementation-plan.md) §4 の reusable exact-SHA path だけを使う
- smoke は deck JSON / HTML / deployment marker / coverage label / citation navigation を確認する
- provisional / rejected / expired candidate は commit、Pages artifact、sitemap、public manifest へ入れない

---

## 11. copyright、security、cost

### 11.1 copyright / provenance

- 公開 deck は要約と最小限の source anchor を中心とし、本文、長い逐語引用、原図・表を転載しない
- 自動 diagram は原図の忠実な複製を要求せず、`generated_diagram` と表示する
- source landing page、access、declared license / unknown、取得日時、PDF hash、generator、coverage を公開 metadata に出す
- license 不明を permissive と表示しない。撤回 request は deck ID / paper ID で対象を一意に非表示化できるようにする
- LLM provider へ本文を送る場合、その provider、保持方針、国外処理等の運用上必要な開示を公開前に用意する

### 11.2 security

- secrets は Worker Secret / GitHub Secret だけ。request、artifact、manifest、prompt、log、HTML に保存しない
- SSRF、prompt injection、path traversal、archive / PDF bomb、oversized output、stored XSS を fail closed で検査する
- PDF parser と renderer を可能なら非特権 process / container で実行し、repository credential のある promote jobから分離する
- generated HTML に `innerHTML` で model text を入れず、URL protocol / origin を再検証する
- `frame-ancestors` を meta CSP で保証できると称しない。GitHub Pages の既知制約は
  [`09-implementation-status.md`](09-implementation-status.md) の現況に従う

### 11.3 cost / cache

- cache key は `paper_id + PDF SHA-256（または abstract SHA-256）+ coverage + language + deck_profile +
  extractor version + provider + model + prompt version + schema version + license-policy version` の canonical hash
- success の同一 key だけを hit とし、partial / parse failure / expired / provider mismatch を再利用しない
- raw PDF / text を persistent cache に入れず、検証済み deck JSON と provenance hash だけを再利用する
- 既定 request limit は 2 件/時/IP、global 20 件/日、同一 paper/key は一件だけ active。status limit は別 bucket。
  active判定はatomic coordinatorが所有し、Workers KV counterとは分離する
- job ごとの input / output token hard cap、provider call count、timeout、retry、daily token / cost budget を config で必須化する
- provider/model の価格表 version がなく費用上限を計算できない有料 call は fail closed。予算超過は dispatch 前と
  各階層生成前に止める
- usage は token / call / estimated cost の集計だけを manifest に残し、prompt / response 本文を残さない

数値上限を引き上げる変更は config、cost fixture、abuse test、運用予算の同じ review 単位で行う。

---

## 12. lineage との関係

slide と lineage は `paper_id`、strong alias、provenance、run manifest、request/status、candidate promotion、
exact-SHA release の primitive を共有するが、producer、schema、cache、quality、workflow、public manifest は分離する。

- slide request が lineage generation を暗黙に dispatch してはならない
- lineage request が slide generationを暗黙に dispatch してはならない
- `ready + passed` かつ artifact byte hash が quality row と一致する既存 lineage がある場合だけ、任意の
  `kind=context` slide を追加できる
- context bullet は `content_origin=lineage` とし、paper claim の PDF citation と混ぜず、accepted claim の
  structured evidence、artifact hash、quality row hashを別 citation namespace で示す
- lineage unavailable / sparse / stale warning / failed / unknown のときは context slide を省略する。slide 全体を失敗させない
- lineage の有無は full-content / abstract-only 判定に影響しない

これにより、共通 orchestration の重複は減らしつつ、lineage の品質不良や再生成が paper slide の本文要約を
汚染しない。

---

## 13. stable error taxonomy

```text
PAPER_SLIDE_REQUEST_INVALID
PAPER_SLIDE_PAPER_NOT_FOUND
PAPER_SLIDE_SOURCE_UNTRUSTED
PAPER_SLIDE_SOURCE_RESTRICTED
PAPER_SLIDE_FETCH_FAILED
PAPER_SLIDE_FETCH_LIMIT_EXCEEDED
PAPER_SLIDE_PDF_INVALID
PAPER_SLIDE_PDF_ENCRYPTED
PAPER_SLIDE_EXTRACTION_FAILED
PAPER_SLIDE_EXTRACTION_INSUFFICIENT
PAPER_SLIDE_BUDGET_EXCEEDED
PAPER_SLIDE_PROVIDER_FAILED
PAPER_SLIDE_OUTPUT_INVALID
PAPER_SLIDE_CITATION_INVALID
PAPER_SLIDE_SECRET_DETECTED
PAPER_SLIDE_REVIEW_REQUIRED
PAPER_SLIDE_REVIEW_REJECTED
PAPER_SLIDE_CANDIDATE_EXPIRED
PAPER_SLIDE_PROMOTION_CONFLICT
PAPER_SLIDE_PUBLISH_FAILED
```

UI message は code から固定文へ写像する。provider response、URL、抽出 text、model output、exception message を
detail に流用しない。PDF failure のうち abstract が存在するものは、policy が許す code だけ abstract-only へ
降格できる。restricted、identity mismatch、secret、budget、invalid output は silent fallback せず失敗する。

---

## 14. 実装順と task boundary

producer を consumer より先に出し、schema / validator、外部取得、LLM、公開 write path を同じ task に混ぜない。

| 単位 | 所有範囲の例 | 成果 | 前提 |
|---|---|---|---|
| SD0 Contract | `schemas/slide-deck-v1.schema.json`、runtime validator、fixtures / tests | closed schema、canonical byte、error taxonomy | なし |
| SD1 Source | `paperpilot/paper_slides/{resolver,fetch,extract,isolate,extract_worker,pipeline}.py`、PDF tests | resolver、SSRF-safe fetch、Linux isolation、bounded parser normalization。production full-text chunkはvisibility verifier待ちでfail closed | SD0 |
| SD2 Generator | 新規 `paperpilot/paper_slides/generate*`、provider fixtures | hierarchy、citation-preserving structured output、cache key / budget | SD0、SD1 |
| SD3 Projection | renderer、static fixture、viewer tests | deterministic accessible HTML。PPTX/PDF は別 follow-up | SD0、SD2 |
| SD4 Workflow | workflow、candidate validator / packaging、promotion tests | provisional → reviewed → exact-SHA publish | SD0〜SD3 |
| SD5 Worker | `/api/paper-slides`、coordinator / request-store / GitHub mocks、status tests | input、atomic job dedup、request別capability、rate / budget、request correlation | SD4 contract |
| SD5P Preview | private object adapter、capability / cookie / TTL tests、preview renderer | bearer-capability scoped provisional preview。public manifestには入れない | SD3、SD5 |
| SD6 UI | catalog CTA、status UI、manifest / preview consumer、browser/a11y tests | selected card から request / polling / requester preview / public deck | SD5、SD5P |
| SD7 Export | PPTX / PDF exporter と visual regression | 同じ reviewed JSON の optional projection | SD3 出荷後 |

同じ共有 schema、candidate packager、public manifest、asset version、lockfile は一人の owner に集約する。
SD1 の live network test、SD2 の live LLM eval、SD4 の dispatch、SD5 / SD5P の Worker・storage deploy、
SD6 の Pages publish は
ローカル fixture 実装と別 gate とし、ユーザーの明示承認なしに実行しない。

---

## 15. 受入テスト

### 15.1 schema / provenance

- runtime validator と JSON Schema が同じ valid fixture を通し、未知 key、duplicate ID、未解決 citationを拒否する
- enum / object / text fieldへ不正な配列・object・bool・数値を入れても例外を漏らさずstable errorだけを返す
- parse前byte上限、深さ、container数を超えるpayloadをboundedに拒否し、invalid値をcanonical化して再走査しない
- full-text fixture の全 factual bullet / note が実在 page / chunk / hash に解決する
- abstract-only fixture は page citation を持たず、全 projection に固定警告が出る
- paper / source / PDF / input / generator envelopeを一項目ずつ改ざんしdeck IDを再計算しても、trusted hash不一致で拒否する
- `corroborated` lineageは較正値・current calibration・独立evidenceのいずれかが欠けると拒否する
- provider / model / prompt / extractor / schema / input hash 欠損を拒否する
- secret-shaped valueはartifact全体、active HTML / JavaScript / data / remote URL payloadはmodel text / visualで拒否する
- canonical JSON と HTML は別 process / 2 回生成で byte-identical

### 15.2 fetch / extraction security

- client URL、HTTP、userinfo、IP literal、unknown host、suffix confusion、private / metadata IP、DNS rebind、
  redirect to private host、redirect loop を拒否する
- Content-Length 詐称、stream oversize、non-PDF magic、encrypted / malformed / oversized / too-many-page PDF、
  extraction timeout / bomb を bounded failure にする
- crop外text、origin内からpage外へ伸びるlong run、極小font/CTM/Tz、foreground/background同色が
  production chunkへ入らずstable visibility failureになる
- PDF / extracted text が success / failure のいずれでも repository、candidate、log、job summary に残らない
- network disabled extraction test が成功し、parser failure が repository credential jobへ影響しない

### 15.3 prompt / output safety

- PDF fixture 内の「system promptを無視」「URLへ送信」「secretを表示」等を命令として実行しない
- tool call / remote image / HTML / JavaScript / data URL を schema または validator が拒否する
- citationなし claim、存在しない page、別 paper chunk、長文転載、上限超過 output は fail closed
- bounded retry と provider timeout / 429 / malformed JSON / partial response を独立 code で検証する

### 15.4 job / review / publish

- invalid / unknown paper は dispatchせず、同一 cache key の同時 POST はatomic coordinatorで一 job に dedupする。
  Workers KVの非原子的`get`→`put`をこの判定の成功fixtureに使わない
- dedupされた同時POSTも、browser requestごとにfreshなrequest record、`request_id`、独立`status_cap`を返し、
  underlying job以外を共有しない
- status transition、terminal `status`、request ID exact match、`Authorization: PaperSlide <status_cap>`の
  request scope、status rate limit、GitHub failure maskingを検証する
- `awaiting_review` では `public_url` がなく public manifest / Pages artifact に入らない
- provisional preview はcapability hash、cookie署名、期限、request scope、deck digestが一致する場合だけ取得でき、
  no-store / noindex / no-referrerを返す。期限切れ、改変署名、別request、object不在では内容の有無を漏らさず
  同一の固定エラーにする
- `request_id`だけでstatus / previewを読めず、capabilityはURL、run name、object key、DOM、history、analytics、
  access / application logへ出ない
- dedupされた別requestはunderlying deck以外のrequest record / capability / preview sessionを共有しない
- rejected / expiredはserver-sideで即時revokeし、storage lifecycle前でも閲覧不可になる。key rotation、未知key ID、
  orphan削除、最大削除猶予をfixtureで検証する
- status / previewはshared cacheを使わず、exact Origin、CSRF、CSP、frame、nosniff、remote asset禁止を検証する
- rejected / expired / SHA mismatch / promotion conflict は repository と既存 public deck を変更しない
- approved review record と candidate hash が一致する場合だけ promote し、exact promoted SHA を一度だけ releaseする
- smoke 成功後だけ `published` と public URL を返す

### 15.5 UI / copyright / cost

- selected card だけが CTA の対象となり、収集行追加で CTA は現れるが bulk generation は起動しない
- loading、queued、extracting、abstract-only、awaiting review、failed、published を live region で伝える
- 320 / 375 / 768 / 1024 / 1440px、keyboard、focus restoration、print、reduced motion、citation往復を検証する
- license unknown、generated diagram、machine summary、reviewed status、source date を誤認なく表示する
- cache hit は provider call 0、budget exceeded は dispatch / provider call 0、日次 cap と job token cap を検証する
- no raw PDF/text、no original figure、no secret、no arbitrary external asset を公開 artifact scan で確認する

---

## 16. 完了条件

- trusted OA PDF がある fixture から page-cited full-content deck を生成し、review 後だけ公開候補にできる
- PDF を使えない fixture は、全文要約と称さず persistent な abstract-only label を持つ
- provisional / reviewed / published と queued / generated / deployed を混同しない
- public deck の全 claim、source、producer、coverage、review、exact source SHA を追跡できる
- raw PDF / extracted text / prompt / response / secret が Git と Pages に存在しない
- SSRF、PDF/parser、prompt injection、stored XSS、cost abuse が bounded fixture で fail closed になる
- slide と lineage が canonical identity と orchestration primitive を共有しつつ、別 artifact / quality gateとして失敗分離される
- 上位学会の catalog ingestion は CTA coverage を増やすだけで、bulk LLM/PDF job を発生させない
- full test、外部 gate、未確認 provider / license 条件を分けて完了報告する
