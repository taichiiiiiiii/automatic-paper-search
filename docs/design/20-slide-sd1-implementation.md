# 20. Paper Slide SD1 implementation brief

- **更新日:** 2026-08-31
- **状態:** source/fetch/isolation はローカル実装済み。full-text は可視性 verifier 待ちで fail closed
- **親契約:** [`17-paper-slide-deck-contract.md`](17-paper-slide-deck-contract.md)

SD1 は、公開 catalog の canonical identity から信頼済み PDF を解決し、SSRF-safe に bounded fetch し、
物理ページ番号を保持した bounded text chunk の低レベル処理を行う。ただし現行の `pypdf` parserだけでは
人間に見える文字列であることを証明できないため、production full-text chunk生成はrender/OCR verifier実装まで
停止する。client URL、title join、live network test、LLM、renderer、workflow、公開はこの単位に含めない。

## 1. 分割と所有ファイル

| 単位 | owner files | public entry point |
|---|---|---|
| SD1R resolver | `paperpilot/paper_slides/resolver.py`、`paperpilot/tests/test_slide_source_resolver.py` | `resolve_pdf_source(catalog_row)` |
| SD1F fetch | `paperpilot/paper_slides/fetch.py`、`paperpilot/tests/test_slide_pdf_fetch.py` | `fetch_pdf(resolved_source, ...)` |
| SD1E extract | `paperpilot/paper_slides/extract.py`、`paperpilot/tests/test_slide_pdf_extract.py` | `extract_pdf(pdf_bytes, ...)` |
| SD1I isolation | `paperpilot/paper_slides/isolate.py`、`paperpilot/paper_slides/extract_worker.py`、`paperpilot/tests/test_slide_pdf_isolation.py` | `extract_pdf_isolated(pdf_bytes, ...)` |
| SD1B binding | `paperpilot/paper_slides/pipeline.py`、`paperpilot/tests/test_slide_pdf_pipeline.py` | `bind_pdf_extraction(source, fetch, extraction)` |

`paperpilot/paper_slides/__init__.py`、`pyproject.toml`、`uv.lock`、本書、workboard は統合 owner だけが更新する。

## 2. Resolver contract

- 入力は catalog row 全体だが、identity は `paper_id + source + source_id` だけで確定する。
- `paper_id == make_paper_id(source, source_id)` を必須とし、title、first match、client URLをidentityに使わない。
- registry は `arxiv | openreview | acl_anthology | cvf` の4種類だけ。unknownはfail closed。
- arXiv、OpenReview、ACL Anthology は正規化済みsource IDからHTTPS landing/PDF URLを構成する。
- CVFはsource IDだけではcollectionを復元できないため、catalogのlanding/PDF URLを入力値として信用せず、
  exact host、HTTPS、port/userinfo/query/fragmentなし、`content/<collection>/{html|papers}`、同一collection、
  source IDとのexact filename一致を検証してcanonical URLを再構成する。
- v1 accessは既知4 public sourceだけ`open_access`、licenseはcatalogが検証済み証拠を持たないため`unknown`。
- errorはstable code/issueだけを持ち、URL、source ID、titleをmessageへ含めない。

## 3. Fetch contract

- resolverが返したtyped sourceだけを受け、任意URL文字列をpublic APIにしない。
- exact host allowlist、HTTPS、userinfo/fragment/non-literal `:443`/IP literal禁止。
- redirectは自動追従せず最大3 hop。各Locationをabsolute化後に同じadapter policyで再検証する。
- DNSの全回答を検査し、loopback/private/link-local/multicast/reserved/unspecified/metadataを1件でも含めば拒否。
- 接続は検証済みIPへpinし、TLS SNI/証明書名/Host headerは検証済みhostnameを使う。pinできないtransportは拒否。
- proxy環境、netrc、cookie、auth headerを使わない。
- connect/read/total timeout、Content-Lengthとstream実byteの両方に32 MiB上限を適用する。
- status 200、`application/pdf`、先頭`%PDF-`を必須とし、body/URL/Locationをerror/logへ含めない。
- testはfake DNS + fake pinned transportだけを使い、live networkへ接続しない。

## 4. Extraction contract

- parserは`pypdf`をoptional `slides` dependencyから使い、import欠損をstable failureにする。
- 入力32 MiB、最大128 pages、暗号化/malformed PDFを拒否する。
- page textはNFKC、新line統一、control/invisible除去、空白正規化を決定的に行う。
- pageごと100,000 code points、全体1,500,000、chunk総数64、1 chunk 12,000 code pointsをhard limitとする。
- chunkはpageを跨がず、`pNNN-cNN`、1-based physical page、normalized text SHA-256、section hintを持つ。
- OCRは行わず、normalized total textが500 code points未満なら`PAPER_SLIDE_EXTRACTION_INSUFFICIENT`。
- attachment、JavaScript、URI/action、annotation本文をLLM入力へ入れず、`page.extract_text()`の結果だけを使う。
- `page.extract_text()`はparser normalizationの入力にすぎず、可視性証拠として扱わない。crop/media不一致、
  明示clip、拡張graphics state、境界外text originは`page_text_visibility_ambiguous`で拒否し、Form XObject textは
  除外する。
- originが内側でもglyph runの大半が外側、極小font / CTM / `Tz`、foreground/background同色、後続paintによる
  occlusionはpypdf visitorだけでは安全に証明できない。そのため実PDFの非空textは現在すべて
  `page_text_visibility_unverifiable`で拒否し、chunkへ入れない。
- render/OCR visibility verifierが独立に成立するまで`coverage.kind = full_text`を生成してはならない。
  catalog abstractだけを使う別経路は必ず`abstract_only`と表示し、full-text成功へ読み替えない。
- raw PDF/textをfile、log、error、fixtureへ残さない。test PDFはtmp/in-memoryで生成する。
- production entry point は in-process parser を package root から公開せず、`extract_pdf_isolated` を使う。
- isolation worker は Linux でのみ起動し、wall timeout、`RLIMIT_CPU / AS / FSIZE / CORE / NOFILE`、空の環境、
  private working directory、bounded stdin/stdout、process-group kill を適用する。macOS その他では
  `isolation_platform_unsupported` で fail closed とし、制限なし実行へ降格しない。
- worker の network / subprocess / fork / exec / ctypes 経路は Python audit hook と runtime monkeypatch で拒否する。
  これは Python runtime 内の防御であり、kernel network namespace、seccomp、container sandbox ではない。
- parent は child の closed JSON、stable error pair、options、PDF/chunk hash、page/chunk順序、text limitsを再検証する。

## 5. Stable result boundary

各層の公開exceptionは`error_code`と`issue_code`だけを返す。success objectはfrozen dataclassとし、
fetch resultはbytes + SHA-256 + byte countを持つ。将来visibility verifierを通過したextract resultだけが
PDF SHA-256、page count、extracted page count、
tuple chunks、extractor identity/optionsだけを持つ。repr/errorへraw bytes/textを出さない。

`bind_pdf_extraction` は resolver identity、実PDF bytes、抽出結果を再検証し、SD0 が使う物理ページ anchor と
chunk/PDF hash binding を immutable mapping として作る。返り値にraw PDF bytesは保持しない。chunk textは
このbinding後もuntrusted dataであり、SD2のdata delimiter外へ出さない。

## 6. Gate

- extraction/isolation focused pytest: **93 passed / 1 skipped**。skip はmacOSでLinux専用isolation parity testを
  実行しないためであり、production APIは同環境でfail closedになる
- resolver全catalog **28,300 / 28,300** 行 dry resolution、fake DNS / fake pinned transportによる
  network-call-zero fetch test、in-memory PDFによる低レベルnormalizationとproduction visibility gateを確認
- Ruff、型/境界mutation、stable error redaction、Linux containerでのcore / isolated parityを確認
- live PDF fetchは実施しておらず、外部sourceの到達性・redirect・実応答は別gate
- live fetch、workflow dispatch、LLM、publish/deploy/push/mergeは明示承認なしに実行しない

SD1はPDFをdeckへ変換する機能ではない。SD2 offline backendとSD3 renderer / public index、selected-cardのread-only
integrationは後続単位としてローカル実装済みだが、VT1〜VT4、request/status Worker、review / publishは未完了である。
したがって現時点でproduction end-to-endのスライド生成を完了とは表示しない。
