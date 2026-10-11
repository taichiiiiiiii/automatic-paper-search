# 51 ライセンス・規約・コンプライアンス調査（2026-10-11）

対象：PaperPilot（https://paperpilot.pages.dev 、日本在住の個人が運営する公開・無料・非営利サイト）
観点：利用している（または利用する可能性がある）API・データソースの規約とライセンス、日本の著作権法（引用・要旨の表示）、サイトに必要な表示、削除依頼への対応、プライバシー。
方法：公式の規約・ドキュメントを読んだ（アクセス日はすべて **2026-10-11**）。本番サイトはヘッドレスブラウザで読み取りのみ行い、フォームは送信していない。リポジトリ（リポジトリ）は読み取りのみで、変更していない。
**この文書は法的助言ではない。** 「要確認」「不確実」と書いた箇所は、弁護士など専門家の確認か、提供元への問い合わせが必要。

---

## 0. 結論（先に）

1. **最大のギャップは学会カタログの要旨全文（28,300 本）**。テーマ系譜の引用文より大きい。
   - カタログは 10 学会分の要旨を**全文**で表示している。リポジトリ（公開）の `data/published/*/papers.json` にも同じ要旨が入っている。
   - 出どころとライセンスは次のとおり：arXiv 1,258 本（CC0）、OpenReview 13,894 本（メタデータは CC0）、ACL Anthology 3,508 本（CC BY 4.0、**帰属表示が必須**）、**CVF Open Access 9,640 本（CVPR 2025/2026・ICCV 2025。「Copyright and all rights therein are retained by authors」で、ライセンスの付与なし）**。
   - CVF の要旨を全文で載せることは、どのライセンスでも許諾されていない。引用（32 条）にも当たりにくい。表示の主役が要旨そのもので、主従関係が成り立たないため。
   - **対応案（推奨）**：CVF 分は次のいずれかにする。
     - (a) arXiv 版の要旨（CC0）に差し替える。
     - (b) S2 TLDR（ODC-BY）＋原典リンクにする。
     - (c) 冒頭の短い抜粋（1〜2 文）＋原典リンクにする（47 条の 5 の「軽微利用」で説明する余地はあるが、要確認）。
2. **ACL Anthology（CC BY 4.0）の帰属表示がサイトにない**。必要なのは、著者・題名・ライセンス名とリンク・改変の有無（要旨の省略など）。フッターの「データ: arXiv / Semantic Scholar / OpenAlex」には、OpenReview・CVF・ACL Anthology が入っていない。
3. **Semantic Scholar（S2）の帰属表示は概ね満たしている**。「仕組み」の #credits に、ODC-BY 1.0、Kinney et al. 2023、Cohan et al. 2019 の記載がある。引用文には「出典: Semantic Scholar（引用文脈、〈論文名〉より 1 文を引用）」と原典リンクが付いている。
   - 不足 1：**公開している JSON**（`lineage.json`、`papers.json`、`paper-details-v1/*.json`）と **GitHub リポジトリ**（`data/state/lineage-cache/` に S2 の生応答が 473 ファイル・49 MB、`data/published/`）に、ODC-BY のライセンス表示（§4.2 の notice）がない。
   - 不足 2：リポジトリに `LICENSE` も `NOTICE` もない（`gh repo view` の licenseInfo は null）。
4. **引用文（S2 contexts）の表示は、32 条の 4 要件にほぼ沿っている**。残る改善点は次の 3 つ。
   - (i) 文の途中から始まる抜粋に「…」を付ける。実例：「“istance and angular distance …”」が語の途中から始まっている。
   - (ii) 出典に**著者名**を加える。48 条 2 項は、著作者名が表示されている著作物ではその著作者名を示すことを求めている。
   - (iii) 系譜ノードの要旨・TLDR が**別の論文のもの**になっている例がある。Flash Attention テーマの「Longformer」ノードに LLM 時代の別論文の要旨が表示されていて、出所の表示として誤っている。
5. **削除依頼の窓口が GitHub Issue だけ**。GitHub アカウントのない著者は依頼できない。また、個人情報に関する依頼を公開の Issue で受けるのは不適切。非公開の連絡手段（メールかフォーム）と、手順（受付 → 一時非表示 → 判断 → 記録）を明記する必要がある。
6. **プライバシーポリシーがない**。
   - サイトが扱っている個人に関する情報：著者名（検索の対象）、テーマ依頼時の IP アドレス（Durable Object に生の IP を最大 1 時間保持）、Workers Logs（observability が有効。保持は Free 3 日 / Paid 7 日）、localStorage（`pp.theme.prefs.v2`）。
   - **依頼したテーマ名は公開リポジトリの Actions の実行入力として公開される**。
   - 個人情報保護法の上では「事業」に営利・非営利を問わない（PPC Q&A 1-54）。そのため、個人運営でも個人情報取扱事業者に当たる可能性がある。少なくとも利用目的の公表と、問い合わせ窓口の設置を推奨する。
7. **規約上の禁止・制限で注意するもの**。
   - S2：キーを他人に開示しない。レート制限を回避しない。
   - arXiv：全マシン合算で 3 秒に 1 回、同時接続 1。PDF やソースを自サーバーから配信しない。公認されているように見せない。
   - OpenAlex：Web サイトのスクレイピングは遮断される。API を使う。
   - Crossref：public は 5 rps / 同時 1、polite は 10 rps / 同時 3。**design 44 の「polite 同時 5」は誤りで、3 に直す**。
   - CORE：PaperPilot のような「検索・発見システム」は、CORE に連絡してライセンスを得る必要がある → **使わないのが無難**。
   - DeepL API Free：入力と訳文を DeepL が**無期限に保存できる**（規約 §3.3.3）。

---

## 1. 現在のサイトの確認結果（2026-10-11、読み取りのみ）

| 場所 | 現状 | 評価 |
|---|---|---|
| フッター（全ページ） | 「Built by PaperPilot / 仕組み / GitHub / 出典とライセンス（→ /how-it-works/#credits）/ データ: arXiv / Semantic Scholar / OpenAlex（各公式サイトへのリンク）」 | S2 規約 §4 の最低限は満たす。**OpenReview・CVF・ACL Anthology の記載がない**。プライバシーポリシー・免責・連絡先へのリンクもない。 |
| 仕組み #credits「出典とライセンス」 | 次の 4 点を記載。<br>・S2 データ（参考文献、引用文脈、意図、重要度）は ODC-BY 1.0。Kinney et al. 2023、Cohan et al. 2019。<br>・引用文は 1 文・約 300 字、引用符付き、出典 S2 と論文リンクを付け、本文や PDF は再配布しない。<br>・OpenAlex（CC0）への謝辞。「Thank you to arXiv for use of its open access interoperability.」と、非公式・非承認であることの表明。<br>・削除依頼は GitHub Issue。 | 方針としてはよい。ただし学会カタログの要旨（arXiv・OpenReview・ACL・CVF）についての記載がない。ODC-BY のリンクはある。 |
| 仕組みの本文 | 「新しい論文の要旨が相手を名指しする 1 文も根拠にする（出典は『新しい論文の要旨』と表示）」と記載 | 要旨からの 1 文も引用として扱う必要がある（§4）。「いまの構成は設計書 39 番」という記述は、39 が削除済みなので古い（リンクはない）。 |
| テーマの関係一覧 →「根拠を表示」 | 「“…引用文…”」と「出典: Semantic Scholar（引用文脈、〈論文名〉より 1 文を引用）」、arXiv・S2 へのリンク | 32 条の明瞭区別と出所明示の形はできている。**冒頭の省略記号と著者名がない**。 |
| 系譜ノード | 題名、著者、被引用数、英語の要旨または TLDR の冒頭（約 140 字で「…」切り） | 短い抜粋なので、リスクは低い。**Longformer に別論文の要旨が付いている（データの誤り）**。 |
| 学会カタログ（`/<conf>/?paper=…`） | **要旨の全文**と、タグ・arXiv・PDF へのリンク | CVF 分が最大のリスク（§0-1）。**CVF・ACL・OpenReview へのリンクにも「arXiv」というラベルが付いている**（出所の表示が誤り）。 |
| テーマ依頼フォーム | 英数字 2〜80 字で「生成する」。Worker → GitHub workflow_dispatch | 入力が公開されることの注記がなく、プライバシーの説明もない。 |
| 外部への送信 | 第三者の JS・解析タグ・Cookie なし（Pages 同一オリジンの静的ファイルのみ）。localStorage に表示設定を保存 | よい。外部送信の規律（電気通信事業法）の面でもリスクは低い（§6）。 |
| リポジトリ（PUBLIC） | `LICENSE` なし。`data/published`（要旨・引用文入りの JSON）、`data/state/lineage-cache`（S2 の生応答 49 MB）、`data/inputs/*`（CSV、要約 md） | ODC-BY の notice がない。CVF の要旨を全文で再配布している。コードのライセンスも未定。 |

---

## 2. データソース別の規約・ライセンス

| ソース | 利用状況 | データのライセンス | 帰属・表示義務 | レート制限・鍵・禁止事項 | PaperPilot の対応状況 / 必要な対応 | 出典（2026-10-11 アクセス） |
|---|---|---|---|---|---|---|
| **Semantic Scholar API** | 参考文献、contexts、intents、isInfluential、TLDR、paperId、被引用数 | API License Agreement（2023-05-17 版）§1：S2 Data に「アクセスし表示する」ための限定ライセンス。§2：S2 Data は付随するライセンス（CC BY-NC または ODC-BY）に従い、**第三者コンテンツは権利者の条件にも従う**。Datasets（papers、abstracts、citations、tldrs）は README 上いずれも **ODC-BY**（2026-10-06 版で確認）。 | §4：Web サイトに「Semantic Scholar」と帰属表示する（必須）。学術論文では Kinney et al. を引用。S2 のロゴを使う場合はブランド規定に従う。ODC-BY §4.3：Produced Work（サイトの表示）にも「Contains information from … ODC Attribution License」相当の notice が必要。§4.2：データベースや派生データベースを公開で配布する場合は、ライセンスの URI を**データの中と文書の両方**に入れる。 | §1.1：キーは許可された者以外に開示しない（GitHub Secret ならよい。フォークや Issue に貼らない）。§5.1：レート制限を超えない・回避しない。§6：API の再販・再配布・サブライセンスの禁止、法的表示の除去の禁止、過剰リクエストの禁止。§3.1：利用統計を AI2 が収集する。準拠法はワシントン州。 | 表示 ◎（#credits）。**JSON・リポジトリの ODC-BY notice ×**。キャッシュは規約上禁止されていない（再配布は ODC-BY で可、要帰属）。生応答 49 MB の公開は「API の再配布」ではないと解するが、**念のため公開の必要性を再検討（private 化、`.gitignore` 化、または Actions cache への移動）**。TLDR は S2 の ML 生成文なので、その旨を表示する（design 46 D1）。 | https://www.semanticscholar.org/product/api/license ; https://api.semanticscholar.org/datasets/v1/release/latest ; https://opendatacommons.org/licenses/by/1-0/ |
| **OpenAlex** | シード検索、ID、書誌情報、keywords、topics、（抄録） | データは **CC0**（「no 'personal use only' carve-out」） | 法的義務なし。謝辞は推奨（掲載済み）。 | 2026-02 から API キーが実質必須。無料 $1/日。Web サイトを自動でアクセスすると「Looks like you're a bot」で遮断される（実測）→ **API だけを使う**。 | ◎。抄録を転置インデックスで配布していることについて、「法的理由」とする公式文言は今回再確認できなかった（**要確認**）。抄録の著作権は CC0 宣言でも著者に残りうるので、要旨としての扱いは §4 に従う。 | https://help.openalex.org/access/pricing/ ; https://openalex.org/terms（bot 遮断で読めず） |
| **arXiv API / e-print** | 新着、要旨、メタデータ、`.bbl`（fallback 案） | ToU：**descriptive metadata（title、abstract、authors、identifiers、classification を含むと脚注で明記）は CC0 1.0**。e-print 本体は著作権の対象で、多くは非独占配布ライセンス。License ページ：「CC0 … will apply to all metadata」。 | 義務なし。「arXiv に公認・支援されているように見せない」こと。謝辞の定型文（掲載済み）は現行 ToU では必須ではないが、残して問題ない。 | **全マシン合算で 3 秒に 1 回、同時接続 1**。台数を増やして回避しない。他人の資格情報は使わない。**PDF やソースを自サーバーから保存・配信しない**（`.bbl` の解析結果を使うのはよいが、ファイルを公開リポジトリに置かない）。引用グラフの作成は「してよいこと」に明記されている。 | ◎。`.bbl` を導入する場合、`fa1src/*.bbl` のような原ファイルを公開しないこと。Actions の並列ジョブでも合算で 3 秒間隔を守る。 | https://info.arxiv.org/help/api/tou.html ; https://info.arxiv.org/help/license/index.html |
| **OpenReview**（ICLR、ICML、NeurIPS のカタログ） | 題名、著者、**要旨全文**、PDF リンク | ToU「Metadata Dedication」：投稿者または OpenReview が metadata（title、Authors、**abstract** を含むと定義）に著作権を持つ範囲で **CC0 1.0** | 義務なし（出所の明示として OpenReview へのリンクを推奨）。 | API の利用には ToU が適用される（自動アクセスの明示的なレート値は見当たらない）。本文 PDF は投稿ごとのライセンスに従う。 | 要旨の表示は概ね可。ただし **リンクのラベル「arXiv」を「OpenReview」に直す**。 | https://openreview.net/legal/terms （2024-09-24 版） |
| **ACL Anthology**（ACL、EMNLP） | 題名、著者、**要旨全文**、PDF リンク | 2016 年以降の ACL 資料は **CC BY 4.0**（2016 年より前は CC BY-NC-SA 3.0）。第三者の資料は対象外。 | **CC BY 4.0：著作者名・題名・ライセンス名とリンク・改変の有無の表示が必要**（ライセンスの一般的な条件。CC 本文は今回未取得）。 | 明示的なレート制限は見当たらない。 | **×：帰属表示がない**。各論文に「© 著者 / CC BY 4.0（リンク）/ 出典: ACL Anthology / 省略あり」を出すか、カタログ単位で一括表示する。リンクのラベル「arXiv」を「ACL Anthology」に直す。 | https://aclanthology.org/faq/copyright/ ; https://aclanthology.org/ （フッター） |
| **CVF Open Access**（CVPR、ICCV） | 題名、著者、**要旨全文**（HTML の `<div id="abstract">` を取得）、PDF リンク | 「Copyright and all rights therein are retained by authors or by other copyright holders. All persons copying this information are expected to adhere to the terms … invoked by each author's copyright.」**ライセンスの付与なし** | — | ToU・robots の詳細は未確認（**要確認**）。HTML の取得は低頻度に抑える。 | **×（最大のリスク）**：9,640 本の要旨全文の掲載と、公開リポジトリでの再配布。§4.3 の対応案を参照。 | https://openaccess.thecvf.com/CVPR2025?day=all |
| **Crossref** | DOI の照合（任意） | 「almost none of the metadata is subject to copyright, and you may use it for any purpose. **Some abstracts … may be subject to copyright**」 | 義務なし | Public 5 req/s・同時 1。Polite（mailto か User-Agent に連絡先）10 req/s・**同時 3**。Plus 150。429 で減速、403 は手動ブロック。キャッシュと User-Agent での識別を推奨。 | 要旨を Crossref から取る場合は §4 に従う。**design 44 の「polite 同時 5」は誤りで 3**。 | https://www.crossref.org/documentation/retrieve-metadata/rest-api/ ; …/access-and-authentication/ （2025-10-16 更新） |
| **DBLP** | 会場・著者の名寄せ（候補） | メタデータは **CC0 1.0**（ODC-BY 1.0 は互換性のための副次ライセンス） | 義務なし（「link to us」を歓迎） | 免責あり。明示的なレートは今回未確認。 | 問題なし。使う場合は謝辞に追加する。 | https://dblp.org/db/about/copyright.html |
| **CORE** | 未使用（design 44 で「不要」） | ODC-BY のデータセットは商用・非商用とも可（要 acknowledge）。**API と他のデータセットには CORE のライセンスが必要**。個人は「personal capacity」かつ acknowledge なら無料になりうる。ただし「検索・発見システム等、CORE の既存サービスと同種の機能で万人向けのもの」は**要連絡**。 | Web サイトは**メインページに CORE ロゴか「powered by CORE」**。個別資源には CORE への来歴リンクも必要。 | キーが必要。30 日前の通知で承認を撤回できる。 | **使わないことを推奨**。使うなら事前に CORE へ連絡し、トップページにロゴを置く。 | https://core.ac.uk/terms ; https://core.ac.uk/acknowledge ; https://api.core.ac.uk/docs/v3 |
| **OpenCitations** | 未使用（FA1 で 0 件） | データセットは **CC0**（Web ページの文章は CC BY 4.0） | 義務なし | REST API は **IP あたり 180 req/分**。アクセストークンの利用を推奨。 | 問題なし。 | https://opencitations.net/governance/ （LICENSE 節）; https://api.opencitations.net/index/v2 |
| **Unpaywall** | 未使用 | 2025 年末から OpenAlex と同じデータベース（OpenAlex のデータは CC0）。Unpaywall 独自のライセンス文言は今回未確認。 | — | **`email=` パラメータが必須**。100,000 回/日まで。スナップショットは廃止され、OpenAlex のスナップショットを使う。 | 使う必要はほぼない（OpenAlex の `open_access` で足りる）。 | https://unpaywall.org/products/api ; https://help.openalex.org/access/unpaywall/ |
| **DeepL API Free**（翻訳案、design 46 D2） | 未使用 | 訳文に DeepL 側の著作権主張は見当たらない。ただし**原文の著作権は残る**（翻訳は翻案＝二次的著作物、著作権法 27 条・28 条）。 | MT であることの明示は規約上の義務ではないが、ユーザーへの誠実さとして推奨。 | **§3.3.3：API Free（規約上の名称は「DeepL API Developer」）では、入力（Content）と訳文（Processed Content）を DeepL が無期限に保存できる**。§3.3.2：機能や提供を予告なく変更・終了できる。月 50 万字。429 には指数バックオフ。 | 公開されている要旨・TLDR だけを送るなら、機密性の問題はない。**CVF の要旨を訳して載せると、翻訳権の問題が加わる**ので、CC0 か CC BY の原文に限る。キーは Secret に保管する。 | https://www.deepl.com/en/pro-license （§1.13、§3.3） |
| **Hugging Face Papers API** | 注目度シグナル（任意） | HF ToS：Content に付いたライセンスはそのまま有効で、ライセンス表記の除去は禁止。HF Papers の AI 要約などは HF または投稿者のコンテンツ。 | — | 明示的な API レートは ToS 上に見当たらない（**要確認**）。 | upvotes などの数値をシグナルとして使うだけにとどめ、**HF の要約文は転載しない**。 | https://huggingface.co/terms-of-service （2022-09-15 発効） |

補足：**S2 の「CC BY-NC」** は、規約 §2 で一部の S2 Data のライセンスとして挙がっている。PaperPilot は非営利なので、どちらでも適合する。ただし将来、広告や寄付で収益を得る場合は再確認が必要。

---

## 3. 著作権法：引用（32 条）と要旨の表示

### 3.1 条文（e-Gov 法令検索、https://laws.e-gov.go.jp/law/345AC0000000048 、2026-10-11）
- **32 条 1 項**：「公表された著作物は、引用して利用することができる。この場合において、その引用は、公正な慣行に合致するものであり、かつ、報道、批評、研究その他の引用の目的上正当な範囲内で行なわれるものでなければならない。」
- **48 条 1 項 1 号・3 号**：32 条による複製と、複製以外の利用（公衆送信を含む）で慣行がある場合には、出所を「合理的と認められる方法及び程度により」明示する。**2 項**：著作者名が表示されている著作物では、その著作者名を示す。
- **47 条の 5**：電子計算機による所在検索や情報解析の結果の提供に付随する**軽微利用**（題号・著作者名・URL などの提供に伴う、ごく一部の表示）。政令の基準（後述）に従う者に限られる。権利者の利益を不当に害する場合は対象外。
- **50 条**：権利制限規定は著作者人格権（同一性保持権 20 条など）に影響しない。

### 3.2 要件（判例・実務上の整理。**解釈には幅があり、要確認**）
1. 公表された著作物であること。
2. 明瞭区別性：引用部分が引用符などで区別されていること。
3. 主従関係：自分の表現が主で、引用は従であること。判例上の基準として知られ、近年は「公正な慣行」と「正当な範囲」を総合的に考慮する裁判例もある。
4. 引用の必要性・目的の正当性（報道・批評・研究など）。
5. 必要最小限であること。
6. 出所の明示（48 条）。
7. 改変しないこと。省略は「…」で示す（人格権への配慮）。

### 3.3 PaperPilot の各表示への当てはめ

| 表示 | 引用として成立しやすいか | 理由・改善点 |
|---|---|---|
| 関係の根拠としての S2 引用文（1 文、300 字以下） | **成立しやすい** | 目的は「関係の種類の判定根拠を示す」こと（研究・批評に準じる）。主は PaperPilot の判定文（rationale）と系譜グラフ。引用符で区別し、出所（論文名・S2・リンク）も示している。**改善**：語の途中から始まる抜粋には先頭に「…」を付ける。出典に著者名（例：「Daras et al.」）を加える。根拠は 1 件だけ表示し、全件の一覧表示はしない（現状どおり）。 |
| 要旨中の「名指しする 1 文」（rationale の根拠） | 成立しやすい | 上と同じ形にそろえる（出典「〈論文名〉の要旨」＋著者名＋リンク）。 |
| 系譜ノードの要旨・TLDR の冒頭（約 140 字で「…」切り） | 引用というより「所在検索の付随表示」に近い | 主に arXiv の論文で、arXiv 由来なら CC0 で問題なし。S2 TLDR は S2 の生成文（ODC-BY）なので、「Semantic Scholar TLDR」と表示する。**別論文の要旨が付いている誤り（Longformer）は、出所の誤表示なので修正が必要**。 |
| 学会カタログの要旨**全文** | **引用としては成立しにくい** | 要旨が表示の主役で、主従関係がない。arXiv（CC0）・OpenReview（CC0）・ACL（CC BY 4.0、要帰属）は**ライセンスで適法化できる**。**CVF（権利留保）はライセンスでも引用でも説明しにくい**。47 条の 5 の軽微利用は「ごく一部」に限られ、全文は対象外と考えるのが安全。 |
| 機械翻訳した要旨（D2 で採用した場合） | 翻案権・翻訳権の問題が加わる | 原文が CC0 か CC BY のものに限る。CC BY なら「翻訳した」ことを明示する。CVF の要旨は訳さない。 |

### 3.4 47 条の 5（軽微利用）を使う場合の注意（**要確認**）
- 施行令・施行規則の基準：権利侵害の防止措置、学識経験者への相談などの措置、問い合わせへの対応体制など。個人のサイトで「基準に従う者」と言えるかは不確実。
- このため、**CVF について 47 条の 5 だけに頼るのは推奨しない**。差し替え（arXiv 版の要旨や S2 TLDR）を主にする。

---

## 4. 学会カタログの要旨：推奨する対応

1. **CVF の 9,640 本**：S2 の `externalIds.ArXiv` や題名照合で arXiv 版を探し、見つかれば arXiv の要旨（CC0）に差し替える。見つからない場合は次のどちらかにする。
   - S2 TLDR（ODC-BY、「Semantic Scholar の自動要約」と明示）。
   - 先頭 1〜2 文（200 字程度）＋「続きは CVF で」のリンク。
   - いずれの場合も、**公開リポジトリと `papers.json` からは CVF の要旨全文を除く**（履歴に残る分の扱いは §7 の要決定事項）。
2. **ACL の 3,508 本**：カタログ画面とデータに `license: "CC BY 4.0"`、`license_url`、`attribution: "<著者>, <題名>, ACL Anthology"` を付ける。画面には「© 著者 · CC BY 4.0 · ACL Anthology より（省略あり）」を表示する。
3. **OpenReview・arXiv**：義務はないが、出所の表示としてリンクのラベルを正しくする（「OpenReview」「arXiv」）。
4. `papers.json` の各行に `source` と `license` を持たせる（`source` は既にある）。カタログの「詳細」に、ソースごとのライセンス表記をまとめて出す。

---

## 5. 削除依頼（テイクダウン）への対応

- **法的な位置づけ**：PaperPilot は、要旨や引用文を**自ら選んで掲載する発信者**に当たる。そのため、プロバイダ責任制限法（現在の名称は情報流通プラットフォーム対処法）の免責の仕組みは期待しにくい。同法の大規模プラットフォーム向けの義務（2025-04 施行）は対象外とみられる（総務省 https://www.soumu.go.jp/main_sosiki/joho_tsusin/d_syohi/ihoyugai.html 、**要確認**）。
- **推奨する手順**（「仕組み」か `/policy` に掲載）：
  1. 窓口：非公開の窓口（メールまたはフォーム）と GitHub Issue（誤りの報告用）を分ける。独自ドメインと Cloudflare Email Routing は design 40 §5 のドメイン決定と連動する。
  2. 受け付ける内容：対象の URL・論文、権利者や本人であることの説明、理由。
  3. 権利者または本人からの依頼は、**受付から 3 営業日以内を目安に一時的に非表示**にする。
     - 非表示にする方法：該当の excerpt、要旨、著者名の表示を抑止する。抑止リストを `data/published/suppressions.json` に置き、ビルド時に適用する。
  4. 判断して回答する。
  5. 記録を残す（日付、対象、対応）。
  6. 必要に応じて、S2・OpenAlex など上流へのデータ訂正の依頼方法を案内する。
- 表示する文例：「本サイトの要旨・引用文の著作権は各著者・出版者に帰属します。掲載の停止や訂正をご希望の権利者・ご本人は〈窓口〉までご連絡ください。確認のうえ速やかに非表示にします。」

---

## 6. プライバシー

| 項目 | 現状（コード・設定で確認） | リスクと推奨 |
|---|---|---|
| 著者名（約 28,300 本 × 複数名、検索対象） | 論文に記載された氏名を、公開されているソースから表示している。所属やメールは表示しない。 | 公開されている情報でも個人情報には当たる。個人情報保護法の「事業」は営利・非営利を問わない（PPC Q&A 1-54）ので、**個人情報取扱事業者に当たる可能性がある**。Web での公開が「第三者提供」（27 条）に当たるかどうかは、専門家の確認が必要（**不確実**。CiNii や dblp のような書誌サービスが一般的に行っている利用ではある）。最低限、次を行う。<br>(1) 利用目的（学術論文の書誌情報の検索・系譜表示）を公表する。<br>(2) 訂正・利用停止の依頼窓口を置く（33〜35 条の請求に相当）。<br>(3) 著者名以外（所属、メール、ORCID）は表示しない（現状どおり）。 |
| テーマ依頼（Worker） | `cf-connecting-ip` を Durable Object に `ip:<生の IP>` のキーで保存し、1 時間で失効（`apps/api/src/lib/quota.ts`）。グローバルの日次カウンタもある。 | 期間が短く、目的（乱用の防止）も正当。ポリシーに「乱用防止のため IP アドレスを最大 1 時間保持」と書く。可能なら日次のソルトでハッシュ化する。 |
| Workers Logs | `observability.enabled: true`（サンプリングの指定なし＝全件）。Free は 3 日、Paid は 7 日保持（Cloudflare の文書）。`console.error` で出しているのは主にエラー文（IP は出していない）。 | invocation ログに、リクエストのメタデータ（IP や国などの cf 属性が含まれうる）が記録されるかどうかは **要確認**。ポリシーに「障害の調査のため、アクセスログを最大 7 日保持（Cloudflare）」と書く。 |
| テーマ名の公開 | workflow_dispatch の inputs として **公開リポジトリの Actions に残る**。 | フォームの近くに「入力したテーマ名は公開されます。個人名など個人情報を入力しないでください」と注記する。 |
| Cloudflare Pages / CDN | Cloudflare は一般の訪問者のアクセスログを処理する（Cloudflare のプライバシーポリシーでは「Customer Logs」）。 | ポリシーで Cloudflare（米国）を委託先・処理者として明記する。越境移転については、個人の非営利サイトとしての最小限の説明でよいか **要確認**。 |
| 解析・Cookie | なし。localStorage は表示設定のみ。 | ポリシーに「解析ツールや Cookie による追跡はしていない」と明記する。電気通信事業法の外部送信規律は、非営利で外部送信もないため、適用外か影響は小さいと考えられる（**要確認**）。 |
| 上流 API への送信 | OpenAlex・S2・arXiv に、運営者のメールや User-Agent を送っている（polite）。 | 運営者自身の情報なので問題なし。 |

---

## 7. サイトに必要な表示・対応のチェックリスト（現状とのギャップ）

凡例：✅ 済　△ 一部　❌ 未対応

### A. 帰属・ライセンス表示
| # | 項目 | 根拠 | 現状 |
|---|---|---|---|
| A1 | Web サイトに「Semantic Scholar」と帰属表示する | S2 規約 §4 | ✅（フッター＋#credits） |
| A2 | S2 由来データの ODC-BY 1.0 notice をサイトに出す（「Contains information from Semantic Scholar … ODC-BY」＋リンク） | ODC-BY §4.3 | ✅（#credits に相当文あり） |
| A3 | **公開 JSON（`lineage.json`、`papers.json`、`paper-details`）の `meta` に license、source、attribution を入れる** | ODC-BY §4.2（派生 DB の公開配布） | △（R2-27：schema が `additionalProperties: false` で追加フィールドを許さず、`papers.json` は配列なので見送り。notice は `NOTICE.md`・`data/README.md` に置いた。JSON 内に入れるのは schema の版上げのとき） |
| A4 | **リポジトリに `DATA_LICENSE.md` か `NOTICE` を置く**（S2 = ODC-BY、OpenAlex・arXiv・OpenReview・DBLP = CC0、ACL = CC BY 4.0、CVF = 権利留保）。コード用の `LICENSE` も決める | ODC-BY §4.2(b)(d)、CC BY 4.0 | ✅（R2-27：`LICENSE`＝MIT、`NOTICE.md`、`data/README.md`） |
| A5 | Kinney et al. 2023、Cohan et al. 2019（intents）を記載する | S2 規約 §4、データセットの README | ✅ |
| A6 | **ACL Anthology の CC BY 4.0 帰属表示**（著者、題名、ライセンスのリンク、改変の有無） | CC BY 4.0 | ✅（R2-27：#credits・`NOTICE.md` にカタログ単位の表示。論文ごとの表示は R2-26（§9.1）で対応、PMLR も R3-3（§9.6）で同じ形にした） |
| A7 | **フッターと #credits に OpenReview・CVF・ACL Anthology を追加**し、それぞれのライセンスや権利状態を書く | 出所の明示（48 条）、誠実な表示 | ✅（R2-27） |

| A6 | **ACL Anthology の CC BY 4.0 帰属表示**（著者、題名、ライセンスのリンク、改変の有無） | CC BY 4.0 | ✅（R2-26、§9） |
| A7 | **フッターと #credits に OpenReview・CVF・ACL Anthology を追加**し、それぞれのライセンスや権利状態を書く | 出所の明示（48 条）、誠実な表示 | ✅（R2-26、§9） |
| A8 | OpenAlex への謝辞（CC0、任意） | — | ✅ |
| A9 | arXiv：公認でないことの表明と謝辞 | arXiv ToU | ✅ |
| A10 | S2 TLDR を出す場合は「Semantic Scholar の自動要約（TLDR）」と明示する | 誤認防止、ODC-BY | ✅（カタログは R2-26 で表示。系譜ノードの `tldr` は実際には要旨の冒頭で、ポップアップに「要旨の冒頭（OpenAlex / Semantic Scholar 経由）」と表示） |
| A11 | MT を使う場合は「機械翻訳（DeepL）」と原文の併記 | 誤認防止 | —（未採用） |
| A12 | CORE を使う場合はトップページに「powered by CORE」 | CORE acknowledge | —（使わない推奨） |

### B. 著作権（引用・要旨）
| # | 項目 | 現状 |
|---|---|---|
| B1 | 引用文は 1 文・300 字以下で、引用符を付ける | ✅ |
| B2 | 引用文の出典に論文名とリンクを付ける | ✅ |
| B3 | **引用文の出典に著者名を加える**（48 条 2 項） | ✅（R2-26） |
| B4 | **途中から始まる・途中で終わる抜粋に「…」を付ける** | ✅（R2-26） |
| B5 | **CVF の要旨全文をやめる**（arXiv 版の要旨、S2 TLDR、または短い抜粋＋リンクに替える）。リポジトリからも除く | △（R2-26：公開 JSON からは除いた。`data/inputs/<cvf>/` の収集 CSV と git 履歴には残る → §9 の残課題） |
| B6 | **リンクのラベルを実際のソースに合わせる**（CVF、ACL、OpenReview を「arXiv」と表示しない） | ✅（R2-26） |
| B7 | **別論文の要旨が付く誤り**（Longformer など）の検出と修正（タイトルと要旨の整合チェック） | ✅（R2-26。公開済みの flash-attention は表示側で除去、次の再生成で生成側でも除去） |
| B8 | PDF やソースを再配信しない（リンクのみ） | ✅ |
| B9 | 公開リポジトリの `data/state/lineage-cache`（S2 の生応答 49 MB）を公開しておく必要があるか再検討する | ✅ 決定 D3＝A：公開のまま、ODC-BY の notice を `NOTICE.md`・`data/README.md` に置く（R2-27） |

### C. 削除依頼・問い合わせ
| # | 項目 | 現状 |
|---|---|---|
| C1 | 削除依頼の窓口 | ✅（R2-27：非公開の報告＋誤りの報告用の Issue。フッター「削除依頼」、#privacy、#credits） |
| C2 | **非公開の窓口（メールかフォーム）** | △（D2＝A：GitHub の非公開の脆弱性報告 `security/advisories/new`。GitHub アカウントが必要。独自ドメインができたらメールへ） |
| C3 | **手順の明文化**（一時非表示の目安、記録） | ✅（R2-27：`docs/policy/takedown.md`、`SECURITY.md`、runbook「運用: 削除・訂正の依頼」。一時非表示は受付から 3 営業日以内） |
| C4 | 抑止リスト（suppressions）の仕組み | ❌（当面は takedown.md の手作業） |

### D. プライバシー・免責
| # | 項目 | 現状 |
|---|---|---|
| D1 | **プライバシーポリシーのページ**（著者名の利用目的、IP の 1 時間保持、Cloudflare のログ、Cookie と解析なし、localStorage、問い合わせ先、訂正・利用停止の受付） | ✅（R2-27：「仕組み」の #privacy 節「プライバシーと削除依頼」、フッターにリンク） |
| D2 | **テーマ依頼フォームに「入力は公開されます」と注記** | ✅（R2-27） |
| D3 | 免責（自動生成で誤りを含む、正確性を保証しない、各提供元の公式サービスではない） | △（未監査バナー、非公認の表明はある。総合的な免責文はない） |
| D4 | 運営者の表示（個人・非営利であること、連絡先） | △（R2-27：#privacy に「個人が運営する非営利のサイト」と非公開の窓口。運営者名は `LICENSE` のみ） |

### E. 運用（規約の順守）
| # | 項目 | 現状 |
|---|---|---|
| E1 | S2：キーを Secret に保管し共有しない。指数バックオフ。複数キーで回避しない | ✅（design 44 §5） |
| E2 | arXiv：全マシン合算で 3 秒に 1 回、同時 1。Actions の並列ジョブでも守る | 要確認（並列ジョブ間の合算） |
| E3 | Crossref：polite は 10 rps / **同時 3**（design 44 を修正） | △ |
| E4 | OpenAlex：API だけを使う（Web のスクレイピングはしない）。予算ヘッダを守る | ✅ |
| E5 | DeepL Free：入力が無期限に保存されうることを承知のうえで、公開テキストだけを送る | —（未採用） |
| E6 | CVF の HTML 取得：低頻度にし、User-Agent に連絡先を入れる。robots と ToU を確認する | 要確認 |

---

## 8. ユーザー（運営者）が決めること

1. **CVF の要旨の扱い**：(a) arXiv 版の要旨に差し替え＋なければ TLDR（推奨）／(b) 先頭 1〜2 文＋リンク／(c) 現状のまま（非推奨）。→ **ユーザー決定 D1=A（2026-10-11）、R2-26 で実装（§9）**。あわせて、公開リポジトリの履歴に残った CVF の要旨全文をどうするか（履歴の書き換えは重いので、今後のファイルから除外する程度でよいか）。
2. **非公開の連絡窓口**：独自ドメイン＋Email Routing（design 40 §5 と連動）／Google フォーム／運営者用の連絡用メール。
3. `data/state/lineage-cache`（S2 の生応答）を公開リポジトリに置き続けるか。
4. コードとデータのライセンス（例：コードは MIT、PaperPilot が生成した派生データは ODC-BY を継承、ソース別の注記付き）。
5. プライバシーポリシーの公開場所（`/policy` か「仕組み」の節）と、運営者名の表示レベル。

---

## 9. 実施内容（R2-26、ユーザー決定 D1=A、2026-10-11）

### 9.1 学会カタログの要旨（B5・A6・B6・A10）
- **方針（`@paperpilot/core/licensing`、`apps/pipeline/src/catalog/abstractReplacements.ts::applyAbstractPolicy`）**：要旨を公開するのは、ライセンスのある出典だけ。arXiv・OpenReview は CC0 1.0、ACL Anthology は CC BY 4.0 でそのまま。CVF（と未知の出典）は、次の順に差し替える。
  1. 同じ論文の arXiv 版の要旨（CC0）。題名がほぼ一致（正規化して一致、または語の Jaccard ≥ 0.9）**かつ**著者の姓が短い方の一覧の 50% 以上で一致した場合だけ採用。S2 が arXiv 版と結び付けている場合（`externalIds.ArXiv`）は改題を許して題名 0.5 以上・著者 50% 以上。
  2. Semantic Scholar TLDR（ODC-BY 1.0、「機械生成の要約」と表示）。
  3. なし（題名・著者・リンクのみ）。
- 差し替えの結果は会議ごとに `data/inputs/<conf>/abstract_replacements.json`（`abstract-replacements-v1`、arXiv の要旨〔CC0〕・TLDR〔ODC-BY〕・照合の根拠を保存）に置き、`buildPages` が読む。**ファイルがない・行がない場合は要旨を出さない（fail closed）**。CVF の要旨は `papers.json` にも `paper-details-v1` にも入らない。
- `papers.json` の各行に `abstract_source`（`arxiv`/`openreview`/`acl_anthology`/`s2_tldr`/`none`）と `abstract_license`（`CC0-1.0`/`CC-BY-4.0`/`ODC-BY-1.0`/空）を追加。arXiv 版に差し替えた行は `arxiv_id` も埋める。方針で外した要旨は縮小ゲート（`abstract` が空になった行の拒否）の対象外。
- **表示（`apps/web/lib/catalog-attribution.ts`）**：各要旨の下に「要旨の出典: arXiv · CC0 1.0（同じ論文の arXiv 版の要旨）」のように出典とライセンスのリンクを出す。ACL は「出典: 〈第一著者〉 et al., “〈題名〉”, ACL Anthology · CC BY 4.0（一覧では冒頭のみ表示）」。TLDR は「要約の出典: Semantic Scholar TLDR（機械生成の要約）· ODC-BY 1.0（著者による要旨ではありません）」。要旨を出さない行には理由を表示。
- **リンクのラベル**：論文ページへのリンクを出典名（CVF Open Access / ACL Anthology / OpenReview / arXiv）で表示し、arXiv 版が見つかった行には別に「arXiv」リンクを出す（B6）。
- フッターに OpenReview・ACL Anthology・CVF Open Access を追加し、「仕組み」#credits にカタログの要旨の出典とライセンスの段落を追加（A7）。

### 9.2 差し替えの取得（resolver）と所要時間
- コマンド（リポジトリのルート、Node 22。メモリを抑えるため pnpm を介さず node から直接起動し、**1 会議ずつ**実行）：
  `node --max-old-space-size=256 --import tsx apps/pipeline/src/catalog/resolveAbstractReplacementsCli.ts --conference <conf>`
  続けて `pnpm exec tsx apps/pipeline/src/catalog/buildPagesCli.ts`（全会議の再ビルド。`papers.json`・`paper-details-v1`・`conferences.json` を生成）。
- 手順：(1) arXiv API の題名検索を 20 題名ずつ OR でまとめる（`ti:"…" OR ti:"…"`、3.1 秒に 1 回、429 で間隔を最大 5 倍に広げ Retry-After を守る）。(2) S2 bulk search（venue＋year、1,000 件/回）で S2 の記録と照合し、`externalIds.ArXiv` があれば arXiv の `id_list`（100 件/回）で要旨を取り、なければ `POST /paper/batch`（500 件/回）で TLDR。(3) 任意の `--s2-match`（1 題名 1 回、鍵なしで約 1 回/秒。数千件で数時間）。
- **再開可能**：各バッチの後にキャッシュを保存。arXiv 検索で一致しなかった行は `kind: none, checked: ["arxiv_title"]`、S2 の段も済めば `"s2"` を記録し、再実行では済んだ段を飛ばす。HTTP エラーのバッチは未検索のまま残り、次の実行で再試行。`--retry-none` で `none` をやり直す。
- 所要時間の見積もり：9,640 本 ÷ 20 ≈ 482 回の arXiv 要求。間隔 3.1 秒なら約 25〜30 分。2026-10-11 の実行では他の利用と重なり 429 で間隔が広がり、1 会議 2,700 本で 1 時間前後かかった。S2 の段は会議あたり数回〜十数回の要求で 1〜2 分。
- 結果（2026-10-11）：9,640 本のうち **arXiv 版の要旨 7,297 本（75.7%）、S2 TLDR 10 本、要旨なし 2,333 本**。
  | 会議 | 行数 | arXiv | TLDR | なし |
  |---|---|---|---|---|
  | CVPR 2025 | 2,871 | 2,271（うち S2 経由の改題 23） | 2 | 598 |
  | ICCV 2025 | 2,701 | 2,112 | 8 | 581 |
  | CVPR 2026 | 4,068 | 2,914 | 0 | 1,154（S2 の venue 検索は CVPR 2026 を 0 件しか返さなかった） |
  - 公開した CVF 行の本文は、全行がキャッシュの arXiv 要旨・TLDR と一致し、`none` の行は本文が空であることを確認した。照合の題名が完全一致しない 14 本（CVPR 2025）は目で確認し、すべて同じ論文（略称の有無・小さな改題）だった。
  - 公開データは生成器で作り直した：上の resolver を 3 会議で順に実行 → `buildPagesCli.ts`（全会議）。`searchIndexCli.ts --check` は「current」。arXiv/OpenReview/ACL の行は `abstract_source`/`abstract_license` が増えただけで本文は不変。

### 9.3 系譜ノードの別論文の要旨（B7）
- **根本原因**：結合の誤りではなく、上流のデータ。OpenAlex の W3015468748（Longformer、arXiv 2004.05150）の `abstract_inverted_index` 自体に、2025 年の別論文「Murmurative Attention」の要旨が入っている（API で確認）。生成器はそれを `short_abstract`/`tldr` にそのまま使っていた。R2-17 の題名・要旨の整合検査は「題名の後の版の名前」と「5 語以上の題名で重なりなし」だけで、この例を見逃していた。
- **対策**：検査を `@paperpilot/core/abstract-sanity` に移し、規則を 1 つ追加した。題名が「〈造語 1 語〉: 副題」で、200 字以上の要旨がその造語に一度も触れず、「We introduce/propose/present 〈別の固有名〉」を含み、副題の特徴語の半分未満しか現れない場合は別論文の要旨と判定する。カタログの 28,310 本で誤検出 1 本、公開中の 4 テーマでは Longformer だけが該当。
  - 生成側：`openalexWork.ts`（OpenAlex の要旨を捨て、S2 の要旨があればそれを使う）と `citingAbstractOf`（関係の根拠に使わない）。
  - 表示側：`apps/web/lib/lineage/core.ts::withoutForeignAbstract` が、公開済みの成果物を読むときに該当ノードの `tldr`/`short_abstract` を外す（flash-attention の再生成までの措置。`data/published` は手で直していない）。
  - 評価用の固定データ `relation-precision-r222.json`/`r223.json` の Longformer の `citing.abstract` を arXiv の要旨（CC0）に差し替え。R2-22/R2-23 の適合率テストの結果は変わらない。
- 系譜ノードのポップアップには「要旨の冒頭（OpenAlex / Semantic Scholar 経由。著作権は著者に帰属）」と表示（`tldr` は S2 TLDR ではなく要旨の冒頭 140 字）。

### 9.4 引用文の表示（B3・B4）
- `clipQuote`：抜粋が小文字・句読点で始まる（語や文の途中から始まる）場合は先頭に「… 」、文末（. ! ? と閉じ括弧・引用符、末尾の [n].）で終わらない場合や 300 字で切った場合は末尾に「…」を付ける。記号を足しても 300 字を超えない。
- 出典の行に引用元（新しい論文）の著者名を入れた：「出典: Semantic Scholar（引用文脈、Beltagy et al.「Longformer: …」より 1 文を引用）」。著者 1 人なら姓、2 人なら「A & B」、3 人以上は「A et al.」。

### 9.5 残課題
- `data/inputs/{cvpr-2025,cvpr-2026,iccv-2025}/` の収集 CSV（`papers_*.csv`、`summary.csv`）と git 履歴には CVF の要旨全文が残る。タグ分類（`buildSummary` が題名＋要旨から付ける）がこれを使うため、今回は残した。除くなら、CVF の収集器が要旨を保存しない形にし、タグは題名＋差し替え後の要旨から付け直す（タグが変わる）。履歴の書き換えは §8-1 の判断待ち。
- CVF の会議を収集し直したら resolver を再実行する（新しい行は実行するまで要旨なし）。CI のワークフローには組み込んでいない（CVF の収集は手動のため）。
- flash-attention テーマの再生成（生成側の検査で Longformer の要旨が消える）。
- `--s2-match` を使えば TLDR の取りこぼしが減る可能性があるが、鍵なしでは数時間かかる。

### 9.6 PMLR の要旨の出典とライセンス（R3-3、2026-10-11）
- **問題**：ICML 2026 は PMLR v306 から集めた（52 §8）。行の識別子と論文ページへのリンクは OpenReview の forum なので、R2-26 の方針（行の URL から出典を推定）は要旨を「OpenReview・CC0 1.0」と表示していた。実際の本文は PMLR の BibTeX のもので、ライセンスは **CC BY 4.0（帰属が必要）**。
- **対策**：出典とライセンスは、収集器が `papers_<date>.csv` の隣に書く `source_license.json` から決める（あれば URL からの推定より優先）。
  - `@paperpilot/core/licensing`：`AbstractSource` に `pmlr`（CC BY 4.0、表示名「PMLR」）を追加。`proceedingsAbstractSource()` が収集器の `source`（`pmlr` / `acl_anthology`）を要旨の出典に対応づける。
  - `apps/pipeline/src/conference/proceedings/sourceLicense.ts::readSourceLicense`／`parseSourceLicense`（壊れたファイルは build を止める）、`catalog/abstractReplacements.ts::collectionAbstractPolicy`・`applyAbstractPolicy(…, collection)`、`catalog/buildPages.ts::loadCollectionAbstractPolicy`（ディレクトリ名と `conference` の一致も確認）。
  - **fail closed**：`license: null`（権利留保）なら URL が OpenReview でも要旨を出さない（CVF と同じ差し替えの経路）。ライセンスがあるのに対応する出典が無い収集器（`neurips_proceedings` など）や、ライセンス ID が `licensing` と食い違う場合は build を止める。`abstracts: "omitted"`（CVF `--listing-only`）のファイルは無視。
  - `papers.json` の PMLR の行に `abstract_url`（論文ごとの PMLR のページ、`landing_urls` から）を追加。行の URL と同じ場合や他の出典では付けない。
- **表示（`apps/web/lib/catalog-attribution.ts`）**：「要旨の出典: 〈第一著者〉 et al., “〈題名〉”, PMLR v306 · CC BY 4.0（一覧では冒頭のみ表示）」。リンク列に「PMLR」（`https://proceedings.mlr.press/` の URL だけ）を OpenReview と PDF の間に出す。#credits と `NOTICE.md` に PMLR の行を追加。
- ACL 2026 の `source_license.json`（`acl_anthology`、CC BY 4.0）は今までの推定と同じ結果で、論文ごとの帰属（著者・題名・ACL Anthology、§9.1）もそのまま。
- 公開データは生成器で作り直した（`buildPagesCli` → `identityLiteCli --as-of` → `searchIndexCli` → `buildLineageQualityCli --as-of`、`as_of` はコミット済みの値）。ICML 2026 の 6,552 本が `pmlr`／`CC-BY-4.0`／`abstract_url` 付きになり、ほかの学会の `papers.json` は変わらない。要旨の本文も変わらない。

---

## 付録：未確認・不確実な点
- OpenAlex の利用規約ページ（openalex.org/terms）は bot 遮断で取得できなかった。抄録を転置インデックスで配布する理由が法的なものかどうかも未確認。
- S2 API の応答に、Datasets と同じ ODC-BY がフィールド単位で及ぶか。規約 §2 は「付随するライセンス」とだけ書いている。保守的に ODC-BY として扱っている。
- CVF サイトの利用規約と robots.txt。
- CC BY 4.0 の本文（帰属要件の正確な文言）は、今回は一般的な知識による記載で、原文は取得していない。
- 47 条の 5 の政令基準を個人が満たすか。著者名の Web 公開が個人情報保護法 27 条の第三者提供に当たるか。Workers Logs に IP が含まれるか。
- 文化庁の引用解説ページ（旧 URL）は 404 だった。条文は e-Gov で確認した。

## 10. 実施記録

### R2-27 法的表示・削除依頼・プライバシー（2026-10-11）

ユーザー決定：**D2＝A**（非公開の窓口は当面 GitHub の非公開の脆弱性報告。リポジトリで有効化済み。独自ドメインができたらメールへ）、**D3＝A**（`data/state` の S2 キャッシュは公開のまま、ODC-BY の notice を付ける）、**D4＝A**（コードは MIT、データは「各出典のライセンスに従う」、サイトにプライバシーの節）。

- 追加：`LICENSE`（MIT、Taichi Nakamura、2026）、`NOTICE.md`（ソース別のライセンスと帰属、S2 の ODC-BY notice と Kinney et al. 2023 / Cohan et al. 2019）、`data/README.md`、`SECURITY.md`、`docs/policy/takedown.md`（受付 → 3 営業日以内に一時非表示 → 判断 → 記録）。runbook に「運用: 削除・訂正の依頼」。
- サイト：フッターに「プライバシー」「削除依頼」と OpenReview・ACL Anthology・CVF Open Access。#credits にカタログのソース別ライセンス、コード MIT／データは各出典、非公開の窓口。新しい節 #privacy「プライバシーと削除依頼」。テーマ依頼フォームに「入力したテーマ名は公開されます」の注記。
- **IP の保持（§6 の訂正）**：調べたところ、`QuotaLedger` の `ip:<IP>` は `expiresAt` で窓を閉じるだけで、**エントリ自体は Durable Object に残り続けていた**（「最大 1 時間」は事実でなかった）。`QuotaLedger.sweepExpired` と Durable Object の alarm を足し、窓が終わった `ip:` エントリを約 1 時間で削除するようにした（`apps/api/src/lib/quota.ts`、`src/durable/quota-object.ts`）。Worker のデプロイ後、最初のテーマ依頼で alarm が入り、それまでに溜まった古いエントリもその alarm で消える。
- 公開 JSON への `license` フィールド（A3）は、schema が追加を許さないため見送り、notice はファイルで示した。
- 残り：~~A6 の論文ごとの帰属~~（R2-26 で ACL、R3-3 で PMLR に対応）、B3〜B7、C4（抑止リスト）、CVF の要旨（R2-26）、メールの窓口（独自ドメイン待ち）。

> 生の取得結果は手元の一時領域に置いたため、リポジトリには入れていない（2026-10-11）。
