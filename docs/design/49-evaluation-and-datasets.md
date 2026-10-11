# 49. LLM なし系譜パイプラインの評価方法と公開データセット（調査）

- 日付: 2026-10-11（調査のみ。リポジトリは変更していない）
- 観点: 評価・方法論。design 41（R2-16〜R2-25）、42（topic relevance）、43（API による関係分類）の続き
- 前提: 関係は S2 の contexts / intents / isInfluential に規則の手がかりを当てて決める（R2-24 で既定は LLM なし）。テーマ判定は bge-small の z 値と語の一致（D7）。手作業ラベルは `relation-precision-r222.json`（58 本）、`-r223.json`（59 本＋rule_cases 19 本）、`relevance-eval-v1.json`（380 件）
- 調べ方: Web 検索、GitHub / Hugging Face の API でライセンス表記を確認、arXiv API、S2 Datasets API（鍵なしの release 一覧）、手元の `pwc_methods.parquet`（手元の一時領域、HF `pwc-archive/methods` と同じファイル）を pyarrow で集計。「要確認」と書いたものは一次資料で確かめられていない

## 0. 結論（先に）

1. **今の評価の一番の弱点は数の少なさと、作った 4 テーマに合わせて規則を直していること。** R2-24 の強い関係 26/26 は、Wilson 95% 区間の下限で 0.87 しか言えない。再現率 26/32 の区間は [0.65, 0.91]。規則はこの 4 テーマのラベルを見ながら足してきたので、hold-out ではない。**最優先は、新しいテーマを含む 300〜500 本の層別ラベル集合と、規則の変更で結果が変わった組を必ず人が見る回帰ゲート**（§4 P0/P1）
2. **公開データで「系譜（A が B を土台にした）」をそのまま正解にできるものは、まだ実質ない。** いちばん近いのは、ペア単位の「重要な引用か」の 2 つ（Valenzuela 2015 の 465 組、Zhu 2015 の著者自身が付けた約 3,100 組、PDDL）と、ACL-ARC の Extension / Uses ラベル（1,941 文）。2026 年の IdeaGene-Bench（1,961 本の系譜）と EvoTree（11 の AI 分野の進化木）は内容は最も近いが、ライセンスが未定・データ公開が未確認
3. **文単位の引用意図データセット（SciCite・ACL-ARC・MultiCite・ACT2・FineCite）は、手がかりの語の規則の適合率を数千文の規模で測る「外部の物差し」として使える。** ただし S2 の intents 自体が SciCite で学習したモデルの出力なので、SciCite で S2 の intents を評価するのは循環になる。分野も NLP（ACL）中心で、ML の系譜とはずれる
4. **Papers with Code の手法アーカイブは系譜の正解には使えない。** 手元で集計すると 8,725 行のうち 6,481 行（74%）は航空券・クルーズの問い合わせのスパム、本物は約 2,244 行。`introduced_year` は 2,199 行が 2000 のままで壊れている。親子（parent）の欄はなく、`collections`（334 種）だけ。FlashAttention・Swin・Switch Transformer の行もない。CC BY-SA 4.0（継承条項あり）
5. **小さな分類器は「凍結した bge-small の埋め込み＋線形の頭」が現実的。** すでに入っている transformers.js / onnxruntime-node だけで動き、重みは数 KB の JSON で済む。SciBERT や SPECTER2 の微調整版（ONNX q8 で約 110 MB）は精度で有利だが、CI の重さと依存が増える。どちらも**強い関係を作る側ではなく、規則の強い関係を下げる（downgrade）側だけに使う**のが D5 と整合する
6. **ついでに見つけたデータ品質の問題**: `relation-precision-r222/r223.json` の最初の辺（Longformer ← Sparse Transformer）の `citing.abstract` が Longformer の要旨ではなく「Murmurative Attention」という別の文章になっている（OpenAlex の要旨の取り違えか汚染と思われる）。R2-23 から「引用元の論文自身の要旨」を強い関係の裏付けに使っているので（SwinIR ← Swin）、**題名と要旨の不一致を検出する検査**が要る（§4 P0-3）

## 1. 引用の意図・機能のデータセット

| データセット | 中身・規模 | ラベル | ライセンス | PaperPilot での使い道 |
|---|---|---|---|---|
| **ACL-ARC**（Jurgens et al., TACL 2018） | ACL Anthology の引用 1,941 文 | Background / Uses / CompareOrContrast / Motivation / **Extension** / Future（6 種） | 元リポジトリ（davidjurgens/citation-function）に LICENSE なし。HF の非公式ミラーは apache-2.0 表記（要確認） | Extension と Uses は R2-16 以降の「builds_on」の手がかりに最も近い。規則の extends の適合率を文単位で測れる。ただし NLP の論文で、多くは 2015 年以前 |
| **SciCite**（Cohan et al., NAACL 2019） | 11,020 文（train 8,194 / dev 916 / test 1,859）、多分野 | background / method / result（3 種） | コードは Apache-2.0。データの単独の表記は HF で `unknown` | **S2 の intents はこのデータで学習したモデルの出力**。S2 intents の評価には循環。自前の分類器の学習データとしては使える。報告値: 構造的足場モデル macro-F1 84.0、SciBERT 85.5 前後 |
| **MultiCite**（Lauscher et al., NAACL 2022） | CL 論文 1,193 本の 12,653 の引用文脈。複数文・複数ラベル | 7 種（background / motivation / uses / extends / similarities / differences / future work） | **CC BY-NC 2.0**（S2ORC 由来） | 「1 文に [3, 7, 12]」「文脈が複数文にまたがる」という R2-23 の難所そのものを含む。extends と differences は extends / contrasts に直接対応。**非商用なので評価専用**（重みを本番に入れない） |
| **ACT2**（Kunnath et al., LREC 2022、3C 共有タスクの後継） | 多分野の約 4,000 引用（題名・文脈付き） | 目的 6 種（background / uses / compares_contrasts / motivation / extension / future）＋重要度（incidental / influential） | リポジトリ（oacore/ACT2）は MIT。論文は CC BY-NC 4.0（データの扱いは要確認） | 重要度ラベルが「強い関係か」に近い。多分野なので ML 以外の分布も混ざる |
| **FineCite**（Jantsch et al., Findings ACL 2025） | 1,056 の引用文脈、文脈の範囲を細かく注釈 | 範囲＋意図 | README は MIT と書くが GitHub の license 欄は空（要確認） | 「どこまでが被引用論文についての文か」の境界判定（R2-23 の番号の対応）の評価 |
| **Teufel et al. 2006** | 116 本 2,829 引用、12 種 | 弱点・対比・支持・使用など | 一般公開されていない（要確認） | スキーム（手がかり語の設計）の参考のみ |
| **CiteWorth**（Wright & Augenstein 2021） | 約 120 万文、引用すべき文か | 2 値 | CC BY-NC 4.0 | 直接は使わない |
| **Valenzuela et al. 2015**（AAAI WS、S2 の isInfluential の元） | **465 組（引用側, 被引用側）** | incidental / important（「被引用の研究を使った・拡張した」） | 公開状況・ライセンスは要確認 | **ペア単位の「強い関係か」に最も近い定義**。S2 の isInfluential の再現率・適合率の外部評価 |
| **Zhu et al. 2015**（JASIST、lemire/citationdata） | 著者 40 人が自分の論文の参考文献に付けた影響度（約 100 本・約 3,100 組） | influential かどうか（著者自身の判断） | **ODC PDDL（パブリックドメイン）** | 著者本人の判断なので、ペア単位の正解として質が高い。分野は混在（ML 以外も多い）。ライセンス上いちばん使いやすい |

文献レビュー: Kunnath et al. 2021「A meta-analysis of semantic classification of citations」（QSS、OA）が上の各スキームの対応表と既存手法の比較をまとめている。手がかりの語の規則と学習モデルの比較の記述もある。

## 2. 引用文脈のコーパス（ラベルなし）

| コーパス | 規模 | ライセンス・入手 | Node / Actions での使い勝手 | 使い道 |
|---|---|---|---|---|
| **S2 Datasets API `citations`**（2026-10-06 版を確認） | 24 億件、8.5 GB × 30 ファイル。各引用に contexts・intents・isInfluential | API 鍵が必要。S2 API License Agreement（表示時の帰属表示あり）。S2ORC は ODC-BY 1.0 | CI に載せるのは無理。手元で一度だけ落とし、対象テーマの組だけ抜いた小さな fixture を作る | 今 API で 1 件ずつ取っているものと同じ中身。**ラベル付けの候補の母集団を偏りなく作る**のに使える（今は published のエッジ周辺だけ） |
| **unarXive 2022** | arXiv 全文（〜2022）、本文の引用マーカーと参照先の対応 | 全体は Zenodo でアクセス申請。**許諾の緩い部分集合**は公開。HF の `unarXive_citrec`（CS の 250 万段落）は CC BY-SA 4.0。コードは MIT | 本リポジトリの TS 側は DuckDB の Node バインディングがないため `UNAVAILABLE_ADAPTER`（常に空）。オフラインのラベル作り専用にするのが妥当 | S2 が文脈を伏せる論文（R2-23 の MMoE・AdaMV-MoE のような出版社の伏せ）が arXiv にあれば文脈を補える。ただし 2023 年以降の論文はない |
| **S2ORC / s2orc_v2** | 全文 1,000〜1,600 万本 | ODC-BY 1.0 | 同上（オフライン） | 引用マーカーと参考文献の対応が取れるので、「手がかりの直後の番号が被引用論文か」（R2-23）を正確に検証できる |
| **CORE** | 全文 2.7 TB（展開後）、API あり | 登録・CORE の規約 | オフラインのみ | arXiv 以外の OA 全文の補完。優先度は低い |

## 3. 系譜（方法の発展）の正解になりうる資源

| 資源 | 中身 | ライセンス | 評価 |
|---|---|---|---|
| **IdeaGene-Bench**（arXiv 2607.08758、2026-07） | 1,961 本の「golden lineage trace」、1,085 の Idea Genome、920 の対の差分（継承・変異・欠落・外部からの取り込み）。10 分野 | GitHub（VisionXLab/IdeasHaveGenomes）の License 節は「TBD」 | 内容は一番近い。**ライセンス確定まで社内の評価専用**。分野と論文の重なり（ML の 4 テーマを含むか）を要確認 |
| **EvoTree**（arXiv 2609.09561、2026-09） | 11 の AI 分野の進化木を注釈したベンチマーク。指標は NMI、引用方向の正解率、概念の純度、境界論文の検出 | データ公開の場所・ライセンスは未確認 | 「サーベイの系統図」を正解にする評価の設計がそのまま参考になる。特に**引用方向の正解率（先祖→子孫の逆転がないか）**は PaperPilot の年の逆転チェックと同じ考え方 |
| **サーベイの分類表・系統図**（自作） | 例: ViT（Han et al. TPAMI「A Survey on Vision Transformer」、Khan et al.「Transformers in Vision」）、効率的注意（Tay et al.「Efficient Transformers: A Survey」）、MoE（Fedus et al.「A Review of Sparse Expert Models」、Cai et al. 2024 の MoE サーベイ）、GNN（Wu et al.「A Comprehensive Survey on GNNs」、Zhou et al.） | 図・表は著作物。**「X は Y の拡張」という事実の組だけを手で抜く**分には問題になりにくい | テーマごとに 30〜60 組の「サーベイが認める先祖関係」を作れる。ペア単位の正解より、**系譜全体の骨格（主要ノードの網羅、先祖への経路の有無）**を測るのに向く |
| **Papers with Code methods**（HF `pwc-archive/methods`） | 8,725 行（手元で集計: スパム 6,481、本物 約 2,244）。欄は name / paper / introduced_year / collections / num_papers。**親子の欄なし**、`introduced_year` は 2,199 行が 2000 | CC BY-SA 4.0 | 系譜の正解には不可。「同じ collection（例: Vision Transformers、Graph Models、Attention Patterns）に入る手法の導入論文」をテーマ判定の弱い正例として使うのが限度。FlashAttention・Swin・Switch がない |
| **ORKG**（Open Research Knowledge Graph） | 人手で構造化した論文の比較表（Comparisons）、REST API | **CC0 1.0**（一部の第三者由来データを除く） | ML の 4 テーマの比較表があれば「同じ問題を解く手法の集合」として使える。網羅は薄い（要確認） |
| **CS-KG 2.0 / AI-KG**（Open University KMi） | 1,450 万本から自動抽出した 6,700 万の文（手法・タスク・関係 219 種） | 要確認（論文は Scientific Data、OA） | 自動抽出なので正解にはならない。「X uses / extends Y」の弱い照合用 |
| **SciERC**（500 要旨、関係 7 種: USED-FOR・COMPARE・HYPONYM-OF など）、**SciREX**（438 本の全文、PwC 由来のデータセット・指標・タスク・手法の n 項関係、Apache-2.0）、**SciNLP**（2025、60 本の全文、1,826 関係） | 論文の中の実体どうしの関係 | SciREX は Apache-2.0、SciERC は明記なし | 論文どうしの系譜ではない。「uses_resource（データ・指標）」と「builds_on（手法）」を分ける語彙の参考程度 |
| **Main path analysis**（Hummon & Doreian 1989、SPC など） | 引用グラフだけで主経路を抜く古典的方法 | 方法（データではない） | **LLM も文脈も使わない基準線（baseline）**として、系譜の骨格の評価で比較対象にできる。グラフだけでサーベイの骨格をどこまで再現できるかを見る |

## 4. 評価計画（優先度つき）

### P0（今すぐ。新しいデータ不要、CI で回せる）

1. **数字に区間を付ける。** 強い関係の適合率・再現率は Wilson 95% 区間で報告する。今の値: 26/26 → [0.87, 1.00]、22/22 → [0.85, 1.00]、再現率 26/32 → [0.65, 0.91]、rule_cases 7/8 → [0.53, 0.98]。「1.00」とだけ書かない
2. **規則の差分ゲート（回帰テスト）。** R2-23 で使った参考文献 5,122 組（引用文のある組）について、規則の出力（関係・手がかりの種類・根拠の文の番号）のスナップショットを fixture にする。規則を変えたら差分を出し、**変わった組がすべて手作業ラベルを持っていなければテストを落とす**。R2-24 の「5,122 組で変わるのは 1 組だけ」の確認を、毎回手でやる代わりに機械でやる。JSON の差分なので数秒で終わり、Actions に載る
3. **データ品質の検査を fixture と本番の両方に。** (a) 題名と要旨の一致（bge-small の余弦、または題名の語の要旨への出現率）が低いものを検出する。Longformer の要旨の取り違えがこれに当たる。要旨を強い関係の裏付けに使うのは、この検査を通ったときだけにする。(b) 年の逆転（被引用のほうが新しい）を数える。(c) 同一論文の版の重複（arXiv 版と会議版）を数える
4. **誤りの分類を固定する。** 誤りの種類（複数番号の取り違え・設定の踏襲・比較の相手・背景の列挙・要旨のみ・データ汚染）を `gold.error_type` として fixture に持たせ、種類ごとの件数を CI の出力に出す。どの規則が効いているかが見える

### P1（次の 1〜2 週。ラベルを増やす）

5. **層別の手作業ラベル 300〜500 組（新テーマを含む）。**
   - 母集団: 今の 4 テーマに加えて、規則を一度も見ていないテーマを 3〜4 個（例: 拡散モデル、LoRA / PEFT、NeRF、RAG）。これを**凍結した hold-out** とし、規則を直すときには見ない
   - 層: 規則の結果（強い / 手がかりはあるが弱い / 手がかりなし）× S2 の isInfluential × intents（methodology あり / なし）× 文脈の有無。強い関係の層を多めに取り、全体の推定は層の重みで戻す（重み付き再現率）
   - 目標の数: 強い関係を 100 本ラベルすれば、誤り 3 本でも適合率の区間下限が約 0.91（97/100 → [0.915, 0.99]）。弱い・手がかりなしの層から 200〜400 本で再現率を推定する
   - 単位: 組（引用側, 被引用側）の正解（strong / relation / quote_backed）＋根拠の文。ガイドラインは ACL-ARC の Extension / Uses と Valenzuela の「important」の定義を下敷きにし、今の fixture の note の判断（設定の踏襲は弱い、など）を明文化する
   - 一致度: 2 割を 2 人目（別のエージェントか利用者）が独立に付け、Cohen の κ を出す。κ < 0.6 ならガイドラインを直す
6. **外部の物差しでの文単位の評価（オフライン、1 回きり＋小さな fixture）。**
   - ACL-ARC（1,941 文）と MultiCite（12,653 文脈）に規則の「builds_on」「contrasts」を当て、Extension / Uses / Differences に対する適合率を出す。規則が ML 以外の書き方で過剰に当たらないかを数千文で確かめる
   - Zhu 2015（PDDL）と Valenzuela 2015 で、S2 の isInfluential と規則のペア単位の一致を出す。S2 の文脈が取れる組だけ
   - 結果から誤りの代表 50〜100 文だけを抜いて repo の fixture にする（MultiCite は CC BY-NC なので、本文の抜き書きを公開リポジトリに入れるかは利用者の判断。ID と期待値だけを入れて本文は scratch に置くのが安全）
7. **系譜全体（グラフ単位）の評価。** テーマごとにサーベイから「先祖関係」を 30〜60 組抜いて正解にする。指標:
   - 主要ノードの再現率（サーベイが挙げる主要手法のうち系譜に入った割合）
   - 先祖への経路の再現率（サーベイが「Y は X の拡張」とする組について、系譜に X→…→Y の経路があるか）
   - 強い関係の辺のうち、サーベイが認める組の割合（サーベイにない組は誤りとは限らないので「確認済み率」として扱う）
   - 年の逆転率、版の重複率
   - 基準線: 引用グラフだけの main path analysis（SPC）と比べる。PaperPilot の規則が主経路より骨格をよく再現しているかを示せる
8. **テーマ判定の評価の拡張。** `relevance-eval-v1`（380 件、4 テーマ、正解付けは 1 人）に上の新テーマを足し、2 人目の判定で κ を出す。外部ベンチマーク（SciRepEval の分野分類・引用予測、LitSearch〔MIT〕、CSFCube〔CC BY-NC-SA〕）は**埋め込みモデルの選択（bge-small / MiniLM / SPECTER2）の確認だけ**に使う。「テーマに入るか」という PaperPilot の問いには直接対応しない

### P2（ラベルが増えてから。小さな分類器）

9. **凍結埋め込み＋線形の頭（推奨）。** 引用文を bge-small（既に q8 で使用中）で埋め込み、ロジスティック回帰の頭を Python で学習して重み（384×k の数値）を JSON で入れる。学習データは自前のラベル＋SciCite＋ACL-ARC（MultiCite は非商用なので本番の重みには入れない）。特徴に規則の手がかりの種類・intents・isInfluential・番号の数を足す。新しい依存はなく、決定的（丸めて比較）
   - 役割: **規則が強いとした辺を下げる（downgrade）だけ**。規則が弱いとした辺を強くすることはしない（D5: 強い関係は名指しと手がかりの文が要る）。まず影の動作（shadow）で数か月、規則と食い違った組をラベル候補に回す（能動学習）
10. **微調整したモデルを ONNX で。** SciBERT（110M パラメータ）を SciCite / ACL-ARC＋自前で微調整し、optimum で ONNX にして q8 量子化（約 110 MB）。transformers.js から読める。HF には SciCite で微調整した SciBERT（例: `lostelf/scibert_scivocab_uncased_scicite_finetuned`、ライセンス要確認）がある。精度は文献上 SciCite で macro-F1 85 前後だが、ML の系譜の「extends」は SciCite の 3 種にはない。**9 の線形の頭で足りなければ検討**
11. SPECTER2（Apache-2.0、ONNX の第三者の書き出しあり）はテーマ判定の埋め込みの候補。42 では S2 の API 経由の評価だけで、ローカルの比較はしていない

### P3（様子を見る）

12. IdeaGene-Bench・EvoTree のライセンスとデータの中身が確定したら、ML の論文との重なりを見て、系譜全体の外部評価に使う
13. ORKG の比較表・CS-KG の「extends / uses」の文を、強い関係の弱い照合（確認済みの印）に使えるか試す

## 5. Node / GitHub Actions での実行性

| 項目 | CI に載せられるか | 重さ（目安） |
|---|---|---|
| fixture の再判定（今の R2-22/23 のテスト） | 可 | 数秒 |
| 規則の差分ゲート（5,122 組のスナップショット） | 可 | 数秒、fixture は数 MB 以下にまとめる（引用文は必要な分だけ） |
| 要旨と題名の一致の検査（bge-small q8、34 MB） | 可。モデルは actions/cache | 400 件で約 40 s（42 の実測） |
| 線形の頭による downgrade | 可 | 埋め込みは上と共有、頭は ms |
| SciBERT / SPECTER2 の ONNX（q8 約 110 MB） | 可だが重い | 文脈 300 件で数十秒の見込み（未計測） |
| S2 `citations`・unarXive・S2ORC・CORE の全量 | 不可 | 手元で一度だけ処理し、小さな fixture を作る |
| ACL-ARC / MultiCite / Zhu / Valenzuela での外部評価 | 原則オフライン。結果の要約（数値）と代表例の ID だけを repo に | — |

## 6. ライセンスのまとめ（公開サイト・公開リポジトリで使う前提）

- 本番の重み・公開の fixture に入れてよい（帰属表示を付ける）: Zhu 2015（PDDL）、ORKG（CC0）、SciREX / SciRepEval / SPECTER2（Apache-2.0）、S2ORC（ODC-BY）、unarXive の許諾の緩い部分集合（CC BY-SA、継承条項に注意）、LitSearch（MIT）
- 評価専用（本文の抜き書きを公開リポジトリに入れない、重みに使わない）: MultiCite（CC BY-NC 2.0）、CiteWorth（CC BY-NC）、CSFCube（CC BY-NC-SA）、ACT2（論文は CC BY-NC、データは要確認）
- 要確認: ACL-ARC（元に LICENSE なし）、SciCite のデータ部分、Valenzuela 2015、IdeaGene-Bench（TBD）、EvoTree、CS-KG
- Papers with Code: CC BY-SA 4.0。使うとしてもテーマ判定の弱い正例の評価だけで、派生データの公開は継承条項がかかる
- S2 の引用文を公開サイトに表示する件は S2 API License Agreement の帰属表示の条件に従う（別のレーンの調査と重複するので詳細は省略）

## 7. 次の一手（推奨順）

1. P0-2 の差分ゲートと P0-3 の要旨の検査（Longformer の要旨の取り違えを最初の検出例にする）を実装する
2. P1-5 の新テーマ 3〜4 個で hold-out ラベル 300 本を作る（規則を直すときに見ない）。強い関係 100 本を含める
3. P1-6 で ACL-ARC と Zhu 2015 に規則を当て、規則の手がかりの過剰な当たりを数千文で確かめる
4. P1-7 でテーマごとにサーベイの先祖関係を 30〜60 組作り、main path analysis との比較を出す
5. ラベルが 500 本を超えたら P2-9 の線形の頭を影の動作で入れる

## 出典（主要なもの）

- ACL-ARC: Jurgens et al., TACL 2018 https://aclanthology.org/Q18-1028 / https://github.com/davidjurgens/citation-function
- SciCite: Cohan et al., NAACL 2019 https://aclanthology.org/N19-1361 / https://github.com/allenai/scicite
- MultiCite: Lauscher et al., NAACL 2022 https://aclanthology.org/2022.naacl-main.137 / https://github.com/allenai/multicite
- ACT2: Kunnath et al., LREC 2022 https://aclanthology.org/2022.lrec-1.363 / https://github.com/oacore/ACT2
- FineCite: Jantsch et al., Findings ACL 2025 https://aclanthology.org/2025.findings-acl.1259 / https://github.com/lab-paper-code/FineCite
- Valenzuela, Ha, Etzioni, Identifying Meaningful Citations, AAAI WS 2015 https://cdn.aaai.org/ocs/ws/ws0121/10185-46008-1-PB.pdf
- Zhu et al., Measuring academic influence, JASIST 2015 https://arxiv.org/abs/1501.06587 / https://github.com/lemire/citationdata
- Kunnath et al., A meta-analysis of semantic classification of citations, QSS 2021 https://direct.mit.edu/qss/article/2/4/1170/107610
- unarXive: https://github.com/IllDepence/unarXive（Zenodo 7752754 全体、7752615 部分集合）、https://huggingface.co/datasets/saier/unarXive_citrec
- S2ORC: https://github.com/allenai/s2orc 、S2 Datasets API https://api.semanticscholar.org/datasets/v1/release/latest
- CORE: https://core.ac.uk/documentation/dataset
- IdeaGene-Bench: https://arxiv.org/abs/2607.08758 / https://github.com/VisionXLab/IdeasHaveGenomes
- EvoTree: https://arxiv.org/abs/2609.09561
- Papers with Code アーカイブ: https://huggingface.co/datasets/pwc-archive/methods（スパム混入の報告: https://huggingface.co/datasets/pwc-archive/files/discussions/1）
- ORKG ライセンス: https://orkg.org/page/license
- CS-KG: https://scholkg.kmi.open.ac.uk/
- SciERC: https://nlp.cs.washington.edu/sciIE/ 、SciREX: https://github.com/allenai/scirex 、SciNLP: https://arxiv.org/abs/2509.07801
- Main path analysis: https://en.wikipedia.org/wiki/Main_path_analysis 、https://arxiv.org/abs/2512.12355
- SPECTER2: https://huggingface.co/allenai/specter2_base 、SciRepEval: https://github.com/allenai/scirepeval
- LitSearch: https://github.com/princeton-nlp/litsearch 、CSFCube: https://arxiv.org/abs/2103.12906

> 生の取得結果は手元の一時領域に置いたため、リポジトリには入れていない（2026-10-11）。
