# 23. Paper Slide SD3 deterministic projection

- **更新日:** 2026-09-01
- **状態:** rendererとpublic index projectionはローカル実装済み。browser visual QA、review/publish/deploy、SD7 exportは未実施
- **親契約:** [`17-paper-slide-deck-contract.md`](17-paper-slide-deck-contract.md)
- **入力:** SD0で検証済みの`slide-deck-v1`だけ。SD2のprovider payloadやraw textは受けない

SD3は同じ検証済みdeck JSONから、公開用またはprivate preview用のHTMLを決定論的に作る。
生成、review判定、storage、capability、workflow、publishは扱わない。PPTX/PDF exportはSD7に分離する。

## 1. communication job

研究者または技術者が、論文の問題、手法、根拠、限界、結論を原論文への引用導線付きで短時間に理解し、
機械生成内容を鵜呑みにせず確認箇所へ移動できることを目的とする。

- 一枚につき一つの主張を中心にする
- title slideは論文名、著者、coverageを簡潔に示す
- 各slideはtakeaway型title、低密度のbullet、必要時だけspeaker notesを持つ
- 最終slideで論文の結論と未解決点を閉じる。汎用的な`Thank you`では終えない
- dashboard/card gridではなく、一つのslide canvasを主役にする

## 2. owner files

| 単位 | owner files | 責務 |
|---|---|---|
| SD3R projector | `paperpilot/paper_slides/render.py`、`paperpilot/tests/test_slide_render.py` | validation、HTML escape、決定的bytes、mode gate |
| SD3A assets | `docs/assets/paper-slides.js`、`docs/assets/paper-slides.css`、viewer tests | navigation、focus、responsive、print、reduced motion |
| SD3F fixture | `paperpilot/tests/fixtures/paper-slide-render-v1/` | reviewed/preview projection、hostile text、citation focus |

`paperpilot/paper_slides/__init__.py`、`docs/assets/versions.json`、本書のstatusは統合ownerだけが更新する。
既存assetのcache queryは`versions.json`から生成し、HTMLへ手入力しない。

## 3. projector boundary

```text
render_slide_deck_html(
  deck: exact dict,
  context: SlideDeckValidationContext,
  mode: public | preview,
  assets: exact code-owned AssetReferences,
) -> RenderedSlideDeck

RenderedSlideDeck
  html_bytes: canonical UTF-8 with LF only
  deck_sha256: SHA-256 of validated canonical deck JSON
  html_sha256: SHA-256 of html_bytes
```

- 関数冒頭で`require_valid_slide_deck`を実行し、valid objectだけをprojectする
- `public`は`review.status=reviewed`、`preview`は`provisional|reviewed`だけを許可する
- `mode`、asset path/version、generator metadataはコード所有またはtrusted configとし、利用者入力を受けない
- ordinary exceptionはstable codeへ変換し、deck text、URL、reviewer、provider payloadをcause/contextへ残さない
- raw PDF、抽出chunk、abstract、prompt、provider responseは入力にも返り値にも含めない

## 4. closed DOM projection

document順序を固定する。

1. skip link、app header、coverage banner、provisional banner
2. 一つの`main`内にdeck title/source metadataとslide canvas
3. slide sectionを`slide_id`順に並べ、前後navigationと現在位置を付ける
4. bulletごとにcitation IDへのfocus linkを付ける
5. speaker notesはclosedな`details`。previewでも初期状態は閉じる
6. citation listはID順、trusted source anchor、page、元slideへのback linkを持つ
7. limitations、machine-generated notice、review/publication metadata

model/catalog由来文字列は全てHTML textとしてescapeする。attributeへ入れられるのはvalidatorを通った列挙、ID、
trusted URLだけで、raw文字列をclass、id、style、script、data attributeへ入れない。HTML fragment、Markdown、SVG、
`style`値、`srcdoc`、remote image、remote fontを生成しない。

## 5. static assets

- HTMLはinline script/styleを持たず、same-originのversioned CSS/JSだけを参照する
- JavaScriptは`textContent`、`classList`、固定attributeだけを使い、`innerHTML`、`insertAdjacentHTML`、`eval`、
  dynamic import、network API、storage、analytics、service workerを使わない
- ArrowLeft/ArrowRight、PageUp/PageDown、Home/Endでslide移動し、URL hashとfocusを同期する
- citation linkはcitationへfocusし、back linkで参照元へ戻る。複数参照元は最初の物理slideを決定的に使う
- JSなしでも全slide、citation、source link、limitationsを文書順に読める
- 320px幅、200% zoom、keyboard-only、screen reader landmarks、`prefers-reduced-motion`、print/PDFを満たす
- default typographyはdeck title 50pt相当、slide title 35pt相当、subheading 24pt相当、body 16pt以上を基準にし、
  text量は縮小ではなく折返し・slide縦scroll・projection failureで処理する

## 6. security and headers

HTML自体は次を満たす。

- remote asset、inline event handler、inline script/style、`javascript:`/`data:` URLなし
- external source linkは`target=_blank`を使う場合`rel="noopener noreferrer"`
- previewは`robots=noindex,nofollow`と明示的な未レビュー表示。capability、object key、cookie値をHTMLへ含めない
- publicはcanonical review-record bytesのfull SHA-256を含むsame-origin linkを持ち、provisional表示を公開済みと
  誤認させない。record本体はSD4が供給する別artifactで、SD3 bundleの所有物とはしない

`frame-ancestors`はmeta CSPで保証できない。Worker/private previewではHTTP headerとして
`Content-Security-Policy`、`Cache-Control: private, no-store`、`X-Robots-Tag`、`Referrer-Policy`、
`X-Content-Type-Options`をSD5が付与する。GitHub Pages公開物はplatform制約を正直に表示し、SD3だけでheader保証を称しない。

## 7. deterministic and size limits

- canonical deck bytesが同じならHTML bytesも同じ。現在時刻、乱数、locale、自動asset discoveryを使わない
- UTF-8、LF、末尾改行一つ、attribute順、section順、citation back-target選択を固定する
- HTML上限は1 MiB、slide 12、citation 99というSD0上限を再利用する
- overflowはmodel textを切らずfail closedにし、短縮が必要ならSD2へ戻す
- `deck_sha256`と`html_sha256`をpublic indexへ渡す。HTMLからdeck JSONを再構成しない
- public projectionはコード所有のGitHub Pages base `/automatic-paper-search`とcontent-addressed assetだけを使う。
  公開indexの`deck_path` / `deck_json_path`は同じ`<deck_sha256>-<html_sha256>` revisionを持つexact
  `.html` / `.deck.json`を指し、それぞれ`html_sha256` / `deck_sha256`で検証する
- publication buildは最初にmutableなsite HTMLのasset versionを同期し、`docs/assets/versions.json`と対象asset bytesの
  hash一致を検証してから、一つのasset snapshotで全review済みdeckを一度だけ投影する。builderは同じsnapshotから
  256 shards、manifest、deck HTML / JSON、full-SHA asset CSS / JSのexact bytes mappingを返す
- asset変更時は既存review済みdeckも新しいasset snapshotで新revisionへ再投影する。asset同期scriptは
  `paper-slides-v1/decks/**/*.html`を後書き換えせず、既存revisionと旧assetはappend-onlyに保持する

## 8. acceptance gates

- reviewed fixtureのpublic HTMLとprovisional fixtureのpreview HTMLがbyte-for-byte再現する
- provisionalをpublicへ渡す、context不一致、tampered citation/source/envelopeはproviderやrenderer処理前に失敗する
- hostile title/bullet/author/limitationがDOMやattributeを脱出せず、active contentを含むdeckはSD0で拒否される
- inline/remote asset、unsafe URL、unversioned asset、secret marker、capability-like値がHTMLにない
- 全citation linkが一意なtargetへ解決し、全back linkが既存slideへ解決する
- JSなしのdocument order、keyboard navigation、hash restore、citation focus、320px、reduced motion、printをtestする
- Python focused pytest、Node viewer test、Ruff、Python 3.10 syntax、narrow mypy、full regressionを通す
- live provider、workflow dispatch、storage、publish/deploy/push/mergeは実行しない

## 9. SD7 export boundary

PPTX/PDFはreview済みの同じdeck JSONから作る別projectionとする。PPTX生成時はpresentation artifact runtimeを使い、
全slide render、個別目視、overlap/clipping/wrapping検査、最低font size、各外部claim/assetのspeaker-note sourceを
release gateに含める。SD3 HTMLをscreenshotしてPPTXへ貼る実装や、未review candidateの自動公開downloadは行わない。
