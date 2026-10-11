# 47 追加の API・データソースと OSS の調査（LLM なし、2026-10-11 調査）

対象：PaperPilot の既知の穴（引用文が取れず強い関係を取りこぼす 7/32、テーマ外ノード、OpenAlex の誤統合、会場と著者の表示、日本語要約、collect の関連度順位）。
前提：無料、LLM を使わない、公開・非商用サイトと矛盾しないライセンス、GitHub Actions（Node 22・7 GB・GPU なし）か Cloudflare Workers で動く、TS のみ。
方法：公式文書の確認と、実際の API 呼び出し・Node での実行。生データは 手元の一時領域 に置いた。リポジトリは読むだけで、変更していない。
44（データソース）と 46（collect の LLM 不要化）にすでに書いた内容（S2 batch、`.bbl`、TLDR、SPECTER2、S2 Recommendations、OpenAlex keywords、DeepL など）は繰り返さず、**新しく分かったこと**と**44 の訂正**だけを書く。この文書は法的助言ではない。

---

## 0. 結論（推奨順）

| # | 推奨 | 埋める穴 | 実測の根拠 | 費用・鍵 |
|---|---|---|---|---|
| 1 | **arXiv HTML（LaTeXML）から引用文を自前で抽出する**（`https://arxiv.org/html/<id>`、`<cite class="ltx_cite">` と `#bib.bibN` を対応付ける） | 「S2 に参考文献はあるが引用文が 0 本」の組。Switch ← GShard もここに入る | キャッシュにある arXiv の引用元 57 本は**すべて** HTML を返した（57/57、`ltx_cite` あり）。S2 で引用文が空の 28 組のうち **27 組で 1 本以上の引用文**が取れた。**Switch ← GShard は 7 本**取れ、「… addresses expert overflow by passing its representation to the next layer … **which we also follow**」「**As in** Shazeer et al (2018); Lepikhin et al (2020), Switch Transformers simplifies …」のように受け継ぎの手がかりがある。Segmenter ← ViT も「**Following** the recent work on Vision Transformers (ViT) [19, 49] …」が取れた | 無料、鍵は不要。robots.txt は `/html` を Allow、`Crawl-delay: 15` |
| 2 | **出版社が S2 に参考文献を出していない論文**（MMoE など）は、**Crossref の `reference` で参考文献リストを補い**、引用文は **OpenAlex の `content`（GROBID TEI XML）**、または CVF などの OA PDF（`unpdf`）から取る | MMoE 系、AdaMV-MoE、PipeMoE（INFOCOM）、ScheMoE（EuroSys）など、S2 の組がすべて `null` の 8 本 | Crossref は 8 本中 **6 本で参考文献を全件**返した（MMoE は 35/35 件で、Eigen 2013 と Shazeer 2017 を含む）。OpenCitations は一部だけ（MMoE は 11 件）。OpenAlex は 8 本中 3 本（MMoE を含む）が `has_content.grobid_xml: true`。AdaMV-MoE は CVF の PDF を Node（unpdf）で解析し、Expert Choice の引用文を 2 本取れた（ただし背景だけで、受け継ぎの文ではない）。ACM の PDF はスクリプトからだと **403** になる | Crossref は無料（`mailto` 付き）。OpenAlex の content は**鍵が必須で 1 件 $0.01**（無料キーの $1/日で約 100 件/日） |
| 3 | **会場と版の判定に DBLP の SPARQL**（`https://sparql.dblp.org/sparql`、CC0）を使う | arXiv と INFOCOM/EuroSys の表示ずれ、OpenAlex の誤統合の検出 | ScheMoE は EuroSys 2024、PipeMoE は INFOCOM 2023、Switch は CoRR と JMLR 2022 を**別々のレコード**として返した。S2 の `externalIds.DBLP` は CoRR 版を指すことがある（FlashAttention は `journals/corr/abs-2205-14135`）。**DBLP の検索 API（`/search/publ/api`）はボット対策（Anubis）の画面を返し、使えない**。SPARQL は使えた（題名の部分一致は 1 問い合わせ 6〜10 秒。DOI で引けば速い見込み） | 無料、鍵は不要 |
| 4 | **日本語訳はローカルの FuguMT（ONNX）を transformers.js で動かす**（翻訳すると決めた場合） | 日本語要約 | `Kadonox/fugumt-en-ja-onnx`（CC BY-SA 4.0）が Node 22 ＋ `@huggingface/transformers@4.3.1` で**動いた**。読み込み 23〜39 秒、1 文 70〜350 ms（CPU）。訳はおおむね良いが、「MoE routing」が「MoEHguwing」「MoEGyming」に壊れた（MarianTokenizer の fast 版が未対応という警告あり）→ 専門語をプレースホルダーで保護する前処理が要る | 無料、鍵は不要。モデルは q8 で約 145 MB、全形式で 470 MB |
| 5 | **シード検索とテーマ判定の補助に OpenAlex `search.semantic`** | テーマ外ノード、collect の関連度 | 「sparse mixture of experts routing for transformers」で上位 5 本がすべて MoE の手法論文だった（Expert Choice、Hash Layers、StableMoE …）。1 回 $0.001。**`related_works` は雑音が多く使えない**（Switch の関連に ResNet・SQuAD・「HISTORIAE」が出た） | 無料キーの範囲内 |

**44 の訂正（重要）**：44 §3・§4 は fallback の 1 位を「arXiv の `/e-print/<id>` の `.bbl`」としていた。しかし arXiv の robots.txt は **`Disallow: /e-print` と `Disallow: /src`**、一方で **`Allow: /html`、`Crawl-delay: 15`** になっている（実測）。e-print はクローラー向けの許可から外れているので、**fallback は HTML を 1 位にし、`.bbl` は HTML が壊れた論文だけ**に使う（使う場合は arXiv の bulk 用の手段を確認してから）。

---

## 1. 既知の穴と、使える手段

| 穴 | 原因 | 推奨（§0 の番号） | 補足 |
|---|---|---|---|
| Switch ← GShard（引用文 0 本） | S2 が arXiv 版と会議版を 1 件にまとめ、context が抽出されていない | 1 | 7 本取れ、そのうち 2 本に「which we also follow」「As in …」の手がかりがある（§2.1） |
| MMoE 系 3 本（MMoE ← Eigen など） | KDD 2018（ACM）が S2 に参考文献を出していない | 2（Crossref で参考文献の組を作る → OpenAlex の GROBID TEI で引用文を取る） | ACM の PDF は人には無料（2026-01 から全面 OA）だが、スクリプトからは 403。OpenAlex が GROBID 済みの XML を持っている |
| AdaMV-MoE ← Expert Choice | ICCV（IEEE）の参考文献が S2 にない | 2（CVF の PDF） | 取れた 2 本はどちらも列挙の中の引用（「[62, 44, 91, 88, 93, 38]」「[91] distributes the top-k …」）。**取れても強い関係にはならない**ので、41 の判定（背景だけ）を裏付ける結果になった |
| FlashDecoding++ ← FlashAttention | 手がかりの文がない | 1（arXiv HTML） | HTML で 3 本取れたが、「used in FlashAttention [18, 19]」「previous research (e.g., FlashAttention [18, 19]) optimizes latency」の程度。強い関係の根拠としては弱い |
| Shazeer ← Eigen | 規則と LLM の食い違い | （データ源の問題ではない） | — |
| 版の統合で引用文 0 本（Switch・PVT・Segmenter・ShiftViT） | S2 の統合 | 1 | 引用元が arXiv にあれば、統合と関係なく HTML から取れる |
| テーマ外ノード | シードと BFS の広がり | 5、および S2 SPECTER2（46）、主経路分析（§3） | PwC の手法分類は不採用（§2.5） |
| OpenAlex の誤統合、arXiv と会議の表示 | OpenAlex の work の統合 | 3、および Crossref・S2 `publicationVenue` との多数決 | DataCite と Crossref の `has-preprint` は arXiv との対応をほぼ持っていない（§2.3） |
| 日本語要約 | 方針が未決定（46 D2） | 4、または Workers AI `m2m100-1.2b` | §2.4 |
| collect の関連度 | — | 5、および 46 の bge-small と S2 Recommendations | — |

---

## 2. 実測の詳細

### 2.1 arXiv HTML からの引用文（推奨 1）

- **対象**：`data/state/lineage-cache/s2_references.json`（104 件の引用元、555 組）。読んだだけで、変更していない。
  - 引用元の S2 ID は ARXIV が 57、DOI が 42。
  - 引用文のない組は 278 組。内訳は、S2 の組が `null`（参考文献にない）202 組、文が空 76 組。
- **HTML の有無**：ARXIV の 57 本すべてで `https://arxiv.org/html/<id>` が 200 を返し、`ltx_cite` があった。2023-12 以前の論文も返る（中身は ar5iv と同じ LaTeXML 変換）。
  - arXiv の報告（arXiv:2605.16562）では、新規投稿の約 97% が何らかの HTML を出し、誤りのない変換は 75%。
- **照合の手順**：
  1. OpenAlex の題名と `<li id="bib.bibN">` の文字列を照合する（トークンの 8 割以上が一致）。
  2. `href="#bib.bibN"` が出てくる段落 `<p class="ltx_p">` の中で、その文を切り出す。
- **結果**（手元の一時領域）：

  | 組の種類 | 組数 | 文献を照合できた | 引用文が 1 本以上 |
  |---|---|---|---|
  | S2 に参考文献はあるが文が空 | 28 | 27 | **27** |
  | S2 の組が `null` | 117 | 9 | 9 |

  - `null` で照合できた 9 組は、S2 が参考文献を拾えていなかった組（例：Deep MoE 1806.01531 → Eigen、Shazeer、MMoE）。
  - 残りの 108 組は、参考文献にもともと載っていない組（照合の一致率 0.1〜0.6）。
- **取れた例**：
  - Switch ← GShard（7 本）：
    - 「Lepikhin et al (2020) adapts a Mixture-of-Expert model and addresses expert overflow by passing its representation to the next layer without processing through a residual connection **which we also follow**.」
    - 「**As in** Shazeer et al (2018); Lepikhin et al (2020), Switch Transformers simplifies the original design in Shazeer et al (2017) …」
  - Segmenter 2105.05633 ← ViT（8 本）：「**Following** the recent work on Vision Transformers (ViT) [19, 49], we split the image into patches …」
  - PVT v2 2106.13797 ← Swin / PVT（16 本・25 本）、Expert Choice 系の 2106.05974 ← Switch（9 本）。
- **実装上の注意**：
  - 表とキャプションの中の引用（「TABLE II: Taxonomy …」「method pre-train data ViT-B …」）が混ざる。`ltx_tabular` と `figcaption` は除外する。
  - 文の分割は `et al.` と `Fig.` で失敗しやすい。`sentence-splitter@5.0.1` は `et al.` を正しく扱ったが、「See Fig. 3」は分割を誤った（実測）。略語の辞書を足す必要がある。
  - 1 本の論文はおおむね 0.4〜0.5 MB。HTML はキャッシュし、`v` 番号を付けて固定する（版が増えなければ再取得しない）。
- **規約**：
  - arXiv の robots.txt は `Allow: /html`、`Crawl-delay: 15`。
  - 1 テーマ 30〜60 本なら、15 秒間隔で 8〜15 分。初回だけで、以降はキャッシュから読む。
  - 表示は 44 §5 の引用ルール（1 文、出典リンク、引用符）のまま。arXiv の論文のライセンスは論文ごとに違う（arXiv 既定の非独占ライセンス、CC BY など）。短い引用の範囲にとどめ、HTML そのものは再配布しない。
- **unarXive 2024 との比較**：HF `ines-besrour/unarxive_2024` は MIT と表示されているが、約 105 GB で 2024-12 まで。Actions には載らないので、評価用の参照にとどめる。

### 2.2 出版社が参考文献を出していない論文（推奨 2）

S2 の組がすべて `null` の引用元 8 本で、各ソースが何を返すかを調べた。

| 引用元 | Crossref の参考文献 | OpenCitations | OpenAlex の GROBID XML | 本文を取る手段 |
|---|---|---|---|---|
| MMoE（KDD'18、ACM） | 35/35 | 11 | あり | OpenAlex の content（ACM の PDF は 403） |
| SDNE（KDD'16、ACM） | 36/36 | 23 | なし | — |
| Deep hybrid（Elsevier） | 46/46 | 36 | あり | OpenAlex の content |
| PipeMoE（INFOCOM'23、IEEE） | 41/41 | 16 | なし | arXiv 版の有無は未確認 |
| AdaMV-MoE（ICCV'23） | 93/93 | 52 | なし | **CVF の OA PDF（取得できた）** |
| Deweather MoE（AAAI'24） | 0 | 0 | あり | OpenAlex の content |
| ScheMoE（EuroSys'24、ACM） | 55/55 | 20 | なし | ACM（403） |
| GIScience（LIPIcs） | 404 | 0 | なし | — |

- **Crossref**：
  - `reference[]` は DOI か、`volume-title`／`unstructured` の文字列で返る（例：「Learning factored representations in a deep mixture of experts. arXiv preprint arXiv:1312.4314」）。
  - 本文中の arXiv ID か題名から、OpenAlex／S2 の ID に解決できる。
  - **参考文献の組（引用の有無）はこれで復元できる**。ただし引用文はない。
  - Crossref は 2022 年から参考文献を既定で公開している。
- **OpenAlex の content**：
  - `https://content.openalex.org/works/{W}.grobid-xml?api_key=…`。1 件 $0.01（100 credits）。鍵がないと 401（実測）。
  - TEI の `<ref type="bibr" target="#bN">` で引用の位置が分かる。
  - 公式文書の注意：GROBID の誤り（参考文献の欠落・重複、自己参照）はそのまま渡される。
  - ライセンスは work ごと（MMoE は `license: null`、bronze OA）。**XML を保存・再配布せず、短い引用だけを表示する**。
  - 予算は、強い関係の候補で引用文がない組の引用元だけに限れば 1 テーマ数件。日次 $1 の中で十分に足りる。
- **PDF の解析（Node）**：
  - `unpdf@1.8.1`（MIT、pdf.js ベース）でテキストを出し、`[n]` の番号で文を拾う方式は CVF の PDF で動いた。
  - GROBID サーバー（Java、Apache-2.0）は Actions のサービスコンテナでも動くが重い。OpenAlex が GROBID 済みの XML を持っているなら、それを買う方が安い。

### 2.3 会場・版・誤統合（推奨 3）

- **DBLP の SPARQL**（QLever、CC0）：
  - `dblp:title`、`dblp:publishedIn`、`dblp:yearOfPublication`、`dblp:primaryDocumentPage`（DOI）が取れる。
  - **arXiv（CoRR）版と会議版が別レコード**なので、「同じ題名で CoRR 以外がある → 会議名を表示」という規則が書ける。
  - PipeMoE を題名で引くと、IPDPS の別論文と 2025 年の CoRR も返った。**題名の完全一致と著者の照合が必須**。
- **DBLP の検索 API**：`dblp.org`、`dblp.uni-trier.de`、`dblp.dagstuhl.de` のいずれも Anubis のボット確認ページを返した（実測）。使えない。
- **DBLP の XML ダンプ**：`https://dblp.org/xml/dblp.xml.gz`（1.11 GB、2026-10-10 更新、HEAD は 200）。Actions でストリーム処理（`saxes`）すれば会場の索引を作れる。ただし週 1 回でも転送が重い。SPARQL で足りない場合の予備にする。
- **S2**：`publicationVenue` は NeurIPS を正しく返した（FlashAttention）が、`journal.name` は「ArXiv」だった。表示には `publicationVenue` を使う。
- **DataCite（arXiv の DOI）と Crossref の `relation.has-preprint`**：arXiv の DOI は `relatedIdentifiers: []`。Crossref の has-preprint は bioRxiv や Research Square ばかりで、arXiv との対応には使えない。
- **誤統合の検出案**：OpenAlex の `locations[]`、S2 の `externalIds`（DOI・ArXiv・DBLP）、DBLP の各レコードについて、題名と初出年が食い違うものを警告する。

### 2.4 日本語訳（推奨 4、方針が決まった場合）

| 手段 | 実測・根拠 | ライセンス・費用 | 評価 |
|---|---|---|---|
| **FuguMT en→ja ONNX**（`Kadonox/fugumt-en-ja-onnx`、2026-04 更新、transformers.js タグ） | Node 22 で動作（§0）。q8：encoder 36 MB ＋ merged decoder 109 MB | CC BY-SA 4.0（モデル）。出力の訳文に SA が及ぶかは不明確なので、帰属表示を付けるのが安全 | **推奨**。Actions の CPU で、1 テーマ 50 文が 1 分弱 |
| Cloudflare Workers AI `@cf/meta/m2m100-1.2b`（seq2seq の NMT で、LLM ではない） | 公式の料金表：31,050 neurons / 100 万トークン（入出力それぞれ）。無料枠は 10,000 neurons/日 → **合計約 32 万トークン/日** | Workers Free で使える（Cloudflare アカウントは既存）。超過は Paid のみ | 品質は未検証。Worker 側で訳す場合の候補 |
| ELAN MT（`Mitsua/elan-mt-bt-en-ja`） | 許諾済みデータだけで学習した Marian。safetensors のみで ONNX 版はない | CC BY-SA 4.0 | 学習データの出所を重視するなら候補。ONNX への変換は Python で一度だけ必要 |
| `Xenova/opus-mt-en-jap` | 「jap」は聖書コーパスの言語コードで、一般文には向かない | Apache-2.0 | 不採用 |

前処理：CamelCase・略語・数式（`MoE`、`FlashAttention`、`O(n^2)`）を `⟦1⟧` のような記号に置き換えてから訳し、訳した後で元に戻す。「MoE routing」が壊れたのはこの種の語。

### 2.5 関連度・テーマ外（推奨 5 ほか）

- **OpenAlex `search.semantic`**：
  - 200 を返し、`cost_usd: 0.001`、`count` は 50（上限 50 件と見られる）。
  - シードの候補集め、およびノード候補が「テーマ文の意味検索の上位にいるか」の補助信号に使える。
- **OpenAlex `related_works`**：雑音が多く不採用（§0）。
- **Papers with Code のアーカイブ**（HF `pwc-archive/methods`、CC BY-SA 4.0、8,725 行）：
  - 「Vision Transformers」32 件、「Graph Models」52 件があるが、**Mixture-of-Experts は 1 件**しかない。
  - `introduced_year` はほとんどが 2000（欠損値）。
  - **約 6 割が宣伝スパム行**（Expedia、航空会社の電話番号など。正規表現による粗い判定）。
  - 不採用。サイトの終了後に荒らされたデータで、テーマの正解リストとしては信用できない。
- **OpenReview API v2**：
  - `notes/search` は鍵なしで 200。
  - 会場ごとの一覧（`content.venueid=`）は **403「Challenge verification required」**（実測）。
  - 採否や会場の取得を安定して使うのは難しい。

---

## 3. OSS（GitHub・npm）

すべて npm の `latest` と週間ダウンロード数（2026-10-11 時点）で確認した。

| 用途 | パッケージ／リポジトリ | ライセンス | メモ |
|---|---|---|---|
| arXiv HTML の解析 | `cheerio@1.2.0` または `linkedom@0.18.13` | MIT / ISC | LaTeXML の `ltx_cite`・`ltx_bibitem` は素直な DOM。専用ライブラリは不要 |
| 文の分割 | `sentence-splitter@5.0.1` | MIT | `et al.` は正しく扱えた。`Fig.` と `Sec.` には辞書を足す |
| GROBID TEI の解析 | `fast-xml-parser@5.11.2` または `saxes@6.0.0` | MIT / ISC | TEI の `ref[@type=bibr]` から `biblStruct` への対応付け |
| PDF のテキスト化 | `unpdf@1.8.1`（pdf.js を同梱） | MIT（pdf.js は Apache-2.0） | 実測で動作。Workers でも動く設計 |
| LaTeX の解析（HTML がない場合） | `@unified-latex/unified-latex-util-parse@1.8.4`（siefkenj/unified-latex） | MIT | `\cite` の位置と周辺の文の抽出に使える。`.bib` は `@retorquere/bibtex-parser@11`（ISC） |
| 題名の照合 | `fuzzball@2.2.6` | MIT | token_set_ratio で bibitem と題名を照合 |
| 翻訳と埋め込みの実行 | `@huggingface/transformers@4.3.1`（onnxruntime-node 1.30） | Apache-2.0 / MIT | すでに bge-small で使っている依存。Marian（FuguMT）も動いた |
| グラフの指標 | `graphology@0.26.0`、`graphology-metrics@2.4.2`、`graphology-communities-louvain@2.0.2` | MIT | PageRank、媒介中心性、コミュニティ。テーマ外ノードの検出（主成分から離れた小さなコミュニティ）に使える |
| **主経路分析（Main Path Analysis、SPC / SPLC）** | 参照実装：`jfb-h/MainPaths.jl`（Julia、MIT）、`felipefrr/mpa_splc`（Python、ライセンス表記なし） | — | 引用 DAG の「系譜の幹」を決める古典的な手法で、LLM を使わない。TS で書いても DAG のトポロジカル順の DP で 100 行程度。**ライセンス表記のない Python 実装はコードを写さず、論文（Hummon & Doreian 1989、Liu & Lu 2012）から実装する**。効果は未検証 |
| 複数ソースの統合の参考 | `LocalCitationNetwork/LocalCitationNetwork.github.io`（JS、★149、**GPL-3.0**） | GPL-3.0 | OpenAlex・S2・Crossref・OpenCitations を併用する設計の参考。**コードは流用しない**（GPL） |
| 同上 | `CitationGecko/citation-network-explorer`（JS、MIT） | MIT | 流用してよいが古い |
| PDF → 構造化（参考） | `grobidOrg/grobid`（Java、Apache-2.0）、`allenai/s2orc-doc2json`（Python、Apache-2.0） | — | 自前で動かすより OpenAlex の GROBID XML を買う方が安い |
| 引用の意図の分類 | 公開されている SciCite 系の実装は Python と学習用ノートブックだけ（★10 未満） | — | S2 の `intents`（SciCite 由来）がすでにあるので、自前のモデルは不要 |

TS で書かれた OpenAlex・S2 のクライアントは、★0〜1 で保守されていない。既存の自前の fetch 層を使い続ける方が良い。

---

## 4. 採用しないもの（理由）

- **DBLP の検索 API**：ボット対策で応答が得られない。SPARQL を使う。
- **arXiv の `/e-print`・`/src`**：robots.txt で Disallow されている（44 の記述を訂正）。
- **ACM の PDF を直接取得**：OA だがスクリプトからは 403。OpenAlex の content を使う。
- **OpenAlex `related_works`、PwC のアーカイブ**：雑音が多い、またはデータが荒らされている。
- **unarXive 2024、ar5iv のデータセット、S2ORC**：全件が数十〜数百 GB で、Actions に載らない。評価用にとどめる。
- **Crossref・DataCite の preprint relation**：arXiv との対応がない。
- **OpenReview の会場一覧**：チャレンジ（403）で止まる。

---

## 5. 実装の順序（案）

1. `lineage` に **`ArxivHtmlContextSource`** を追加する。
   - 条件は「S2 の文が空」かつ「引用元に arXiv ID がある」組。
   - 15 秒間隔で取得し、ID＋版でキャッシュする。
   - `ltx_p` だけを対象にし、表とキャプションは除外する。
   - 文献は題名の照合で特定する。
   - 取れた文を既存の規則（R2-23）に通し、出典ラベルを `arxiv_html` にする。
   - 41 の 7 本で再評価する。Switch ← GShard は救える見込み、FlashDecoding++ と AdaMV は救えない見込み。
2. **S2 の組がすべて `null` の引用元**の処理を足す。
   - Crossref の `reference` で参考文献の組を作る（出典 `crossref`）。
   - 強い関係の候補だけ、OpenAlex の `grobid-xml` を取得する。上限は 1 実行 20 件（$0.2）とし、予算ヘッダで打ち切る。
   - CVF のように OA PDF の URL がある場合は、unpdf で読む。
3. **会場の正規化**を足す。
   - 優先順は S2 `publicationVenue` → DBLP SPARQL（DOI で引き、なければ題名の完全一致）→ OpenAlex。
   - 食い違いを品質表に出す。
4. 翻訳を採用する場合は、FuguMT ONNX をビルド時のジョブで動かし、訳文をキャッシュする。表示に「機械翻訳」を明記し、原文を併記する。
5. （実験）主経路分析と louvain を使い、テーマ外ノードの候補を出す。42 の評価セットで P/R を測る。

---

## 6. 未検証・不確実な点

- arXiv HTML について：
  - 15 秒の Crawl-delay を守った場合の、実運用での 429 の有無（今回は 3 秒間隔で 92 回取得し、すべて 200）。
  - arXiv の HTML に、API の利用規約（3 秒 1 回）と robots.txt のどちらが適用されるか。安全側の 15 秒を推奨した。
- OpenAlex の GROBID XML の中身：鍵が手元にないため取得していない。`has_content` が true であることだけ確認した。
- 引用文の自前抽出による強い関係の回復数：Switch ← GShard 以外の 6 本は、規則に通した評価をしていない。抽出した文を目で見ただけ。
- m2m100（Workers AI）の日本語訳の品質。
- FuguMT の訳文に CC BY-SA が及ぶかどうか。
- DBLP SPARQL の利用上限と、DOI で引いた場合の速さ。
- 主経路分析の効果。
- PipeMoE と ScheMoE に arXiv 版があるか。

## 付録：probe47/ の中身

- `arxiv_html_avail.json`：57 本の HTML の有無。
- `html_ctx_results.json`：145 組の照合と引用文。
- `html/*.html`：取得した arXiv の HTML。
- `pdfctx.mjs`：unpdf で PDF から引用文を抽出するスクリプト。
- `mt.mjs`：FuguMT の実行スクリプト。
- `pwc_methods.parquet`：PwC の手法アーカイブ。
- `adamv.pdf`：AdaMV-MoE の CVF の PDF。
- `oa_hdr.txt`：OpenAlex の content が 401 になったときの応答ヘッダー。

> 生の取得結果は手元の一時領域に置いたため、リポジトリには入れていない（2026-10-11）。
