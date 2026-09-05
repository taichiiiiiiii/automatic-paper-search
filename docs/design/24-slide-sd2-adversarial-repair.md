# 24. Paper Slide SD2 adversarial repair brief

- **更新日:** 2026-09-01
- **状態:** adversarial repairを含むSD2 offline backendはローカル実装済み。production full-text、live provider、review/publicationは未成立
- **対象:** `generator_contract.py`、`generator_budget.py`、`generator_prompt.py`、`generate.py`と対応test
- **非対象:** live provider、network adapter、workflow、storage、review、publish

このbriefはSD2独立監査で再現した境界破壊を、実装と回帰testへ一対一で落とす。
修正はfixture providerだけで検証し、Qwen call、retry、別model fallbackを行わない。

## 1. release blockers

### R1. full-text visibility provenance

任意に組み立てた`BoundPdfExtraction`と`extractor=pypdf:*`を`full_text`として受理しない。
visible-text verifierが未実装の間、production full-text経路はfail closedにする。test用の入力を許可する場合も、
fixture provider、明示的なtest-only builder、`visible-text-v1:test`の三条件を同時に満たし、公開APIからは作れない境界に置く。

必須test:

- `pypdf:6.16.2`、空でない任意extractor、偽造したbound inputをprovider call前に拒否
- abstract-onlyは影響なく生成可能
- test-only full-text fixtureは明示的な専用builder経由だけ成功

### R2. cache/input identity completeness

最終deck bytesまたは`deck_id`へ影響するproducer-owned値は、すべてinput identityへ入れる。raw proseを保存せず、
必要ならcanonical metadata digestを使う。最低限、title、authors、`fetched_at`、`generated_at`、page count、extracted page count、
generator/coordinator version、prompt content version、prompt request-envelope versionをbindする。

必須test:

- 上記各fieldを一つだけ変えると`input_sha256`と`cache_key`が変わる
- 同一identityならdeck bytes、deck ID、input SHA、cache keyがすべて一致
- 異なるdeck bytesが同じcache keyを持つfixtureを作れない

### R3. every model-authored assertion is grounded

providerが作るtitleやlimitationを、引用参照のない文字列として最終artifactへ移さない。SD2 v1では次のいずれかを採用する。

1. 非title slide titleにもexact `record_ids`を持たせ、最終SD0 contractまでcitation bindingを保持する。
2. SD0 contractを変えない場合、非title titleとtop-level limitationをコード所有の非事実ラベルだけに限定し、
   論文固有の限界は引用付きbullet/noteにのみ置く。

source paper titleはcatalog由来のtrusted envelopeから投影し、providerへ渡さない。model-authored limitationを単なる
`list[str]`としてartifactへ残す案は禁止する。

必須test:

- 引用なしの「万能な治療法」型title/limitationを拒否または最終artifactから排除
- title/limitationが引用を持つ設計ではunknown/unselected `record_ids`を拒否
- 必須のmachine-generated/abstract-only警告はコード所有で常に付与

### R4. provider-call mutation boundary

`frozen=True`をsecurity boundaryとみなさない。providerへ渡すobjectと、後段検証・hash・artifact生成に使うtrusted objectを
共有しない。call前のcanonical request hashを、`count_tokens`後と`generate_json`後の両方で再計算し、変化を拒否する。
summaryとcompositionの両stageに同じ規則を適用する。

必須test:

- `count_tokens`中のsystem/data/record mutationをgenerate前に拒否
- `generate_json`中のclaim/record mutationをpayload parse前に拒否
- providerがcall前hashを保存してresponseへ返してもmutationを拒否

### R5. provider identity, pricing and budget snapshots

provider/caller所有dataclass参照をledger、cache identity、artifactへ保持しない。validation直後にprimitiveをfresh exact objectへ
copyし、そのsnapshotだけを使う。provider identityは各call後にもsnapshotと照合する。pricing/budgetはreserveとreconcileで
同じimmutable snapshotを使う。

必須test:

- `generate_json`中にprovider identityを`object.__setattr__`で変えてもartifact/cacheへ反映されず失敗
- reserve後にpricing rateを0へ変えてもusage costは元snapshotどおり、またはcallを失敗
- call間にbudget/pricing/provider identityを変えても後続call前にfail closed

### R6. production adapter registry and deadline

provider/model名の自己申告だけでproduction adapterを許可しない。fixture providerはtest-only entry pointへ隔離する。
production adapterはcode-owned registry/factoryの具体実装へbindし、各callへtrusted clockから計算した残りdeadlineを渡す。
同期coreだけで停止不能なthreadを安全にkillできるとは主張せず、network接続・read timeoutはadapter側の必須契約にする。

必須test:

- public/default経路でfixture identityを拒否し、明示したtest helperだけが受理
- deadlineが0以下ならprovider call前に拒否
- provider復帰時にtrusted clock上のwall budget超過をcandidate作成前に拒否
- pricingの有効期限はrequestの`generated_at`ではなく注入したtrusted UTC clockで判定

### R7. verbatim and semantic limits

引用IDは出所を示すが、意味的支持を自動証明しない。candidateは常にprovisionalとしhuman reviewを残す。
一方、providerが入力chunkを大規模に逐語コピーすることは機械的に抑止する。正規化した連続一致の最大長と、
全出力に占めるaggregate overlapを決定的に計測し、短い専門語を誤検知しない閾値をfixtureで固定する。

必須test:

- 一般的な短い専門語・短い数値は許可
- 長い連続コピーと複数slideへ分散したaggregate copyを拒否
- guardはraw input/outputをexception、result、logへ残さない

## 2. error and information boundary

- ordinary failureは既存のstable `PAPER_SLIDE_*` + issue codeへ変換する
- raw paper text、provider payload、request ID、title、author、record ID、secret-like textをexception/repr/logへ含めない
- `KeyboardInterrupt`と`SystemExit`はmaskしない
- repair retry、free-form repair prompt、別model fallbackを追加しない

## 3. acceptance gates

1. 監査reproを先にnegative testとして追加し、修正前に失敗することを確認
2. SD2 focused pytest、Ruff format/check、Python 3.10 AST、narrow mypy
3. 全`test_slide_*.py`、全Python回帰、Node viewer回帰
4. wheel/sdistにruntime moduleが入り、test/fixtureやsecretが入らないことを確認
5. 独立read-only security re-auditでR1〜R5を再確認

SD2修正完了はoffline coreの完了を意味するだけで、live Qwen、full-text OCR verifier、OCI worker image、review、公開を
完了扱いにしない。
