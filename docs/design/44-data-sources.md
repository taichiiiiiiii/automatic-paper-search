# 44 データソース調査：レート制限・規約・推奨構成（2026-10-10 調査）

対象：PaperPilot の系譜生成（参考文献リスト／シード検索／関係の根拠）。
調査方法：公式ドキュメントの確認と少量の実 API 呼び出し。レスポンスは `cache44/` に保存。
この文書は法的助言ではない。規約の解釈は「公式文言＋推奨対応」にとどめている。

---

## 0. 結論（先に）

1. **OpenAlex の 429 の主因は「キーなし予算」**。2026-02-13 以降、キーなしの予算は **$0.10/日（1,000 credits）** しかない。search は 1 回 10 credits なので、**1 日 100 回**で尽きる。上限は毎日 0:00 UTC にリセットされる。GitHub Actions の共有 IP では、ほぼ確実に枯渇する。
   → **無料 API キー（$1/日 = 10,000 credits）を Secret `OPENALEX_API_KEY` として登録するのが最優先**。`mailto`（polite pool）は 2026-02 に廃止済みで、もう効果はない。
2. **参考文献リストの主ソースは Semantic Scholar（S2）`/paper/batch` にする**。`references.paperId,references.title` を指定すると、最大 500 件を 1 回で取れる。実測では、OpenAlex で 0 件だった FlashAttention 1/2/3 の参考文献を S2 は 111/20/61 件返した。
   fallback は **arXiv の LaTeX ソースに入っている `.bbl`** にする。FA1 では `\bibitem` が 94 件あった。
3. **関係の根拠は S2 の `/paper/{id}/references`**（contexts / intents / isInfluential）から取る。FA1 では 111 件中 88 件に context が付いていた。ただしこれらの項目は **batch では取得できない**（400 `Unsupported fields: references.contexts`）。グラフに採用する論文だけを、個別に取得する。
4. **S2 の citations データセット（contexts を含む）のライセンスは ODC-BY**。サイトに「Semantic Scholar」の帰属表示が必要で、論文 *The Semantic Scholar Open Data Platform* の引用も求められている。
   context の文は第三者（論文著者）の著作物の抜粋なので、**短い引用として、出典リンク・明瞭区別・削除依頼窓口を付けて表示する**のが安全。
5. **S2 キー取得のリスク**：2024 年のリリースノート（2025-01 にアーカイブ済み）に「フリーメールのドメインからの申請と、サードパーティアプリ向けの申請は承認しない」とある。承認されない可能性があるので、**キーなしでも回る設計を前提にする**（キャッシュ、batch、指数バックオフ）。

---

## 1. OpenAlex（2026 年時点）

| 項目 | 内容（出典） |
|---|---|
| キー | **2026-02 から実質必須**。公式ブログ「API keys are now required」。キーなしでも動くが「デモ用途のみ。本番利用には向かない」。キーは無料（アカウント作成後 openalex.org/settings/api）。`api_key=` パラメータまたは `Authorization: Bearer` で送る。 |
| 予算 | 無料キーは **$1/日**、キーなしは **$0.10/日**（10 倍差）。リセットは 0:00 UTC。プリペイド追加は $1 単位。年額プランは Member $5k（$20/日）、Member+ $10k（$100/日、daily sync 付き）、Partner $20k〜。 |
| 単価 | ID/DOI 単体取得は**無料**。list+filter は $0.0001（1 credit）。search と semantic search は $0.001（10 credits）。rerank は +10 credits。content（PDF）は $0.01。 |
| その他の上限 | 100 req/s を超えると 429。`per_page` 最大 100、OR 値は最大 100、basic paging は 10,000 件まで（それ以上は cursor）。 |
| 実測 | キーなしで `filter=doi:A\|B\|C` を実行：`x-ratelimit-limit: 1000`、`x-ratelimit-limit-usd: 0.1`、`cost 1 credit`。この時点で残り 674 credits、reset まで 42,798 秒。FA1/2/3 は `referenced_works_count = 0` を確認（既知の欠損。GitHub issue #7 の "Attention Is All You Need" と同じ症状）。 |
| polite pool | **廃止**。Deprecations ページに「Historical: Polite Pool — before February 2026 … mailto」とある。`mailto` を付けても予算は増えない。 |
| ライセンス | データは **CC0**。帰属表示は法的義務ではないが、表示を推奨。 |
| bulk | 全件スナップショットは無料でダウンロードできる（CC0、S3）。ただし数百 GB 規模なので Actions には不向き。daily sync は Member+ 以上の特典。 |
| CI での推奨 | (1) キーを Secret に登録する。(2) ID はまとめて `filter=openalex:W1\|W2…` または `doi:` の OR で引く（100 件で 1 credit）。(3) `select=` で必要なフィールドだけ取る。(4) `per_page=100`。(5) search の回数を最小にし、結果をキャッシュする。(6) 429 では `Retry-After` に従い指数バックオフする。日次予算を使い切った場合の 429 は、待っても回復しない（reset は 0:00 UTC）。`X-RateLimit-Remaining` を見て打ち切る。(7) `/rate-limit?api_key=` で残量を記録する。 |

予算の目安（無料キー）：search 1,000 回/日、または list 10,000 回/日。1 テーマあたり search 20 回 + list 200 回でも 400 credits で、余裕がある。

## 2. Semantic Scholar（S2）

| 項目 | 内容 |
|---|---|
| キーなし | 公式ページの記載は「1000 req/s を**全キーなしユーザーで共有**。混雑時はさらに絞られる」。実測でも 429 が頻発した。ほぼ毎回 1〜2 回の再試行で 200 になった。 |
| キーあり | 新規キーは「**全エンドポイント 1 RPS**」。審査を経て上げられる場合がある。約 60 日使わないキーは自動削除される。指数バックオフは**必須**（2024 年のリリースノート）。 |
| キー申請の注意 | 2024-08 以降の記載：フリーメールのドメインからの申請と、サードパーティアプリ向けの申請は承認しない。申請の処理に約 1 か月かかる。リリースノートは 2025-01 にアーカイブされたため、現在の運用は不明。 |
| `/paper/batch` (POST) | 最大 500 ID。応答は 10 MB まで、citations は 9,999 件まで。`/paper/{id}` と同じフィールドが使え、**`references.paperId`、`references.title` なども指定できる**（実測 200）。**`references.contexts` は 400 エラー**になる（contexts / intents / isInfluential は引用関係そのものの属性なので、`/references` と `/citations` でしか取れない）。 |
| `/paper/{id}/references` | `fields=contexts,intents,isInfluential,…`、`limit` は最大 1000。FA1 では 111 件中、context 付き 88、intent 付き 86、influential 18。**context の一部は参考文献の行の誤抽出**（例："[17] Tri Dao, …"）なので、フィルタが必要。 |
| `/paper/search/bulk` | 1 回 1,000 件。トークンで続きを取れて、最大 1,000 万件。boolean クエリが使えるが relevance 順ではなく、ネストした references は返さない。シード候補を広く集める用途向き。 |
| `/paper/search`、`/paper/search/match` | relevance 検索と、タイトルで 1 件を特定する検索。後者は `.bbl` の文献を照合するのに使える。 |
| `/snippet/search` | 本文中の約 500 語の抜粋を検索できる。根拠の補強に使えるが、抜粋が長いので公開表示には不向き。 |
| Datasets API | 一覧と README はキーなしで読める（最新 release は 2026-10-06）。ダウンロードリンクの取得には**キーが必要**（実測で 401 "A valid API key is required"）。citations は 2.4B 件 / 30 ファイル × 8.5 GB で、Actions には不向き。 |
| ライセンス | API License Agreement（2023-05-17 版）：API を通じて S2 Data にアクセスし、**表示する**ための限定ライセンス。S2 Data 自体は付随するライセンス（CC BY-NC または ODC-BY）に従う。**citations、papers、abstracts、s2orc_v2 の README はいずれも ODC-BY**。citations の README は contexts と intents を含むと明記している。 |
| 帰属 | 規約 §4：「Licensee will include an attribution to "Semantic Scholar" on its website」。データセットの README は「製品・サービスで使う場合は Kinney et al. 2023 (arXiv:2301.10140) を引用」と求めている。intents を使う場合は Cohan et al. NAACL 2019 も挙げている。S2 のロゴを使う場合はブランド規定に従う。 |
| 禁止事項 | API の再販・再配布・サブライセンス、レート制限の回避、過剰なリクエスト、法的表示の除去。複数キーの併用は要相談。 |
| 第三者コンテンツ | 規約は「S2 Data には第三者コンテンツが含まれ、その権利者の条件にも従う」としている。context の文は**論文本文の抜粋**（著作権は著者または出版社）。ODC-BY が許諾しているのはデータベースとしての利用。 |

**context 文を公開サイトに表示してよいか**：S2 の規約は「表示」を許諾している。citations データセットは ODC-BY で、帰属を付ければ再配布も可能。したがって、**S2 側の条件は帰属表示で満たせる**。
残るのは原著作物の権利で、1 文程度の短い引用であれば、日本の著作権法 32 条の引用要件で対処するのが現実的。要件は次のとおり：
- 主従関係：系譜の解説が主で、引用は従。
- 明瞭区別：引用符などで区切る。
- 出所明示：論文名とリンク。
- 必要最小限：1 文、300 字程度まで。

現行の InspectorDialog は `excerpt` と「原典を開く」リンクを表示しているので、上記の形に近い。

## 3. その他の参考文献ソース（arXiv の ML 論文向け）

| ソース | ML arXiv での網羅性 | 制限・規約 | 工数 | 評価 |
|---|---|---|---|---|
| **arXiv LaTeX ソース（`/e-print/<id>`）の `.bbl` / `.bib`** | 高い。ML の論文はほぼすべて LaTeX で、FA1 では `.bbl` に 94 件。`\cite` の位置から自前で context も取れる。 | arXiv API の利用規約：レガシー API は「3 秒に 1 回、同時接続 1」で、全マシン合算（e-print もこれに準じて扱うのが安全）。**参考文献から引用グラフを作ることは「してよいこと」に明記**。e-print 本体（PDF / ソース）を自サーバーに保存して配信するのは禁止。arXiv が後援しているかのような表示も禁止。 | 中。`.bbl` を自前でパース（`\bibitem` の分割、タイトル抽出）し、S2 の `search/match` か OpenAlex で ID に解決する。`.bbl` がない論文は `.bib` を見る。Actions で 3 秒間隔なら、1 テーマ数十本で数分。 | **fallback 1 位** |
| GROBID（PDF から抽出） | 高いが、PDF 由来なので誤りが多い | Apache-2.0。Java / Docker のサーバーが必要。 | 高い（Actions でサービスコンテナとして動かせるが重い） | LaTeX がない場合のみ |
| refextract（INSPIRE） | 物理系向けで、ML では中程度 | GPL 系（未確認） | 中 | 優先度は低い |
| unarXive 2022 | 2023-03 時点まで（FA2/3 は含まれない） | open subset は Zenodo で公開（4.8 GB、ライセンスは同梱）。full は restricted で、各論文のライセンスに従う必要がある。 | 高い（静的で古い） | 評価用データのみ |
| CORE API v3 | OA 本文が中心で、arXiv も含む | 無料。キーなしで「batch 1 回、または単体 5 回 / 10 秒」。登録すると改善。非商用、引用を推奨。 | 中 | 不要 |
| Europe PMC | バイオ系のみで、ML はほぼ対象外 | — | — | 対象外 |
| DBLP | 書誌のみ。参考文献は Crossref / OpenCitations 由来を表示しているだけ。 | CC0 | 低い | 会場・著者の名寄せ用途だけ |
| Hugging Face Papers（`/api/papers/<arxiv>`） | 参考文献はない。summary、upvotes、ai_keywords、linked models / datasets がある（実測で 200）。 | HF の規約。キーなしでも利用可。 | 低い | シードの注目度シグナル用（任意） |
| Crossref | arXiv の DOI（10.48550）は参考文献の寄託がなく、空 | 2025-12 改定：public は 5 rps / 同時 1、polite（`mailto`）は 10 rps / 同時 5。メタデータは基本 CC0。 | 低い | 参考文献用途は不要。出版版の DOI 照合のみ。 |
| OpenCitations | FA1 は `[]`（実測） | CC0 | 低い | 不要 |

## 4. 推奨構成（無料枠・GitHub Actions 前提）

**(a) 参考文献リスト**
1. S2 `/paper/batch` で `fields=externalIds,title,year,referenceCount,references.paperId,references.externalIds`、最大 500 ID / 回。キーなしでも、指数バックオフ（10 秒×n）とキャッシュで動く。キーが取れたら 1 RPS で一定のペースで投げる。
2. `referenceCount` に比べて取れた件数が少ない場合、または 0 件の場合は、arXiv の `.bbl` をパースする（3 秒間隔、User-Agent に連絡先を入れる）。ID への解決は S2 `search/match` → OpenAlex の title filter の順。
3. OpenAlex `referenced_works` は補完にだけ使う。union を取り、出典を記録する。

**(b) シード検索**：OpenAlex search（無料キー、`select=`、`per_page=100`）を主にし、S2 `/paper/search` を併用する。広く集めるときは S2 `search/bulk`。Groq / Gemini は検索には使わない。

**(c) 関係の根拠**：グラフに採用した論文に限って S2 `/references` を個別に取得し、contexts / intents / isInfluential を使う（design 41 D6 と同じ方針）。
- context が誤抽出のもの（"[n] 著者名…" のような参考文献行、極端に短い文）は除外する。
- S2 に context がない辺は、arXiv の LaTeX の `\cite` の周辺の文を自前で抽出する（原文の短い引用として扱う）。
- LLM は「手がかり語」のある辺だけに使う。

**運用**：全 API 応答をキャッシュする（Actions cache、または R2 / KV、ID をキーに）。予算ヘッダを記録する。日次予算を使い切ったら fail-closed で翌日に回す。

## 5. コンプライアンス対応（サイトに追加するもの）

1. **フッターと「仕組み」ページの出典表示を拡充する**。
   - 現状はフッターに「データ: arXiv / Semantic Scholar / OpenAlex」とあるだけ。
   - 「Semantic Scholar」の表示は規約 §4 の必須事項で、現状の文言でも最低限は満たしている。リンクは追加することが望ましい。
   - 「仕組み」ページ、または `/credits` に次を追記する：
     - S2 由来のデータ（参考文献、引用 context、intent、influential）は ODC-BY 1.0 であること。
     - Kinney et al. 2023 の引用。
     - intent を使う場合は Cohan et al. 2019 の引用。
     - OpenAlex は CC0（謝意として表示）。
     - 「Thank you to arXiv for use of its open access interoperability.」相当の謝辞。arXiv が後援しているかのように見える表現は避ける。
2. **引用 context の表示ルール**：
   - 1 文、最大 300 字程度にとどめ、引用符で区別する。
   - 論文名と arXiv / S2 の原典リンクを必ず付ける（InspectorDialog は対応済み）。
   - 出典のラベルを付ける（例「Semantic Scholar 提供の引用文脈」）。
   - 本文をまるごと載せたり、PDF / ソースを再配信したりしない。
3. **削除依頼の窓口**（GitHub Issue またはメール）を「仕組み」ページに書く。
4. **公開成果物（JSON の artifact）にライセンス項目を入れる**。excerpt を含む公開データには、`source` ごとのライセンス（S2 = ODC-BY、OpenAlex = CC0）と帰属文を同梱する（ODC-BY は派生データベースの公開時にも帰属を求めるため）。
5. **レート制限の順守**：
   - S2：指数バックオフは必須。複数キーで回避しない。
   - arXiv：3 秒に 1 回、同時 1 接続。Actions の並列ジョブでも合算で守る。
   - OpenAlex：予算ヘッダを守る。
6. **S2 キーの扱い**：Secret として保管し、第三者に共有しない。約 60 日使わないと削除されるので、定期的に使うか監視する。

## 付録：実測ログ（cache44/）
- `oa_hdr.txt` / `oa_fa.json`：OpenAlex キーなしの予算ヘッダ、FA1–3 の referenced_works = 0
- `s2_batch_fa.json`：S2 batch で FA1/2/3 の refs = 111/20/61
- `s2_batch_ctx.json`：batch での `references.contexts` は 400
- `s2_refs_fa1.json`：`/references` で context 88/111
- `s2_release_latest.json`：Datasets の README（ODC-BY、帰属）
- `fa1src/*.bbl`：arXiv e-print の `.bbl`（94 bibitem）
- `hf_fa1.json`、`oc_fa1.json`、`arxiv_tou.md`
