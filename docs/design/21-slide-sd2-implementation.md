# 21. Paper Slide SD2 implementation brief

- **更新日:** 2026-09-01
- **状態:** SD2 offline backendはローカル実装済み。live provider/network adapterは別gate、production full-textはVT1〜VT4とimage承認/E2E待ちでblocked
- **親契約:** [`17-paper-slide-deck-contract.md`](17-paper-slide-deck-contract.md)
- **前提:** SD0 artifact contract。SD1 full-text入力はsecurity re-audit合格後だけ有効化する

SD2はidentity-boundな論文入力から、引用参照を失わない`slide-deck-v1` provisional candidateを作る。
provider/modelは本文内容だけを提案し、identity、URL、hash、coverage、generator provenance、citation anchor、
`deck_id`を自己申告しない。SD2はnetwork adapter、renderer、workflow、preview、publishを含まない。

## 1. 実装単位とowner境界

| 単位 | owner files | 責務 |
|---|---|---|
| SD2C input/output contract | `paperpilot/paper_slides/generator_contract.py`、`test_slide_generator_contract.py` | closed dataclass、provider JSON total validator、stable error |
| SD2B budget/cache | `paperpilot/paper_slides/generator_budget.py`、`test_slide_generator_budget.py` | call/token/cost reservation、usage照合、cache key |
| SD2P prompt plan | `paperpilot/paper_slides/generator_prompt.py`、`test_slide_generator_prompt.py` | 固定system instruction、data envelope、決定的call plan |
| SD2G coordinator | `paperpilot/paper_slides/generate.py`、`test_slide_generate.py` | map/reduce、citation継承、trusted envelope注入、SD0最終検証 |
| SD2F fixtures | `paperpilot/tests/fixtures/paper-slide-generator-v1/` | network-free provider response、prompt injection、budget/引用異常fixture |

共有`paperpilot/paper_slides/__init__.py`と本書は統合ownerだけが更新する。provider固有HTTP adapter、Qwen live call、
lockfile変更は別gateとし、SD2 coreに混ぜない。

## 2. 公開入力

公開service入力は次のproducer-owned objectだけとし、任意dict、任意URL、raw provider promptを受けない。

```text
SlideGenerationInput
  paper_id: canonical 40hex
  language: ja | en
  deck_profile: research-brief-v1
  title: untrusted catalog text
  authors: tuple[untrusted catalog text]
  source: exact ResolvedPDFSource由来metadata
  fetched_at: producer clockが注入したUTC
  coverage:
    FullTextGenerationInput
      bound_extraction: BoundPdfExtraction
    AbstractGenerationInput
      abstract: untrusted full abstract
      abstract_sha256: producerがUTF-8 bytesから再計算
      source_anchor: resolverのlanding_url
```

- full-textは`BoundPdfExtraction`のexact runtime type、resolver identity、PDF/chunk hashを再検証する。
- abstract-onlyはcatalogの同じ`paper_id` rowから得たfull abstractだけを使い、最低500、最大48,000 code points。
  synthetic IDはexact `abstract`一件だけなので分割せず、chunk-summary一回の48,000 code-point hard capと一致させる。
- title、authors、abstract、chunk textは全てuntrusted data。system instructionやtrusted metadataへ文字列連結しない。
- `generated_at`と`fetched_at`はpublic request/modelから受けず、producerが引数で渡すUTC clockから作る。
- lineage contextはSD2 MVPに含めない。quality-passed v2 claim実装後の独立入力として追加する。

## 3. provider boundary

SD2 coreが受けるproviderは、networkやtoolを直接扱わない次のProtocolとする。

```text
StructuredSlideProvider
  identity -> ProviderIdentity(provider, model, adapter_version)
  count_tokens(request) -> exact non-negative int
  generate_json(request, max_output_tokens) -> ProviderJsonResponse
```

`ProviderJsonResponse`は`payload: bytes`、`input_tokens`、`output_tokens`、`provider_request_id_hash | null`だけを持つ。
生request ID、HTTP header/body、例外本文、prompt/responseをlogやartifactへ保存しない。coreはtool、browser、code、image、
remote fileをproviderへ公開せず、adapter側にもそれらを無効化するclosed設定を要求する。

- provider/modelはコード内registryのexact pairだけを許可する。public requestによるoverrideは禁止。
- `count_tokens`を提供できないmodelは有料call前にfail closed。
- ordinary provider例外はfreshな`PAPER_SLIDE_PROVIDER_FAILED`へ変換し、cause/contextとprovider本文を捨てる。
- `KeyboardInterrupt`と`SystemExit`はmaskしない。
- SD2のfixture providerはmemory内responseだけを返し、networkを一切使わない。
- Qwen adapterは別単位。現在の設定名は`qwen3.7-max`だが、live canary成功をSD2 coreの完了条件にしない。

## 4. prompt/data envelope

requestは文字列一枚ではなく、trusted instructionとuntrusted recordsを別fieldにしたclosed objectにする。

```json
{
  "request_version": "paper-slide-prompt-v1",
  "stage": "chunk_summary | outline | composition",
  "system_instruction": "code-owned fixed text",
  "language": "ja",
  "output_contract": "chunk-summary-v1 | deck-content-v1",
  "untrusted_records": [{"record_id": "p003-c02", "text": "..."}],
  "prior_claims": []
}
```

adapterはsystem instructionをsystem role、残りをcanonical JSON data blockとして渡す。`untrusted_records[*].text`内の
命令、role marker、URL、tool要求、出力形式変更要求はdataであり実行しない。delimiterを本文から探索・置換せず、
canonical JSON length framingを使う。modelにidentity、URL、hash、secret、filesystem pathを渡さない。

## 5. 決定的な階層生成

`research-brief-v1`は入力順序を物理page、chunk IDで固定し、次のcall planを作る。

1. **chunk summary:** 1 callにつき最大4 chunks、合計48,000 code points。出力は最大12 claims。
   各claimは`text`、入力集合のexact `record_ids`、`claim_kind=problem|method|evidence|limitation|conclusion`だけ。
2. **outline/composition:** 検証済みclaimだけを1 callへ渡し、full-textは6〜10 slides、abstract-onlyは4〜6 slidesを要求。
   先頭はtitle一枚。非title bullet/noteは1件以上の`record_ids`を必須とする。
3. coordinatorはmodelの`record_ids`をproducer側citationへ変換し、重複参照を一意化して物理page/chunk順に並べ、
   `c01..cNN`を割り当てる。modelはcitation ID、page、hash、anchorを選ばない。
4. visualはSD2 MVPでは常に`{"kind":"none","alt":null,"spec":null}`。diagram提案はSD3以降の別validatorへ送る。
5. 同じinput/config/provider fixtureではcall order、canonical request bytes、candidate bytesを決定的にする。

claimを引用先へexactに結べない、未知record ID、重複key、順序/上限違反、uncited factual textは補完・推測せず失敗する。
semantic correctnessは自動validatorだけでは保証せず、provisional表示とhuman reviewを必須にする。

## 6. provider出力のclosed contract

raw provider payloadは256 KiB以下、UTF-8 JSON object一件だけ。parse前にdepth 16、container 512、scalar 8,000、
structural token 16,000を上限とし、duplicate key、NaN/Infinity、trailing dataを拒否する。

`chunk-summary-v1`:

```json
{"schema_version":"chunk-summary-v1","claims":[
  {"claim_id":"k01","claim_kind":"method","text":"...","record_ids":["p003-c02"]}
]}
```

`deck-content-v1`:

```json
{"schema_version":"deck-content-v1","slides":[
  {"kind":"title","title":"...","bullets":[],"speaker_notes":[]},
  {"kind":"method","title":"...","bullets":[
    {"text":"...","record_ids":["p003-c02"]}
  ],"speaker_notes":[]}
],"limitations":[]}
```

- 全objectはexact keys。配列順は意味を持ち、IDは昇順・一意。
- textはNFKC、control/bidi/zero-width除去後とexact一致し、HTML、URL、secret形状を拒否する。
- provider limitationは最大8件。producerが言語別machine-summary警告とabstract-only警告を必ず追加する。
- parse/schema/citation失敗はmodelへ自由文repairさせない。SD2 v1のattemptは各stage 1回で、silent model fallbackなし。
- public exceptionはerror/issue codeだけを持ち、生成text、record ID、provider payloadを含めない。

## 7. budgetとcost

`GenerationBudget`のhard maximum:

| 項目 | 既定 | hard maximum |
|---|---:|---:|
| provider calls | 8 | 16 |
| total input tokens | 120,000 | 200,000 |
| total output tokens | 16,000 | 32,000 |
| output/call | 4,000 | 8,000 |
| total wall time | 180秒 | 300秒 |
| estimated cost | registryのrequest ceiling | operator config以下 |

各call前に`count_tokens`とrequested output maximumから最悪費用をinteger micro-unitでreserveする。reservationがcall/token/
cost上限を一つでも超えればproviderを呼ばず`PAPER_SLIDE_BUDGET_EXCEEDED`。responseのusageはnon-negative exact int、
reserved input/output以下を必須とし、矛盾は`PAPER_SLIDE_PROVIDER_FAILED`。pricing registryはprovider/model、currency、
input/output per-million micro-unit、effective_at、versionをclosedに保持し、未知/expired価格では有料callしない。

## 8. trusted envelopeと最終candidate

producerがprovider出力の外から次を注入する。

- `paper_id`、language、deck profile、coverage label/count
- source title/authors/landing URL/access/license/fetched_at/PDF SHA
- producer/version、extractor、provider/model、prompt/schema version
- input SHA、generated_at、provisional review
- citation page/chunk/hash/anchor
- required limitations、derived `deck_id`

`input_sha256`は、raw textを保存せず、canonical identity/provenance、PDF/abstract hash、ordered chunk hashes、language、profile、
extractor/provider/model/prompt/schema/pricing versionから計算する。cache keyはこれにbudget policy versionとlicense-policy
versionを加えたcanonical hash。partial、invalid、provider mismatch、pricing mismatchはcache hitにしない。

最終candidateは`SlideDeckValidationContext`をproducer側で構成し、`trusted_envelope_sha256`を別計算してから
`require_valid_slide_deck`と`canonical_slide_deck_bytes`を通す。raw PDF、abstract、chunk text、prompt、provider responseは
返り値、cache、log、artifactに残さない。

## 9. acceptance gates

- fixture providerだけでfull-text/abstract-only candidateがSD0 runtimeとJSON Schemaを通る。
- 全bullet/noteのrecord IDがexact trusted referenceへ解決し、page/hash/anchor改変で失敗する。
- prompt injection文字列がsystem/tool/model selectionを変更せず、出力へHTML/URL/secretとして残れば拒否される。
- unknown/duplicate record、duplicate JSON key、oversize/depth/scalar bomb、bool-as-int、NaNをstable failureにする。
- provider exception/message/response、raw text、secret markerがexception/repr/logへ漏れない。
- budget超過はprovider call前、usage矛盾はcandidate作成前に止まる。retry/model fallbackは0回。
- input/config一致でrequest bytes、call plan、cache key、deck bytesが一致する。
- abstract-onlyに固定label/limitationが常時あり、full-textと誤表示できない。
- focused pytest、Ruff、Python 3.10 syntax、narrow mypy、wheel inclusion、full regressionを通す。
- live LLM、workflow dispatch、publish/deploy/push/mergeは実行しない。

## 10. 実装順

1. SD2C closed model-output validatorとhostile fixture
2. SD2B budget reservation、usage ledger、cache/input hash
3. SD2P canonical requestとdeterministic call plan
4. SD2G fixture providerによるfull-text/abstract-only coordinator
5. SD0 validator/Schemaとの統合、独立security review
6. 別承認単位でQwen adapter canary。HTTP 429時は再試行・別modelへのsilent fallbackをしない

SD2のclosed contract、budget/cache、prompt plan、coordinatorとadversarial repairはnetwork-free fixtureで実装済みである。
production adapter registryは意図的に空のままで、live Qwen callはこの完了根拠に含めない。

VT1〜VT4とdigest承認済みcredential-free image/E2Eが成立するまで、SD2 full-text production pathはfail closedに保つ。
abstract-only candidateを全文要約として表示してはならない。
