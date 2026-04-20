# 5. プロダクト企画

## 5.1 コンセプト
**PaperPilot — 研究者のための論文自動収集パイプライン**
キーワードを登録するだけで、arXiv・Semantic Scholar・OpenAlexから最新論文を自動収集。学会採択ステータス・GitHub Stars・引用速度などの品質シグナルに基づいてスコアリングし、本当に読むべき論文だけをCSV/Slack/メールで毎日届ける。
## 5.2 5段階フィルタリングパイプライン
500件の生データを10件の高品質論文に絞り込む、コスト効率の高い5段階ファネル設計。上流は高速・低コスト、下流は高精度。

| Stage | 処理内容 | 残り件数 | コスト |
|---|---|---|---|
| Stage 0: 収集 | arXiv/S2/OpenAlexからの生データ取得 | 500件 | ¥0 |
| Stage 1: ルールベース | カテゴリ・日付・除外ワード・差分フィルタ | 200件 | ¥0 |
| Stage 2: メトリクス | 学会採択・GitHub Stars・引用速度・著者h-index・キーワード一致 | 80件 | ¥0 |
| Stage 3: Embedding | SPECTER2で研究テーマとの類似度計算 | 30件 | ¥0〜500 |
| Stage 4: LLM | 関連度判定・日本語要約・読むべき理由の生成 | 10件 | ¥900/月 |

## 5.3 品質シグナルの詳細設計
論文の品質を判定するために、以下のシグナルを統合スコアとして活用する。
### 5.3.1 学会採択ステータス（重み×3.0 — 最重要）
査読を通過した論文は、専門家が品質を保証済みであり、arXiv上の未査読プレプリントとは信頼性が段違いである。

| ティア | 対象 | スコア | 取得方法 |
|---|---|---|---|
| Tier 1 | NeurIPS, ICML, ICLR | 100点 | OpenReview API（公式） |
| Tier 2 | AAAI, CVPR, ACL, EMNLP | 80点 | arXivコメント欄の正規表現パース |
| Tier 3 | AISTATS, NAACL, ECCV, ICCV | 60点 | Semantic Scholar API（venue情報） |
| Workshop | 各学会Workshop採択 | 30点 | arXivコメント欄 |
| 未査読 | arXivプレプリントのみ | 0点 | — |

取得ルートは3つ。arXiv APIのcommentフィールドに「Accepted at ICLR 2026」等が記載されるケースが最も手軽で、正規表現のみで検出可能。OpenReview APIではICLR/NeurIPS/ICMLの採択リストを公式データとして取得可能。Semantic Scholar APIのvenue/publicationVenueフィールドでも掲載先を確認できる。
### 5.3.2 GitHub Stars / コード公開（重み×2.0）
コードが公開されている論文は再現性が高く実用価値が高い。Stars数は実務コミュニティからの評価を反映する。

| ランク | Stars数 | スコア | 取得方法 |
|---|---|---|---|
| バズ論文 | 1,000+ | 100点 | Papers with Code API → GitHub API |
| 注目実装 | 100-999 | 70点 | 同上 |
| 一定の注目 | 10-99 | 40点 | 同上 |
| コード公開 | 1-9 | 20点 | 同上 |
| 未公開 | 0 | 0点 | — |

Papers with Code APIでarXiv IDからリンクされたGitHubリポジトリを取得し、GitHub APIでリアルタイムのStar数を取得する。公式リポジトリかどうかのフラグも利用可能。Star数に加え「Star Velocity（1日あたりの獲得数）」を算出すると、公開直後の論文でも注目度を測定できる。
### 5.3.3 統合スコア計算式
**total_score = venue_score × 3.0 + github_score × 2.0 + citation_velocity × 1.5 + author_score × 1.0 + social_buzz × 1.0 + keyword_match × 0.5 + embedding_sim × 2.5**
各シグナルを0〜100に正規化した上で重み付け合算する。例えば「ICLR採択（300点）+ GitHub 500 Stars（約140点）」の論文は合計440点以上となり、未査読・コード無し（0点）の論文との差は圧倒的である。重みはYAML設定で自由に調整可能。
## 5.4 技術スタック

| レイヤー | 技術 | 理由 |
|---|---|---|
| 言語 | Python 3.12+ | 学術APIライブラリが豊富 |
| 論文API | arXiv / Semantic Scholar / OpenAlex | すべて無料・高品質 |
| 品質API | Papers with Code / GitHub / OpenReview | 無料で品質シグナル取得可能 |
| LLM | Claude API（Anthropic） | 日本語性能が最も高い |
| Embedding | SPECTER2 / SciBERT | 学術論文特化モデル |
| スケジューラ | GitHub Actions / cron | 無料で定期実行 |
| UI (Phase 3) | Streamlit | Pythonのみで構築可能 |

## 5.5 差別化ポイント

| 観点 | Elicit等の既存SaaS | PaperPilot |
|---|---|---|
| 実行環境 | クラウドのみ | ローカル / 自サーバー / GitHub Actions |
| 定期収集 | Pro ($49/月) 以上で限定的 | 無料（cron / GitHub Actions） |
| 品質フィルタ | venue情報は表示するが自動スコアリングに未統合 | 学会採択×3.0 + GitHub Stars×2.0の統合スコアで自動ランキング |
| データソース | 主にSemantic Scholar | arXiv + S2 + OpenAlex + PwC統合 |
| 日本語対応 | なし | LLMによる日本語要約 |
| カスタマイズ | 制限あり | YAML設定で自由に変更 |
| コスト | $12〜$79/月 | ¥0〜¥1,500/月 |
| OSS | 非公開 | MIT License |