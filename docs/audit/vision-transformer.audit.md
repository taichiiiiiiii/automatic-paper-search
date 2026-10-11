# 監査シート: Vision Transformer（theme:vision-transformer）

## まとめ

| 項目 | 件数 |
|---|---|
| ノード | 20（フォーカス 5・サーベイらしい 1・掲載先を DBLP で補正 2） |
| 強い関係 | 13（contrasts 1・extends 11・supersedes 1） |
| 強い関係の根拠 | Semantic Scholar の引用文 6・arXiv HTML 本文の引用文 3・引用側の要旨 1・基礎文献リスト（引用文なし） 2・題名の版（引用文なし） 1 |
| 第二審査で要確認 | ノード 0・関係 1 |
| 見立てでテーマ外 / 書誌の誤り / 関係の誤り | 0 / 0 / 0 |
| 見立てをすべて採用したときの監査記録 | **合格**（監査済みになる見込み。標本のテーマ外の割合 0.0%） |

- 対象: `data/published/themes/vision-transformer/lineage.json`
- input_sha256: `2c30b8e84e7999f41de7e75d6c226ef5da488b50a39add529f2f6dcf76547f79`（この値の成果物だけに有効。作り直したら監査し直し）
- 下書き作成: 2026-10-11T10:58:36.125Z
- 範囲（設計 41 D5）: ノード 20 件すべて、強い主張の関係（contrasts・supersedes・extends・successor）13 件すべて
- 第二審査の下書き: 要確認 ノード 0 件・関係 1 件（「妥当／要確認」は判定ではない。判定は監査者が JSON に書く）

## 要確認の一覧（第二審査）

- R9 `extends` 「An Image is Worth 16x16 Words」→「Swin Transformer V2」（基礎文献リスト（引用文なし））: 種類は正しいが根拠が弱い。基礎文献リストの規則（引用文なし）。Swin V2 の直接の土台は Swin（別の辺で supersedes）で、ViT からは間接的。ViT 系の拡張として extends は許容できるが根拠は弱い

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

## ノード（20 件）

| # | 題名 | 年 | 著者・掲載 | リンク | 採用の理由 | 第二審査 | 理由 |
|---|---|---|---|---|---|---|---|
| 1 | An Image is Worth 16x16 Words: Transformers for Image Recognition at Scale 〔根・フォーカス〕<br>`openalex:W3094502228` | 2020 | Alexey Dosovitskiy, Lucas Beyer, Alexander Kolesnikov ほか / ICLR（DBLP） | [OpenAlex](https://openalex.org/W3094502228) [DOI](https://doi.org/10.48550/arxiv.2010.11929) [arXiv](https://arxiv.org/abs/2010.11929) [S2](https://www.semanticscholar.org/arxiv/2010.11929) [DBLP](https://dblp.org/rec/conf/iclr/DosovitskiyB0WZ21) | 根（次数が最大のフォーカス論文）。フォーカス論文（テーマ検索で選ばれたシード）。グラフ内の 15 本に引用される（「Transformers in Vision」・「TransUNet」・「Pyramid Vision Transformer」 など） | 妥当（テーマ内: はい、書誌: はい） | ViT 本体（Dosovitskiy ら、arXiv 2010.11929、ICLR 2021。掲載先は DBLP で補正）。根として妥当 |
| 2 | Training data-efficient image transformers & distillation through attention 〔フォーカス〕<br>`openalex:W4394668313` | 2020 | Hugo Touvron, Matthieu Cord, Matthijs Douze ほか / ICML（DBLP） | [OpenAlex](https://openalex.org/W4394668313) [DOI](https://doi.org/10.48550/arxiv.2012.12877) [arXiv](https://arxiv.org/abs/2012.12877) [S2](https://www.semanticscholar.org/arxiv/2012.12877) [DBLP](https://dblp.org/rec/conf/icml/TouvronCDMSJ21) | フォーカス論文（テーマ検索で選ばれたシード）。正典シード（meta.canonical_seeds）。グラフ内の 4 本に引用される（「Going deeper with Image Transformers」・「When Shift Operation Meets Vision Trans…」・「Reversible Vision Transformers」 など）。グラフ内の 1 本を引用する（「An Image is Worth 16x16 Words」 など） | 妥当（テーマ内: はい、書誌: はい） | DeiT（arXiv 2012.12877、2020-12）。掲載先 ICML は DBLP（ICML 2021）、年は arXiv の初出 |
| 3 | ViViT: A Video Vision Transformer 〔フォーカス〕<br>`openalex:W3147387781` | 2021 | Anurag Arnab, Mostafa Dehghani, Georg Heigold ほか / IEEE/CVF International Conference on Computer Vision (ICCV) | [OpenAlex](https://openalex.org/W3147387781) [DOI](https://doi.org/10.1109/iccv48922.2021.00676) [arXiv](https://arxiv.org/abs/2103.15691) [S2](https://www.semanticscholar.org/arxiv/2103.15691) | フォーカス論文（テーマ検索で選ばれたシード）。グラフ内の 5 本に引用される（「Transformers in Vision」・「Segmenter」・「Swin Transformer V2」 など）。グラフ内の 2 本を引用する（「An Image is Worth 16x16 Words」・「Pyramid Vision Transformer」 など） | 妥当（テーマ内: はい、書誌: はい） | ViT 系の手法（本体・改良・自己教師あり学習・派生アーキテクチャ）でテーマ内。題名・年・著者・掲載先は記録と一致 |
| 4 | Masked Autoencoders Are Scalable Vision Learners 〔フォーカス〕<br>`openalex:W4226002507` | 2022 | Kaiming He, Xinlei Chen, Saining Xie ほか / IEEE Computer Society Conference on Computer Vision and Pattern Recognition/Proceedings - IEEE Computer Society Conference on Computer Vision and Pattern Recognition/Proceedings | [OpenAlex](https://openalex.org/W4226002507) [DOI](https://doi.org/10.1109/cvpr52688.2022.01553) [arXiv](https://arxiv.org/abs/2111.06377) [S2](https://www.semanticscholar.org/arxiv/2111.06377) | フォーカス論文（テーマ検索で選ばれたシード）。正典シード（meta.canonical_seeds）。グラフ内の 1 本に引用される（「A ConvNet for the 2020s」 など）。グラフ内の 2 本を引用する（「An Empirical Study of Training Self-Sup…」・「Emerging Properties in Self-Supervised …」 など） | 妥当（テーマ内: はい、書誌: はい） | ViT 系の手法（本体・改良・自己教師あり学習・派生アーキテクチャ）でテーマ内。題名・年・著者・掲載先は記録と一致 |
| 5 | Swin-Unet: Unet-Like Pure Transformer for Medical Image Segmentation 〔フォーカス〕<br>`openalex:W4321232185` | 2023 | Hu Cao, Yueyue Wang, Joy Chen ほか / Lecture notes in computer science | [OpenAlex](https://openalex.org/W4321232185) [DOI](https://doi.org/10.1007/978-3-031-25066-8_9) [arXiv](https://arxiv.org/abs/2105.05537) [S2](https://www.semanticscholar.org/arxiv/2105.05537) | フォーカス論文（テーマ検索で選ばれたシード）。正典シード（meta.canonical_seeds）。グラフ内の 1 本に引用される（「SwinIR」 など）。グラフ内の 4 本を引用する（「TransUNet」・「Pyramid Vision Transformer」・「Swin Transformer」 など） | 妥当（テーマ内: はい、書誌: はい） | Swin を使った医用画像分割（ECCV 2022 workshop、LNCS 刊行は 2023）。応用寄りだがフォーカスとして許容 |
| 6 | TransUNet: Transformers Make Strong Encoders for Medical Image Segmentation<br>`openalex:W3127751679` | 2021 | Jieneng Chen, Yongyi Lu, Qihang Yu ほか / arXiv (Cornell University) | [OpenAlex](https://openalex.org/W3127751679) [DOI](https://doi.org/10.48550/arxiv.2102.04306) [arXiv](https://arxiv.org/abs/2102.04306) [S2](https://www.semanticscholar.org/arxiv/2102.04306) | グラフ内の 1 本に引用される（「Swin-Unet」 など）。グラフ内の 1 本を引用する（「An Image is Worth 16x16 Words」 など）。テーマ判定（embedding+terms）を通過 | 妥当（テーマ内: はい、書誌: はい） | CNN と ViT の混成エンコーダ。ViT の初期の代表的な応用。掲載先 arXiv は正しい（DBLP も CoRR のみ） |
| 7 | Pyramid Vision Transformer: A Versatile Backbone for Dense Prediction without Convolutions<br>`openalex:W3131500599` | 2021 | Wenhai Wang, Enze Xie, Xiang Li ほか / IEEE/CVF International Conference on Computer Vision (ICCV) | [OpenAlex](https://openalex.org/W3131500599) [DOI](https://doi.org/10.1109/iccv48922.2021.00061) [S2](https://api.semanticscholar.org/graph/v1/paper/DOI:10.1109/iccv48922.2021.00061?fields=title,year,authors,externalIds) | グラフ内の 5 本に引用される（「Swin Transformer」・「ViViT」・「Swin Transformer V2」 など）。グラフ内の 1 本を引用する（「An Image is Worth 16x16 Words」 など）。テーマ判定（embedding+terms）を通過 | 妥当（テーマ内: はい、書誌: はい） | ViT 系の手法（本体・改良・自己教師あり学習・派生アーキテクチャ）でテーマ内。題名・年・著者・掲載先は記録と一致 |
| 8 | Swin Transformer: Hierarchical Vision Transformer using Shifted Windows<br>`openalex:W3138516171` | 2021 | Ze Liu, Yutong Lin, Yue Cao ほか / IEEE/CVF International Conference on Computer Vision (ICCV) | [OpenAlex](https://openalex.org/W3138516171) [DOI](https://doi.org/10.1109/iccv48922.2021.00986) [S2](https://api.semanticscholar.org/graph/v1/paper/DOI:10.1109/iccv48922.2021.00986?fields=title,year,authors,externalIds) | グラフ内の 9 本に引用される（「Segmenter」・「SwinIR」・「When Shift Operation Meets Vision Trans…」 など）。グラフ内の 2 本を引用する（「An Image is Worth 16x16 Words」・「Pyramid Vision Transformer」 など）。テーマ判定（embedding+terms）を通過 | 妥当（テーマ内: はい、書誌: はい） | ViT 系の手法（本体・改良・自己教師あり学習・派生アーキテクチャ）でテーマ内。題名・年・著者・掲載先は記録と一致 |
| 9 | An Empirical Study of Training Self-Supervised Vision Transformers<br>`openalex:W3145450063` | 2021 | Xinlei Chen, Saining Xie, Kaiming He / IEEE/CVF International Conference on Computer Vision (ICCV) | [OpenAlex](https://openalex.org/W3145450063) [DOI](https://doi.org/10.1109/iccv48922.2021.00950) [S2](https://api.semanticscholar.org/graph/v1/paper/DOI:10.1109/iccv48922.2021.00950?fields=title,year,authors,externalIds) | グラフ内の 1 本に引用される（「Masked Autoencoders Are Scalable Vision…」 など）。グラフ内の 2 本を引用する（「An Image is Worth 16x16 Words」・「Emerging Properties in Self-Supervised …」 など）。テーマ判定（embedding+terms）を通過 | 妥当（テーマ内: はい、書誌: はい） | ViT 系の手法（本体・改良・自己教師あり学習・派生アーキテクチャ）でテーマ内。題名・年・著者・掲載先は記録と一致 |
| 10 | Going deeper with Image Transformers<br>`openalex:W3146097248` | 2021 | Hugo Touvron, Matthieu Cord, Alexandre Sablayrolles ほか / IEEE/CVF International Conference on Computer Vision (ICCV) | [OpenAlex](https://openalex.org/W3146097248) [DOI](https://doi.org/10.1109/iccv48922.2021.00010) [arXiv](https://arxiv.org/abs/2103.17239) [S2](https://www.semanticscholar.org/arxiv/2103.17239) | グラフ内の 3 本に引用される（「A ConvNet for the 2020s」・「Reversible Vision Transformers」・「Swin-Unet」 など）。グラフ内の 2 本を引用する（「An Image is Worth 16x16 Words」・「Training data-efficient image transform…」 など）。テーマ判定（embedding+terms）を通過 | 妥当（テーマ内: はい、書誌: はい） | ViT 系の手法（本体・改良・自己教師あり学習・派生アーキテクチャ）でテーマ内。題名・年・著者・掲載先は記録と一致 |
| 11 | Emerging Properties in Self-Supervised Vision Transformers<br>`openalex:W3159481202` | 2021 | Mathilde Caron, Hugo Touvron, Ishan Misra ほか / IEEE/CVF International Conference on Computer Vision (ICCV) | [OpenAlex](https://openalex.org/W3159481202) [DOI](https://doi.org/10.1109/iccv48922.2021.00951) [arXiv](https://arxiv.org/abs/2104.14294) [S2](https://www.semanticscholar.org/arxiv/2104.14294) | グラフ内の 2 本に引用される（「An Empirical Study of Training Self-Sup…」・「Masked Autoencoders Are Scalable Vision…」 など）。グラフ内の 1 本を引用する（「An Image is Worth 16x16 Words」 など）。テーマ判定（embedding+terms）を通過 | 妥当（テーマ内: はい、書誌: はい） | ViT 系の手法（本体・改良・自己教師あり学習・派生アーキテクチャ）でテーマ内。題名・年・著者・掲載先は記録と一致 |
| 12 | Segmenter: Transformer for Semantic Segmentation<br>`openalex:W3161838454` | 2021 | Robin Strudel, Ricardo Alexandrino Garcia, Ivan Laptev ほか / IEEE/CVF International Conference on Computer Vision (ICCV) | [OpenAlex](https://openalex.org/W3161838454) [DOI](https://doi.org/10.1109/iccv48922.2021.00717) [arXiv](https://arxiv.org/abs/2105.05633) [S2](https://www.semanticscholar.org/arxiv/2105.05633) | グラフ内の 3 本を引用する（「An Image is Worth 16x16 Words」・「Swin Transformer」・「ViViT」 など）。テーマ判定（embedding+terms）を通過 | 妥当（テーマ内: はい、書誌: はい） | ViT 系の手法（本体・改良・自己教師あり学習・派生アーキテクチャ）でテーマ内。題名・年・著者・掲載先は記録と一致 |
| 13 | SwinIR: Image Restoration Using Swin Transformer<br>`openalex:W3207918547` | 2021 | Jingyun Liang, Jiezhang Cao, Guolei Sun ほか / IEEE/CVF International Conference on Computer Vision Workshops (ICCVW) | [OpenAlex](https://openalex.org/W3207918547) [DOI](https://doi.org/10.1109/iccvw54120.2021.00210) [S2](https://api.semanticscholar.org/graph/v1/paper/DOI:10.1109/iccvw54120.2021.00210?fields=title,year,authors,externalIds) | グラフ内の 3 本を引用する（「An Image is Worth 16x16 Words」・「Swin Transformer」・「Swin-Unet」 など）。テーマ判定（embedding+terms）を通過 | 妥当（テーマ内: はい、書誌: はい） | Swin を画像復元に使う（ICCV 2021 workshop）。応用寄りだが Swin 系の派生として広く引用されるので許容 |
| 14 | Transformers in Vision: A Survey 〔サーベイ〕<br>`openalex:W3119997354` | 2022 | Salman Hameed Khan, Muzammal Naseer, Munawar Hayat ほか / ACM Computing Surveys | [OpenAlex](https://openalex.org/W3119997354) [DOI](https://doi.org/10.1145/3505244) [arXiv](https://arxiv.org/abs/2101.01169) [S2](https://www.semanticscholar.org/arxiv/2101.01169) | グラフ内の 2 本を引用する（「An Image is Worth 16x16 Words」・「ViViT」 など）。テーマ判定（embedding+terms）を通過 | 妥当（テーマ内: はい、書誌: はい） | ViT のサーベイ（ACM CSUR 2022）。テーマ内。強い関係には関わっていない |
| 15 | When Shift Operation Meets Vision Transformer: An Extremely Simple Alternative to Attention Mechanism<br>`openalex:W4226028923` | 2022 | Guangting Wang, Yucheng Zhao, Chuanxin Tang ほか / Proceedings of the AAAI Conference on Artificial Intelligence | [OpenAlex](https://openalex.org/W4226028923) [DOI](https://doi.org/10.1609/aaai.v36i2.20142) [S2](https://api.semanticscholar.org/graph/v1/paper/DOI:10.1609/aaai.v36i2.20142?fields=title,year,authors,externalIds) | グラフ内の 3 本を引用する（「An Image is Worth 16x16 Words」・「Swin Transformer」・「Training data-efficient image transform…」 など）。テーマ判定（embedding+terms）を通過 | 妥当（テーマ内: はい、書誌: はい） | ViT 系の手法（本体・改良・自己教師あり学習・派生アーキテクチャ）でテーマ内。題名・年・著者・掲載先は記録と一致 |
| 16 | Swin Transformer V2: Scaling Up Capacity and Resolution<br>`openalex:W4312349930` | 2022 | Ze Liu, Han Hu, Yutong Lin ほか / IEEE Computer Society Conference on Computer Vision and Pattern Recognition/Proceedings - IEEE Computer Society Conference on Computer Vision and Pattern Recognition/Proceedings | [OpenAlex](https://openalex.org/W4312349930) [DOI](https://doi.org/10.1109/cvpr52688.2022.01170) [S2](https://api.semanticscholar.org/graph/v1/paper/DOI:10.1109/cvpr52688.2022.01170?fields=title,year,authors,externalIds) | グラフ内の 5 本を引用する（「An Image is Worth 16x16 Words」・「Pyramid Vision Transformer」・「Swin Transformer」 など）。テーマ判定（embedding+terms）を通過 | 妥当（テーマ内: はい、書誌: はい） | ViT 系の手法（本体・改良・自己教師あり学習・派生アーキテクチャ）でテーマ内。題名・年・著者・掲載先は記録と一致 |
| 17 | A ConvNet for the 2020s<br>`openalex:W4312443924` | 2022 | Zhuang Liu, Hanzi Mao, Chao-Yuan Wu ほか / IEEE Computer Society Conference on Computer Vision and Pattern Recognition/Proceedings - IEEE Computer Society Conference on Computer Vision and Pattern Recognition/Proceedings | [OpenAlex](https://openalex.org/W4312443924) [DOI](https://doi.org/10.1109/cvpr52688.2022.01167) [S2](https://api.semanticscholar.org/graph/v1/paper/DOI:10.1109/cvpr52688.2022.01167?fields=title,year,authors,externalIds) | グラフ内の 3 本を引用する（「Swin Transformer」・「Going deeper with Image Transformers」・「Masked Autoencoders Are Scalable Vision…」 など）。テーマ判定（embedding+terms）を通過 | 妥当（テーマ内: はい、書誌: はい） | ConvNeXt は CNN の論文だが、ViT の設計を CNN に持ち込んだ対比の基準として ViT の系譜でよく扱われる。テーマ外と見る判断もあり得る境界例（テーマ外にしても標本の割合は 10% 以内） |
| 18 | Video Swin Transformer<br>`openalex:W4312560592` | 2022 | Ze Liu, Jia Ning, Yue Cao ほか / IEEE Computer Society Conference on Computer Vision and Pattern Recognition/Proceedings - IEEE Computer Society Conference on Computer Vision and Pattern Recognition/Proceedings | [OpenAlex](https://openalex.org/W4312560592) [DOI](https://doi.org/10.1109/cvpr52688.2022.00320) [S2](https://api.semanticscholar.org/graph/v1/paper/DOI:10.1109/cvpr52688.2022.00320?fields=title,year,authors,externalIds) | グラフ内の 1 本に引用される（「Swin Transformer V2」 など）。グラフ内の 3 本を引用する（「An Image is Worth 16x16 Words」・「Swin Transformer」・「ViViT」 など）。テーマ判定（embedding+terms）を通過 | 妥当（テーマ内: はい、書誌: はい） | ViT 系の手法（本体・改良・自己教師あり学習・派生アーキテクチャ）でテーマ内。題名・年・著者・掲載先は記録と一致 |
| 19 | Reversible Vision Transformers<br>`openalex:W4312777001` | 2022 | Karttikeya Mangalam, Haoqi Fan, Yanghao Li ほか / IEEE Computer Society Conference on Computer Vision and Pattern Recognition/Proceedings - IEEE Computer Society Conference on Computer Vision and Pattern Recognition/Proceedings | [OpenAlex](https://openalex.org/W4312777001) [DOI](https://doi.org/10.1109/cvpr52688.2022.01056) [S2](https://api.semanticscholar.org/graph/v1/paper/DOI:10.1109/cvpr52688.2022.01056?fields=title,year,authors,externalIds) | グラフ内の 6 本を引用する（「An Image is Worth 16x16 Words」・「Pyramid Vision Transformer」・「Swin Transformer」 など）。テーマ判定（embedding+terms）を通過 | 妥当（テーマ内: はい、書誌: はい） | ViT 系の手法（本体・改良・自己教師あり学習・派生アーキテクチャ）でテーマ内。題名・年・著者・掲載先は記録と一致 |
| 20 | ViTA: A Vision Transformer Inference Accelerator for Edge Applications<br>`openalex:W4385187240` | 2023 | Shashank Nag, Gourav Datta, Souvik Kundu ほか / IEEE International Symposium on Circuits and Systems proceedings | [OpenAlex](https://openalex.org/W4385187240) [DOI](https://doi.org/10.1109/iscas46773.2023.10181988) [arXiv](https://arxiv.org/abs/2302.09108) [S2](https://www.semanticscholar.org/arxiv/2302.09108) | グラフ内の 2 本を引用する（「Swin Transformer」・「Training data-efficient image transform…」 など）。テーマ判定（embedding+terms）を通過 | 妥当（テーマ内: はい、書誌: はい） | ViT 推論用のハードウェア加速器（ISCAS 2023）。ViT 専用なのでテーマ内 |

## 強い主張の関係（13 件）

### R1. `contrasts`: 「An Image is Worth 16x16 Words: Transformers for Image Recognition at Scale」(2020) → 「Swin Transformer: Hierarchical Vision Transformer using Shifted Windows」(2021)

- 意味: 引用側が被引用側との違いをはっきり示し、対照的な手法を取っている
- 辺: `openalex:W3094502228` → `openalex:W3138516171`
- 分類: s2_context_rule、確信度 0.7
- 根拠: Semantic Scholar の引用文（[確認](https://api.semanticscholar.org/graph/v1/paper/DOI:10.1109/iccv48922.2021.00986?fields=title,year,authors,externalIds)）
- 引用文: “These merits make Swin Transformer suitable as a general-purpose backbone for various vision tasks, in contrast to previous Transformer based architectures [19] which produce feature maps of a single resolution and have quadratic complexit…”
- 理由欄: 「Swin Transformer」(2021) は 「An Image is Worth 16x16 Words: …」(2020) と異なる手法を取ると述べている（Semantic Scholar の引用文・引用の意図から規則で判定）。引用文: "These merits make Swin Transformer suitable as a general-purpose backbone for various vision tasks, in contrast to previous Transformer based architectures [19] which produce feature maps of a single resolution and have quadratic complexit…"
- 第二審査: 妥当。引用文「in contrast to previous Transformer based architectures [19] which produce feature maps of a single resolution」が ViT（[19]）を名指しして違いを述べる。単一解像度の ViT に対する階層型という対比として妥当（extends と見る立場もあるが、contrasts も正しい）

### R2. `extends`: 「An Image is Worth 16x16 Words: Transformers for Image Recognition at Scale」(2020) → 「TransUNet: Transformers Make Strong Encoders for Medical Image Segmentation」(2021)

- 意味: 引用側（新しい論文）が被引用側の手法を土台にして拡張している
- 辺: `openalex:W3094502228` → `openalex:W3127751679`
- 分類: s2_context_rule、確信度 0.8
- 根拠: Semantic Scholar の引用文（[確認](https://www.semanticscholar.org/arxiv/2102.04306)）
- 引用文: “Following [4], we first perform tokenization by re-”
- 理由欄: 「TransUNet」(2021) は 「An Image is Worth 16x16 Words: …」(2021) を土台にしている（Semantic Scholar の引用文・引用の意図から規則で判定）。引用文: "Following [4], we first perform tokenization by re-"
- 第二審査: 妥当。TransUNet は ViT をエンコーダに使って拡張している。S2 の引用文「Following [4], we first perform tokenization …」（ViT のパッチ化の踏襲）は途中で切れているが、ViT を名指しする組の文

### R3. `extends`: 「An Image is Worth 16x16 Words: Transformers for Image Recognition at Scale」(2020) → 「Pyramid Vision Transformer: A Versatile Backbone for Dense Prediction without Convolutions」(2021)

- 意味: 引用側（新しい論文）が被引用側の手法を土台にして拡張している
- 辺: `openalex:W3094502228` → `openalex:W3131500599`
- 分類: s2_context_rule、確信度 0.8
- 根拠: arXiv HTML 本文の引用文（[確認](https://arxiv.org/html/2102.12122v2)）
- 引用文: “For image classification, we follow ViT [13] and DeiT [63] to append a learnable classification token to the input of the last stage, and then employ a fully connected (FC) layer to conduct classification on top of the token.”
- 理由欄: 「Pyramid Vision Transformer」(2021) は 「An Image is Worth 16x16 Words: …」(2020) を土台にしている（arXiv HTML（arXiv:2102.12122v2）の本文の引用文から規則で判定）。引用文: "For image classification, we follow ViT [13] and DeiT [63] to append a learnable classification token to the input of the last stage, and then employ a fully connected (FC) layer to conduct classification on top of the token."
- 第二審査: 妥当。PVT は ViT にピラミッド構造を足した拡張（定説）。arXiv HTML の引用文はクラストークンの踏襲（ViT と DeiT を同時に引く）で細部だが、関係の種類は正しい

### R4. `extends`: 「An Image is Worth 16x16 Words: Transformers for Image Recognition at Scale」(2020) → 「An Empirical Study of Training Self-Supervised Vision Transformers」(2021)

- 意味: 引用側（新しい論文）が被引用側の手法を土台にして拡張している
- 辺: `openalex:W3094502228` → `openalex:W3145450063`
- 分類: s2_context_rule、確信度 0.8
- 根拠: Semantic Scholar の引用文（[確認](https://api.semanticscholar.org/graph/v1/paper/DOI:10.1109/iccv48922.2021.00950?fields=title,year,authors,externalIds)）
- 引用文: “ViT-BN is our modified ViT that has BatchNorm, and “/7” denotes a patch size of 7×7 (otherwise following [15]).”
- 理由欄: 「An Empirical Study of Training …」(2021) は 「An Image is Worth 16x16 Words: …」(2021) を土台にしている（Semantic Scholar の引用文・引用の意図から規則で判定）。引用文: "ViT-BN is our modified ViT that has BatchNorm, and “/7” denotes a patch size of 7×7 (otherwise following [15])."
- 第二審査: 妥当。MoCo v3 は ViT の自己教師あり学習を調べる論文で、ViT を土台にしている。引用文はパッチの記法の踏襲で弱いが、関係の種類は正しい

### R5. `extends`: 「An Image is Worth 16x16 Words: Transformers for Image Recognition at Scale」(2020) → 「ViViT: A Video Vision Transformer」(2021)

- 意味: 引用側（新しい論文）が被引用側の手法を土台にして拡張している
- 辺: `openalex:W3094502228` → `openalex:W3147387781`
- 分類: s2_context_rule、確信度 0.8
- 根拠: Semantic Scholar の引用文（[確認](https://www.semanticscholar.org/arxiv/2103.15691)）
- 引用文: “Embed to tokens FactorisedSelf-Attention We propose a pure-transformer architecture for video classiﬁcation, inspired by the recent success of such models for images [18].”
- 理由欄: 「ViViT」(2021) は 「An Image is Worth 16x16 Words: …」(2021) を土台にしている（Semantic Scholar の引用文・引用の意図から規則で判定）。引用文: "Embed to tokens FactorisedSelf-Attention We propose a pure-transformer architecture for video classiﬁcation, inspired by the recent success of such models for images [18]."
- 第二審査: 妥当。引用文「pure-transformer architecture for video classification, inspired by the recent success of such models for images [18]」。ViViT は ViT を動画に拡張

### R6. `extends`: 「An Image is Worth 16x16 Words: Transformers for Image Recognition at Scale」(2020) → 「Segmenter: Transformer for Semantic Segmentation」(2021)

- 意味: 引用側（新しい論文）が被引用側の手法を土台にして拡張している
- 辺: `openalex:W3094502228` → `openalex:W3161838454`
- 分類: s2_context_rule、確信度 0.8
- 根拠: arXiv HTML 本文の引用文（[確認](https://arxiv.org/html/2105.05633v3)）
- 引用文: “For the encoder, we build upon the vision transformer ViT [19] and consider ”Tiny”, ”Small”, ”Base” and ”Large” models described in Table 1.”
- 理由欄: 「Segmenter」(2021) は 「An Image is Worth 16x16 Words: …」(2021) を土台にしている（arXiv HTML（arXiv:2105.05633v3）の本文の引用文から規則で判定）。引用文: "For the encoder, we build upon the vision transformer ViT [19] and consider ”Tiny”, ”Small”, ”Base” and ”Large” models described in Table 1."
- 第二審査: 妥当。arXiv HTML の引用文「For the encoder, we build upon the vision transformer ViT [19]」がそのまま根拠

### R7. `extends`: 「Swin Transformer: Hierarchical Vision Transformer using Shifted Windows」(2021) → 「SwinIR: Image Restoration Using Swin Transformer」(2021)

- 意味: 引用側（新しい論文）が被引用側の手法を土台にして拡張している
- 辺: `openalex:W3138516171` → `openalex:W3207918547`
- 分類: s2_context_rule、確信度 0.75
- 根拠: 引用側の要旨（[確認](https://doi.org/10.1109/iccvw54120.2021.00210)）
- 要旨: “In this paper, we propose a strong baseline model SwinIR for image restoration based on the Swin Transformer.”
- 理由欄: 「SwinIR」(2021) は 「Swin Transformer」(2021) を土台にしている（引用元の論文の要旨から規則で判定）。要旨: "In this paper, we propose a strong baseline model SwinIR for image restoration based on the Swin Transformer."
- 第二審査: 妥当。引用側の要旨「we propose a strong baseline model SwinIR for image restoration based on the Swin Transformer」がそのまま根拠

### R8. `extends`: 「An Image is Worth 16x16 Words: Transformers for Image Recognition at Scale」(2020) → 「When Shift Operation Meets Vision Transformer: An Extremely Simple Alternative to Attention Mechanism」(2022)

- 意味: 引用側（新しい論文）が被引用側の手法を土台にして拡張している
- 辺: `openalex:W3094502228` → `openalex:W4226028923`
- 分類: foundational_allowlist、確信度 0.65
- 根拠: 基礎文献リスト（引用文なし）
- 理由欄: 「When Shift Operation Meets Vision Transformer: An Extremely…」(2022) は分野の基礎文献「An Image is Worth 16x16 Words: Transformers for Image Recog…」(2020)を引用しており、その系譜に連なるものとして拡張関係で残している（基礎文献リストに基づく規則）。
- 第二審査: 妥当。基礎文献リストの規則（引用文なし）。ShiftViT は ViT（と Swin）の注意を shift 演算に置き換える変種で、extends で妥当

### R9. `extends`: 「An Image is Worth 16x16 Words: Transformers for Image Recognition at Scale」(2020) → 「Swin Transformer V2: Scaling Up Capacity and Resolution」(2022)

- 意味: 引用側（新しい論文）が被引用側の手法を土台にして拡張している
- 辺: `openalex:W3094502228` → `openalex:W4312349930`
- 分類: foundational_allowlist、確信度 0.65
- 根拠: 基礎文献リスト（引用文なし）
- 理由欄: 「Swin Transformer V2: Scaling Up Capacity and Resolution」(2022) は分野の基礎文献「An Image is Worth 16x16 Words: Transformers for Image Recog…」(2020)を引用しており、その系譜に連なるものとして拡張関係で残している（基礎文献リストに基づく規則）。
- 第二審査: **要確認**。基礎文献リストの規則（引用文なし）。Swin V2 の直接の土台は Swin（別の辺で supersedes）で、ViT からは間接的。ViT 系の拡張として extends は許容できるが根拠は弱い

### R10. `extends`: 「An Image is Worth 16x16 Words: Transformers for Image Recognition at Scale」(2020) → 「Reversible Vision Transformers」(2022)

- 意味: 引用側（新しい論文）が被引用側の手法を土台にして拡張している
- 辺: `openalex:W3094502228` → `openalex:W4312777001`
- 分類: s2_context_rule、確信度 0.8
- 根拠: arXiv HTML 本文の引用文（[確認](https://arxiv.org/html/2302.04869v1)）
- 引用文: “Following ViT [15], we use the Multi-head attention and the MLP sublocks as functions F and G respectively.”
- 理由欄: 「Reversible Vision Transformers」(2022) は 「An Image is Worth 16x16 Words: …」(2020) を土台にしている（arXiv HTML（arXiv:2302.04869v1）の本文の引用文から規則で判定）。引用文: "Following ViT [15], we use the Multi-head attention and the MLP sublocks as functions F and G respectively."
- 第二審査: 妥当。arXiv HTML の引用文「Following ViT [15], we use the Multi-head attention and the MLP sublocks as functions F and G」。可逆構造への ViT の拡張

### R11. `extends`: 「Swin Transformer: Hierarchical Vision Transformer using Shifted Windows」(2021) → 「Video Swin Transformer」(2022)

- 意味: 引用側（新しい論文）が被引用側の手法を土台にして拡張している
- 辺: `openalex:W3138516171` → `openalex:W4312560592`
- 分類: s2_context_rule、確信度 0.8
- 根拠: Semantic Scholar の引用文（[確認](https://api.semanticscholar.org/graph/v1/paper/DOI:10.1109/cvpr52688.2022.00320?fields=title,year,authors,externalIds)）
- 引用文: “As our architecture is adapted from Swin Transformer [28], our model can be initialized by its strong pre-trained model on a large-scale dataset.”
- 理由欄: 「Video Swin Transformer」(2022) は 「Swin Transformer」(2021) を土台にしている（Semantic Scholar の引用文・引用の意図から規則で判定）。引用文: "As our architecture is adapted from Swin Transformer [28], our model can be initialized by its strong pre-trained model on a large-scale dataset."
- 第二審査: 妥当。引用文「As our architecture is adapted from Swin Transformer [28]」がそのまま根拠

### R12. `extends`: 「Swin Transformer: Hierarchical Vision Transformer using Shifted Windows」(2021) → 「Swin-Unet: Unet-Like Pure Transformer for Medical Image Segmentation」(2023)

- 意味: 引用側（新しい論文）が被引用側の手法を土台にして拡張している
- 辺: `openalex:W3138516171` → `openalex:W4321232185`
- 分類: s2_context_rule、確信度 0.8
- 根拠: Semantic Scholar の引用文（[確認](https://www.semanticscholar.org/arxiv/2105.05537)）
- 引用文: “Motivated by the Swin Transformer’s [19] success, we propose Swin-Unet to leverage the power of Transformer for 2D medical image segmentation in this work.”
- 理由欄: 「Swin-Unet」(2023) は 「Swin Transformer」(2021) を土台にしている（Semantic Scholar の引用文・引用の意図から規則で判定）。引用文: "Motivated by the Swin Transformer’s [19] success, we propose Swin-Unet to leverage the power of Transformer for 2D medical image segmentation in this work."
- 第二審査: 妥当。引用文「Motivated by the Swin Transformer’s [19] success, we propose Swin-Unet」。Swin のブロックで U-Net を作っており extends で妥当

### R13. `supersedes`: 「Swin Transformer: Hierarchical Vision Transformer using Shifted Windows」(2021) → 「Swin Transformer V2: Scaling Up Capacity and Resolution」(2022)

- 意味: 引用側が被引用側を置き換える新版（同じ系列の改訂版）である
- 辺: `openalex:W3138516171` → `openalex:W4312349930`
- 分類: title_version、確信度 0.7
- 根拠: 題名の版（引用文なし）
- 理由欄: 「Swin Transformer V2: Scaling Up Capacity and Resolution」(2022) は「Swin Transformer: Hierarchical Vision Transformer using Shi…」(2021) のバージョンアップ版にあたり、命名パターンから置き換え (supersedes) と推定される。
- 第二審査: 妥当。同じ著者による Swin の V2（題名の版の規則）。supersedes で妥当

