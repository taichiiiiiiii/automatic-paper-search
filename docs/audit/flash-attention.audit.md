# 監査シート: Flash Attention（theme:flash-attention）

## まとめ

| 項目 | 件数 |
|---|---|
| ノード | 14（フォーカス 5・サーベイらしい 0・掲載先を DBLP で補正 5） |
| 強い関係 | 4（extends 1・supersedes 3） |
| 強い関係の根拠 | Semantic Scholar の引用文 1・題名の版（引用文なし） 3 |
| 第二審査で要確認 | ノード 0・関係 1 |
| 見立てでテーマ外 / 書誌の誤り / 関係の誤り | 0 / 0 / 0 |
| 見立てをすべて採用したときの監査記録 | **合格**（監査済みになる見込み。標本のテーマ外の割合 0.0%） |

- 対象: `data/published/themes/flash-attention/lineage.json`
- input_sha256: `e9c5dc3e6cac258cde4a6777dbe103ead065eeaf3187fbec09b0d48427c43499`（この値の成果物だけに有効。作り直したら監査し直し）
- 下書き作成: 2026-10-11T10:58:37.873Z
- 範囲（設計 41 D5）: ノード 14 件すべて、強い主張の関係（contrasts・supersedes・extends・successor）4 件すべて
- 第二審査の下書き: 要確認 ノード 0 件・関係 1 件（「妥当／要確認」は判定ではない。判定は監査者が JSON に書く）

## 要確認の一覧（第二審査）

- R1 `extends` 「FlashAttention-2」→「Efficient FlashAttention on Blackwell v…」（Semantic Scholar の引用文）: 種類は正しいが根拠が弱い。論文自体は FlashAttention のアルゴリズムを Blackwell 向けに実装したもので extends は正しい。ただし引用文は記法の踏襲（「We follow the FlashAttention algorithms in using … notation … [2, 3, 4]」、3 本同時の引用）で根拠としては弱い

## 判定の書き方

同じ名前の `.audit-pending.json` を編集する（この Markdown は表示用）。

- nodes[].on_topic: テーマ内なら true、テーマ外なら false
- nodes[].metadata_ok: 題名・年・著者・DOI/arXiv が正しければ true（違えば false と note に理由）
- relations[].verdict: 関係の種類が正しければ "correct"、誤りなら "wrong"（正しい種類を corrected_relation に。関係が成り立たないなら null のまま note に理由）
- auditor に監査者名、audited_at に監査日時（例 2026-10-12T10:00:00+09:00）
- suggestion は第二審査の下書き（判定ではない）。未記入の項目を suggestion で埋めてよい場合だけ accept_suggestions_for_unset を true にする
- 編集後: pnpm exec tsx apps/pipeline/src/lineage/quality/auditDraftCli.ts import --draft <このファイル>（--write で監査記録に追記）

関係の種類の意味（src＝被引用側・古い方、dst＝引用側・新しい方）:

- `extends`: 引用側（新しい論文）が被引用側の手法を土台にして拡張している
- `successor`: 引用側が被引用側の直接の後継（同じ系列の次の段階）である
- `supersedes`: 引用側が被引用側を置き換える新版（同じ系列の改訂版）である
- `contrasts`: 引用側が被引用側との違いをはっきり示し、対照的な手法を取っている
- `ablation`: 引用側が被引用側の要素を外して効果を確かめている
- `baseline_only`: 比較対象・背景として引用しているだけ

## ノード（14 件）

| # | 題名 | 年 | 著者・掲載 | リンク | 採用の理由 | 第二審査 | 理由 |
|---|---|---|---|---|---|---|---|
| 1 | FlashAttention: Fast and Memory-Efficient Exact Attention with IO-Awareness 〔根・フォーカス〕<br>`openalex:W4281758439` | 2022 | Dao, Tri, Daniel Y. Fu, Stefano Ermon ほか / NeurIPS（DBLP） | [OpenAlex](https://openalex.org/W4281758439) [DOI](https://doi.org/10.48550/arxiv.2205.14135) [arXiv](https://arxiv.org/abs/2205.14135) [S2](https://www.semanticscholar.org/arxiv/2205.14135) [DBLP](https://dblp.org/rec/conf/nips/DaoFERR22) | 根（次数が最大のフォーカス論文）。フォーカス論文（テーマ検索で選ばれたシード）。グラフ内の 8 本に引用される（「FlashAttention-2」・「FlashDecoding++」・「A Case Study in CUDA Kernel Fusion」 など）。グラフ内の 5 本を引用する（「Generating Long Sequences with Sparse T…」・「Efficient Content-Based Sparse Attentio…」・「Rethinking Attention with Performers」 など） | 妥当（テーマ内: はい、書誌: はい） | FlashAttention 本体（NeurIPS 2022、DBLP で補正）。著者表記「Dao, Tri」だけ姓, 名の形式（表示上の軽微な不揃いで誤りではない） |
| 2 | FlashAttention-2: Faster Attention with Better Parallelism and Work Partitioning 〔フォーカス〕<br>`openalex:W4384648639` | 2023 | Tri Dao / ICLR（DBLP） | [OpenAlex](https://openalex.org/W4384648639) [DOI](https://doi.org/10.48550/arxiv.2307.08691) [arXiv](https://arxiv.org/abs/2307.08691) [S2](https://www.semanticscholar.org/arxiv/2307.08691) [DBLP](https://dblp.org/rec/conf/iclr/Dao24) | フォーカス論文（テーマ検索で選ばれたシード）。グラフ内の 6 本に引用される（「FlashDecoding++」・「A Case Study in CUDA Kernel Fusion」・「FlashAttention-3」 など）。グラフ内の 4 本を引用する（「Efficient Content-Based Sparse Attentio…」・「Rethinking Attention with Performers」・「Self-attention Does Not Need $O(n^2)$ M…」 など） | 妥当（テーマ内: はい、書誌: はい） | FlashAttention-2（arXiv 2023、ICLR 2024。掲載先は DBLP で補正） |
| 3 | FlashAttention-3: Fast and Accurate Attention with Asynchrony and Low-precision 〔フォーカス〕<br>`openalex:W4400611982` | 2024 | Shah, Jay, Ganesh Bikshandi, Zhang, Ying ほか / NeurIPS（DBLP） | [OpenAlex](https://openalex.org/W4400611982) [DOI](https://doi.org/10.48550/arxiv.2407.08608) [arXiv](https://arxiv.org/abs/2407.08608) [S2](https://www.semanticscholar.org/arxiv/2407.08608) [DBLP](https://dblp.org/rec/conf/nips/ShahBZTRD24) | フォーカス論文（テーマ検索で選ばれたシード）。グラフ内の 4 本に引用される（「FlashAttention on a Napkin」・「BLASST」・「VFA」 など）。グラフ内の 5 本を引用する（「Generating Long Sequences with Sparse T…」・「Efficient Content-Based Sparse Attentio…」・「Rethinking Attention with Performers」 など） | 妥当（テーマ内: はい、書誌: はい） | FlashAttention-3（NeurIPS 2024、DBLP で補正）。著者表記「Shah, Jay」が姓, 名の形式（軽微） |
| 4 | FlashAttention on a Napkin: A Diagrammatic Approach to Deep Learning IO-Awareness 〔フォーカス〕<br>`openalex:W4405090274` | 2024 | Vincent Abbott, Gioele Zardini / Trans. Mach. Learn. Res.（DBLP） | [OpenAlex](https://openalex.org/W4405090274) [DOI](https://doi.org/10.48550/arxiv.2412.03317) [arXiv](https://arxiv.org/abs/2412.03317) [S2](https://www.semanticscholar.org/arxiv/2412.03317) [DBLP](https://dblp.org/rec/journals/tmlr/AbbottZ25) | フォーカス論文（テーマ検索で選ばれたシード）。グラフ内の 4 本を引用する（「FlashAttention」・「FlashAttention-2」・「A Case Study in CUDA Kernel Fusion」 など） | 妥当（テーマ内: はい、書誌: はい） | FlashAttention の IO を図式で扱う理論寄りの論文（TMLR、DBLP で補正）。テーマ内 |
| 5 | VFA: Relieving Vector Operations in Flash Attention with Global Maximum Pre-computation 〔フォーカス〕<br>`openalex:W7154502343` | 2026 | Yupeng Sun, Yanzhao Li, Zhiqiang Zou ほか / arXiv (Cornell University) | [OpenAlex](https://openalex.org/W7154502343) [DOI](https://doi.org/10.48550/arxiv.2604.12798) [arXiv](https://arxiv.org/abs/2604.12798) [S2](https://www.semanticscholar.org/arxiv/2604.12798) | フォーカス論文（テーマ検索で選ばれたシード）。グラフ内の 1 本に引用される（「Efficient FlashAttention on Blackwell v…」 など）。グラフ内の 7 本を引用する（「Efficient Content-Based Sparse Attentio…」・「Rethinking Attention with Performers」・「FlashAttention」 など） | 妥当（テーマ内: はい、書誌: はい） | 効率的な注意機構（FlashAttention 系列とその前身の疎・線形注意）でテーマ内。題名・年・著者は記録と一致 |
| 6 | Generating Long Sequences with Sparse Transformers<br>`openalex:W2940744433` | 2019 | Rewon Child, Scott Gray, Alec Radford ほか / arXiv (Cornell University) | [OpenAlex](https://openalex.org/W2940744433) [DOI](https://doi.org/10.48550/arxiv.1904.10509) [arXiv](https://arxiv.org/abs/1904.10509) [S2](https://www.semanticscholar.org/arxiv/1904.10509) | グラフ内の 7 本に引用される（「Efficient Content-Based Sparse Attentio…」・「Rethinking Attention with Performers」・「SMYRF」 など）。テーマ判定（embedding+terms）を通過 | 妥当（テーマ内: はい、書誌: はい） | 効率的な注意機構（FlashAttention 系列とその前身の疎・線形注意）でテーマ内。題名・年・著者は記録と一致 |
| 7 | Rethinking Attention with Performers<br>`openalex:W3091156754` | 2020 | Krzysztof Choromański, Valerii Likhosherstov, David Dohan ほか / ICLR（DBLP） | [OpenAlex](https://openalex.org/W3091156754) [DOI](https://doi.org/10.48550/arxiv.2009.14794) [arXiv](https://arxiv.org/abs/2009.14794) [S2](https://www.semanticscholar.org/arxiv/2009.14794) [DBLP](https://dblp.org/rec/conf/iclr/ChoromanskiLDSG21) | グラフ内の 5 本に引用される（「Self-attention Does Not Need $O(n^2)$ M…」・「FlashAttention」・「FlashAttention-2」 など）。グラフ内の 2 本を引用する（「Generating Long Sequences with Sparse T…」・「Efficient Content-Based Sparse Attentio…」 など）。テーマ判定（embedding+terms）を通過 | 妥当（テーマ内: はい、書誌: はい） | 効率的な注意機構（FlashAttention 系列とその前身の疎・線形注意）でテーマ内。題名・年・著者は記録と一致 |
| 8 | SMYRF: Efficient Attention using Asymmetric Clustering<br>`openalex:W3092852584` | 2020 | Giannis Daras, Nikita Kitaev, Augustus Odena ほか / arXiv (Cornell University) | [OpenAlex](https://openalex.org/W3092852584) [DOI](https://doi.org/10.48550/arxiv.2010.05315) [arXiv](https://arxiv.org/abs/2010.05315) [S2](https://www.semanticscholar.org/arxiv/2010.05315) | グラフ内の 1 本に引用される（「FlashAttention」 など）。グラフ内の 2 本を引用する（「Generating Long Sequences with Sparse T…」・「Efficient Content-Based Sparse Attentio…」 など）。テーマ判定（embedding+terms）を通過 | 妥当（テーマ内: はい、書誌: はい） | SMYRF。掲載先は arXiv 版の記録だが、DBLP では NeurIPS 2020（題名「SMYRF - …」で表記が違うため自動補正されない）。不完全だが誤りではない |
| 9 | Efficient Content-Based Sparse Attention with Routing Transformers<br>`openalex:W2997517014` | 2021 | Aurko Roy, Mohammad Saffar, Ashish Vaswani ほか / Transactions of the Association for Computational Linguistics | [OpenAlex](https://openalex.org/W2997517014) [DOI](https://doi.org/10.1162/tacl_a_00353) [arXiv](https://arxiv.org/abs/2003.05997) [S2](https://www.semanticscholar.org/arxiv/2003.05997) | グラフ内の 7 本に引用される（「Rethinking Attention with Performers」・「SMYRF」・「Self-attention Does Not Need $O(n^2)$ M…」 など）。グラフ内の 1 本を引用する（「Generating Long Sequences with Sparse T…」 など）。テーマ判定（embedding+terms）を通過 | 妥当（テーマ内: はい、書誌: はい） | Routing Transformer。年 2021 は TACL の刊行年（arXiv 2003.05997 は 2020-03） |
| 10 | Self-attention Does Not Need $O(n^2)$ Memory<br>`openalex:W4226001818` | 2021 | Markus N. Rabe, Charles Staats / arXiv (Cornell University) | [OpenAlex](https://openalex.org/W4226001818) [DOI](https://doi.org/10.48550/arxiv.2112.05682) [arXiv](https://arxiv.org/abs/2112.05682) [S2](https://www.semanticscholar.org/arxiv/2112.05682) | グラフ内の 3 本に引用される（「FlashAttention」・「FlashAttention-2」・「Efficient FlashAttention on Blackwell v…」 など）。グラフ内の 3 本を引用する（「Generating Long Sequences with Sparse T…」・「Efficient Content-Based Sparse Attentio…」・「Rethinking Attention with Performers」 など）。テーマ判定（embedding+terms）を通過 | 妥当（テーマ内: はい、書誌: はい） | 効率的な注意機構（FlashAttention 系列とその前身の疎・線形注意）でテーマ内。題名・年・著者は記録と一致 |
| 11 | FlashDecoding++: Faster Large Language Model Inference on GPUs<br>`openalex:W4388327470` | 2023 | Ke Hong, Guohao Dai, Jiaming Xu ほか / arXiv (Cornell University) | [OpenAlex](https://openalex.org/W4388327470) [DOI](https://doi.org/10.48550/arxiv.2311.01282) [arXiv](https://arxiv.org/abs/2311.01282) [S2](https://www.semanticscholar.org/arxiv/2311.01282) | グラフ内の 2 本に引用される（「VFA」・「Efficient FlashAttention on Blackwell v…」 など）。グラフ内の 2 本を引用する（「FlashAttention」・「FlashAttention-2」 など）。テーマ判定（embedding+terms）を通過 | 妥当（テーマ内: はい、書誌: はい） | FlashDecoding++。掲載先は arXiv 版の記録で正しいが、DBLP では MLSys 2024（題名が長い別表記）。不完全だが誤りではない |
| 12 | A Case Study in CUDA Kernel Fusion: Implementing FlashAttention-2 on NVIDIA Hopper Architecture using the CUTLASS Library<br>`openalex:W4390042124` | 2023 | Ganesh Bikshandi, Shah, Jay / arXiv (Cornell University) | [OpenAlex](https://openalex.org/W4390042124) [DOI](https://doi.org/10.48550/arxiv.2312.11918) [arXiv](https://arxiv.org/abs/2312.11918) [S2](https://www.semanticscholar.org/arxiv/2312.11918) | グラフ内の 1 本に引用される（「FlashAttention on a Napkin」 など）。グラフ内の 2 本を引用する（「FlashAttention」・「FlashAttention-2」 など）。テーマ判定（embedding+terms）を通過 | 妥当（テーマ内: はい、書誌: はい） | FA-2 の Hopper 向け実装（CUTLASS）。テーマ内。著者表記「Shah, Jay」が姓, 名の形式（軽微） |
| 13 | BLASST: Dynamic BLocked Attention Sparsity via Softmax Thresholding<br>`openalex:W4417447635` | 2025 | Jiayi Yuan, Cameron Shinn, Kai Xü ほか / arXiv (Cornell University) | [OpenAlex](https://openalex.org/W4417447635) [DOI](https://doi.org/10.48550/arxiv.2512.12087) [arXiv](https://arxiv.org/abs/2512.12087) [S2](https://www.semanticscholar.org/arxiv/2512.12087) | グラフ内の 1 本に引用される（「VFA」 など）。グラフ内の 3 本を引用する（「Generating Long Sequences with Sparse T…」・「FlashAttention」・「FlashAttention-3」 など）。テーマ判定（embedding+terms）を通過 | 妥当（テーマ内: はい、書誌: はい） | 注意の疎化カーネル。FlashAttention 系の実装を前提にしておりテーマ内 |
| 14 | Efficient FlashAttention on Blackwell via Fixed-Shift Softmax and Persistent Scheduling<br>`openalex:W7220440728` | 2026 | Олександр Сташук, Hongtao Yu, Jay Shah / arXiv (Cornell University) | [OpenAlex](https://openalex.org/W7220440728) [DOI](https://doi.org/10.48550/arxiv.2610.02229) [arXiv](https://arxiv.org/abs/2610.02229) [S2](https://www.semanticscholar.org/arxiv/2610.02229) | グラフ内の 6 本を引用する（「Self-attention Does Not Need $O(n^2)$ M…」・「FlashAttention」・「FlashAttention-2」 など）。テーマ判定（embedding+terms）を通過 | 妥当（テーマ内: はい、書誌: はい） | Blackwell 向けの FlashAttention 実装（arXiv 2610.02229）。テーマ内。第一著者がキリル文字表記（Oleksandr Stashuk）で表示が不揃いだが誤りではない |

## 強い主張の関係（4 件）

### R1. `extends`: 「FlashAttention-2: Faster Attention with Better Parallelism and Work Partitioning」(2023) → 「Efficient FlashAttention on Blackwell via Fixed-Shift Softmax and Persistent Scheduling」(2026)

- 意味: 引用側（新しい論文）が被引用側の手法を土台にして拡張している
- 辺: `openalex:W4384648639` → `openalex:W7220440728`
- 分類: s2_context_rule、確信度 0.8
- 根拠: Semantic Scholar の引用文（[確認](https://www.semanticscholar.org/arxiv/2610.02229)）
- 引用文: “We follow the FlashAttention algorithms in using e P for unnormalized shifted exponentials, m for the row shift, ℓ for their row sum, and L for log-sum-exp [2, 3, 4].”
- 理由欄: 「Efficient FlashAttention on Bla…」(2026) は 「FlashAttention-2」(2023) を土台にしている（Semantic Scholar の引用文・引用の意図から規則で判定）。引用文: "We follow the FlashAttention algorithms in using e P for unnormalized shifted exponentials, m for the row shift, ℓ for their row sum, and L for log-sum-exp [2, 3, 4]."
- 第二審査: **要確認**。論文自体は FlashAttention のアルゴリズムを Blackwell 向けに実装したもので extends は正しい。ただし引用文は記法の踏襲（「We follow the FlashAttention algorithms in using … notation … [2, 3, 4]」、3 本同時の引用）で根拠としては弱い

### R2. `supersedes`: 「FlashAttention: Fast and Memory-Efficient Exact Attention with IO-Awareness」(2022) → 「FlashAttention-2: Faster Attention with Better Parallelism and Work Partitioning」(2023)

- 意味: 引用側が被引用側を置き換える新版（同じ系列の改訂版）である
- 辺: `openalex:W4281758439` → `openalex:W4384648639`
- 分類: title_version、確信度 0.7
- 根拠: 題名の版（引用文なし）
- 理由欄: 「FlashAttention-2: Faster Attention with Better Parallelism …」(2023) は「FlashAttention: Fast and Memory-Efficient Exact Attention w…」(2022) のバージョンアップ版にあたり、命名パターンから置き換え (supersedes) と推定される。
- 第二審査: 妥当。同じ著者による FlashAttention の第 2 版（題名の版の規則）。supersedes で妥当

### R3. `supersedes`: 「FlashAttention: Fast and Memory-Efficient Exact Attention with IO-Awareness」(2022) → 「FlashAttention-3: Fast and Accurate Attention with Asynchrony and Low-precision」(2024)

- 意味: 引用側が被引用側を置き換える新版（同じ系列の改訂版）である
- 辺: `openalex:W4281758439` → `openalex:W4400611982`
- 分類: title_version、確信度 0.7
- 根拠: 題名の版（引用文なし）
- 理由欄: 「FlashAttention-3: Fast and Accurate Attention with Asynchro…」(2024) は「FlashAttention: Fast and Memory-Efficient Exact Attention w…」(2022) のバージョンアップ版にあたり、命名パターンから置き換え (supersedes) と推定される。
- 第二審査: 妥当。FlashAttention 系列の第 3 版。FA-1 から見ても新版で supersedes で許容（FA-2→FA-3 と重なる推移の辺）

### R4. `supersedes`: 「FlashAttention-2: Faster Attention with Better Parallelism and Work Partitioning」(2023) → 「FlashAttention-3: Fast and Accurate Attention with Asynchrony and Low-precision」(2024)

- 意味: 引用側が被引用側を置き換える新版（同じ系列の改訂版）である
- 辺: `openalex:W4384648639` → `openalex:W4400611982`
- 分類: title_version、確信度 0.7
- 根拠: 題名の版（引用文なし）
- 理由欄: 「FlashAttention-3: Fast and Accurate Attention with Asynchro…」(2024) は「FlashAttention-2: Faster Attention with Better Parallelism …」(2023) のバージョンアップ版にあたり、命名パターンから置き換え (supersedes) と推定される。
- 第二審査: 妥当。FA-2 の次の版。supersedes で妥当

