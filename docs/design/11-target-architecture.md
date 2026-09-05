# 11. PaperPilot 目標アーキテクチャ

- **状態:** 決定
- **決定日:** 2026-08-30
- **対象:** 公開サイト、生成パイプライン、Worker API、CI/CD、リポジトリ構成

この文書は、現行実装の正本である
[`09-implementation-status.md`](09-implementation-status.md) と、サイト再設計の判断履歴である
[`10-site-redesign.md`](10-site-redesign.md) をつなぐ目標設計である。01〜07 の古い基本設計より、
本書と 09 を優先する。

---

## 1. 結論

PaperPilot は次の構成とする。

1. **ユーザー向けには 1 サイトとする。** 探索サイトと系譜サイトを分離しない。
2. **モード選択専用サイトは作らない。** 最初に用途を選ばせるゲートではなく、トップページから検索を開始し、
   対象を選んだ後に一覧・関係・系譜という文脈依存のビューを提示する。
3. **論文を中心オブジェクトにする。** 学会、テーマ、検索、系譜は論文集合の入口または表現であり、
   別製品ではない。
4. **静的 MPA を維持する。** 読み取りは GitHub Pages の生成済み JSON、変更操作だけを
   Cloudflare Worker API が受け持つ。全面 SPA にはしない。
5. **リポジトリは分割しない。** Python パイプライン、静的 UI、Worker、ワークフローを同じ変更単位で
   契約テストできる利点が、現時点では分割の利点を上回る。
6. **生成と公開を分離する。** 自動生成物は、スキーマ検証、データ監査、テストを通過してから公開する。
7. **実行と統合検証はDockerを正本にする。** `uv`はlock更新・依存解決と補助checkに限定し、通常collector、
   test、静的previewをdigest固定imageへ段階移行する。untrusted PDF workerはroot imageへ統合しない。

プロダクトの一本の導線は **「探す → 内容をつかむ → つながりがあれば辿る」** とする。
系譜は全論文に存在する主導線ではなく、監査済みデータがある論文だけに付く高価値な追加ビューである。

---

## 2. 判断の根拠

2026-08-30 時点の実データは次の状態である。

| 項目 | 現況 | 設計への影響 |
|---|---:|---|
| 学会カタログ | 10 学会 / 28,300 catalog rows | 検索と一覧は主導線にできる |
| 学会系譜 | 非空 2 学会、空スタブ 8 学会。node は最大でも catalog rows の約 0.85% | 系譜を全体の入口にはできない |
| テーマ系譜 | 3 テーマ | 差別化機能だが、探索全体の背骨にはまだ薄い |
| Deep tree | 14 本 | 論文詳細から到達できるようにする価値がある |
| HTML | 17 ページ、共通ナビ導入済み | 新しい入口サイトは不要 |
| 横断検索 | 28,300 件、gzip 約 0.72 MB | 静的サイトのまま横断探索できる |
| カタログ生成日 | 全 10 学会が 2026-06-28 | 定期更新が復旧するまで「最新」「毎週更新」と称さない |

フェーズ 1 で横断検索、共通ナビ、アセット版数管理は出荷済みである。次の設計課題は、
検索結果・学会一覧・関係情報・系譜を同じ論文コンテキストで接続することにある。

更新 workflow が実際に監視付きで動くまでは、本サイトを **学会スナップショットと監査済み系譜の探索サイト**
として説明する。各 collection に snapshot date を表示し、鮮度の約束と実運用を一致させる。

---

## 3. 情報設計

### 3.1 ページ責務

| URL | 主目的 | 主操作 |
|---|---|---|
| `/` | 全体から探す | 横断検索、例示クエリ、学会・公開済み系譜への入口 |
| `/<conference>/` | 学会内で選ぶ | 検索、タグ・採択種別フィルタ、論文詳細の展開 |
| `/<conference>/?paper=<paper_id>` | 論文を共有する | 対象論文へフォーカスし、概要、系譜、スライド生成の状態と操作を表示 |
| `/<conference>/lineage.html?focus=<paper_id>` | 実データのある系譜を辿る | 祖先・後継・関係種別の探索 |
| `/themes/` | 監査済み系譜を探す・生成する | 品質監査を通過したテーマ・学会系譜のハブ、生成依頼、生成状態の確認 |
| `/themes/?theme=<slug>&node=<node_id>` | テーマ内の系譜を辿る | 現行 permalink を維持して対象テーマと node にフォーカス |
| `/how-it-works/` | 信頼性を理解する | データ源、関係分類、更新日、制約の確認 |

`?paper=<paper_id>` は単なる検索条件ではなく、対象カードを必ず描画して詳細を展開する選択状態とする。
初回ロードでは対象まで scroll するが focus を奪わず、画面内の選択操作では詳細見出しへ focus を移す。
閉じる操作は parameter を除去し、戻る操作で直前の一覧状態を復元する。ID が存在しない場合は
status message を表示して通常カタログを残し、別論文へ曖昧に fallback しない。

MVP では新しい論文詳細ページを量産しない。著者、概要、タグ、外部リンクをすでに持つ現行カードを
論文コンテキストとして改善し、選択・共有可能にする。独立詳細ページは SEO、引用共有、表示情報量の
いずれかで必要性が確認された後に検討する。
一覧状態では現行どおり title、authors、abstract snippet、tags を残して走査性を保ち、選択状態で全文要旨、
外部リンク、直接関係、利用可能な系譜 CTA とスライド生成 CTA を展開する。スライド CTA は
[`17-paper-slide-deck-contract.md`](17-paper-slide-deck-contract.md) の source / request / review gate を満たす場合だけ
有効化し、検索結果一覧から直接、有料生成を開始させない。

既存 URL は維持する。URL を変更する場合は、旧 URL から同じ対象へ移る互換処理を先に用意する。
テーマの `node`、deep view の `arxiv`、既存 lineage の graph-local `focus` は移行期間中も受け付け、
identity alias から新しい `paper_id` へ解決する。

### 3.2 「モード」と「ビュー」を分ける

サイト全体を「検索モード」「学会モード」「系譜モード」に分けない。これは同じ論文を探すための
**ビューの違い**であり、ユーザーに最初から選ばせる情報ではない。

- トップページは検索を主操作にする。
- 学会と「監査済み系譜」は検索の代替入口として検索欄の下に置く。
- MVP の横断検索は論文の `title + authors + tags` を対象とする。テーマと学会は検索結果へ混ぜず、
  別の棚として提示する。
- 順位は `完全タイトル一致 > タイトル一致 > 著者一致 > タグ一致` を基本にし、同順位だけを
  collection の新しさと既存順序で安定化する。先頭から見つかった 20 件を返す方式にはしない。
- 各結果に学会、年、採択種別、match reason を出し、ユーザーが開く前に適合理由を判断できるようにする。
- combobox は上位 20 件を候補として出し、総件数と「結果をさらに見る」を併記する。全結果は同じページ内の
  paging された一覧へ展開し、21 件目以降を見えないままにしない。
- 論文が選ばれた後だけ、「概要」「関係」「系譜」「スライド化」を提示する。
- 系譜データがない場合は空グラフを表示せず、「未生成」と更新日を表示する。
- ページを移る一覧・系譜切替はリンク、同一画面の表示設定は `aria-pressed` を持つ button とする。
- 状態の優先順位は `URL > 保存済み設定 > responsive default` とする。ページ・論文の選択には
  `pushState`、検索・フィルタ・表示方法には `replaceState` を使い、localStorage は既定値だけを補う。

したがって、必要なのはモード選択サイトではなく、**共通入口の中で現在の文脈に合う次の操作を示すこと**である。

### 3.3 画面遷移

```text
トップ（横断検索）
  ├─ 検索結果を選ぶ ──> 学会カタログ / 対象論文
  │                         ├─ 概要・外部リンク
  │                         ├─ 直接関係
  │                         ├─ 系譜あり ──> Focus View / フル系譜
  │                         └─ スライド化 ─> 生成状態 / 公開済み deck
  ├─ 学会を選ぶ ─────> 学会カタログ
  └─ テーマを選ぶ ───> テーマ系譜
                            └─ 未登録テーマ ──> 生成依頼と進行状況
```

グローバルナビは現行の「探す / 系譜 / 仕組み」を維持する。`/themes/` は URL を変えずに
品質監査を通過したテーマ系譜と学会系譜を分けて載せるハブへ拡張する。件数を設計に固定せず、
学会別や表示形式をグローバルナビに増やさず、
現在ページ内のローカル操作として扱う。

### 3.4 モバイルとアクセシビリティ

- 320〜720px では検索を最上段・全幅にし、主要操作の hit target を 44px 以上にする。
- モバイル検索結果は、combobox の DOM とキーボード契約を保ったまま overlay から通常フローへ切り替える。
- 系譜は `view=list|graph` を URL に持つ。明示指定がない 720px 以下では読み上げ可能な
  「関係リスト」を既定とし、グラフは任意表示にする。
- 関係リストは始点、終点、関係種別、confidence、rationale を持ち、グラフと同じ filter を使う。
- SVG だけを情報源にせず、edge の根拠へキーボードでも到達できるようにする。
- 現行の combobox、skip link、live region、focus restoration、reduced motion を維持する。
- search index v2 は最初の意味のある入力まで遅延取得し、取得中・失敗・retry を live region でも伝える。
  圧縮転送量は実データで **gzip 2.5 MB 以下**を gate とし、取得後の frozen query 応答を代表端末で 100 ms
  以内に保つ。上限を超えたら author/tag の辞書化または分割索引を行い、初期 HTML へ埋め込まない。
- 320 / 375 / 768 / 1024 / 1440px で body の意図しない横はみ出しゼロを確認する。
  系譜 canvas 内の明示的な横スクロールは許可する。

---

## 4. システム境界

```text
Conference collectors ──> normalized CSV / catalog snapshots ─┐
Discovery Stage 0–4 ─────> recommendation outputs              ├─> Identity Lite
Lineage generators ──────> relation / deep artifacts ──────────┘        │
                                                                         ▼
                                                          Static projectors
                                                                         │
                                                         検証・データ監査
                                                                         │
                                                                         ▼
                                                       GitHub Pages（read plane）
                                                                         ▲
Browser ── POST ──> Worker API ── dispatch ──> GitHub Actions ──────────┘
              入力検証・rate limit                   生成・検証・昇格
```

発見・ランキング、会議全件収集、系譜生成は目的の違う orchestration として残す。会議全件を
キーワード検索の Stage 0〜4 に無理に通さず、まず native source ID と静的 projection で接続する。
移行中も Stage 0 の外部契約 `list[Paper]` は compatibility projection として維持する。
複数 source の fact merge が必要になった場合にだけ、この境界の内側へ `SourceObservation → Normalizer →
Canonical PaperEntity` を段階導入する。

### 境界ルール

- ブラウザは外部論文 API や GitHub Actions を直接呼ばない。
- Worker は `/api/*` だけを所有し、公開サイト本体を第二のサイトとして配信しない。
- Worker の認証情報は Cloudflare Secret、生成側の認証情報は GitHub Secrets に置く。
- ユーザー入力はブラウザ、Worker、workflow、Python の各境界で再検証する。
- Worker API の CORS は公開サイトの正規 origin に限定する。ワイルドカードは移行中だけの互換策とする。
- status API にも rate limit と短時間 cache を設け、PAT 付き GitHub API 呼び出しを無制限にしない。
- `worker/README.md`、`wrangler.jsonc`、実装コメントは「API-only Worker / GitHub Pages UI」に統一する。

インフラ上は Pages と Worker の二つのデプロイ単位があるが、ユーザーに見せる製品は一つである。

---

## 5. データ契約

### 5.1 論文 ID — Identity Lite を先に出す

現行の横断検索はタイトルを使って対象論文へ移動するため、同名論文やタイトル変更に弱い。一方、現行データの
source URL からは 28,300 / 28,300 rows で OpenReview、arXiv、ACL Anthology、CVF の native ID を抽出できる。
MVP はこの事実を使い、完全な identity registry を前提にしない。

- collector から公開 projection まで `source` と `source_id` を欠落させずに運ぶ。
- `paper_id = sha256("paperpilot:v1:" + normalized_source + ":" + source_id)[:40]` とし、
  40 文字の lowercase hex を得る。同じ source record からは必ず同じ ID を生成する。
- DOI と arXiv ID などの強い alias は完全一致だけを記録し、既存 relation/deep data の join に使う。
  新しい alias が後から見つかっても、公開済みの source-derived ID を自動変更しない。
- 別 source の record を title 類似度だけで自動統合しない。title と year は衝突・重複候補の測定にだけ使う。
- 現行 `Paper.uid` と旧 URL parameter は互換 projection として残し、canonical identity とは区別する。

Identity Lite の shadow build で、source ID 欠損率、同一 strong alias の重複率、競合率、field loss をレポートする。
複数 source の同一論文統合が実際の機能を阻害すると確認された場合に限り、append-only registry、redirect、
merge / split decision record、single-writer allocation を導入する。それまでは registry の運用コストと
誤統合リスクを負わない。

Identity Lite v1 の `normalized_source` は `arxiv | openreview | acl_anthology | cvf` の列挙とする。
arXiv は version suffix を除いた canonical path、OpenReview は case-sensitive な `forum?id`、ACL は末尾 slash を
除いた anthology ID、CVF は canonical HTML filename stem を `source_id` にする。URL decode、host alias、slash、
arXiv version の golden vectors を source ごとに持ち、未知 host・欠損・曖昧 parse は title fallback せず失敗として
coverage report に出す。

strong alias の運搬先は `docs/identity-aliases-v1.json` とし、`[namespace, normalized_id, paper_id]` を
dual-publish する。重複 key が異なる `paper_id` を指したら build を fail する。旧 URL parameter の解決と
lineage/deep migration はこの sidecar を使う。

### 5.2 論理データモデル

以下は複数 source を本格統合するときの**長期論理モデル**であり、検索・カード共有 MVP の実装前提ではない。
MVP は `source`、`source_id`、`paper_id`、既存 paper fields、collection membership を保持すればよい。

| オブジェクト | 責務 |
|---|---|
| `SourceObservation` | source record ID、取得時刻、request fingerprint、raw/normalized snapshot URI と hash |
| `PaperEntity` | immutable `paper_id`、aliases、現在採用する論文 facts |
| `FieldProvenance` | title、authors、date 等の各値がどの observation 由来かを示す |
| `CollectionMembership` | conference、Oral/Poster、topic/tag、順序とその provenance |
| `SignalObservation` | raw value、normalized score、status、observed_at、producer version |
| `DerivedAnnotation` | LLM relevance/summary/reason/tags、input hash、provider/model/prompt/schema/status |
| `RankingRun` | candidate-set hash、weights、config、as-of、ordered paper IDs |
| `RelationAssertion` | source/destination ID、evidence、relation、confidence、LLM/heuristic/OpenAlex/unarXive の版 |

entity facts、source observation、派生評価、画面上の collection membership を混ぜない。
特に signal の `0` は「観測したゼロ」と「未取得」「API失敗」を兼用せず、`status` で区別する。
Stage 2 の top-N 前に候補集合を保存し、ranking は再生成可能な materialized view として扱う。

### 5.3 公開成果物

| 成果物 | 生成元 | 主な利用者 | 契約 |
|---|---|---|---|
| `docs/<conf>/papers.json` | `build_pages.py` | 学会カタログ | top-level array と既存 key/value を維持し、`paper_id` / `source` / `source_id` を additive に追加 |
| `docs/search-index.json` | `build_search_index.py` | 旧トップ検索 | `[title, conference]` の互換索引 |
| `docs/search-index-v2.json`（新設） | `build_search_index.py` | 新トップ検索 | `[title, conference, paper_ref, authors, tags, year, paper_type]`。`paper_ref` は同時生成する ID block の連番参照 |
| `docs/search-paper-ids-v1/<block>.json`（新設） | `build_search_index.py` | 新トップ検索 | 256 row 単位で `paper_ref` を canonical `paper_id` へ解決。結果 page に必要な block だけ遅延取得 |
| `docs/identity-aliases-v1.json`（新設） | Identity Lite projector | 旧 URL / relation join | `[namespace, normalized_id, paper_id]`。alias key は一意 |
| `docs/paper-details-v1/<prefix>.json`（新設） | `build_pages.py` | 選択済み論文カード | `paper_id` 先頭 2 hex の 256 shard。全文要旨を選択時だけ遅延取得 |
| `docs/conferences.json` | `build_pages.py` | トップ / 系譜ハブ | 学会 membership、件数、更新日 |
| `docs/<conf>/lineage.json` | lineage build scripts | 学会系譜 | node ID を `paper_id` へ解決可能 |
| `docs/<conf>/deep-manifest.json` / `deep-*.json` | deep lineage generators | 論文 deep view | 旧 arXiv/node ID と `paper_id` alias |
| `docs/themes/<slug>/lineage.json` | `build_theme_lineage.py` | テーマ系譜 | edge の根拠・生成方法を保持 |
| `docs/themes/themes-manifest.json` | manifest generator | テーマ一覧 | slug、表示名、更新日、品質状態 |
| `docs/themes/_quality.json` | quality generator | テーマ一覧 | collection 単位の品質状態 |
| `docs/lineage-quality-v1.json`（新設） | lineage audit | トップ / 系譜ハブ | conference/theme 共通の availability、audit、freshness、audit record |
| run manifest（新設） | generation validation | CI / 運用 | run ID、as-of、code/config/input/output/dependency hash、artifact locator/expiry、件数、失敗、provider/model/prompt/schema |
| release manifest（将来） | publish validation | UI / CI | release ID、schema、件数、生成日時、per-file hash、系譜可否 |

既存 JSON を一度に wrapper object へ変更しない。MVP は既存 URL、top-level array、既存 key/value を維持し、
`papers.json` の identity key を additive に追加して v2 search index を dual-publish する。選択時の全文要旨は
catalog payload を膨らませず、`paper_id` の先頭 2 hex で shard した sidecar から遅延取得する。
Git SHA と run manifest で生成単位を追跡する。Merkle root、versioned release bundle、
`data/releases/<release_id>/...` は、Git 外に複数 snapshot を配信する必要が生じた時点の拡張とする。

collection ごとの lineage 状態は互いに独立した
`availability = unavailable | sparse | ready | failed`、`audit_status = unknown | passed | failed`、
`freshness = fresh | stale` と、`path`、`generated_at`、`node_count`、`edge_count`、`schema_version` を持つ。
`0 node` は `unavailable`、node はあるが `0 edge` は `sparse` とする。HTTP 200、ファイルの存在、
node/edge 数だけで可否を判定しない。`stale` は品質不合格を意味せず、監査合格済みなら日付と警告付きで表示できる。

`audit-v1` は入力 hash、audit version、実行日時、判定主体、各 check と evidence を JSON に残し、次を合格条件とする。

- 宣言された root/focus がすべて一意に node へ解決し、catalog 起点なら `seed_paper_id` を持つ
- node ID は一意、dangling edge は 0、root/focus でない孤立 node は 0
- 全 edge が relation、0〜1 の confidence、非空 rationale、producer/evidence provenance を持つ
- 全 focus seed と、固定 seed で抽出した最大 20 node の topic relevance golden labels に対し、
  focus mismatch 0、sample off-topic 率 10% 以下である
- 既知の重大な root/topic 誤りを allowlist で隠さず、修正または `failed` として記録する

自動構造監査と frozen golden fixture を CI で再実行し、手動判定を使う場合も対象 ID、判定、理由、reviewer、
input hash を fixture に commit する。`audit_status=unknown` は通常の「系譜あり」棚に出さない。

`search-index.json` の現行 `[title, conference]` を in-place で並べ替えない。最初に
`search-index-v2.json` を `[title, conference, paper_ref, authors, tags, year, paper_type]` として
dual-publish する。40 hex の canonical ID を各 row に入れた初回案は実データで gzip 3.02 MB となり
2.5 MB gate を超えたため、`paper_ref` は同時生成する `search-paper-ids-v1` の 256 row block から解決する。
consumer は現在の結果 page に必要な block だけを取得し、canonical ID 解決後に `?paper=` link を描画する。
新 consumer を出荷してから
旧索引を廃止する。廃止条件は全 HTML/JS が v2 を参照し、CI の legacy-reference 検索が 0 件となり、
一つ前の rollback artifact の retention が終了したこととする。lineage も移行中は graph-local `id` と
`paper_id` を併記する。
`year` は source record を優先し、欠損時だけ conference slug の年を使う。どちらにも無い場合は `null` とし、
推測値を現在年で埋めない。

### 5.4 Replay Lite

最初に必要なのは完全な raw event store ではなく、失敗した生成を説明し、限定された入力から再試行できる
最小記録である。

- run manifest に `run_id`、`as_of`、code/config/input/output hash、dependency lock digest、
  provider/model/prompt/schema、件数、失敗を記録する。
- commit 済み conference CSV を normalized snapshot として扱い、同じ入力から公開 JSON を再生成できるようにする。
- Stage 0 candidates、top-N 直前の候補集合、lineage evidence、LLM response だけを短期の非公開 artifact に残し、
  manifest に artifact ID/path、content hash、`expires_at` を記録する。
- signal の観測ゼロ、未取得、外部 API 失敗を別 status にする。
- cache を変更する際は input/evidence hash と producer/model/prompt/schema version を key に含め、
  成功、失敗、期限切れを別状態にする。

artifact retention 外の network-free replay は保証しない。全 raw response の長期 CAS/R2 保存、
`SourceObservation` / `FieldProvenance` の全面導入は、複数 source の fact merge、監査要件、または長期 replay の
実需要が確認されてから ADR を作る。
依存解決を再現可能にするため `uv.lock` を commit 対象へ変更し、CI は lockfile と実環境の digest を
run manifest に残す。lock を持たない過去 run は byte-identical replay 可能とは称さない。

### 5.5 系譜の信頼性

- edge は `relation`、`confidence`、`rationale`、`provenance` を持つ。
- catalog paper を seed にする generator は入力時の `paper_id` を focus/root node の `seed_paper_id` として保持し、
  OpenAlex 等へのタイトル検索結果で上書き・欠落させない。タイトル検索は candidate discovery にだけ使う。
- deep manifest は起点 catalog の `paper_id` と、graph-local / arXiv alias を併記する。
- 既存 artifact は exact alias で一意に結べるものだけ migration mapping を監査・保存する。一意に結べない
  conference lineage は `audit_status=failed` として棚から外し、seed ID を保持する generator で再生成する。
- LLM 由来の場合は provider、model、prompt/schema version をキャッシュと成果物で追跡できるようにする。
- `unknown`、分類失敗、外部 API 部分障害を欠損と区別する。
- 0 node / 0 edge の空スタブは「系譜あり」と判定しない。
- トップの「系譜あり」棚には `availability=ready` かつ `audit_status=passed` の collection だけを載せる。
- `sparse`、`failed`、監査不合格・未監査は通常棚から外す。`freshness=stale` は隠さず、snapshot date と
  警告を付けて表示する。
- 生成日時とデータ品質状態を UI に表示し、古いデータを最新と称さない。
- 生成 JSON は専用スクリプトだけが書き、手編集しない。

---

## 6. リポジトリ構成

現行 monorepo を維持し、責務を次のように固定する。

| 領域 | 責務 | 依存方向 |
|---|---|---|
| `paperpilot/models/` | 正規化ドメインモデル | 他層に依存しない |
| `paperpilot/identity/`（段階導入） | Identity Lite の source ID 正規化。必要時だけ merge history | models。registry は測定後に追加 |
| `paperpilot/sources/` | 外部データ取得 | models と共通 HTTP のみ |
| `paperpilot/signals/` | 品質情報の付与 | models と共通 HTTP のみ |
| `paperpilot/exporters/` | CSV / JSON / Slack / Email projection | models と出力 adapter |
| `paperpilot/pipeline/` | Stage 0〜4 のオーケストレーション | source / signal / encoder / llm / exporter |
| `paperpilot/scripts/` | 学会収集、公開成果物生成、監査 | domain 層を利用する adapter |
| `paperpilot/data/` | run manifest、版付き cache。registry / release ledger は必要時だけ追加 | generator / promotion だけが更新 |
| `schemas/`（新設） | 公開 JSON、run manifest、Worker API の版付き契約 | 実装から独立 |
| `docs/assets/` | 静的 UI の共有実装 | 公開 JSON 契約だけを読む |
| `docs/**.json` | 公開生成物 | 生成スクリプトのみが書く |
| `worker/` | 変更要求 API | UI 契約と workflow 入力契約 |
| `.github/workflows/` | 生成・検証・公開の実行制御 | スクリプトを呼ぶだけに保つ |

次の条件が揃うまでは別リポジトリへ分割しない。

- 独立した所有者とリリース周期がある
- 共通 JSON 契約を versioned package として切り出せる
- Worker と UI を別変更にしても end-to-end 検証を失わない
- 権限分離が monorepo の environment / secret policy では実現できない

生成データを Git から R2 などへ移す案は、Git の容量・保持期間・配信要件が実際の制約になるまで採用しない。

新しい Source / Signal / Exporter / LLMProvider / Encoder は明示 registry の `type -> factory` と
capability metadata で登録する。任意コードの dynamic import や自動 discovery は行わない。

---

## 7. 生成・公開フロー

収集 workflow を再有効化する前に、`collect-weekly.yml` が会議ごとに
`build_pages.py --conference` を呼び、そのたび `conferences.json` を単一会議で上書きする経路を
修正する。発見 Stage 0〜4 の出力と会議カタログ更新も別系統であるため、同じ更新と称して連結しない。

ここからの設計は価値提供を止めない最小安全策と、観測後に導入する拡張を分ける。長期の完全基盤を
read-only UX MVP の前提にしない。

### 7.1 Minimum Safety Gate

`develop` を production source として当面維持し、次の小さい公開 DAG を最初の運用 PR で作る。

1. 一つの Pages workflow が protected `develop` の exact SHA を checkout する。
2. `validate` と `build` が同じ SHA を検証し、Pages artifact を一度だけ作る。
3. `deploy` は `needs: [validate, build]` で成功時だけ同じ artifact を公開する。
4. 独立した push/manual deploy と生成 workflow 内の二重 deploy を廃止する。
5. post-deploy smoke がトップ、代表 catalog、search index、監査済み lineage を確認する。
6. rollback は deployment record 上の known-good `develop` ancestor を入力にし、現在の protected workflow code が
   その SHA の `docs/` を package・検証・公開して smoke まで確認する。古い SHA 内の workflow code は実行しない。

bot の役割は候補生成と最小 commit までで、Pages deploy は release workflow だけが行う。権限は
`generate = contents:read + 必要な source/LLM secrets`、`validate/build = contents:read、secrets なし`、
`promote = contents:write`、`deploy = contents:read + pages:write + id-token:write` に job 単位で分ける。
Actions は commit SHA に pin する。branch 分割、Merkle bundle、独自 release ledger はこの安全策には含めない。

bot promotion は `GITHUB_TOKEN` で commit し、`promote.outputs.sha` を同じ run の `needs: promote` から
protected reusable release workflow へ明示的に渡す。bot push が別 workflow を自動発火することに依存せず、
PAT や `actions:write` で Pages を再 dispatch しない。human merge/push も同じ release workflow を使い、
公開の handoff をこの一経路に限定する。任意 ref の manual deploy は廃止するが、検証付き rollback 入力は残す。

### 7.2 オンデマンド生成の最小契約

read-only UX の PR では Worker API と write path を変更しない。生成経路を直す PR では次だけを保証する。

1. Worker が入力、rate limit、budget を検証し、unique な `request_id` を workflow input / run name に渡す。
2. `generate` は候補 artifact を作り、`validate` は schema、lineage、evidence を secrets なしで検証する。
3. `promote` は最新 `develop` へ候補を適用し、共有 manifest を再生成して exact tree を検証する。
   tip を比較して non-fast-forward なら作業 tree を捨て、新しい tip から候補適用・再生成・再検証を有限回やり直す。
4. promotion 後の exact SHA を release workflow が一度だけ公開する。生成 job は deploy しない。
5. `published` は production 上の対象データを smoke で確認した後だけ返す。dispatch の受付を公開完了としない。

Git ref update を compare-and-swap 境界として使い、失敗した試行の部分データを公開しない。初期の要求量では
強い FIFO / exactly-once や受付時点の single-writer を約束せず、競合 retry の上限を超えた要求は
`failed/retry-later` にする。重複 promotion、lost update、同時要求が実測された場合に Durable Object 相当の
原子的 queue と lease を導入する。

### 7.3 Worker と PyPI

- Cloudflare の全 `develop` push auto-deploy は停止するか Worker path 限定にする。外部設定変更なので実施時に
  ユーザー承認を得て、停止または path 限定を確認するまで read-only UX を production merge しない。
- `worker/**`、Worker dependency、`wrangler.jsonc` が変わる PR だけ Node test、typecheck、API mock、dry-run を要求する。
- 現在 PyPI 配布を運用していない間は publish job を削除または恒偽化し、`id-token:write` と production
  environment を外した build-only workflow にする。
- 初回の実 PyPI release 前に protected tag、version 一致、build/check、clean install、OIDC approval を導入する。

### 7.4 拡張を開始するトリガー

| 拡張 | 導入トリガー |
|---|---|
| append-only identity registry / merge・split | exact alias の重複・競合が join や共有 URL を実際に壊す |
| Durable request / FIFO promotion coordinator | 同時要求、lost update、stuck job が観測される |
| versioned release bundle / Merkle / release ledger | Git 外で複数 snapshot を配信、または UI と data の独立 rollback が必要になる |
| R2/CAS と full raw replay | Actions retention を越える監査・再現要件、または Git 容量制約が生じる |
| GitHub App 等の短寿命 credential | 自動生成頻度・権限範囲が拡大し、現 credential の rotation では不十分になる |
| `develop` / `main` 分離 | 統合 cadence と production promotion cadence が実際に分かれる |

---

## 8. 品質ゲート

### MVP の変更面別 required status

| Status | 対象 | 必須検証 |
|---|---|---|
| `python-quality` | exact-SHA Pages release で常時 | ruff、Python 3.12 の full pytest。Node/asset contract の skip は fail |
| `contract-quality` | exact-SHA Pages release で常時 | 全公開 JSON/XML/HTML parse、workflow YAML、legacy/v2 dual-publish、ID coverage、secret scan |
| `site-quality` | UI / asset 変更 | Node suite、frozen search queries、主要 browser/a11y、320/375px smoke |
| `data-quality` | lineage / catalog 変更 | 件数整合、snapshot date、root/topic/orphan/evidence を含む lineage audit |
| `worker-quality` | Worker / config 変更時だけ | Node suite、typecheck、routing/KV/GitHub mock、dry-run |
| `package-quality` | package / release 変更時だけ | build、metadata、clean install、CLI smoke。publish は別承認 |

`site-quality` は少なくとも 320 / 375 / 768 / 1024 / 1440px の代表 viewport で body の意図しない
overflow を確認する。全 viewport の重い browser test は UI 変更時に行い、データだけの生成 run には課さない。
キーボード、focus、loading / empty / error、reduced motion、edge 根拠の読み上げ、untrusted text の DOM 安全性は
触れた変更面に応じて必須にする。

### 公開条件

- テストとデプロイを同時に開始しない。単一 coordinator が required status 成功後に開始する。
- bot の自動 commit も人の PR と同じデータ契約・監査を通す。
- Lighthouse は観測を続け、安定した基準値を得てから blocking threshold を決める。
- source SHA と Pages deployment を対応付け、exact SHA rollback を smoke まで自動化する。
- Pages / Worker の post-deploy smoke と失敗通知を rollback の前提とする。

---

## 9. 実装ロードマップ（価値順）

安全、data contract、product は別 Agent / worktree で並行開発してよい。production merge を止める必須条件は
S1 だけとし、停止中 collector、未使用 PyPI、Replay Lite は並行して直す。producer を consumer より先に merge し、
データ契約変更と write path 変更を同じ PR に混ぜない。

### S1 — Production merge blocker

- Pages を exact-SHA の `validate/build → deploy(needs)` という一つの workflow にする
- bot の二重 deploy をなくし、job 権限を分け、`promote.outputs.sha` から reusable release へ一度だけ handoff する
- Cloudflare auto-deploy を停止または Worker path 限定にする。外部変更は明示承認を得る
- post-deploy smoke と、known-good SHA を使う検証付き manual rollback を用意する

### S2 — Safety / Replay hygiene（S1・D1 と並行可）

- `collect-weekly.yml` の `conferences.json` 上書きバグを直し、空 lineage を成功扱いしない
- rollback を自動化し、未使用 PyPI publish から OIDC 権限と production environment を外す
- `uv.lock` を commit し、run manifest schema と artifact locator / hash / expiry を導入する
- Stage 0 candidates、top-N 前集合、lineage evidence、LLM response を短期 artifact として manifest から辿れるようにする
- signal の observed zero / missing / failed と、変更対象 cache の producer version を分離する

### D1 — Identity / Search / Quality producer

- 既存 rows は source URL から v1 規則で ID を導出し、新規 collector は native `source` / `source_id` を
  CSV まで明示的に保持して deterministic `paper_id` を shadow 生成する
- 28,300 rows の欠損・衝突・重複・field loss を report し、source normalization の golden vectors を固定する
- `search-index-v2.json` と `identity-aliases-v1.json` を先に dual-publish する。既存 consumer は
  additive key を無視できる状態を維持する
- conference/theme 共通の `lineage-quality-v1.json` を生成し、既存 artifact を audit-v1 で判定する
- search v2 の raw/gzip/heap/query budget と、legacy/v2 compatibility を CI で測る

### P1 — Unified Top / Paper Context（read-only、D1 の後）

- トップで title / author / tag を検索し、完全タイトル > タイトル > 著者 > タグで順位付けする
- 結果に学会、年、採択種別、match reason、総件数を出し、上位 20 件の先も一覧で辿れるようにする
- `?paper=<paper_id>` で既存カードを選択・展開・共有し、旧 `?q=` / `?focus=` を互換入口として残す
- 「学会から探す」と、`ready + passed` の「系譜あり」を検索下の棚にする。stale は日付と警告を出す
- 既存 Worker API と write path は変えず、paper JSON は wrapper / 既存 key を変えない additive evolution に限定する

### P2 — Honest Connections / Mobile

- lineage generator が catalog seed の `paper_id` を node/deep manifest へ保持する
- 既存 artifact は exact alias の一回限り migration を監査し、一意に結べないものは再生成する
- 特に既存 ECCV lineage の root とテーマ適合性を確認し、不合格なら通常棚から外す
- 論文カードから実データのある直接関係と deep tree へ到達可能にする
- 狭い画面は読み上げ可能な関係リストを既定とし、graph を任意表示にする
- rationale / provenance / generated date を同じ規則で表示する

### 観測後にだけ実装するもの

- full identity registry、merge / split、redirect ledger
- full `SourceObservation` / `FieldProvenance` と raw event store
- Durable FIFO queue、完全な request state machine、GitHub App
- R2/CAS、Merkle release、複数世代の独立 data rollback
- 実 PyPI 配布用の完全 CD、全 matrix / SBOM / Lighthouse blocking

---

## 10. エージェント開発方針

- 調査・設計・評価・セキュリティ Agent が、契約と受入条件を先に固定する。
- Backend / Frontend 実装 Agent は repository profile に従い、担当ごとの独立 worktree で行う。
- 同じ生成物や共有 CSS を複数実装 Agent が同時編集しない。
- 統合担当は差分、テスト、生成元、公開影響を確認してから取り込む。
- 外部 API を使う評価は frozen fixture と別にし、費用・失敗率・再現性を記録する。
- Codex / 開発 Agent が workflow dispatch、merge、公開を行う場合はユーザー承認を要する。
- 公開フォームから受理した production request は、rate limit、policy、検証、promotion gate の成功後に
  自動公開してよく、個別の手動承認を要求しない。

---

## 11. 不採用とする案

- 探索サイトと系譜サイトを別々に公開する
- 最初に用途を選ばせるモード選択専用サイト
- 系譜データが薄い段階でグラフを唯一のトップ画面にする
- GitHub Pages を捨てて全面 SPA / 常時稼働 backend へ移す
- タイトルだけを論文 ID として使う
- 空 lineage を実データのように表示する
- 現段階で frontend、pipeline、Worker を別リポジトリへ分割する
- Git の制約や長期 replay 要件を測る前に生成データを R2/CAS へ移す

---

## 12. 完了条件

### Product MVP

- トップから検索を始めるのにモード選択を要求しない
- frozen query set に完全タイトル、部分タイトル、著者、タグを含め、期待論文が top 5、完全タイトルが top 1 になる
- 検索結果に match reason、学会、年、採択種別を表示し、選択した既存カードを必ず開く
- search v2 は初回入力まで遅延取得し、raw 8.5 MB / gzip 2.5 MB / parse・index peak heap 64 MB 以下、
  取得後の frozen query 100 ms 以下を代表モバイル条件で満たす
- 上位 20 件を越える結果に総件数と到達可能な paging 一覧があり、loading / error / retry を読み上げられる
- 既存 URL を維持し、Identity Lite 後は共有 URL で同じカード状態を復元できる
- 一覧カードの abstract snippet を維持し、選択カードだけが全文・外部リンク・関係・スライド CTA を展開する
- 28,300 catalog rows の `paper_id` coverage が 100% になり、衝突・重複・field loss を report する
- 「系譜あり」棚には `availability=ready` / `audit_status=passed` の collection だけを表示し、stale は日付で示す
- 関係データがない論文では空グラフや無効 CTA を出さず、ある場合だけ直接関係・deep view へ進める
- カードから辿れる lineage/deep の root は同じ `paper_id` または一意な exact alias を持ち、title join に依存しない
- 全 collection に snapshot date を表示し、実際に更新されていないデータを「最新」「毎週更新」と称さない
- 主要操作がキーボードと 320px 幅で完結し、edge 根拠を graph なしの関係リストでも読める

利用分析を導入するまでは上記を offline fixture と usability check で評価する。将来 analytics を導入する場合は、
privacy 方針と収集項目を別判断にし、検索成功率、zero-result 率、論文カード到達率、系譜遷移率を観測する。

### Safety MVP

- `collect-weekly.yml` が全 conference を一度に集約し、`conferences.json` を部分データで上書きしない
- Pages が protected `develop` の exact SHA で validation に成功した一つの artifact だけを公開する
- generate / validate / promote / deploy が最小権限で分かれ、一要求から deploy は一度だけ起きる
- post-deploy smoke の失敗を検知し、直前の known-good Git SHA へ rollback できる
- Worker / PyPI を変更しない PR に不要な大規模基盤や release gate を課さない
- UI、Worker、workflow、設計書が「GitHub Pages UI + API-only Worker」という同じ境界を説明する

### Replay Lite

- `uv.lock` が commit され、対象 run の dependency digest と一致する
- run manifest から input/output hash と短期 artifact の ID/path/hash/expiry を一意に辿れる
- retention 内の frozen run 一件を network-free で再投影し、時刻依存 field を除いて同一 output hash を得る
- observed zero / missing / failed が signal status で区別され、hash だけ残った期限切れ run を replay 可能と称さない
