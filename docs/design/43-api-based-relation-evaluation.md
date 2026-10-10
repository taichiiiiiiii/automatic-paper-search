# 43. 関係の種類を公開 API だけで決められるか（R2-9 評価）

- 日付: 2026-10-10（評価のみ。生成の動作は変えていない）
- 問い: 系譜の edge の関係（supersedes / successor / extends / ablation / baseline_only / contrasts）は今 LLM（Groq 無料枠）で決めている。2026-08 から約 2 か月黙って壊れており、1 日 20 万トークンの上限もある。公開 API を組み合わせれば LLM は要らなくなるか
- 範囲: **関係の種類**と、LLM なしでどこまでできるか。テーマとの関連（topic relevance）は R2-4 で別に評価する
- 再現: `pnpm exec tsx apps/pipeline/src/lineage/eval/apiRelationsCli.ts --broad 300`（応答はすべて `~/.hermes/cache/scratch/r2-9-cache` にキャッシュする。2 回目以降はネットワークを使わない）。規則は `apps/pipeline/src/lineage/eval/apiRelations.ts`、人手確認の記録は `apps/pipeline/test/fixtures/lineage-eval/api-relations-handcheck.json`

## 結論（先に）

1. **LLM なしでも「中身のある引用か、背景として触れただけか」までは決められる。** 粗い 2 値（受け継ぐ／受け継がない）の正解率は、規則 v2 が hold-out で 80%（24/30）。今の LLM（prompt v2）が出しているラベルの大半は `baseline_only` で、規則 v2 との粗い一致は 79%（34/43）
2. **細かい種類（土台にした／比較した／データ等を使った）は、API だけでは半分しか当たらない。** 規則 v2 の精度は builds_on 50%（6/12）、compares_with 63%（5/8）、uses_resource 50%（5/10）。間違いの大半は「1 文が [3, 7, 12] のように何本も引用していて、手がかりの語が別の論文についての語だった」もの
3. **今の LLM は細かい種類でもっと悪い。** LLM は要旨しか見ないので、背景として引いただけの組に extends / successor を付けすぎる（人手確認で、LLM が「受け継ぐ」とした 24 件のうち正しいのは 5 件）。一方で、本当に受け継いでいる組（5 件）は LLM が全部拾い、規則 v2 は半分を取りこぼす
4. 推奨: **API 優先 + 根拠の文で判定する LLM を補助に（API-first + LLM fallback）**。関係の種類は 5 つに減らし、どの edge にも根拠の文（S2 の引用文脈）を付ける。LLM には要旨でなく引用文脈を渡し、手がかりの語が見つかった edge（約 25%）だけに使う。LLM が止まっても系譜は作れる（細かい種類が `background` 寄りになるだけ）

## 1. API の調査

| API | 取れるもの | 関係の種類の手がかり | 上限・条件（2026-10 に確認） |
|---|---|---|---|
| Semantic Scholar Graph API | `/paper/{id}/references`・`/citations` に引用ごとの `contexts`（引用している文）、`intents`（background / methodology / result）、`isInfluential`。`POST /paper/batch`（最大 500 件）、`/paper/search/match` | **あり（唯一の組ごとの手がかり）**。文脈・意図・重要度 | 鍵なし: 全利用者共有で 1000 req/s、混雑時は絞られる（今回 約 330 回の呼び出しで 429 が 100 回以上）。鍵: 無料、申請フォーム（semanticscholar.org/product/api → Request an API Key）、最初は全エンドポイント 1 req/s の専用枠。出版社によって文脈が伏せられる。S2 API License Agreement に従う |
| OpenAlex | `referenced_works`、`cites:` フィルタ、`related_works`、topics | なし（引用の有無だけ）。topics は R2-4 | 鍵なし $0.10/日、無料鍵 $1/日、100 req/s。データは CC0 |
| OpenCitations Index v2 | DOI 同士の引用、`timespan`、`author_sc`（著者の自己引用）・`journal_sc` | 自己引用の印だけ | 180 req/分/IP、CC0。DOI の無い arXiv だけの論文は出ない |
| Crossref REST | 出版社が登録した参考文献の一覧 | なし | 公開 5 req/s・同時 1、polite（mailto）10 req/s・同時 3 |
| arXiv API | 書誌情報。本文（LaTeX/PDF）は別に取得 | 本文を自分で解析すれば文脈と番号の対応が取れる（unarXive と同じ作り）。重い | 3 秒に 1 回 |
| scite.ai | `GET /tallies/{doi}`（支持・反論・言及の件数）は**鍵なしで 200 を確認**。引用ごとの文や検索は鍵が必要（Pro 約 $20/月〜、研究・商用は別契約） | 実質なし。件数は論文単位で組単位でない。ML 論文はほぼ「言及」（GNN モデル論文: 言及 4805・支持 2・反論 0） | 個人利用以外は要相談 |
| Hugging Face Papers（Papers with Code の後継。PwC の API は 2025-07 に終了） | `/api/papers/{arxiv}`、`/api/models?filter=arxiv:{id}` で論文に結び付いたモデル・データセット | 論文同士の関係はない。コード・モデルの有無（uses_resource の補助）だけ | 公開。厳密な上限の記載なし |
| 引用意図のデータセット | SciCite（S2 の intents の学習元、3 種）、ACL-ARC（background / uses / compare-contrast / motivation / extension / future の 6 種）、unarXive（本文の引用文脈。`classify.ts` の 1 層目で既に使用） | 自前の小さな分類器を作れる | 今回は大きなモデルを落とさない条件なので試していない |

組ごとに関係の種類を返すのは **S2 だけ**。ほかは「引用がある」ことの確認か、論文単位の補助情報になる。

## 2. 実測した網羅率

対象: 公開中の 4 テーマの全 edge と、git の履歴で一度でも LLM が付けたラベルのある edge（focus、325 件）。比較のため、それ以外の古い edge から無作為に 300 件（broad）。edge は `src` = 引用される側（古い）、`dst` = 引用する側。

| | focus（n=325） | broad（n=300） | 全体（n=625） |
|---|---|---|---|
| 引用側を S2 で特定できた | 100% | 98.7% | 99.4% |
| その組が S2 の参考文献に見つかった | 91.7% | 90.7% | 91.2% |
| intent が 1 つ以上ある | 57.8% | 57.3% | 57.6% |
| 引用文脈（文）がある | 71.7% | 78.7% | 75.0% |
| `isInfluential` | 28.6% | 51.3% | 39.5% |
| 著者が重なる（自己引用） | 8.9% | 14.0% | 11.4% |
| OpenAlex でも引用を確認 | 99.4% | 98.7% | 99.2% |

intent の内訳（組が見つかった 570 件）: なし 210、background+methodology 147、methodology 96、background 96、background+methodology+result 13、result 4、ほか 4。**`result`（比較）が付くのは 3% だけ**で、S2 の intent だけでは「比較した」はほぼ分からない。

公開中のテーマ別: GNN 35 件中 文脈あり 21、MoE 12 件中 9、ViT 109 件中 92、FlashAttention 6 件中 3。小さく古いテーマほど文脈が欠ける。

## 3. 規則（API だけ）

簡略化した関係: `builds_on`（土台にした）/ `compares_with`（比べた・対比した）/ `uses_resource`（データ・コード・最適化法などを使った）/ `background`（背景として触れた）/ `cites_unspecified`（引用はあるが種類の手がかりなし）。

v1 を作って人手確認（dev 49 件）し、外れ方を見て v2 に直した。v2 は別の 30 件（hold-out、v2 の出力を見る前に正解を付けた）で確かめた。

| 順 | v2 の規則 | 結果 | v1 との違い |
|---|---|---|---|
| 0 | S2 にその組が無い | cites_unspecified | 同じ |
| 1 | 引用側の題名が survey / review / overview / tutorial | background | 新設（サーベイは全部背景） |
| 2 | 文に「build on/upon」「we extend/adapt」「extension/variant of」「following [X]」「our … is based on」「inspired by」「we adopt/use the … architecture/module」 | builds_on | 同じ |
| 3 | 1 つの節の中に「use/adopt/train on/evaluate on/initialized with …」と「dataset/benchmark/code/optimizer/framework/weights …」 | uses_resource | 語が文のどこかにあれば可 → 1 つの節の中に限定 |
| 4 | 主語が we/our の文で「unlike / in contrast to / differ from」「outperform / compared with / baseline / state of the art」、または結果表の行（小数が 4 つ以上） | compares_with | 主語を問わず → we/our に限定、表の行を追加 |
| 5 | S2 intent に result | compares_with | 同じ |
| 6 | S2 intent に methodology **かつ** `isInfluential` | builds_on（弱） | v1 は methodology だけで builds_on、`isInfluential` だけでも、著者の重なりだけでも builds_on |
| 7 | 文脈はあるが上のどれでもない | background | |
| 8 | 文脈なし | cites_unspecified | |

v2 を全 625 件に当てた結果: background 281、cites_unspecified 134、builds_on 136、compares_with 39、uses_resource 35。

## 4. LLM のラベルとの比較

### 4.1 突き合わせ（v2、LLM のラベルがある 261 件。LLM 側は各 edge の最新のラベル）

| LLM ＼ API v2 | builds_on | compares_with | uses_resource | background | cites_unspecified |
|---|---|---|---|---|---|
| contrasts（134） | 25 | 5 | 12 | 52 | 40 |
| extends（67） | 10 | 3 | 2 | 32 | 20 |
| baseline_only（41） | 1 | 0 | 0 | 38 | 2 |
| successor（18） | 5 | 2 | 1 | 4 | 6 |
| supersedes（1） | 0 | 0 | 0 | 1 | 0 |

- 粗い 2 値（受け継ぐ = supersedes/successor/extends/ablation ↔ builds_on）の一致: v1 56.8%（105/185）、v2 63.2%（122/193）。公開中の成果物の LLM ラベル（prompt v2）だけなら v2 との一致は 79%（34/43）
- `contrasts` の 134 件は主に prompt v1 の時代のもの（R2-2d で使いすぎを直す前）。API 側でそれを裏づける文（we/our + unlike 等）があるのは 5 件だけ

### 4.2 人手確認（79 件。引用文脈を読んで正解を付けた）

| | dev（49 件。LLM ラベル × v1 の組で層別に抽出、v2 の調整に使用） | hold-out（30 件。LLM あり 15・なし 15 を無作為） |
|---|---|---|
| 正解の内訳 | background 33・builds_on 7・compares_with 6・uses_resource 3 | background 17・builds_on 5・compares_with 4・uses_resource 4 |
| 常に background と答えた場合 | 67%（33/49） | 57%（17/30） |
| API v1（5 種） | 51%（25/49） | 40%（12/30） |
| **API v2（5 種）** | 82%（40/49）※調整に使った | **67%（20/30）** |
| API v1（粗い 2 値） | 71% | 60% |
| **API v2（粗い 2 値）** | 88% | **80%（24/30）** |
| LLM（LLM ラベルのある edge、5 種に写して） | 36%（14/39） | 27%（4/15） |
| LLM（粗い 2 値） | 62%（24/39） | 73%（11/15） |
| 同じ edge での API v2（5 種 / 粗い） | 82% / 90% | 67% / 73% |

種類ごとの精度（79 件まとめて）:

| 予測 | API v1 | API v2 | LLM（粗い 2 値で見て） |
|---|---|---|---|
| builds_on / 受け継ぐ | 28%（9/32） | 50%（6/12） | extends 15%（2/13）、successor 20%（2/10）、supersedes 1/1 |
| compares_with | 25%（4/16） | 63%（5/8） | contrasts は「受け継がない」としては 20/20 正しいが、本当に対比・比較なのは約 2 割 |
| uses_resource | 45%（5/11） | 50%（5/10） | （該当ラベルなし） |
| background | 95%（19/20） | 90%（44/49） | baseline_only 10/10 |

- 本当に builds_on の 12 件の拾い方: v1 9、v2 6、LLM は LLM ラベルのある 5 件を 5 件とも
- `isInfluential` は種類でなく「中身のある引用か」の手がかりとして効く: true の 33 件のうち背景でないもの 22（67%）、false の 46 件では 7（15%）
- S2 の methodology intent は builds_on の手がかりにならない（methodology が付いた 36 件のうち builds_on は 8）

**注意**: 正解は 1 人（評価を作った私）が付けた。見たのは S2 の引用文脈で、規則が見るものと同じ。LLM は要旨しか見ていないので、この比べ方は API に有利。dev は珍しい組を多めに取った層別抽出なので、全体の割合の推定には hold-out を使う。

### 4.3 どこで LLM が勝ち、どこで負けたか

| | LLM が良い | API v2 が良い |
|---|---|---|
| 本当に受け継いでいる組（Swin→Swin V2、Non-local→CCNet、ConvNeXt→RepLKNet） | 要旨から系統を読める。文脈が無い組（GNN 2006→GNN 2009 は S2 に文脈なし）でも答えを出す | 手がかりの語が無いと取りこぼす（DALL·E が Transformer を使う、Xception が Inception を土台にする） |
| 背景として触れただけの組（サーベイ、関連研究の列挙） | extends / successor / contrasts を付けすぎる（題名が似ているだけで「発展」） | サーベイ規則と既定の background でほぼ正しい |
| 理由の説明 | 自然文だが根拠が確かめられない（要旨からの推測） | 論文の実際の文を根拠として出せる |
| 失敗のしかた | 黙って壊れる、上限で止まる | 1 文に複数の引用があると、別の論文についての語に反応する（例: 「LINE → MoNet」は Word2Vec についての "inspired by" に反応） |

## 5. LLM なしで失うもの

- 細かい種類の半分（builds_on・uses_resource は約 5 割の精度、builds_on の半分を取りこぼす）
- 文脈が無い 約 25% の edge（出版社が伏せた・古い PDF）の種類。`cites_unspecified` になる
- supersedes（置き換え）と successor（発展）と extends（応用）の区別。v2 は 1 つの builds_on にまとめる（題名の版数 `title_version` と foundational allowlist は今のまま使える）
- ablation の判定（今回の edge には実例がない）

## 6. 主系統（main line）を API で選べるか（簡易）

点数 = builds_on（規則）2 + `isInfluential` 1 + 著者の重なり 0.5 − サーベイ 2 で並べた。

- ViT（文脈 92/109）: 上位は Transformer→ViT、Swin→Swin V2、ViT→ViViT、Swin→Video Swin、Swin→CSWin で、人の目で見ても主系統に近い
- GNN（文脈 21/35）: 本当の主系統 GNN 2006→GNN 2009 は S2 に文脈が無く、点が付かない。上位 2 件目は誤検出（上の LINE→MoNet）
- MoE・FlashAttention: edge が少なく、テーマ外の論文が混じっているので、関係の種類より R2-4 のテーマ判定の問題が大きい

`isInfluential` と規則の builds_on は、web の主系統（`apps/web/lib/lineage/v2/projection.ts` の spine。今は relation の順位 supersedes > successor > extends … で決めている）の順位付けの材料に使える。ただし文脈の無い古い組は拾えないので、foundational allowlist・題名の版数と併用する。

## 7. 費用と上限

| | API のみ（S2） | 今（LLM） |
|---|---|---|
| 1 テーマあたりの呼び出し | 引用側の論文 1 件につき 1 回（`/references`、1000 件まで 1 回）+ 一括 2〜3 回。focus 325 edge の引用側は 83 本 | edge 1 件につき 1 回（要旨 2 本入りの prompt） |
| 時間 | 鍵あり 1 req/s で 1〜2 分。鍵なしは 429 待ちで約 3 倍（今回 625 edge・引用側 302 本で約 15 分） | Groq 無料枠の速度。1 日 20 万トークンで止まる |
| お金 | 無料（S2 鍵も無料） | 無料枠 |
| 壊れ方 | 429・5xx は待って再試行。鍵が無くても動く | 鍵切れ・モデル終了で黙って推測に落ちた（41 の D3） |

**無料の S2 鍵があると変わること**: 取れるデータ（文脈・intent・`isInfluential`）は鍵があっても同じなので、本評価の数字は変わらない。変わるのは速さと安定性だけ（共有枠の 429 が無くなり、1 req/s が保証される）。CI で毎回使うなら鍵を取って `S2_API_KEY` として登録するのを勧める（ユーザーの作業）。

## 8. 推奨

| 案 | 内容 | 評価 |
|---|---|---|
| API だけ | 規則 v2 で決め、LLM を外す | 動かすのは簡単で壊れにくい。粗い 2 値は今の LLM と同等以上。ただし細かい種類は半分外れるので、表示は「土台／比較／利用／背景／引用」程度に留め、根拠の文を必ず見せる |
| **API 優先 + LLM は補助（推奨）** | 規則 v2 で全 edge を決める。手がかりの語が出た edge（約 25%）と、`isInfluential` だが文脈に手がかりが無い edge だけ、**引用文脈と A の題名・著者・年**を LLM に渡して「この文の手がかりは A についてか」「builds_on / compares_with / uses_resource / background のどれか」を聞く | LLM の呼び出しと入力が大きく減る（要旨 2 本 → 文 1〜4 個、edge の 1/4 程度）。上限に当たったり止まったりしても、v2 の結果のまま公開できる（41 の D3 の「公開を止める」は細かい種類にだけ掛ければよい） |
| LLM 優先（今） | 要旨で LLM が決め、S2 は補助 | 「受け継ぐ」の精度が約 2 割で、根拠も確かめられない。勧めない |

## 9. 組み込みの見取り図（案 A は R2-10 で実装。[41](41-lineage-publication-and-reliability.md) の実装メモ）

| 場所 | 変更 |
|---|---|
| `apps/pipeline/src/lineage/theme/bfs.ts` ほか | 今のテーマ生成は OpenAlex の参考文献だけで、`_intents`・`_contexts`・`_is_influential` が空（だから全 edge が「曖昧」で LLM 行き）。引用側ごとに S2 `/paper/{id}/references` を 1 回呼び、組に付ける段を足す（新規 `theme/s2Citations.ts`、キャッシュは `versionedCache.ts`）。S2 の id は arXiv → DOI → 題名の順で引く（今回 100% 特定できた） |
| `apps/pipeline/src/lineage/classify/classify.ts` | `CITATION_CONTEXT_PATTERNS`・`INTENT_RELATION_MAP` を規則 v2（`eval/apiRelations.ts` を `classify/` に移す）に置き換え。`isAmbiguous()` を「手がかりの語が出た、または influential だが手がかりなし」に変える。LLM の prompt は要旨でなく文脈を渡す（`llm/base.ts` の `buildClassifyPrompt`、prompt_version を上げる） |
| 契約 `apps/pipeline/src/lineage/contract/v1.ts` | 案 A（v1 のまま）: builds_on → `extends`、compares_with（対比の語あり）→ `contrasts`、それ以外の compares_with・uses_resource・background → `baseline_only`、cites_unspecified → 今の `citation_heuristic`（`successor`・0.4）。`CLASSIFICATION_METHODS` に `s2_context_rule` を足し、根拠の文を `rationale` に入れる。案 B（`lineage-artifact-v2`）: relation を 5 種に替え、edge に `evidence: { source: "semantic_scholar", sentence, intents, is_influential }` を持たせる。まず案 A で出し、表示を作り直すときに案 B に移るのを勧める |
| web | 案 B のとき `apps/web/lib/lineage/v2/constants.ts` の `Relation`、`projection.ts` の `RELATION_RANK`（spine の順位）、凡例と edge の説明、`how-it-works` ページ。根拠の文は 1 文だけ引用し、出典（Semantic Scholar）を示す |
| 品質検査 | `computeThemeQuality.ts` の `provenance_breakdown` に規則ごとの件数を出す。`cites_unspecified` の割合を検査項目にする |

## 10. 今回作ったもの

- `apps/pipeline/src/lineage/eval/apiRelations.ts` — 規則 v1・v2（純関数）、LLM ラベルの写し方、集計
- `apps/pipeline/src/lineage/eval/apiRelationsCli.ts` — 履歴からの edge 収集、S2・OpenAlex の取得（1 req/s、429 で指数的に待つ、全応答をキャッシュ）、報告
- `apps/pipeline/test/lineage/eval/apiRelations.test.ts` と `apps/pipeline/test/fixtures/lineage-eval/api-relations-handcheck.json`（人手確認 79 件。S2 の信号・規則の結果・LLM のラベル・正解・メモ）。テストは記録した信号から v1・v2 の結果を再現できることと、hold-out で v2 ≥ v1 であることを確かめる
