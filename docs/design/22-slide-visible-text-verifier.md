# 22. Paper Slide visible-text verifier implementation brief

- **更新日:** 2026-09-01
- **状態:** VT0 visible contractはローカル実装済み。VT1〜VT4、image digest承認、Linux/Docker Desktop E2E、human citation reviewは未実装・未実施
- **親契約:** [`17-paper-slide-deck-contract.md`](17-paper-slide-deck-contract.md)
- **理由:** pypdfのtext layerだけでは、人間に見える文字列かを証明できない

現在のSD1は、非空のPDF textを`page_text_visibility_unverifiable`でfail closedにする。したがって安全に使える
生成経路は当面`abstract_only`だけであり、`full_text`を再有効化する条件を本書で固定する。

## 1. 採用方式

full-textの正本を埋込text layerにせず、**最終描画pixelから得たOCR text**にする。pypdfは暗号化、page count、
構造上限のpreflightだけに使い、LLMへ渡す本文はrasterizer + OCR workerの出力だけとする。

```text
trusted PDF bytes
  → digest-pinned credential-free container
  → pageを最終表示状態へrasterize
  → rasterだけをOCR
  → confidence/size/pixel budget gate
  → physical page付きnormalized chunks
  → parentがPDF/page/chunk hashを再検証
```

crop外、alpha 0、白地の白文字、後から塗り潰された文字、clip外、画面外、極小textは最終pixelに読める形で
存在しないため、OCR本文へ採用しない。OCRが読めるほど表示されているprompt injectionは依然untrusted dataであり、
SD2のsystem/data分離、no-tools、closed output、citation、人手reviewで扱う。

## 2. v1の制限

- OCR languageは`eng`だけ。英語として十分に認識できない論文は`abstract_only`へ明示降格する。
- 数式、表、図中の細字、二段組は欠落し得る。欠落はlimitationsへ固定表示し、推測補完しない。
- 原図、raster page、OCR座標、抽出全文をartifact、Git、Pages、cache、logへ保存しない。
- OCRは意味の正しさを保証しない。生成deckはprovisionalで、人手review前に公開しない。
- PDF自身のtext layerとの一致を成功条件にしない。hidden layerを正解データに使わない。

## 3. hard limits

`visible-text-v1` profileは既存SD1 ceilingより小さく固定する。

| 項目 | v1上限 |
|---|---:|
| PDF bytes | 32 MiB |
| pages | 32 |
| render DPI | 180 |
| page dimension | 各辺4,096 px |
| total rendered pixels | 100,000,000 |
| page raster bytes | 32 MiB |
| OCR wall time/page | 15秒 |
| total wall time | 180秒 |
| page text | 100,000 code points |
| total text | 1,500,000 code points |
| chunks | 64 |

pageは一枚ずつ処理してrasterを直ちに破棄する。dimension/pixel budgetはallocation前に計算し、rotation後の実寸にも
再適用する。巨大page、異常DPI、透過/色空間変換失敗、OCR timeout、engine crashはstable codeで停止する。

## 4. worker imageと隔離

- 専用OCI imageをrepository digestで固定し、mutable tagや`--pull=always`を使わない。
- imageはrasterizer、OCR engine、`eng` language data、PaperPilot workerだけを含む。
- 各binary、language data、Python wheelのSHA-256とversionをimage attestationへ記録する。
- host mount、network、IPC、capability、root、writable root、container log、親credentialを禁止する。
- stdin/stdoutだけを使い、read-only root + bounded tmpfs、PID/memory/CPU/fd/file/pixel/output上限を適用する。
- image build/pull、digest承認、runtime socket設定は外部gate。未設定・attestation不一致ならfull-textへfallbackしない。

image内に`VOLUME`、credential、sitecustomize、remote model downloaderを含めない。OCR language dataはbuild時に固定し、
runtime downloadを行わない。

## 5. 実装単位

| 単位 | owner files | 成果 |
|---|---|---|
| VT0 contract | `paperpilot/paper_slides/visible_contract.py`、tests | pixel/OCR manifest、stable errors、parent validation |
| VT1 renderer/OCR core | `paperpilot/paper_slides/visible_extract.py`、synthetic PDF tests | sequential raster、OCR、page-aware chunks |
| VT2 worker | `visible_extract_worker.py`、container contract | stdin/stdout closed protocol、resource limits |
| VT3 integration | `isolate.py` runner mode、`pipeline.py` binding tests | attested workerだけをproduction full-textへ接続 |
| VT4 image | dedicated Dockerfile/wheelhouse lock/inspection tests | offline reproducible image input、digest approval checklist |

VT0はhostile JSONのbounded parse、PDF/options/page/chunk/hash/resource aggregateのparent再検証、immutableな
redacted result、code-owned engine registryを実装した。production registryは意図的に空であり、rasterizer/OCR実処理を
行うVT1、隔離workerのVT2、production bindingのVT3、承認済みimageのVT4を代替しない。

既存`extract.py`のpypdf normalization helperは構造・回帰テストに残してよいが、VT3合格前に
`_is_page_text_visibility_verified=True`へ変更してはならない。

## 6. output contract

worker resultは既存`PdfExtractionResult`へ投影できる情報だけを返す。

- PDF SHA-256、physical page count、OCR成功page count
- `pNNN-cNN`、physical page、normalized text、text SHA-256、短いsection hint
- `extractor = visible-text-v1:<rasterizer-version>+<ocr-version>+eng-<data-hash-prefix>`
- effective DPI、pixel/page/text/chunk limitsを含むclosed options

word confidenceやbboxはworker内の判定にだけ使い、公開deckへ出さない。pageごとに最低word数、中央値confidence、
visible character比を満たさないtextは採用せず、全体が500 code points未満なら既存
`PAPER_SLIDE_EXTRACTION_INSUFFICIENT`とする。

## 7. synthetic security fixtures

全fixtureはtest内で生成し、PDF/raster/OCR全文をrepositoryへ残さない。

- 通常の英語二段組PDFがpage番号を保持して成功する
- crop外、media外、render mode 3/7、alpha 0、白地の白、clip外、後描画の白矩形で隠したtextが出力へ入らない
- originだけ内側の長大run、極小font/CTM/Tzが出力へ入らない
- visible prompt injectionはtextとして残るが、SD2でdata recordからsystem instructionへ昇格しない
- scan PDF、回転page、透明page、巨大dimension、pixel bomb、malformed/encrypted、timeout、worker crashがbounded failure
- OCR engineを偽装したchild outputのpage/hash/options/textをparentが拒否する
- worker/container不在時にpypdf textやabstractを`full_text`としてsilent fallbackしない

## 8. 出荷gate

1. synthetic fixtureの可視/不可視判定を2つの独立test ownerがreviewする。
2. dedicated imageをoffline wheelhouseからbuildし、SBOM、binary/data hash、no-volume/no-secret inspectionを保存する。
3. digest固定imageでproduction container pathのE2EをLinux CIとDocker Desktopの双方で実行する。
4. 既知の公開OA PDFを明示承認後にread-only canaryし、page/citationを人手照合する。
5. canary合格後だけ`full_text` coverageを有効化する。失敗は常に`abstract_only`表示またはrequest failureで可視化する。

VT0〜VT4、image digest承認、E2E、human citation reviewのいずれかが欠ける間は、production full-textはblockedのままとする。
