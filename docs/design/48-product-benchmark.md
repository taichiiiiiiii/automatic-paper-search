# 48 類似サービス・OSS との比較と、LLM を使わずに取り入れられる改善案（2026-10-11 調査）

- 調査範囲: Connected Papers、Litmaps、ResearchRabbit、Inciteful、Local Citation Network、Citation Gecko / citationchaser / CoCites、Semantic Scholar（Semantic Reader・Research Feeds）、scite、alphaXiv、Hugging Face Papers（Daily / Trending）、Papers with Code の後継（HF Trending、CodeSOTA、PapersWithCodePlus、CatalyzeX、paperswithcode-data のアーカイブ）、Elicit / Consensus（LLM 系。参考のみ）、CiteSpace / VOSviewer / CitNetExplorer（書誌計量のデスクトップツール）
- PaperPilot の現状は、リポジトリの設計書 40・41・46、`apps/web` のコンポーネント、本番の `lineage-quality-v1.json`（as_of 2026-10-11T02:56Z）で確かめた。リポジトリには手を入れていない
- 前提: 方針は「LLM なし」。ただし S2 の TLDR・SPECTER2・OpenAlex の topics/keywords のように、上流が作った ML の出力を使うことは許す（46 と同じ扱い）

---

## 0. 結論（先に）

1. **「関係の種類」と「引用文という根拠」を出す系譜は、調べた範囲では PaperPilot だけ**。ほかの地図系ツール（Connected Papers・Litmaps・ResearchRabbit・Inciteful・Local Citation Network）の線は「引用した」か「似ている」だけで、種類も根拠もない。種類を出す scite は 1 本ずつの引用を「支持・反対・言及」に分けるだけで、手法の系譜は作らない。しかも有料で、分類は深層学習。Semantic Scholar は意図と isInfluential を持っているが、系譜の画面はない。この強みは**根拠を見せる UX と監査の表示**をもっと前に出すことで伸ばせる。
2. **足りないのは、系譜の中身より「入口」と「続き」**。
   - 入口: 任意の論文を種（seed）にできない。テーマは 4 つだけ。要旨の全文検索がない。似た論文の表示もない。
   - 続き: 新着の通知（Litmaps Monitor・S2 Research Feeds・HF Daily に当たるもの）がない。カタログが 2026-06-28 で止まっている。BibTeX などの書き出しもない。
   - 周辺: コード・モデル・データセットへのリンクがない（PwC の後継が担っていた役割）。
3. **LLM なしで取り入れられる手法は多い**。どれも書誌計量の古典的な手法か、公開されている API・データで作れる。
   - 共引用・書誌結合（Connected Papers）
   - Prior works / Derivative works（Connected Papers・LCN）
   - PageRank・Adamic-Adar（Inciteful）
   - 2 本の論文をつなぐ経路（Inciteful Connector）
   - **主経路分析（SPC、CitNetExplorer・CiteSpace 系）**
   - **バースト検出（Kleinberg、CiteSpace）**
   - 年 × 被引用数の散布図（Litmaps）
   - 引用の種類の件数表示（scite）
   - 新着の監視（Litmaps Monitor）
   - HF Papers API と PwC のアーカイブデータでのコード・リソースのリンク
4. **推奨順**（詳しくは §4）
   - P0（小さな工数で効果が大きい）: 主経路（本流）の強調、Prior/Derivative パネル、関係ごとの誤り報告リンク、書き出し（BibTeX・CSV・共有 URL）、鮮度の表示
   - P1: テーマごとの新着フィード（共引用で拾う RSS/Atom）、コード・HF のリンク、論文詳細の「系譜での位置」、似た論文（SPECTER2 の近傍）
   - P2: 任意の論文を種にした系譜（Worker の既存の依頼経路を流用）、要旨の静的全文検索、学会ごとの急上昇語（バースト）
   - P3（見送りか保留）: アカウント・コレクション、コメント欄（alphaXiv 型）、LLM による要約や対話

---

## 1. 比較表（機能・UX）

凡例: ◎ 強い、○ ある、△ 限定的、— ない。「LLM」は利用者に見える機能で生成 AI を使うかどうか。

| サービス | 系譜・地図の作り方 | 線の意味 | 根拠の提示 | 新着・監視 | 入口（種の指定） | 書き出し・連携 | 料金・公開 | LLM |
|---|---|---|---|---|---|---|---|---|
| **PaperPilot** | テーマ単位。引用を BFS でたどり、テーマ外のノードをゲートで落とす。家系図・時系列・トピックの 3 レイアウト | ◎ 6 種（置換・後継・拡張・ablation・参照・対立）、確信度つき | ◎ 引用文（≤300 字）・判定方法・出典。「監査済み／未監査」の表示 | — カタログは 6 月のスナップショット | △ テーマ名（4 件と依頼フォーム）、学会カタログ | △ グラフの SVG/PNG 書き出し | 無料・日本語 | なし（既定） |
| Connected Papers | 種 1 本の周りの約 5 万本から、共引用と書誌結合の類似度で数十本を選ぶ。力学レイアウト（引用の木ではない） | 類似度（線の太さ） | — | — | 論文 1 本 | △ BibTeX ほか | 無料枠（月数グラフ）＋有料 | なし |
| Litmaps | 種（複数可）から引用と類似（SPECTER の埋め込み）で広げる。x=年、y=被引用数の散布図 | 引用 | — | ◎ Monitor（保存した検索・地図の新着を毎週メール） | 論文・検索語・文献管理ソフトからの取り込み | ◎ Zotero・BibTeX | 無料枠＋Pro | 一部（意味検索） |
| ResearchRabbit（2025 年に刷新、Litmaps と提携・買収とも報道） | 種の集合から Earlier / Later / Similar を順にたどる「rabbit hole」 | 引用・類似 | — | ○ 新着の通知 | 論文の集合・著者 | ○ Zotero | 無料（入力 50 本未満）＋RR+ | 類似に埋め込み |
| Inciteful（OSS） | 種の集合から 2 段の引用網を作り、PageRank・Adamic-Adar・被引用数で順位をつける。**Literature Connector**: 2 本をつなぐ経路 | 引用 | — | — | 論文・BibTeX | ○ | 無料・OSS | なし |
| Local Citation Network（OSS、GPL-3） | 種の集合の引用網。網の中で Top Cited / Top Citing を提案。OpenAlex・S2・Crossref・OpenCitations | 引用 | — | — | DOI の一覧・Zotero | ○ | 無料・OSS | なし |
| Citation Gecko / CoCites / citationchaser | 種の前方・後方の引用を数える（CoCites は共引用の頻度） | 引用 | — | — | 種の集合 | ○（系統的レビュー向け） | 無料 | なし |
| Semantic Scholar | 論文ページ（引用・参考文献、「Highly Influential」、引用文と意図）、Topic ページ、Semantic Reader（本文中の引用カード） | 意図 3 種＋影響の印（データはあるが図はない） | ○ 引用文と意図 | ◎ Research Feeds（ライブラリから推薦） | 検索・著者 | ○ API・BibTeX | 無料 | TLDR・Topic の定義は ML 生成 |
| scite | 引用文を 1 本ずつ「支持・反対・言及」に分類（Smart Citations） | ◎ 3 種、件数 | ◎ 引用文 | ○ ダッシュボード・通知 | 論文・DOI | ○ Zotero プラグイン | 有料中心 | 分類は深層学習。Assistant は LLM |
| alphaXiv | arXiv の上の議論（行単位のコメント）、Trending、組織・研究者をたどる | — | — | ○ Trending | arXiv ID | — | 無料 | LLM による要約・対話あり |
| Hugging Face Papers | Daily（キュレーションと投票）、Trending（GitHub スターの伸びなど）。論文とモデル・データセット・Space の相互リンク。PwC の公式の後継 | — | — | ◎ 毎日 | arXiv ID・検索 | ○ API | 無料 | 要約は一部 AI |
| PwC の後継（CodeSOTA・PapersWithCodePlus・CatalyzeX・paperswithcode-data） | 論文↔コード、SOTA のリーダーボード、手法の分類（methods） | — | — | — | — | データは CC-BY-SA | 無料 | なし |
| CiteSpace / VOSviewer / CitNetExplorer | 共引用・書誌結合のクラスタ、時系列（timeline / timezone）、**バースト検出**、媒介中心性、**主経路分析** | 引用・共起 | — | — | 書誌データの読み込み（専門家向け） | ○ | 無料（デスクトップ） | なし |
| Elicit / Consensus | 問いに対して LLM が論文を探して要約・抽出（参考） | — | 要旨からの抜き出し | ○ | 自然文の問い | ○ | 無料枠＋有料 | ◎ LLM 中心 |

---

## 2. PaperPilot の位置づけ

### 2.1 独自のもの（守って伸ばす）

| 強み | 似たもの | 差 |
|---|---|---|
| 関係の種類（拡張・置換・対立など）を線に出す | scite（支持・反対・言及）、S2 の意図 | 他は「引用 1 本の性格」。PaperPilot は「手法の系統」の主張になっている |
| 引用文をそのまま根拠として見せ、判定方法と確信度も出す | scite・S2 | 地図系のツールで根拠を見せるものはない |
| fail-closed の公開と「監査済み／未監査」の表示 | なし | 他のツールは全部を自動で出す。品質の約束を画面に出しているのは PaperPilot だけ |
| LLM を使わない・再現できる（規則と API） | Inciteful・LCN（OSS で決定的） | 関係の種類まで決定的なのは PaperPilot だけ |
| 日本語 UI、ML のトップ会議 10 学会のカタログ | なし（日本語の系譜ツールは見当たらない） | 対象を ML に絞って学会単位に整理している |
| 3 レイアウト（家系図・時系列・トピック）、関係の種類・根拠の種類・確信度での絞り込み | Litmaps（年軸）、CiteSpace（timeline） | Web で手軽に使える形は少ない |

### 2.2 足りないもの（ギャップ）

| ギャップ | 他のツールでの姿 | 利用者への影響 | 重さ |
|---|---|---|---|
| 任意の論文を種にできない | Connected Papers・Litmaps・RR・Inciteful・LCN はすべて「論文 1 本（または集合）から」 | 4 テーマのどれかに当たらないと系譜を使えない | 大 |
| 新着の発見・監視がない | Litmaps Monitor、S2 Research Feeds、HF Daily・Trending、alphaXiv | 「続きを追う」理由がなく、再訪が起きない | 大 |
| 鮮度（カタログは 2026-06-28 で停止） | HF・alphaXiv は毎日 | 「新しい論文」の目的に答えられない | 大（40 §5 判断 1） |
| 要旨の全文検索・似た論文がない | S2、Litmaps の Similar | 語が題名に無い論文を見つけられない | 中 |
| コード・モデルへのリンクがない | HF Papers、PwC の後継、CatalyzeX | ML の実務者が最もよく使う導線が欠けている | 中 |
| 書き出し（BibTeX・RIS・CSV）、Zotero 連携がない | ほぼ全部 | 文献調査の作業に組み込みにくい | 中（工数は小さい） |
| 「本流」がひと目で分からない（全部の辺が同じ重み） | CitNetExplorer の主経路、Connected Papers の最短路 | 大きなグラフ（GNN は 35 ノード・131 辺）を読みにくい | 中 |
| 論文ごとに「どう受け継がれたか」の集計がない | scite のバッジ（支持 n・反対 n） | 論文詳細から系譜に入りにくい | 中 |
| 誤りの報告が GitHub Issue だけ | scite は引用文単位で報告できる | 監査の手間を利用者に分けてもらえない | 小〜中 |

---

## 3. LLM を使わずに取り入れられるアイデア

| # | 発想の元 | 中身（LLM なしでの作り方） | 使うデータ | 備考 |
|---|---|---|---|---|
| I1 | CitNetExplorer・CiteSpace の主経路分析 | テーマの DAG（古→新）で辺ごとに **SPC**（Search Path Count。始点から終点までの全経路のうち、その辺を通る数）を出し、グローバルまたはキー・ルートの主経路を太線で描く。`baseline_only` を重みを下げて含めるか、強い関係だけで作るかを選べるようにする | 既存の `lineage.json` だけ | 純粋なグラフ計算。root の選び方（R2-2b）の検証にも使える |
| I2 | Connected Papers の Prior / Derivative works | Prior: テーマ内のノードが多く引用しているのに、グラフには入っていない論文（＝見落とされた祖先の候補）。Derivative: テーマ内のノードを多く引用している新しい論文（＝続きの候補）。どちらも「テーマ内の何本とつながるか」で順位をつける | BFS で取得済みの OpenAlex `referenced_works`、`cited_by`（取得を 1 回足す）、S2 のキャッシュ | 既存のトピックゲート（D7）を通した候補だけを出す。テーマ外のノードが混ざる問題を再発させない |
| I3 | Litmaps Monitor・S2 Research Feeds | テーマごとに週 1 回、OpenAlex の `filter=cites:Wxxx` を主要ノード（主経路・次数の上位 k）について引き、**2 本以上を引用する新しい論文**を新着として出す。静的な `feed.xml`（Atom）と、テーマページの「新着」欄にする | OpenAlex（鍵は登録済みの前提）、S2 の batch で TLDR | 数十 credits/週の見込み。cron の再開はユーザーの判断（40 §5） |
| I4 | scite のバッジ | 論文詳細・ノードカードに「このテーマの中で: 拡張された n・置き換えられた n・背景として引用された n」を出す。S2 の意図（background / method / result）の件数も添える | 既存の辺、S2 のキャッシュ | 意味は scite と違う（支持・反対ではない）と明記する |
| I5 | Inciteful Literature Connector | テーマ内の 2 本を選ぶと、関係の種類つきの最短経路（または SPC が最大の経路）を強調する | 既存の `lineage.json` | クライアント側の計算で済む |
| I6 | CiteSpace のバースト検出 | 学会・年ごとに、題名・要旨の語（または OpenAlex keywords）の出現数に Kleinberg のバースト検出（2 状態の簡単な版で十分）を当て、「急上昇の語」を出す。語からテーマの依頼につなぐ | カタログ（約 28,300 本）、OpenAlex keywords | 46 のタグ（`TOPIC_RULES`＋OpenAlex keywords）と語彙を揃える |
| I7 | Litmaps の年 × 被引用数 | 時系列レイアウトの y 軸に被引用数（対数）を選べるようにする | ノードの `cited_by_count` | 既存の時系列レイアウトの拡張で済む |
| I8 | HF Papers・PwC の後継 | arXiv ID から HF Papers の API（`/api/papers/{id}`。upvotes・GitHub リポジトリ・関連モデル）と、paperswithcode-data のアーカイブ（論文→リポジトリ、手法の分類）を引き、「コード」「HF」のバッジを付ける | HF API、PwC のアーカイブ（CC-BY-SA 4.0。表示に帰属表示が要る） | scratch にある `pwc_methods.parquet` も手法名の別名辞書（`theme_aliases.json`）を作るのに使える |
| I9 | S2・Litmaps の Similar | SPECTER2 の埋め込み（S2 API）またはローカルの bge-small（R2-11 と同じもの）で、カタログ内の近傍 k 本を事前に計算し、静的 JSON で「似た論文」を出す | 埋め込み | 46 の関連度の置き換えと同じ部品を使える |
| I10 | LCN・Inciteful の複数の種 | 依頼フォームで「テーマ名」だけでなく「論文 1〜5 本（arXiv ID・DOI）」も受け付け、種の集合から BFS する（トピックゲートは種の要旨の語と埋め込みで作る） | 既存の Worker → Actions の依頼経路 | 種の上限・依頼の上限（Durable Object）はそのまま流用 |
| I11 | scite の引用文単位の報告 | 関係の根拠ダイアログに「この判定は誤り」のリンクを置き、GitHub Issue のテンプレートに辺の ID・関係・引用文を詰めて開く（サーバ不要） | なし | 届いた報告は人手監査（R2-3）の fixture の材料になる |
| I12 | Connected Papers・CiteSpace の共引用・書誌結合 | トピックゲート（D7）の 3 つめの手がかりとして「テーマ内ノードとの書誌結合・共引用の強さ」を足す。今の「テーマ内ノード 2 件以上から引用でつながる」を、重み（Salton の cos など）に一般化する | 取得済みの参考文献リスト | 42 のラベルつき評価で効果を測ってから入れる |
| I13 | 同じ著者の続編（S2・OpenAlex の著者 ID） | 「著者が重なる」「年が後」「引用している」「題名の語が近い」の組を、後継（successor）の手がかりに加える。引用文の手がかりがない組の補強にする | OpenAlex・S2 の著者 ID | 強い関係を出すかどうかは D5（名指しと手がかりの文が要る）を変えない。確信度と並べ順の補助に限る |
| I14 | PwC の手法の分類（methods） | 手法 → 上位カテゴリ → 導入論文の対応を使い、テーマの別名・基礎文献のリスト（foundational allowlist）を半自動で作る | paperswithcode-data のアーカイブ | 人が選ぶ前提の候補出し。LLM によるキーワード拡張を置き換える（46 §2.5 の補助） |

見送るもの: LLM による要約・対話・質問応答（Elicit・Consensus・alphaXiv 型）。方針に反するうえ、根拠つきという強みを薄める。アカウントとコメント欄は、ログインの導入条件（40 §4）を満たすまで入れない。

---

## 4. 優先順位つきの提案

工数: S＝1〜2 日、M＝3〜7 日、L＝2 週以上（いずれも 1 人・テストを含む目安）。効果は「利用者が感じる価値」と「差別化への寄与」から判断した。

### P0（すぐにやる。どれも公開中の 4 テーマですぐ効く）

| # | 提案 | 対象 | 工数 | 効果 | 中身・完了条件 |
|---|---|---|---|---|---|
| P0-1 | **本流（主経路）の強調**（I1） | パイプライン＋web | S〜M | 高 | 生成時に SPC を計算し、`lineage.json` に `main_path: [edge_id…]`（任意の欄。契約・JSON Schema に追加）を出す。web は太線と「本流だけ表示」の切り替え。GNN（131 辺）で主経路が 10 辺前後に収まるかを試算してから入れる |
| P0-2 | **関係ごとの「誤りを報告」**（I11） | web | S | 中〜高 | 根拠ダイアログに、Issue テンプレートを埋めて開くリンクを置く。ラベル `lineage-feedback`。監査の材料が集まる |
| P0-3 | **書き出しと共有** | web | S | 中 | 表示中のノードを BibTeX・CSV（関係・根拠を含む）で書き出す。共有 URL（絞り込みの状態は URL に入っている）をコピーするボタン。BibTeX は arXiv ID・DOI から静的に組み立てる |
| P0-4 | **鮮度と範囲の明示** | web | S | 中 | テーマ・学会ごとに「データの日付」「ノードの選び方（テーマ外の除外あり）」を見出しの近くに出す（40 の R1-3 と同じ）。トップの「系譜は準備中」という文言が、未監査で公開中の 4 テーマと食い違っていないかも直す（2026-10-11 の取得ではトップが「公開条件を満たす系譜は現在ありません」と出ていた。品質表では 4 テーマが `ready / unaudited`） |
| P0-5 | **Prior / Derivative パネル**（I2、まずは既存データだけ） | パイプライン＋web | M | 高 | Prior は取得済みの参考文献だけで出せる。Derivative は `cited_by` の取得を 1 回足す。どちらもトピックゲートを通したものだけを、「グラフ外の候補」として別の欄に出す（系譜の辺としては扱わない） |

### P1（次の段。発見と再訪の理由を作る）

| # | 提案 | 工数 | 効果 | 中身・完了条件 |
|---|---|---|---|---|
| P1-1 | **テーマの新着フィード**（I3） | M | 高 | 週 1 回の Actions（データを書くので cron の再開はユーザー判断）で、主要ノードを 2 本以上引用する新しい論文を `themes/<slug>/new.json` と `feed.xml` に出す。テーマページに「新着」欄。新着は系譜には入れず、次の作り直しの候補にする |
| P1-2 | **コード・HF のリンク**（I8） | S〜M | 中〜高 | 収集時に HF の API と PwC のアーカイブを引き、カタログのカードと系譜のノードに「コード」「HF」のバッジを付ける。帰属表示を「出典とライセンス」に足す |
| P1-3 | **論文詳細に「系譜での位置」**（I4） | S | 中 | カタログの論文がどれかのテーマのノードなら、テーマへのリンクと「拡張された n・置き換えられた n」を出す（今は `pilotLineageHref` のリンクだけ） |
| P1-4 | **似た論文**（I9） | M | 中 | カタログ内の近傍 k=10 を事前に計算して静的に出す。46 の関連度（bge-small）と同じ部品を使う |
| P1-5 | **2 本をつなぐ経路**（I5）と年 × 被引用の表示（I7） | S | 中 | クライアント側だけで作れる。P0-1 のあとに入れる |

### P2（入口を広げる。運用の負担が増えるので R1・R2 が安定してから）

| # | 提案 | 工数 | 効果 | 中身・完了条件 |
|---|---|---|---|---|
| P2-1 | **論文を種にした系譜**（I10） | L | 非常に高 | 依頼フォームで arXiv ID・DOI（1〜5 本）を受け付ける。Worker の検証（存在確認・上限）→ 既存の `theme-on-demand` の経路で生成。トピックゲートは種の要旨の語と埋め込みで作る。公開の基準（fail-closed・未監査の表示）は変えない。最大の価値だが、品質の約束と費用（S2 への問い合わせ）を設計し直す必要がある |
| P2-2 | **要旨の全文検索** | M | 中 | Pagefind か MiniSearch で静的な索引を作る（28,000 本の要旨で数 MB の見込み。分割読み込みにする）。今の「題名・著者・タグ」の検索を置き換えるのではなく、切り替えで使えるようにする |
| P2-3 | **急上昇の語**（I6） | M | 中 | 学会の年ごとにバースト検出をかけ、トップに「急上昇」を出す。語からテーマの依頼に進める |
| P2-4 | **ゲートとルールの強化**（I12・I13・I14） | M | 中（品質） | 書誌結合・共引用の重み、同じ著者の続編の手がかり、PwC の手法の分類から別名の候補を作る。42・43 の評価セットで差を測ってから採用する |

### P3（保留）

- アカウント・保存・メール通知（40 §4 の条件を満たすまで）。代わりに RSS/Atom（P1-1）と共有 URL（P0-3）で済ませる
- コメント・議論（alphaXiv 型）。運営の手間とスパム対策が重い。代わりに Issue（P0-2）を使う
- SOTA のリーダーボード（PwC 型）。CodeSOTA などが既にあるので、リンクだけにとどめる
- LLM による要約・対話。方針により入れない

### 工数と効果のまとめ（2×2）

```text
          効果 高                         効果 中
工数 小   P0-1 本流・P0-2 報告・P1-2 コード  P0-3 書き出し・P0-4 鮮度・P1-3 位置・P1-5 経路
工数 中   P0-5 Prior/Derivative・P1-1 新着  P1-4 似た論文・P2-2 全文検索・P2-3 急上昇・P2-4 ゲート
工数 大   P2-1 論文を種にした系譜            —
```

---

## 5. ロードマップ（40）への当てはめ案

| 40 の段 | 入れる提案 |
|---|---|
| R1（鮮度） | P0-4（鮮度の表示）、P1-1（新着フィード。cron の再開とまとめて判断） |
| R2（系譜の公開） | P0-1（本流。監査で強い関係を確かめる優先順位にも使える）、P0-2（誤りの報告を監査の材料にする）、P0-5、P2-4 |
| R4（検索と使い勝手） | P0-3、P1-3、P1-4、P1-5、P2-2、P2-3 |
| R5（拡張の判断） | P2-1（論文を種にした系譜）、P1-2 の範囲（HF・PwC のデータの扱い） |

---

## 6. 注意点

- **Prior / Derivative と新着は、系譜の辺にしない**。辺には根拠つきの関係だけを置くという今の約束を守るため、別の欄（「候補」「新着」）に分けて出す。
- **ライセンス**: paperswithcode-data は CC-BY-SA 4.0（帰属表示と継承が要る）。HF Papers の API の規約は収集前にもう一度確認する。S2（ODC-BY）・OpenAlex（CC0）は今の表示で足りる。
- **費用**: 新着フィードと Derivative は OpenAlex の `cites:` の問い合わせが増える。テーマ 4 つ・主要ノード 10 本で、週あたり数十 credits の見込み（44 の実測から推定。まだ測っていない）。
- **調査の限界**: 各サービスの機能は公式ページ・ヘルプ・第三者のレビュー（2025〜2026 年）で確かめた。有料機能は実際には使っていない。ResearchRabbit と Litmaps の関係は「提携」とも「買収」とも報じられていて、はっきりしない。

## 出典（主なもの）

- Connected Papers About（共引用・書誌結合、力学レイアウト、S2 のコーパス）: https://www.connectedpapers.com/about
- Litmaps Monitor: https://docs.litmaps.com/en/articles/7948099-search-monitoring
- ResearchRabbit の 2025 年の刷新（Aaron Tay）: https://aarontay.substack.com/p/researchrabbits-2025-revamp-iterative 、公式: https://learn.researchrabbit.ai/en/articles/12440130-welcome-to-the-new-researchrabbit
- Inciteful（Paper Discovery・Literature Connector）: https://inciteful.xyz/ 、https://inciteful.xyz/c
- Local Citation Network: https://github.com/LocalCitationNetwork/LocalCitationNetwork.github.io
- Semantic Scholar の Semantic Reader とリリースノート: https://semanticscholar.org/product/semantic-reader 、https://semanticscholar.org/product/release-notes
- scite Smart Citations: https://scite.ai/reports/scite-a-smart-citation-index-keppkgL5
- HF Daily Papers: https://huggingface.co/blog/daily-papers 、Trending: https://huggingface.co/papers/trending
- PwC の終了と代わりのサービス: https://github.com/paperswithcode/paperswithcode-data/issues/122 、https://blog.tib.eu/2025/10/02/papers-with-code-went-offline-the-knowledge-doesnt-have-to/
- 主経路分析（Hummon & Doreian 1989、SPC）: https://en.wikipedia.org/wiki/Main_path_analysis
- CitNetExplorer・VOSviewer によるクラスタリング: https://arxiv.org/abs/1702.03411
- alphaXiv: https://www.alphaxiv.org/

> 生の取得結果は手元の一時領域に置いたため、リポジトリには入れていない（2026-10-11）。
