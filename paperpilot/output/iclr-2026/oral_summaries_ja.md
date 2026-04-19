# ICLR 2026 Oral 採択論文 16 本 — 日本語要約

開催: 2026年4月23-27日 @ Rio de Janeiro, Brazil
ソース: arXiv 上で "ICLR 2026 Oral" と明記された論文（自動抽出 + 人手要約）

---

## 1. Through the Lens of Contrast: Self-Improving Visual Reasoning in VLMs

**著者**: Zhiyu Pan, Yizheng Wu, Jiashen Hua 他
**リンク**: http://arxiv.org/abs/2603.02556v1
**タグ**: `VLM` `self-improvement` `視覚推論`

### 要約（3行）
- **問題**: VLM の self-improvement は視覚幻覚を検証できず精度が上がらない。
- **手法**: 類似画像×同義質問のコントラスト対を使い、幻覚を抑えた論理展開を生成する VC-STaR を提案。55K 件のデータセット VisCoR-55K を公開。
- **結果**: 複数 VLM で SFT すると視覚推論精度が顕著に向上。

### 読むべき理由
VLM の訓練データ自動生成の定番手法になりうる。**データセット VisCoR-55K が公開予定** なので再現性も高い。

---

## 2. InfoNCE Induces Gaussian Distribution

**著者**: Roy Betser, Eyal Gofer, Meir Yossef Levi, Guy Gilboa
**リンク**: http://arxiv.org/abs/2602.24012v1
**タグ**: `contrastive learning` `理論` `表現学習`

### 要約（3行）
- **問題**: 対照学習の InfoNCE 損失で学習した表現が経験的に Gaussian になる理由が未解明。
- **手法**: アラインメント・集中条件下で InfoNCE 表現が多変量 Gaussian に漸近収束することを理論証明。弱い条件下では低ノルム+高エントロピー正則化の追加で同様の漸近結果。
- **結果**: CIFAR-10 等で複数エンコーダ・規模を横断して実証。

### 読むべき理由
**理論的美しさ**。self-supervised learning の表現が Gaussian であることの原理的説明 → 下流タスクの解析・設計に直結する重要な礎石。

---

## 3. Decentralized Attention Fails Centralized Signals: Rethinking Transformers for Medical Time Series

**著者**: Guoqi Yu, Juncheng Wang, Chen Yang, Jing Qin, Angelica I. Aviles-Rivero
**リンク**: http://arxiv.org/abs/2602.18473v1
**タグ**: `医療` `時系列` `Transformer批判`

### 要約（3行）
- **問題**: EEG/ECG 等の医療時系列は「中央集権的」な波形を持つが、Transformer の分散 attention はこれを捉えにくい構造的ミスマッチ。
- **手法**: 全トークンを直接交わらせず、**中心 core token を中継** させる CoTAR（MLP ベース）を提案し attention を置換。
- **結果**: 医療時系列で SOTA。

### 読むべき理由
「Transformer が何にでも最適ではない」という興味深い反例。医療AI 分野の実用ベースライン転換になり得る。

---

## 4. FlashVID: Efficient Video Large Language Models via Training-free Tree-based Spatiotemporal Token Merging

**著者**: Ziyang Fan, Keyu Chen, Ruilong Xing, Yulin Li, Li Jiang
**リンク**: http://arxiv.org/abs/2602.08024v1
**タグ**: `Video LLM` `高速化` `training-free`

### 要約（3行）
- **問題**: Video LLM は大量の visual token で推論コストが膨大。空間・時間を独立に圧縮する既存手法は劣化が大きい。
- **手法**: **訓練不要** の FlashVID を提案。ADTS で代表 token 選択 → 木構造 TSTM で時空間冗長除去。
- **結果**: **visual token を 10% に削減しても性能維持**、5 ベンチマーク×3 VLLM で効果実証。

### 読むべき理由
training-free で即導入可能。Video LLM を実運用するチーム必読。

---

## 5. Pareto-Conditioned Diffusion Models for Offline Multi-Objective Optimization

**著者**: Jatan Shrestha, Santeri Heiskanen, Kari Hepola 他
**リンク**: http://arxiv.org/abs/2602.00737v2
**タグ**: `Diffusion` `多目的最適化` `offline`

### 要約（3行）
- **問題**: オフライン多目的最適化（MOO）は静的データセットのみから未知のトレードオフを探索する必要あり。
- **手法**: PCD — 希望トレードオフで条件付けする拡散モデルで、サロゲート不要。reweighting + reference-direction でパレート前線探索。
- **結果**: 標準 offline MOO ベンチで既存手法と同等以上かつ**タスク間での一貫性が高い**。

### 読むべき理由
材料探索・薬剤設計・ハードウェア設計等の実応用に直結。

---

## 6. Discount Model Search for Quality Diversity Optimization in High-Dimensional Measure Spaces

**著者**: Bryon Tjanaka, Henry Chen, Matthew C. Fontaine, Stefanos Nikolaidis
**リンク**: http://arxiv.org/abs/2601.01082v4
**タグ**: `QD最適化` `進化計算` `高次元`

### 要約（3行）
- **問題**: Quality Diversity (QD) 最適化は低次元尺度に限定。SOTA の CMA-MAE もヒストグラム依存で高次元で崩壊。
- **手法**: **Discount Model Search (DMS)** — ヒストグラムを smooth/連続モデルに置き換え、高次元尺度空間でも探索継続可能に。
- **結果**: 新規 2 ドメインを導入し DMS の新しい QD 能力を実証。

### 読むべき理由
ロボット制御・ゲーム AI で扱える「多様性」の次元数が飛躍的に広がる。

---

## 7. In-Place Test-Time Training

**著者**: Guhao Feng, Shengjie Luo, Kai Hua, Ge Zhang, Di He (ByteDance)
**リンク**: http://arxiv.org/abs/2604.06169v1
**タグ**: `LLM` `test-time` `ByteDance`

### 要約（3行）
- **問題**: 従来 LLM は "train then deploy" で、推論時に新情報を取り込めない。既存の TTT も LLM への適用は計算・目的の不整合で困難。
- **手法**: MLP 最終射影行列を "fast weights" として使う **In-Place TTT** を提案。Next-Token-Prediction に整合する理論的根拠のある目的関数 + chunk-wise 更新で効率化。
- **結果**: LLM への "drop-in" 強化が可能、再訓練不要。

### 読むべき理由
**ByteDance 発** の Oral。継続学習・ドメイン適応のパラダイム転換候補。コード公開あり。

---

## 8. Scaling Atomistic Protein Binder Design with Generative Pretraining and Test-Time Compute

**著者**: Kieran Didi, Zuobai Zhang, Guoqing Zhou 他 (NVIDIA)
**リンク**: http://arxiv.org/abs/2603.27950v1
**タグ**: `タンパク質設計` `拡散` `NVIDIA`

### 要約（3行）
- **問題**: 構造ベースの de novo タンパク質結合子（binder）設計は「条件付き生成」か「hallucination」かで分断されてきた。
- **手法**: **Proteina-Complexa** — 両者を統一。合成 binder-target の大規模データ Teddymer で事前学習、実多量体で高品質化、推論時に test-time 最適化。
- **結果**: 計算ベンチマークで SOTA 達成、in-silico 成功率大幅向上。

### 読むべき理由
**NVIDIA の創薬分野参戦**。実験室レベルに近い成果を計算で出す試み。

---

## 9. On the Generalization Capacities of MLLMs for Spatial Intelligence

**著者**: Gongjie Zhang, Wenhao Li, Quanhao Qian, Jiuniu Wang, Deli Zhao
**リンク**: http://arxiv.org/abs/2603.06704v1
**タグ**: `MLLM` `3D` `空間推論`

### 要約（3行）
- **問題**: 3D 位置推定・ナビゲーション MLLM は RGB 入力のみで、カメラパラメータ無視により訓練カメラ分布に過適合。
- **手法**: Camera-Aware MLLM — カメラ内部パラメータ埋め込み注入 + データ拡張で分布ずらし + 3D foundation model から幾何事前知識を蒸留。
- **結果**: クロスカメラ汎化で既存手法を大幅に上回る。

### 読むべき理由
**ロボティクス・AR/VR** の基礎になる重要知見。「カメラ忘れるな」という地味だが強力な教訓。

---

## 10. Distributional Equivalence in Linear Non-Gaussian Latent-Variable Cyclic Causal Models

**著者**: Haoyue Dai, Immanuel Albrecht, Peter Spirtes, Kun Zhang (CMU)
**リンク**: http://arxiv.org/abs/2603.04780v1
**タグ**: `因果推論` `理論` `潜在変数`

### 要約（3行）
- **問題**: 潜在変数を含む因果発見は強い構造仮定に頼りがち。任意構造での同値性理論が未整備。
- **手法**: 線形非ガウシアン設定で、**任意の潜在構造+巡回を含むグラフ同士の分布同値性** を edge rank 制約で特徴づけ、同値類を走査するアルゴリズムと同定手順を提案。
- **結果**: パラメトリック設定で潜在変数付き初の構造仮定なし同値性特徴づけ。

### 読むべき理由
因果発見の理論ブレイクスルー。**CMU の大御所 Spirtes + Kun Zhang** の Oral。

---

## 11. Latent Particle World Models: Self-supervised Object-centric Stochastic Dynamics Modeling

**著者**: Tal Daniel, Carl Qi, Dan Haramati, Amir Zadeh, Chuan Li
**リンク**: http://arxiv.org/abs/2603.04553v1
**タグ**: `世界モデル` `object-centric` `自己教師` `ロボット`

### 要約（3行）
- **問題**: 実世界のマルチオブジェクト動画からの世界モデルは監督コストが高く、意思決定に使いにくい。
- **手法**: **LPWM** — 動画のみで end-to-end 学習、keypoint/bbox/マスクを自動発見。潜在行動モジュールで確率的パーティクル動力学を学習。
- **結果**: 確率動画モデリングで SOTA、目標条件付き模倣学習にも適用可能。

### 読むべき理由
世界モデル × object-centric × 実世界動画で動く希少な研究。ロボティクス応用に直結。

---

## 12. Radiometrically Consistent Gaussian Surfels for Inverse Rendering

**著者**: Kyu Beom Han, Jaeyoon Kim, Woo Jae Kim, Jinhwan Seo, Sung-eui Yoon
**リンク**: http://arxiv.org/abs/2603.01491v1
**タグ**: `3D` `Gaussian Splatting` `inverse rendering`

### 要約（3行）
- **問題**: Gaussian Splatting による inverse rendering は、間接照明の monitor が unobserved view に対し監督を持たず劣化。
- **手法**: **RadioGS** — 未観測 view でも Gaussian の学習 radiance と物理レンダリング結果の残差最小化（radiometric consistency）で自己補正。
- **結果**: 間接反射を含む material/照明分離の精度が向上。

### 読むべき理由
NeRF/3DGS 系の実用応用（素材分離・relighting）に直接効く。

---

## 13. RAIN-Merging: Instruction Following in Large Reasoning Models with Preserved Thinking Format

**著者**: Zhehao Huang, Yuhang Liu, Baijiong Lin, Yixin Lou, Zhengbao He
**リンク**: http://arxiv.org/abs/2602.22538v1
**タグ**: `LRM` `モデルマージ` `指示追従`

### 要約（3行）
- **問題**: Large Reasoning Model は長い推論はできるが指示フォーマット順守が弱い。instruction-tuned モデル (ITM) との merge は thinking/answer 区分崩壊でナイーブには失敗。
- **手法**: **RAIN-Merging** — ITM task vector を thinking トークンの null space に射影 → 推論機構を保持。calibration セットで instruction attention を推定して integration。
- **結果**: **勾配不要** で指示追従を強化、推論性能維持。

### 読むべき理由
o1-like / DeepSeek-R1-like LRM を用いる現場で即使える実用技法。

---

## 14. P-GenRM: Personalized Generative Reward Model with Test-time User-based Scaling

**著者**: Pinyi Zhang, Ting-En Lin, Yuchuan Wu, Jingyang Chen, Zongqi Wang
**リンク**: http://arxiv.org/abs/2602.12116v1
**タグ**: `RLHF` `個人化` `Reward Model`

### 要約（3行）
- **問題**: 個人化 RM は①評価基準の単純化、②新規ユーザーへの汎化の弱さ、が課題。
- **手法**: **P-GenRM** — 好みを構造化された評価チェーンに変換、ユーザー prototype でクラスタリング、個人+prototype の2段スケーリング。
- **結果**: 既存 personalized RM を上回る SOTA。新規ユーザー汎化も改善。

### 読むべき理由
ChatGPT 等の personalization レイヤー設計の基礎技術。

---

## 15. Monocular Normal Estimation via Shading Sequence Estimation (RoSE)

**著者**: Zongrui Li, Xinhua Ma, Minghui Hu 他
**リンク**: http://arxiv.org/abs/2602.09929v5
**タグ**: `3D` `法線推定` `生成モデル転用`

### 要約（3行）
- **問題**: 単眼 RGB からの法線推定は「見た目は正しいが 3D 不整合」に陥りがち。
- **手法**: **RoSE** — 法線予測を「shading sequence 推定」に再定義し、image-to-video 生成モデルで shading 動画を予測、最小二乗法で法線化。
- **結果**: 合成データ + 実物で高精度な法線を獲得。

### 読むべき理由
**動画生成モデルを 3D 幾何推論に転用** という発想の Oral。汎用視覚モデルの転用法の好例。

---

## 16. Coupling Experts and Routers in Mixture-of-Experts via an Auxiliary Loss

**著者**: Ang Lv, Jin Ma, Yiyuan Ma, Siyuan Qiao
**リンク**: http://arxiv.org/abs/2512.23447v2
**タグ**: `MoE` `LLM` `補助損失`

### 要約（3行）
- **問題**: MoE の router の判断と expert の実能力が整合する保証がなく性能を制限。
- **手法**: **ERC (Expert-Router Coupling) loss** — 各 expert の router embedding を proxy token として扱い、摂動後の activation で ①expert は自分の proxy に最強反応、②proxy は対応 expert から最強反応、を強制。
- **結果**: 計算は $n^2$（n=expert数、バッチ非依存）の定数コスト。

### 読むべき理由
**DeepSeek/Qwen/Mixtral 系**の MoE LLM をさらに強化する補助損失。軽量で導入しやすい。

---

## 総評

### トピック別注目度
- **LLM強化系**: #7 In-Place TTT, #13 RAIN-Merging, #16 ERC loss (全てすぐ試せる系)
- **理論**: #2 InfoNCE Gaussian, #10 因果同値性
- **3D/視覚**: #9 カメラaware MLLM, #12 RadioGS, #15 RoSE
- **応用**: #8 NVIDIA タンパク質, #3 医療時系列, #4 FlashVID

### 私の推し Top 3
1. **#8 Scaling Atomistic Protein Binder Design** (NVIDIA) — 創薬の計算パラダイム
2. **#2 InfoNCE Induces Gaussian Distribution** — 理論的美しさ
3. **#7 In-Place Test-Time Training** (ByteDance) — 即実装したくなる手法

---

*生成: 2026-04-18 by Claude Code via PaperPilot*
*ソース: [paperpilot/output/iclr-2026/papers_2026-04-18.json](./papers_2026-04-18.json)*
