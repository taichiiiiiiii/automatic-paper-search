# 監査シート: Mixture of Experts（theme:mixture-of-experts）

## まとめ

| 項目 | 件数 |
|---|---|
| ノード | 21（フォーカス 5・サーベイらしい 0・掲載先を DBLP で補正 10） |
| 強い関係 | 7（contrasts 2・extends 5） |
| 強い関係の根拠 | Semantic Scholar の引用文 6・arXiv HTML 本文の引用文 1 |
| 第二審査で要確認 | ノード 1・関係 0 |
| 見立てでテーマ外 / 書誌の誤り / 関係の誤り | 0 / 0 / 0 |
| 見立てをすべて採用したときの監査記録 | **合格**（監査済みになる見込み。標本のテーマ外の割合 0.0%） |

- 対象: `data/published/themes/mixture-of-experts/lineage.json`
- input_sha256: `1ac5ccd635265dc89c05318674530978bde6262b1f0988f9c13e9b861bc2ab9f`（この値の成果物だけに有効。作り直したら監査し直し）
- 下書き作成: 2026-10-11T10:58:39.682Z
- 範囲（設計 41 D5）: ノード 21 件すべて、強い主張の関係（contrasts・supersedes・extends・successor）7 件すべて
- 第二審査の下書き: 要確認 ノード 1 件・関係 0 件（「妥当／要確認」は判定ではない。判定は監査者が JSON に書く）
- ノードが 20 件を超えるので、監査記録の sample_labels には 20 件だけ入る。テーマ外・書誌の誤りと判定したノードは必ず入れ、残りは決まった順で選ぶ（取り込み時に自動）

## 要確認の一覧（第二審査）

- ノード「Estimating or Propagating Gradients Through Stochastic Neurons for Conditional Computation」(2013): テーマ内 はい・書誌 はい。Bengio ら 2013（straight-through 推定）。MoE そのものではないが条件付き計算の基礎として MoE 論文に引用される。フォーカス論文なので、テーマ外と判定すると監査は不合格になる（境界例）

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

## ノード（21 件）

| # | 題名 | 年 | 著者・掲載 | リンク | 採用の理由 | 第二審査 | 理由 |
|---|---|---|---|---|---|---|---|
| 1 | Estimating or Propagating Gradients Through Stochastic Neurons for Conditional Computation 〔フォーカス〕<br>`openalex:W2242818861` | 2013 | Yoshua Bengio, Nicholas Léonard, Aaron C. Courville / arXiv (Cornell University) | [OpenAlex](https://openalex.org/W2242818861) [DOI](https://doi.org/10.48550/arxiv.1308.3432) [arXiv](https://arxiv.org/abs/1308.3432) [S2](https://www.semanticscholar.org/arxiv/1308.3432) | フォーカス論文（テーマ検索で選ばれたシード）。正典シード（meta.canonical_seeds）。グラフ内の 5 本に引用される（「Learning Factored Representations in a …」・「Conditional Computation in Neural Netwo…」・「Outrageously Large Neural Networks」 など） | **要確認**（テーマ内: はい、書誌: はい） | Bengio ら 2013（straight-through 推定）。MoE そのものではないが条件付き計算の基礎として MoE 論文に引用される。フォーカス論文なので、テーマ外と判定すると監査は不合格になる（境界例） |
| 2 | Outrageously Large Neural Networks: The Sparsely-Gated Mixture-of-Experts Layer 〔根・フォーカス〕<br>`openalex:W2581624817` | 2017 | Noam Shazeer, Azalia Mirhoseini, Krzysztof Maziarz ほか / ICLR (Poster)（DBLP） | [OpenAlex](https://openalex.org/W2581624817) [DOI](https://doi.org/10.48550/arxiv.1701.06538) [arXiv](https://arxiv.org/abs/1701.06538) [S2](https://www.semanticscholar.org/arxiv/1701.06538) [DBLP](https://dblp.org/rec/conf/iclr/ShazeerMMDLHD17) | 根（次数が最大のフォーカス論文）。フォーカス論文（テーマ検索で選ばれたシード）。正典シード（meta.canonical_seeds）。グラフ内の 7 本に引用される（「Modeling Task Relationships in Multi-ta…」・「Hard Mixtures of Experts for Large Scal…」・「Scaling Vision with Sparse Mixture of E…」 など）。グラフ内の 4 本を引用する（「Learning Factored Representations in a …」・「Conditional Computation in Neural Netwo…」・「Estimating or Propagating Gradients Thr…」 など） | 妥当（テーマ内: はい、書誌: はい） | MoE の手法・学習・システムでテーマ内。題名・年・著者・掲載先は記録と一致 |
| 3 | Deep Mixture of Experts via Shallow Embedding 〔フォーカス〕<br>`openalex:W2966327190` | 2018 | Xin Wang, Fisher Yu, Lisa Dunlap ほか / UAI（DBLP） | [OpenAlex](https://openalex.org/W2966327190) [DOI](https://doi.org/10.48550/arxiv.1806.01531) [arXiv](https://arxiv.org/abs/1806.01531) [S2](https://www.semanticscholar.org/arxiv/1806.01531) [DBLP](https://dblp.org/rec/conf/uai/WangYDMWMDG19) | フォーカス論文（テーマ検索で選ばれたシード）。グラフ内の 3 本に引用される（「Scaling Vision with Sparse Mixture of E…」・「Speechmoe2」・「Efficient Deweahter Mixture-of-Experts …」 など） | 妥当（テーマ内: はい、書誌: はい） | DeepMoE。年 2018 は arXiv 初出、掲載先 UAI（2019）は DBLP で補正 |
| 4 | Switch Transformers: Scaling to Trillion Parameter Models with Simple and Efficient Sparsity 〔フォーカス〕<br>`openalex:W3119866685` | 2021 | William Fedus, Barret Zoph, Noam Shazeer / J. Mach. Learn. Res.（DBLP） | [OpenAlex](https://openalex.org/W3119866685) [DOI](https://doi.org/10.48550/arxiv.2101.03961) [arXiv](https://arxiv.org/abs/2101.03961) [S2](https://www.semanticscholar.org/arxiv/2101.03961) [DBLP](https://dblp.org/rec/journals/jmlr/FedusZS22) | フォーカス論文（テーマ検索で選ばれたシード）。正典シード（meta.canonical_seeds）。グラフ内の 8 本に引用される（「BASE Layers」・「Scaling Vision with Sparse Mixture of E…」・「Hash Layers For Large Sparse Models」 など）。グラフ内の 1 本を引用する（「GShard」 など） | 妥当（テーマ内: はい、書誌: はい） | MoE の手法・学習・システムでテーマ内。題名・年・著者・掲載先は記録と一致 |
| 5 | Mixture-of-Experts with Expert Choice Routing 〔フォーカス〕<br>`openalex:W4226079124` | 2022 | Yanqi Zhou, Tao Lei, Hanxiao Liu ほか / NeurIPS（DBLP） | [OpenAlex](https://openalex.org/W4226079124) [DOI](https://doi.org/10.48550/arxiv.2202.09368) [arXiv](https://arxiv.org/abs/2202.09368) [S2](https://www.semanticscholar.org/arxiv/2202.09368) [DBLP](https://dblp.org/rec/conf/nips/ZhouLLDHZDCLL22) | フォーカス論文（テーマ検索で選ばれたシード）。グラフ内の 4 本に引用される（「PipeMoE」・「AdaMV-MoE」・「Robust Mixture-of-Expert Training for C…」 など）。グラフ内の 7 本を引用する（「Outrageously Large Neural Networks」・「Hard Mixtures of Experts for Large Scal…」・「Switch Transformers」 など） | 妥当（テーマ内: はい、書誌: はい） | MoE の手法・学習・システムでテーマ内。題名・年・著者・掲載先は記録と一致 |
| 6 | Learning Factored Representations in a Deep Mixture of Experts<br>`openalex:W1593114658` | 2013 | David Eigen, Marc’Aurelio Ranzato, Ilya Sutskever / arXiv (Cornell University) | [OpenAlex](https://openalex.org/W1593114658) [DOI](https://doi.org/10.48550/arxiv.1312.4314) [arXiv](https://arxiv.org/abs/1312.4314) [S2](https://www.semanticscholar.org/arxiv/1312.4314) | グラフ内の 7 本に引用される（「Outrageously Large Neural Networks」・「Modeling Task Relationships in Multi-ta…」・「Scaling Vision with Sparse Mixture of E…」 など）。グラフ内の 1 本を引用する（「Estimating or Propagating Gradients Thr…」 など）。テーマ判定（embedding+terms）を通過 | 妥当（テーマ内: はい、書誌: はい） | MoE の手法・学習・システムでテーマ内。題名・年・著者・掲載先は記録と一致 |
| 7 | Conditional Computation in Neural Networks for faster models<br>`openalex:W2179423374` | 2015 | Emmanuel Bengio, Pierre‐Luc Bacon, Joëlle Pineau ほか / arXiv (Cornell University) | [OpenAlex](https://openalex.org/W2179423374) [DOI](https://doi.org/10.48550/arxiv.1511.06297) [arXiv](https://arxiv.org/abs/1511.06297) [S2](https://www.semanticscholar.org/arxiv/1511.06297) | グラフ内の 2 本に引用される（「Outrageously Large Neural Networks」・「Scaling Vision with Sparse Mixture of E…」 など）。グラフ内の 1 本を引用する（「Estimating or Propagating Gradients Thr…」 など）。テーマ判定（embedding+terms）を通過 | 妥当（テーマ内: はい、書誌: はい） | MoE の手法・学習・システムでテーマ内。題名・年・著者・掲載先は記録と一致 |
| 8 | Expert Gate: Lifelong Learning with a Network of Experts<br>`openalex:W2554616628` | 2017 | Rahaf Aljundi, Punarjay Chakravarty, Tinne Tuytelaars / IEEE Computer Society Conference on Computer Vision and Pattern Recognition/Proceedings - IEEE Computer Society Conference on Computer Vision and Pattern Recognition/Proceedings | [OpenAlex](https://openalex.org/W2554616628) [DOI](https://doi.org/10.1109/cvpr.2017.753) [arXiv](https://arxiv.org/abs/1611.06194) [S2](https://www.semanticscholar.org/arxiv/1611.06194) | グラフ内の 1 本に引用される（「Outrageously Large Neural Networks」 など）。テーマ判定（embedding+terms）を通過 | 妥当（テーマ内: はい、書誌: はい） | Expert Gate：専門家ネットワークをゲートで選ぶ継続学習。MoE の一種として許容（境界例、次数 1） |
| 9 | Hard Mixtures of Experts for Large Scale Weakly Supervised Vision<br>`openalex:W2963254338` | 2017 | Sam Gross, Marc’Aurelio Ranzato, Arthur D. Szlam / IEEE Computer Society Conference on Computer Vision and Pattern Recognition/Proceedings - IEEE Computer Society Conference on Computer Vision and Pattern Recognition/Proceedings | [OpenAlex](https://openalex.org/W2963254338) [DOI](https://doi.org/10.1109/cvpr.2017.540) [arXiv](https://arxiv.org/abs/1704.06363) [S2](https://www.semanticscholar.org/arxiv/1704.06363) | グラフ内の 7 本に引用される（「Scaling Vision with Sparse Mixture of E…」・「Hash Layers For Large Sparse Models」・「Speechmoe2」 など）。グラフ内の 1 本を引用する（「Outrageously Large Neural Networks」 など）。テーマ判定（embedding+terms）を通過 | 妥当（テーマ内: はい、書誌: はい） | MoE の手法・学習・システムでテーマ内。題名・年・著者・掲載先は記録と一致 |
| 10 | Modeling Task Relationships in Multi-task Learning with Multi-gate Mixture-of-Experts<br>`openalex:W2809290718` | 2018 | Jiaqi Ma, Zhe Zhao, Xinyang Yi ほか / ACM SIGKDD International Conference on Knowledge Discovery & Data Mining (KDD) | [OpenAlex](https://openalex.org/W2809290718) [DOI](https://doi.org/10.1145/3219819.3220007) [S2](https://api.semanticscholar.org/graph/v1/paper/DOI:10.1145/3219819.3220007?fields=title,year,authors,externalIds) | グラフ内の 2 本に引用される（「AdaMV-MoE」・「Efficient Deweahter Mixture-of-Experts …」 など）。グラフ内の 2 本を引用する（「Learning Factored Representations in a …」・「Outrageously Large Neural Networks」 など）。テーマ判定（embedding+terms）を通過 | 妥当（テーマ内: はい、書誌: はい） | MMoE（KDD 2018）。arXiv ID なしだが書誌は正しい |
| 11 | GShard: Scaling Giant Models with Conditional Computation and Automatic Sharding<br>`openalex:W3122317902` | 2021 | Dmitry Lepikhin, HyoukJoong Lee, Yuanzhong Xu ほか / International Conference on Learning Representations | [OpenAlex](https://openalex.org/W3122317902) | グラフ内の 11 本に引用される（「Switch Transformers」・「BASE Layers」・「Scaling Vision with Sparse Mixture of E…」 など）。グラフ内の 1 本を引用する（「Estimating or Propagating Gradients Thr…」 など）。テーマ判定（embedding+terms）を通過 | 妥当（テーマ内: はい、書誌: はい） | GShard（ICLR 2021）。DOI・arXiv ID が空（arXiv 2006.16668）だが題名・年・著者は正しい |
| 12 | BASE Layers: Simplifying Training of Large, Sparse Models<br>`openalex:W3147874613` | 2021 | Mike Lewis, Shruti Bhosale, Tim Dettmers ほか / ICML（DBLP） | [OpenAlex](https://openalex.org/W3147874613) [DOI](https://doi.org/10.48550/arxiv.2103.16716) [arXiv](https://arxiv.org/abs/2103.16716) [S2](https://www.semanticscholar.org/arxiv/2103.16716) [DBLP](https://dblp.org/rec/conf/icml/LewisBDGZ21) | グラフ内の 4 本に引用される（「Hash Layers For Large Sparse Models」・「GLaM」・「Mixture-of-Experts with Expert Choice R…」 など）。グラフ内の 2 本を引用する（「Switch Transformers」・「GShard」 など）。テーマ判定（embedding+terms）を通過 | 妥当（テーマ内: はい、書誌: はい） | MoE の手法・学習・システムでテーマ内。題名・年・著者・掲載先は記録と一致 |
| 13 | Scaling Vision with Sparse Mixture of Experts<br>`openalex:W3170943566` | 2021 | Carlos Riquelme, Joan Puigcerver, Basil Mustafa ほか / NeurIPS（DBLP） | [OpenAlex](https://openalex.org/W3170943566) [DOI](https://doi.org/10.48550/arxiv.2106.05974) [arXiv](https://arxiv.org/abs/2106.05974) [S2](https://www.semanticscholar.org/arxiv/2106.05974) [DBLP](https://dblp.org/rec/conf/nips/RiquelmePMNJPKH21) | グラフ内の 8 本を引用する（「Learning Factored Representations in a …」・「Conditional Computation in Neural Netwo…」・「Estimating or Propagating Gradients Thr…」 など）。テーマ判定（embedding+terms）を通過 | 妥当（テーマ内: はい、書誌: はい） | MoE の手法・学習・システムでテーマ内。題名・年・著者・掲載先は記録と一致 |
| 14 | Hash Layers For Large Sparse Models<br>`openalex:W3212449162` | 2021 | Stephen Roller, Sainbayar Sukhbaatar, Arthur D. Szlam ほか / NeurIPS（DBLP） | [OpenAlex](https://openalex.org/W3212449162) [DOI](https://doi.org/10.48550/arxiv.2106.04426) [arXiv](https://arxiv.org/abs/2106.04426) [S2](https://www.semanticscholar.org/arxiv/2106.04426) [DBLP](https://dblp.org/rec/conf/nips/RollerSSW21) | グラフ内の 2 本に引用される（「Mixture-of-Experts with Expert Choice R…」・「AdaMV-MoE」 など）。グラフ内の 6 本を引用する（「Learning Factored Representations in a …」・「Outrageously Large Neural Networks」・「Hard Mixtures of Experts for Large Scal…」 など）。テーマ判定（embedding+terms）を通過 | 妥当（テーマ内: はい、書誌: はい） | MoE の手法・学習・システムでテーマ内。題名・年・著者・掲載先は記録と一致 |
| 15 | GLaM: Efficient Scaling of Language Models with Mixture-of-Experts<br>`openalex:W4200634402` | 2021 | Nan Du, Yanping Huang, Andrew M. Dai ほか / ICML（DBLP） | [OpenAlex](https://openalex.org/W4200634402) [DOI](https://doi.org/10.48550/arxiv.2112.06905) [arXiv](https://arxiv.org/abs/2112.06905) [S2](https://www.semanticscholar.org/arxiv/2112.06905) [DBLP](https://dblp.org/rec/conf/icml/DuHDTLXKZYFZFBZ22) | グラフ内の 1 本に引用される（「Mixture-of-Experts with Expert Choice R…」 など）。グラフ内の 5 本を引用する（「Outrageously Large Neural Networks」・「Hard Mixtures of Experts for Large Scal…」・「Switch Transformers」 など）。テーマ判定（embedding+terms）を通過 | 妥当（テーマ内: はい、書誌: はい） | MoE の手法・学習・システムでテーマ内。題名・年・著者・掲載先は記録と一致 |
| 16 | Speechmoe2: Mixture-of-Experts Model with Improved Routing<br>`openalex:W3215427016` | 2022 | Zhao You, Shulin Feng, Dan Su ほか / IEEE International Conference on Acoustics Speech and Signal Processing | [OpenAlex](https://openalex.org/W3215427016) [DOI](https://doi.org/10.1109/icassp43922.2022.9747065) [S2](https://api.semanticscholar.org/graph/v1/paper/DOI:10.1109/icassp43922.2022.9747065?fields=title,year,authors,externalIds) | グラフ内の 4 本を引用する（「Hard Mixtures of Experts for Large Scal…」・「Deep Mixture of Experts via Shallow Emb…」・「Switch Transformers」 など）。テーマ判定（embedding+terms）を通過 | 妥当（テーマ内: はい、書誌: はい） | MoE の手法・学習・システムでテーマ内。題名・年・著者・掲載先は記録と一致 |
| 17 | PipeMoE: Accelerating Mixture-of-Experts through Adaptive Pipelining<br>`openalex:W4386260498` | 2023 | Shaohuai Shi, Xinglin Pan, Xiaowen Chu ほか / INFOCOM（DBLP） | [OpenAlex](https://openalex.org/W4386260498) [DOI](https://doi.org/10.1109/infocom53939.2023.10228874) [S2](https://api.semanticscholar.org/graph/v1/paper/DOI:10.1109/infocom53939.2023.10228874?fields=title,year,authors,externalIds) [DBLP](https://dblp.org/rec/conf/infocom/ShiPCL23) | グラフ内の 1 本に引用される（「ScheMoE」 など）。グラフ内の 3 本を引用する（「GShard」・「BASE Layers」・「Mixture-of-Experts with Expert Choice R…」 など）。テーマ判定（embedding+terms）を通過 | 妥当（テーマ内: はい、書誌: はい） | PipeMoE（INFOCOM 2023）。前回の下書きで誤りだった掲載先は DBLP で補正済み |
| 18 | AdaMV-MoE: Adaptive Multi-Task Vision Mixture-of-Experts<br>`openalex:W4390873360` | 2023 | Tianlong Chen, Xuxi Chen, Xianzhi Du ほか / IEEE/CVF International Conference on Computer Vision (ICCV) | [OpenAlex](https://openalex.org/W4390873360) [DOI](https://doi.org/10.1109/iccv51070.2023.01591) [S2](https://api.semanticscholar.org/graph/v1/paper/DOI:10.1109/iccv51070.2023.01591?fields=title,year,authors,externalIds) | グラフ内の 6 本を引用する（「Learning Factored Representations in a …」・「Modeling Task Relationships in Multi-ta…」・「Hard Mixtures of Experts for Large Scal…」 など）。テーマ判定（embedding+terms）を通過 | 妥当（テーマ内: はい、書誌: はい） | MoE の手法・学習・システムでテーマ内。題名・年・著者・掲載先は記録と一致 |
| 19 | Robust Mixture-of-Expert Training for Convolutional Neural Networks<br>`openalex:W4390874353` | 2023 | Yihua Zhang, Ruisi Cai, Tianlong Chen ほか / IEEE/CVF International Conference on Computer Vision (ICCV) | [OpenAlex](https://openalex.org/W4390874353) [DOI](https://doi.org/10.1109/iccv51070.2023.00015) [S2](https://api.semanticscholar.org/graph/v1/paper/DOI:10.1109/iccv51070.2023.00015?fields=title,year,authors,externalIds) | グラフ内の 4 本を引用する（「Learning Factored Representations in a …」・「Hard Mixtures of Experts for Large Scal…」・「GShard」 など）。テーマ判定（embedding+terms）を通過 | 妥当（テーマ内: はい、書誌: はい） | MoE の手法・学習・システムでテーマ内。題名・年・著者・掲載先は記録と一致 |
| 20 | Efficient Deweahter Mixture-of-Experts with Uncertainty-Aware Feature-Wise Linear Modulation<br>`openalex:W4393160139` | 2024 | Rongyu Zhang, Yulin Luo, Jiaming Liu ほか / Proceedings of the AAAI Conference on Artificial Intelligence | [OpenAlex](https://openalex.org/W4393160139) [DOI](https://doi.org/10.1609/aaai.v38i15.29622) [S2](https://api.semanticscholar.org/graph/v1/paper/DOI:10.1609/aaai.v38i15.29622?fields=title,year,authors,externalIds) | グラフ内の 6 本を引用する（「Learning Factored Representations in a …」・「Outrageously Large Neural Networks」・「Modeling Task Relationships in Multi-ta…」 など）。テーマ判定（embedding+terms）を通過 | 妥当（テーマ内: はい、書誌: はい） | 題名の「Deweahter」は誤字に見えるが AAAI の公式記録（Crossref）も同じ綴り（arXiv 版は Deweather）。記録どおり |
| 21 | ScheMoE: An Extensible Mixture-of-Experts Distributed Training System with Tasks Scheduling<br>`openalex:W4394923534` | 2024 | Shaohuai Shi, Xinglin Pan, Qiang Wang ほか / EuroSys（DBLP） | [OpenAlex](https://openalex.org/W4394923534) [DOI](https://doi.org/10.1145/3627703.3650083) [S2](https://api.semanticscholar.org/graph/v1/paper/DOI:10.1145/3627703.3650083?fields=title,year,authors,externalIds) [DBLP](https://dblp.org/rec/conf/eurosys/ShiPWLRHYLC24) | グラフ内の 3 本を引用する（「Switch Transformers」・「Mixture-of-Experts with Expert Choice R…」・「PipeMoE」 など）。テーマ判定（embedding+terms）を通過 | 妥当（テーマ内: はい、書誌: はい） | ScheMoE（EuroSys 2024）。前回の下書きで誤りだった掲載先は DBLP で補正済み |

## 強い主張の関係（7 件）

### R1. `contrasts`: 「Switch Transformers: Scaling to Trillion Parameter Models with Simple and Efficient Sparsity」(2021) → 「Mixture-of-Experts with Expert Choice Routing」(2022)

- 意味: 引用側が被引用側との違いをはっきり示し、対照的な手法を取っている
- 辺: `openalex:W3119866685` → `openalex:W4226079124`
- 分類: s2_context_rule、確信度 0.7
- 根拠: Semantic Scholar の引用文（[確認](https://www.semanticscholar.org/arxiv/2202.09368)）
- 引用文: “Unlike most related works, we do not impose any auxiliary loss for load balance, such as described in Switch Transformer [10] and GShard [21].”
- 理由欄: 「Mixture-of-Experts with Expert …」(2022) は 「Switch Transformers」(2021) と異なる手法を取ると述べている（Semantic Scholar の引用文・引用の意図から規則で判定）。引用文: "Unlike most related works, we do not impose any auxiliary loss for load balance, such as described in Switch Transformer [10] and GShard [21]."
- 第二審査: 妥当。引用文「Unlike most related works, we do not impose any auxiliary loss for load balance, such as described in Switch Transformer [10] and GShard [21]」。2 本を引くが両方を名指しし、負荷分散の扱い（トークンが専門家を選ぶ vs 専門家がトークンを選ぶ）の対比として contrasts で妥当

### R2. `contrasts`: 「GShard: Scaling Giant Models with Conditional Computation and Automatic Sharding」(2021) → 「Mixture-of-Experts with Expert Choice Routing」(2022)

- 意味: 引用側が被引用側との違いをはっきり示し、対照的な手法を取っている
- 辺: `openalex:W3122317902` → `openalex:W4226079124`
- 分類: s2_context_rule、確信度 0.7
- 根拠: Semantic Scholar の引用文（[確認](https://www.semanticscholar.org/arxiv/2202.09368)）
- 引用文: “Unlike most related works, we do not impose any auxiliary loss for load balance, such as described in Switch Transformer [10] and GShard [21].”
- 理由欄: 「Mixture-of-Experts with Expert …」(2022) は 「GShard」(2020) と異なる手法を取ると述べている（Semantic Scholar の引用文・引用の意図から規則で判定）。引用文: "Unlike most related works, we do not impose any auxiliary loss for load balance, such as described in Switch Transformer [10] and GShard [21]."
- 第二審査: 妥当。Switch → Expert Choice と同じ引用文。GShard を名指しした負荷分散の扱いの対比として contrasts で妥当

### R3. `extends`: 「Learning Factored Representations in a Deep Mixture of Experts」(2013) → 「Outrageously Large Neural Networks: The Sparsely-Gated Mixture-of-Experts Layer」(2017)

- 意味: 引用側（新しい論文）が被引用側の手法を土台にして拡張している
- 辺: `openalex:W1593114658` → `openalex:W2581624817`
- 分類: s2_context_rule、確信度 0.7
- 根拠: Semantic Scholar の引用文（[確認](https://www.semanticscholar.org/arxiv/1701.06538)）
- 引用文: “While Eigen et al. (2013) uses two stacked MoEs allowing for two sets of gating decisions, our convolutional application of the MoE allows for different gating decisions at each position in the text.”
- 理由欄: 「Outrageously Large Neural Netwo…」(2017) は 「Learning Factored Representatio…」(2013) を土台にしている（Semantic Scholar の引用文・引用の意図から規則で判定）。引用文: "While Eigen et al. (2013) uses two stacked MoEs allowing for two sets of gating decisions, our convolutional application of the MoE allows for different gating decisions at each position in the text."
- 第二審査: 妥当。Eigen ら（Deep MoE）→ Shazeer ら（Sparsely-Gated MoE）。Shazeer らは「Our work builds on this use of MoEs」と書いており extends が正しい（R2-31 で contrasts から修正）

### R4. `extends`: 「Outrageously Large Neural Networks: The Sparsely-Gated Mixture-of-Experts Layer」(2017) → 「Scaling Vision with Sparse Mixture of Experts」(2021)

- 意味: 引用側（新しい論文）が被引用側の手法を土台にして拡張している
- 辺: `openalex:W2581624817` → `openalex:W3170943566`
- 分類: s2_context_rule、確信度 0.8
- 根拠: Semantic Scholar の引用文（[確認](https://www.semanticscholar.org/arxiv/2106.05974)）
- 引用文: “Our approach is inspired by [54] who proposed a top-k gating in LSTMs, with auxiliary losses ensuring the expert balance [26].”
- 理由欄: 「Scaling Vision with Sparse Mixt…」(2021) は 「Outrageously Large Neural Netwo…」(2017) を土台にしている（Semantic Scholar の引用文・引用の意図から規則で判定）。引用文: "Our approach is inspired by [54] who proposed a top-k gating in LSTMs, with auxiliary losses ensuring the expert balance [26]."
- 第二審査: 妥当。引用文「Our approach is inspired by [54] who proposed a top-k gating in LSTMs」。V-MoE は Shazeer らの top-k ゲーティングを使う

### R5. `extends`: 「GShard: Scaling Giant Models with Conditional Computation and Automatic Sharding」(2021) → 「Switch Transformers: Scaling to Trillion Parameter Models with Simple and Efficient Sparsity」(2021)

- 意味: 引用側（新しい論文）が被引用側の手法を土台にして拡張している
- 辺: `openalex:W3122317902` → `openalex:W3119866685`
- 分類: s2_context_rule、確信度 0.8
- 根拠: arXiv HTML 本文の引用文（[確認](https://arxiv.org/html/2101.03961v3)）
- 引用文: “Lepikhin et al. (2020) adapts a Mixture-of-Expert model and addresses expert overflow by passing its representation to the next layer without processing through a residual connection which we also follow.”
- 理由欄: 「Switch Transformers」(2021) は 「GShard」(2021) を土台にしている（arXiv HTML（arXiv:2101.03961v3）の本文の引用文から規則で判定）。引用文: "Lepikhin et al. (2020) adapts a Mixture-of-Expert model and addresses expert overflow by passing its representation to the next layer without processing through a residual connection which we also follow."
- 第二審査: 妥当。arXiv HTML の引用文「Lepikhin et al. (2020) adapts a Mixture-of-Expert model and addresses expert overflow … which we also follow」。Switch は GShard の設計を引き継ぐ同じ系列（successor でも可、extends も正しい）

### R6. `extends`: 「GShard: Scaling Giant Models with Conditional Computation and Automatic Sharding」(2021) → 「Scaling Vision with Sparse Mixture of Experts」(2021)

- 意味: 引用側（新しい論文）が被引用側の手法を土台にして拡張している
- 辺: `openalex:W3122317902` → `openalex:W3170943566`
- 分類: s2_context_rule、確信度 0.8
- 根拠: Semantic Scholar の引用文（[確認](https://www.semanticscholar.org/arxiv/2106.05974)）
- 引用文: “Following [39], we place the MoEs on every other layer (we refer to these as V-MoE Every-2).”
- 理由欄: 「Scaling Vision with Sparse Mixt…」(2021) は 「GShard」(2021) を土台にしている（Semantic Scholar の引用文・引用の意図から規則で判定）。引用文: "Following [39], we place the MoEs on every other layer (we refer to these as V-MoE Every-2)."
- 第二審査: 妥当。引用文「Following [39], we place the MoEs on every other layer」は GShard の配置設計の採用。設計の継承なので extends で許容

### R7. `extends`: 「Outrageously Large Neural Networks: The Sparsely-Gated Mixture-of-Experts Layer」(2017) → 「Mixture-of-Experts with Expert Choice Routing」(2022)

- 意味: 引用側（新しい論文）が被引用側の手法を土台にして拡張している
- 辺: `openalex:W2581624817` → `openalex:W4226079124`
- 分類: s2_context_rule、確信度 0.8
- 根拠: Semantic Scholar の引用文（[確認](https://www.semanticscholar.org/arxiv/2202.09368)）
- 引用文: “At the high level, we adopt the idea of sparsely activated Mixture-of-Experts (MoE) [31].”
- 理由欄: 「Mixture-of-Experts with Expert …」(2022) は 「Outrageously Large Neural Netwo…」(2017) を土台にしている（Semantic Scholar の引用文・引用の意図から規則で判定）。引用文: "At the high level, we adopt the idea of sparsely activated Mixture-of-Experts (MoE) [31]."
- 第二審査: 妥当。引用文「we adopt the idea of sparsely activated Mixture-of-Experts (MoE) [31]」がそのまま根拠

