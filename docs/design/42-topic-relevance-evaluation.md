# 42. テーマ内判定（topic relevance）の比較評価（R2-4 / 41 D4）

状態: 調査完了。推奨（段階 1＋段階 2）を R2-11 で生成器に組み込んだ（[41](41-lineage-publication-and-reliability.md) D7。下の「組み込み（R2-11）」）
関連: [41](41-lineage-publication-and-reliability.md) D4、`apps/pipeline/src/lineage/theme/topicScope.ts`、`bfs.ts`

## 結論

- 今の規則で一番効いていない部分は**基礎論文の許可リスト（foundational allowlist）による無条件の採用**と**共引用の支持（support）による採用**。どちらもテーマに関係なく ResNet・Inception・BERT・Adam などを入れてしまう。この 2 つを外して語の一致だけにすると、精度が 0.73 から 0.85 に上がる（再現率は 0.71 → 0.68）。費用はかからない。
- 一番良かったのは**語の一致と、小さなローカル埋め込みモデルとの類似度の組み合わせ**。`(語一致 AND z≥0) OR z≥1.0`（bge-small-en-v1.5、テーマ内で標準化した類似度 z）は P 0.87 / R 0.77 / F1 0.82。過去に公開されたテーマ外ノード 109 件のうち残るのは 3 件（今の規則では 11 件）。
- OpenAlex の topics / concepts / keywords は使えない。粒度が粗すぎる（ViT の候補なら ResNet も同じ topic になる）うえ、Flash Attention・MoE・ViT にはそもそも対応する topic がない。
- LLM による判定は、全候補を聞くと 1 テーマで 15k〜110k トークンかかり、Groq 無料枠（200k TPD）と関係分類の予算を食い合う。使うとしても、埋め込みで判断がつかない帯（候補の約 25〜30%）だけにする。
- **推奨**: 段階 1 で許可リストと支持による採用をやめて語の一致だけにする（コード変更は小さく、CI の重さも変わらない）。段階 2 で bge-small（q8, 34 MB）による z 判定を足す。LLM は使わない（必要になったら境界の帯だけに使う）。

## 評価セット

`apps/pipeline/test/lineage/theme/fixtures/relevance-eval-v1.json`（380 件、手で付けた正解）

- 候補の集め方は `eval/collectRelevanceCandidates.ts`（OpenAlex、2026-10-10 時点）。
  - git 履歴にある公開版 `data/published/themes/<slug>/lineage.json` のすべてのノード（171 件。drift した旧版はテーマ外の良い例になる）
  - 過去の全 seed
  - 各 seed の depth 1 候補から、sha1 で決めた標本。参照は `referenced_works` 全件、被引用は被引用数上位 16 件（CI の width 8 で descendants パスが読む数）。標本は abstract があるものに限る（生成器も abstract のない候補は捨てる）。
- OpenAlex で削除・統合済みの ID は除いた。生成器も取得できないので同じ扱いになる。
- 正解の付け方
  - テーマ内: 主題がテーマそのもの、テーマの直接の前身・基礎、テーマの手法の変種
  - テーマ外: テーマを他分野の道具として使うだけ、データセット、汎用の学習技法、無関係な分野
  - 理由を 1 行ずつ付けた。
- 評価は seed を除いた候補で行う（seed は gate の対象外）。

| テーマ | 候補（seed 除く） | うちテーマ内 | 過去に公開されたもの |
|---|---|---|---|
| Graph Neural Network | 86 | 26 | 31 |
| Flash Attention | 53 | 4 | 14 |
| Mixture of Experts | 100 | 24 | 45 |
| Vision Transformer | 120 | 24 | 60 |

限界:

- 正解付けは 1 人（agent）。境界例には「borderline」と書いた（PagedAttention、DGCNN など）。
- FA には参照の候補がない（FlashAttention-1 の OpenAlex レコードに `referenced_works` がない）。
- 標本は参照の候補が多めで、生成器が width で絞った後のグラフとは分布が違う。

## 比較した方法

| 系 | 方法 | 内容 |
|---|---|---|
| a 規則 | 規則（今） | `TopicScope.admits(p,0)`（語一致・許可リスト）、descendant は題名が主題のとき |
| | 規則 + 支持 | 上に加え、候補プール全体で語一致する非 seed の隣接が 2 件以上あれば採用（本番の上限見積もり） |
| | 語一致のみ | 許可リストも支持も使わない |
| | 題名のみ | `role === "subject"` |
| b OpenAlex | 検索 topic | `/topics?search=<テーマ>` の 1 位と topic を共有するか（GNN 以外は該当なし） |
| | seed topic | 主題 seed の primary topic / 全 topic と一致するか |
| | keyword / concept / subfield | テーマの keyword 一致、主題 seed が共通に持つ level≥2 concept、primary subfield |
| c 埋め込み | MiniLM-L6-v2 / bge-small-en-v1.5（q8, transformers.js） | 候補の題名+要旨と、次の各ベクトルとの cos 類似度: テーマ名、テーマ名+別名・topic 語（terms）、seed 重心、主題 seed 重心（subject）、subject+terms。閾値は 2 通り: 生の cos、テーマ内の z 値（プール内で平均を引き標準偏差で割る）。閾値は leave-one-theme-out で決めた（他の 3 テーマで最適な値を残り 1 テーマに当てる） |
| e 組み合わせ | 規則と埋め込みの OR / AND、OpenAlex との AND など | 下の表のとおり |

## 結果（主要な行。全行は `evalRelevanceCli.ts` の出力）

P/R/F1 は 4 テーマ合算（micro）の「テーマ内」に対する値。「公開済み 残る on/off」は、過去に公開されたノードのうち採用されるテーマ内の数とテーマ外の数。

| 方法 | P | R | F1 | 公開済み 残る on/off | GNN F1 | FA F1 | MoE F1 | ViT F1 |
|---|---|---|---|---|---|---|---|---|
| a 規則（今: 語/許可リスト/descendant 題名） | 0.73 | 0.71 | 0.72 | 33/41 · 11/109 | 0.78 | 0.00 | 0.83 | 0.63 |
| a 規則 + プール支持≥2（本番の上限） | 0.50 | 0.87 | 0.64 | 39/41 · 35/109 | 0.77 | 0.00 | 0.78 | 0.49 |
| a 語一致のみ（許可リストなし） | 0.85 | 0.68 | 0.76 | 31/41 · 2/109 | 0.78 | 0.00 | 0.83 | 0.73 |
| a 題名のみ | 0.87 | 0.53 | 0.66 | 25/41 · 2/109 | 0.68 | 0.00 | 0.65 | 0.70 |
| b OA 検索 topic（GNN のみ該当） | 0.95 | 0.27 | 0.42 | 11/41 · 0/109 | 0.88 | 0.00 | 0.00 | 0.00 |
| b OA 主題 seed の topic のどれか | 0.28 | 0.91 | 0.43 | 39/41 · 77/109 | 0.86 | 0.20 | 0.41 | 0.35 |
| b OA primary topic = seed | 0.38 | 0.60 | 0.47 | 30/41 · 35/109 | 0.77 | 0.21 | 0.26 | 0.46 |
| b OA keyword 一致 | 0.70 | 0.38 | 0.50 | 20/41 · 5/109 | 0.54 | 0.00 | 0.55 | 0.46 |
| c MiniLM terms 生 cos（loto） | 0.72 | 0.73 | 0.73 | 30/41 · 9/109 | 0.83 | 0.36 | 0.79 | 0.62 |
| c bge subject_terms 生 cos（loto） | 0.62 | 0.64 | 0.63 | 27/41 · 18/109 | 0.71 | 0.00 | 0.75 | 0.54 |
| c bge z(terms)（loto, z=0.6） | 0.78 | 0.82 | 0.80 | 32/41 · 8/109 | 0.82 | 0.67 | 0.88 | 0.72 |
| e 規則（今） AND z(MiniLM subject_terms)（loto） | 0.89 | 0.64 | 0.75 | 29/41 · 1/109 | 0.79 | 0.00 | 0.81 | 0.70 |
| e 語一致 OR z(MiniLM subject_terms)≥t（loto, t=1.0） | 0.81 | 0.81 | 0.81 | 33/41 · 6/109 | 0.85 | 0.57 | 0.82 | 0.78 |
| **e (語一致 AND z≥0) OR z≥1.0 [bge subject_terms]** | **0.87** | **0.77** | **0.82** | **33/41 · 3/109** | 0.85 | 0.57 | 0.86 | 0.77 |
| e (語一致 AND z≥0.3) OR z≥1.0 [MiniLM subject_terms] | 0.84 | 0.79 | 0.82 | 32/41 · 4/109 | 0.85 | 0.57 | 0.85 | 0.77 |
| e (語一致 AND z≥0.5) OR z≥1.5 [MiniLM subject_terms] | 0.91 | 0.64 | 0.75 | 29/41 · 0/109 | 0.79 | 0.00 | 0.81 | 0.72 |

読み取り:

- **生の cos 閾値はテーマ間で移らない**。最適値は bge で 0.75〜0.79、MiniLM で 0.53〜0.67 とテーマごとにずれる。プール内の z 値に直すと、4 テーマとも同じ値（z≈0.6〜1.0）で働く。
- seed の重心だけをクエリにすると弱い（MiniLM seeds: P 0.34）。テーマ外の seed（SuperGlue、MoE adapter による継続学習、ConvNeXt）に引っ張られるため。主題 seed とテーマ語を混ぜた `subject_terms` が安定した。
- 組み合わせの閾値（0/1.0 など）は固定の 4 通りから選んだので、多少この評価セットに合わせ込んでいる。loto で決めた単独の z 閾値（0.5〜0.6）とは矛盾しない。

## 失敗例

| 方法 | テーマ外を採用した例（FP） | テーマ内を落とした例（FN） |
|---|---|---|
| 規則（今） | ViT: Inception, MobileNets, SENet, ResNet, AlexNet, VGG, BERT, Reformer, Distilling（全部許可リスト経由）／ GNN: "Encoding Sentences with GCNs for SRL", "Image Generation from Scene Graphs" ／ MoE: "Region-Aware MoE Network for HSI fusion" | GNN: DeepWalk, cascade correlation 系の前身, DGCNN ／ ViT: Non-local, Stand-alone self-attention 等の前身 ／ FA: UltraAttn, PagedAttention（題名に語がない descendant） |
| 規則 + 支持 | GNN: Adam, ArnetMiner, MUTAG の元論文 ／ MoE: ZeRO, AdamW ／ ViT: ほぼすべての CNN 古典（49 件） | — |
| OA topic | ViT: Glorot, Cats and dogs, Inception（同じ "CV/深層学習" topic）／ MoE: マルチタスク学習・継続学習の大半 | FA: topic がなく判定できない |
| 推奨 (bge) | GNN: SRL/NMT への GCN 応用、scene graph からの画像生成、RGBD 分割 ／ MoE: 無線ネットワークへの MoE 応用 ／ ViT: SwinIR, 霞除去 ViT, SwinNet（ViT を道具に使う応用） ／ FA: EfficientViT | GNN: cascade correlation の前身 2 件, SyncSpecCNN, DTNN ／ MoE: Expert Gate, PLE, DEMix, Adaptive Mixtures of Local Experts ／ ViT: "Attention Is All You Need" と自己注意の前身、MetaFormer（許可リストを外したため） ／ FA: 効率的注意の総説, PagedAttention |

推奨の方法で残る FP は「テーマを道具として使う応用」が中心。これは LLM 分類（関係 `baseline_only` / `contrasts`）や人手監査で見える種類で、データセットや汎用技法の混入はほぼなくなる。

## 費用・CI での重さ・決定性

| 方法 | 外部呼び出し | 実行時間（1 テーマ） | CI の重さ | 決定性 |
|---|---|---|---|---|
| a 規則 | 0 | ms | 変化なし | 完全 |
| b OpenAlex topics | 0（今の works 取得に `topics` を select するだけ） | 0 | 変化なし | OpenAlex の再分類で変わる（topic は版ごとに更新される） |
| c 埋め込み（bge-small q8） | 初回にモデル 34 MB をダウンロード（キャッシュ可） | 候補 400 件で約 40 s（M 系 CPU。MiniLM なら約 20 s） | `@huggingface/transformers` + onnxruntime-node で node_modules が約 380 MB 増える | 同じ CPU・同じ版ならビット単位で同じ。CPU が変わると小数の末尾がずれうる → 丸めとキャッシュで吸収 |
| c' S2 SPECTER2（API） | 候補 500 件ごとに 1 回（認証なしは 429 が多い） | 数秒〜数分 | 依存は増えない | S2 側の版に依存し、DOI のない候補は引けない |
| d LLM（Groq） | 20 件で 1 回 | — | 0 | 低い（温度 0 でも版で変わる）→ キャッシュが必須 |

LLM の見積もり（題名 + 要旨の先頭 1000 字 ≈ 1 件 250 トークン、出力は 1 件 10 トークン、指示文は 20 件ごとに 300 トークン）:

| テーマ | 候補（abstract あり） | 全件を判定 | 境界の帯だけ（約 25〜30%） | 題名だけで判定 |
|---|---|---|---|---|
| GNN | 174 | 約 50k | 約 15k | 約 9k |
| FA | 56 | 約 17k | 約 5k | 約 3k |
| MoE | 195 | 約 55k | 約 15k | 約 10k |
| ViT | 403 | 約 115k | 約 32k | 約 20k |

1 日の上限 200k に対して関係分類が 1 テーマ 5〜60k 使う（41 D2）。全件を判定すると 1 日 1〜2 テーマしか回らない。帯だけなら収まるが、正解との比較はしていない（キーがないため、ここでは評価できない）。

## 推奨と組み込み計画

### 段階 1（今すぐ・費用なし）: 規則を「語一致のみ」へ

- `TopicScope.admits`
  - 許可リスト（`isFoundationalAncestor`）による無条件の採用をやめる。許可リストは関係分類（`deriveRelation` の extends 短絡）のためだけに使う。
  - `support` による採用をやめる。`minSupport` 0 を「支持なし」の意味にして既定にする。
- `bfs.ts` の deferred pass と `confirmSupportAdmissions` は、`minSupport=0` のとき何もしない。
- descendant の `provisional`（語が要旨だけにある）は不採用にする。今は支持で救っているが、支持がほぼ機能していないため。
- 期待値（この評価セット）: P 0.73→0.85、公開済みテーマ外の残り 11→2。

### 段階 2: 埋め込みの z 判定を足す（推奨の本命）

判定式（`TopicScope` に `relevance?: number` を渡す）:

| 候補の種類 | 採用条件 |
|---|---|
| 参照（親） | (語一致 AND z ≥ 0) OR z ≥ 1.0 |
| 被引用（descendant） | (題名が主題 AND z ≥ 0) OR z ≥ 1.0 |
| 許可リストの論文 | 上と同じ条件で判定する（z ≥ 0 なら "foundational" を理由として記録） |
| seed | 対象外（seed の順位付けには使ってよい。z の低い seed は主題でないと見なせる） |

- **z の定義**: `cos(候補, q)` を候補プール内で標準化した値。q は、主題 seed（`role==="subject"`、いなければ全 seed）の題名+要旨ベクトルの平均と、`テーマ名; 別名; _topic_terms` のベクトルを平均して正規化したもの。
- **プールの取り方**: `runBfsAndDescendants` の最初に、全 seed の references（最大 200）と citations（16）を先に取得する（`fetchRelated` はキャッシュされるので取得は増えない）。それをまとめて埋め込み、μ・σ を固定する。depth 2 以降と自動拡張の再試行では、新しい候補も同じ μ・σ で z にする。
- **モジュール**: `lineage/theme/topicEmbedding.ts` に `TopicEmbedder` インタフェース（`embed(texts) → number[][]`）を置く。本番の実装は `@huggingface/transformers` を動的 import する。テストは偽の embedder を使う。
- **モデル**: `Xenova/bge-small-en-v1.5`（q8）。版（revision）を固定する。MiniLM-L6-v2 でも F1 はほぼ同じ（0.82）なので、重さを優先するなら MiniLM（23 MB、2 倍速い）でもよい。
- **キャッシュ**
  - ベクトル: `data/state/lineage-cache/emb_<model>_<sha256(text)>.json`。値は小数 4 桁に丸める。
  - モデル: Actions の cache に置く（キーはモデル名と revision）。
- **決定性**: 丸め、キャッシュ、版の固定、閾値の余裕（z の刻みは 0.1）で、境界での反転を抑える。成果物の `meta.topic_gate = {method, model, revision, z_lo, z_hi, pool_size}` に判定方法を記録する。
- **失敗時（フォールバック）**: パッケージがない、モデルを取得できない、推論で例外、のいずれかなら警告を出して段階 1 の「語一致のみ」で続ける。生成は止めない。`meta.topic_gate.method = "terms"` にして、品質表で見えるようにする。
- **CI**: 依存は `apps/pipeline` の optionalDependencies にする（または別パッケージにする）。通常の `tests` ジョブには入れず、`regen-themes.yml` と `theme-on-demand.yml` だけで入れる。実行時間は 1 テーマ +30〜60 s。
- **D1 の自動検査（テーマ外率）への流用**: 公開前に全ノードの z を計算し、z < 0 の非 seed ノードの割合を品質表に出せる。人手監査の 10% 基準の目安になる。

### 段階 3（必要なら）: LLM は境界の帯だけ

`0 ≤ z < 1.0` かつ語一致なし、または `z < 0` かつ語一致あり。この帯だけを 20 件ずつ判定する（ViT でも約 32k トークン）。判定はキャッシュして再生成では聞き直さない。D2 の予算と D3 の失敗時の扱い（使えなければ段階 2 の判定のまま）に従う。

## 組み込み（R2-11）

[41](41-lineage-publication-and-reliability.md) D7 の決定に従い、段階 1 と段階 2 を生成器に入れた。

| 項目 | 内容 | 場所 |
|---|---|---|
| 段階 1 | 既定を「語一致のみ」にした（`minSupport` 0＝支持による採用なし、`admitFoundational` false）。被引用側の provisional もなくした。許可リストは関係分類（`deriveRelation`）と根の選択だけに使う。旧規則は `--topic-min-support 2` などで明示したときだけ動く | `topicScope.ts`、`cli.ts` |
| 段階 2 | `TopicScope.admits(p, support, z)` / `admitsDescendant(p, z)`。参照は `(語一致 AND z≥0) OR z≥1.0`、被引用は `(題名が主題 AND z≥0) OR z≥1.0`。許可リストの論文も同じ条件で判定し、通れば理由を `foundational` と記録する | `topicScope.ts` |
| z のプール | `runBfsAndDescendants` の最初に、全 seed の references（`width×4`）と citations（`descWidth×4`）を取得する（BFS 本体と同じ呼び出しなので、2 回目はキャッシュから読む）。要旨のあるものと seed を 1 回でまとめて埋め込み、μ・σ を固定する。depth 2 以降の新しい候補も同じ μ・σ で z にする | `bfs.ts`、`topicEmbedding.ts` |
| 埋め込み | `TopicEmbedder` インタフェース。本番は `@huggingface/transformers` 3.8.1（`apps/pipeline` の optionalDependency）を動的 import する。モデルは `Xenova/bge-small-en-v1.5`、q8、revision `ea104dacec62c0de699686887e3f920caeb4f3e3` で固定。パッケージとモデルは最初のキャッシュ未命中のときだけ読み込む | `topicEmbedding.ts` |
| ベクトルのキャッシュ | `data/state/lineage-cache/embeddings/emb_<model>_<rev12>_<sha256(model,revision,text)>.json`。値は小数 4 桁に丸める（新規に計算した値も丸めるので、キャッシュの有無で結果が変わらない） | 同上 |
| フォールバック | パッケージがない・モデルを取得できない・推論で例外、のどれでも段階 1 の規則で続け、生成は止めない。成果物の `meta.topic_gate` に `method: "terms"` と `fallback_reason` を記録する | 同上 |
| 記録 | `meta.topic_gate = {method: "embedding+terms" \| "terms", model, revision, thresholds: {z_lo, z_hi}, pool_size}`。`lineage-artifact-v1` の `meta` は追加のキーを許すので、スキーマも core の判定も変えていない。gate を切ったとき（`--no-topic-gate`、Python 時代の parity テスト）は記録しない | `build.ts` |
| CLI | `--no-topic-embedding` で段階 1 の規則だけにできる。`--topic-min-support` の既定は 0（0 以上を受け付ける） | `cli.ts` |
| CI | `regen-themes.yml`・`theme-on-demand.yml` に `actions/cache`（SHA 固定、v6.1.0）を 2 つ足した。モデル（約 35 MB、キーはモデル名＋revision）と、ベクトル（実行ごとに更新して前回分を引き継ぐ） | workflows |

### ベクトルを git に入れない理由

- 1 件あたり約 3 KB（384 次元・小数 4 桁の JSON）。1 テーマの候補は seed 5・width 8 で最大約 240 件なので、1 回の生成で最大約 0.7 MB、数百ファイルになる。
- 被引用の上位は作り直すたびに入れ替わるので、テーマを作り直すごとに増え続け、git の履歴に残り続ける。promote の許可パスも広げる必要がある。
- 失っても再計算で同じ値に戻る（版を固定し、丸めている）。そのため Actions の cache に置く。決定性は、版の固定・丸め・Actions の cache で保つ。cache が消えても、同じ CPU 系統なら丸めた値は同じになる。

### 本番の経路での再評価

`evalRelevanceCli.ts --embed` は、`TopicScope` の既定値と `topicEmbedding.ts`（実モデル）を、評価セットのテーマごとの候補全体をプールとして通す。2026-10-10、M 系 CPU での結果:

| 行 | P | R | F1 | TP/FP/FN | 公開済み 残る on/off |
|---|---|---|---|---|---|
| 本番 段階 1（既定値、z なし） | 0.85 | 0.68 | 0.76 | 53/9/25 | 31/41 · 2/109 |
| 本番 段階 2（embedding+terms） | **0.87** | **0.77** | **0.82** | 60/9/18 | 33/41 · 3/109 |

上の推奨行（scores ファイルから計算した値）と一致した。初回は 375 件を約 24 s で埋め込み（RSS 約 300 MB）、キャッシュが温まった 2 回目は 0.1 s だった。

### 注意

- `onnxruntime-node` は、推論の後に `process.exit()` を呼ぶと macOS で異常終了する（rc 134）。テーマの CLI は `process.exitCode` を使っているので問題ない。新しい CLI で埋め込みを使うときも `process.exit()` は呼ばないこと。
- optionalDependency なので、`pnpm install` をするすべての CI ジョブにも入る（取得するのは約 128 MB、展開後は約 380 MB）。重さが問題になったら、別パッケージに分けて生成ジョブだけで入れる。
- 41 D7 の「方針の `theme_min_generated_at` を進める」は、マージして作り直すときに行う。進めると、今の未監査公開（GNN・MoE）は作り直すまで非公開になる。

## 再実行

```sh
# 候補の取得（OpenAlex、キャッシュはスクラッチ側）
pnpm exec tsx apps/pipeline/src/lineage/theme/eval/collectRelevanceCandidates.ts --cache-dir <dir> --mailto <addr> --out pool.json
# 埋め込みスコア（transformers.js はリポジトリ外に入れる）
npm i --prefix <emb> @huggingface/transformers@3
pnpm exec tsx apps/pipeline/src/lineage/theme/eval/computeRelevanceEmbeddings.ts --transformers <emb> --model-cache <emb>/models
# 比較（オフライン・約 10 s）
pnpm exec tsx apps/pipeline/src/lineage/theme/eval/evalRelevanceCli.ts [--failures] [--json]
# 本番の経路（TopicScope + topicEmbedding.ts、実モデル）の行を足す（R2-11）
pnpm exec tsx apps/pipeline/src/lineage/theme/eval/evalRelevanceCli.ts --embed --model-cache <dir> --vector-cache <dir>
```

正解ファイルは `relevance-eval-v1.json`（380 件、1.3 MB）、埋め込みスコアは `relevance-eval-v1.scores.json`。標本の取り出しと正解付けは手作業で行った（取り出しは sha1 順の決まった標本で、手順は上に書いたとおり）。
