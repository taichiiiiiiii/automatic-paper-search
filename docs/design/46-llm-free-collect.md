# 46 収集パイプライン（collect）の LLM 不要化：API と埋め込みでの置き換え（2026-10-11 調査）

対象：`apps/pipeline/src/collect/` の LLM 利用（Stage 4 の再順位付け・日本語要約・理由・タグ、キーワード拡張）。
系譜（lineage）の LLM は別文書で扱う（41 D6・43）。
調査方法：コードの読解、公式ドキュメント、少量の実 API 呼び出し（S2・OpenAlex。生の応答は手元の一時領域に保存し、要点は §4）。LLM API は呼んでいない。
この文書は法的助言ではない。規約は「公式文言＋推奨対応」にとどめる。

---

## 0. 結論（先に）

1. **いま本番で collect の LLM は動いていない**。`data/config/config.yaml` と `config.daily-watch.yaml` はどちらも `llm.enabled: false`、Stage 3 の埋め込みも `enabled: false` で、エンコーダーは配線されていない（`createRunnerDeps.ts` は `overrides.encoder` を渡すだけ）。collect の cron も 2026-06-04 から止まっている（40）。過去の出力（`data/inputs/papers_2026-05-2x.json`）も `llm_*` はすべて null。
   → 置き換えは「動いている機能を外す」のではなく、「**LLM なしで、止まっている Stage 3/4 相当の機能を実際に動かす**」作業になる。
2. **サイト（apps/web）は `llmSummaryJa` / `llmReason` / `llmTags` を一切表示していない**。web 側に参照はゼロ。
   - カタログのタグチップは `catalog/topicRules.ts` の正規表現（`TOPIC_RULES`）から作られている。
   - 系譜ノードは S2 の英語 TLDR をそのまま表示している（`node-card.tsx`・`topics-gallery.tsx`）。
   - LLM 出力の行き先は CSV / JSON（`data/inputs/`）、メール、Slack だけ。**サイトの見た目は今回の置き換えでは変わらない**。
3. 置き換え案（推奨）：
   | 用途 | いま（LLM） | 置き換え（推奨） | 補助・代替 |
   |---|---|---|---|
   | 関連度（1–5 の再順位付け） | `evaluateBatch` の `relevance` | **ローカル bge-small（R2-11 と同じモデル・キャッシュ）でプロフィール文と cos → プール内 z スコア** | S2 `embedding.specter_v2`（API で 768 次元が取れる）と「手本論文」の中心ベクトルの cos |
   | 日本語要約 `summaryJa` | 3 行の日本語要約 | **S2 TLDR（英語 1 文、ODC-BY）を表示し、無ければ要旨の第 1 文** | 機械翻訳（DeepL / Google / Azure の無料枠、またはローカル FuguMT）→ **要決定（MT も ML）** |
   | 理由 `reason` | 自由文 | **シグナルからの定型文**（類似度の順位、一致キーワード、会場、★、フォロー一致） | — |
   | タグ `tags` | 自由語 | **`TOPIC_RULES`（サイトと同じ語彙）＋ OpenAlex の work keywords 上位** | OpenAlex topics（4,516 区分）。S2 `s2FieldsOfStudy` は粗すぎて不採用 |
   | キーワード拡張（手動 CLI） | 同義語・略語の生成 | **OpenAlex `group_by=keywords.id` の共起＋要旨中の略語定義（"Retrieval-Augmented Generation (RAG)"）の抽出**。候補を提示して人が選ぶ | S2 Recommendations API（手本論文 → 新着論文。キーワードではなく候補論文の追加として使う） |
4. **費用・鍵**：いずれも無料枠で足りる。S2 は鍵なしでも batch 1 回で全件取れる（週 30 本程度）。OpenAlex は無料キー（44 で登録済みの前提 `PAPERPILOT_OPENALEX_API_KEY`）で、1 回の実行あたり数十 credits。
5. **上流の ML は残る**：S2 TLDR は S2 のモデル（SciTLDR）が生成した文、SPECTER2・OpenAlex topics/keywords も上流の ML。こちらで LLM を呼ぶことはなくなるが、「ML 生成のテキストを表示する」点は変わらない。TLDR の表示と MT の採否はユーザー決定（§8）。

---

## 1. 現状（コードと運用）

| 場所 | 内容 | 本番での状態 |
|---|---|---|
| `collect/stages/llmRank.ts`（Stage 4） | `provider.evaluateBatch(chunk, profile)` → `llmRelevance`（1–5）・`llmSummaryJa`・`llmReason`・`llmTags` を設定し、`relevance` → `totalScore` の順で並べ替え、`stage4_top_n`（既定 10）件に切る。失敗時は素通し | `llm.enabled: false` のため、**Stage 2 のスコア順で 10 件に切るだけ** |
| `lineage/llm/base.ts` のプロンプト | `{"index","relevance":1-5,"summary_ja":"日本語で3行以内","reason","tags":[...]}` を JSON 配列で要求 | 同上（呼ばれない） |
| `collect/keywordExpand.ts` | `provider.chat()` で同義語・略語・関連語を最大 15 個 → 重複を除いて最大 10 個を追加 | **cron ではなく手動の `expand-keywords` サブコマンド**（`cli.ts`）。`--write` で config.yaml を書き換える。LLM が無いと終了コード 2 |
| `collect/runtime/llmProvider.ts` | `config.llm.provider` で ollama / gemini / claude / groq を構築（lineage の実装を借用） | 上の 2 つ専用。lineage は別の factory を使うので、collect から外しても lineage には影響しない |
| `collect/runner.ts` | Stage 0–4 の制御。`buildProfile()` は `profile.description` か「関心キーワード: …」（日本語の前置き付き）を返す | Stage 3 は `deps.encoder` が無いので、`embedding.enabled: true` にしても `stage3:encoder backend 'minilm' unavailable` を errors に記録するだけ |
| `collect/stages/embedding.ts`（Stage 3） | `title + abstract[:400]` とプロフィールの cos を `(sim+1)/2*100` にして `weight`（2.5）倍で `totalScore` に加算 | 未使用 |
| 出力 | CSV（`llm_relevance, llm_summary_ja, llm_reason, llm_tags` 列）、JSON（同名キー）、メール（「要約:」行）、Slack | CSV / JSON は `data/inputs/`。メール・Slack は無効 |
| apps/web | `llm*` の参照なし。カタログのタグは `TOPIC_RULES`、系譜ノードは S2 TLDR（英語） | — |

---

## 2. 用途ごとの置き換え案

### 2.1 関連度（再順位付け）

**目的**：プロフィール（関心）に近い論文を上に出す。LLM の 1–5 評価の代わり。

| 案 | 中身 | 長所 | 短所 |
|---|---|---|---|
| **A. ローカル bge-small（推奨・主）** | `lineage/theme/topicEmbedding.ts` の埋め込み器（`Xenova/bge-small-en-v1.5` q8、版固定、ディスクキャッシュ）を `AbstractEncoder` として Stage 3 に配線する。プロフィール文にはクエリ用の前置き（`queryPrefix`）を付ける。cos をその実行の候補プール内で z スコア化して加点する | 鍵が要らない。R2-11 と同じ依存・キャッシュ・決定性。自由文のプロフィールがそのまま使える。42 で同モデルが主題判定 P 0.87 / R 0.77 | 英語専用モデル。`buildProfile()` の「関心キーワード:」という日本語の前置きは英語にする必要がある。CI で初回だけモデル（約 34 MB）を取得 |
| **B. S2 SPECTER2（補助）** | S2 `/paper/batch` に `embedding.specter_v2` を足すだけで 768 次元が返る（§4：直近 5 日の arXiv でも 100/100）。プロフィールは「手本論文（`profile.seed_papers`）」の SPECTER2 ベクトルの平均にする | 論文どうしの近さに強い（引用関係で学習）。モデルを持たなくてよい | 自由文のプロフィールは埋め込めない（自由文には `allenai/specter2_adhoc_query` アダプタをローカルで動かす必要がある）。cos の幅が狭い（実測 0.87–0.94）ので z 化が必須。応答が大きい（1 本約 15 KB） |
| C. S2 Recommendations API（候補追加） | `POST /recommendations/v1/papers`（positive / negative の手本、`from=recent`、最大 500 件） | 手本に近い**新着**を直接返す（§4：FlashAttention を手本に 10 件中 9 件が関連） | 順位付けではなく候補の追加。キーワード検索の結果と混ぜる設計が要る |

推奨：**A を Stage 3 の既定**にし、`profile.seed_papers` があるときだけ B の z スコアを足す（例：`z = 0.5·z_bge + 0.5·z_specter`）。C は「手本論文」機能を作るときに追加の収集元として使う。

並べ替え：Stage 4 の「LLM relevance → totalScore」を「totalScore（埋め込みを含む）」だけにする。CSV の互換のために `llm_relevance` 列へ z を 1–5 に割り付けた値を入れるかどうかは §8 の決定事項（推奨は列を `relevance_z` に改名し、`llm_*` 列は空のまま残して 1 リリース後に削除）。

### 2.2 日本語要約（`summaryJa`）

| 案 | 中身 | ライセンス・条件 | 評価 |
|---|---|---|---|
| **A. S2 TLDR（英語、推奨）** | `/paper/batch` に `tldr` を追加。`tldr.text` を「TL;DR（英語）」として表示 | S2 Datasets の tldrs は **ODC-BY**（README「This collection is licensed under ODC-BY」、SciTLDR ベース）。API 規約 §4 で「Semantic Scholar」の帰属表示が必須（サイトは表示済み、44 §5）。再配布（CSV・JSON・メール）も帰属付きで可 | 直近の arXiv で 93–96%、5 月の 60 本で 58/60。約 2 割強は要旨の冒頭とほぼ同文（抽出型） |
| B. 要旨の第 1 文（フォールバック） | TLDR が無いときに arXiv 要旨の第 1 文（または「In this work, we …」を含む文）を出す | arXiv のメタデータ（要旨を含む）は CC0（arXiv の bulk/OAI の説明。**要再確認**）。S2 経由の要旨は ODC-BY だが第三者著作物を含む旨の注記あり。1 文の引用なら 44 §2 の引用要件で扱える | 抽出なので誤りは無いが、背景の文が当たることがある |
| C. 機械翻訳（任意） | A/B の英文 1 文を日本語に訳す | **DeepL API Free**：月 50 万字（公式の usage limits）。**Google Cloud Translation**：月 50 万字無料、超過 $20/100 万字（カード登録が要り、超過は自動課金）。**Azure Translator F0**：月 200 万字（恒久か初年度だけかは二次情報で食い違う → **要確認**）。Google の「Translation LLM」モードは LLM なので使わない（NMT を指定）。**ローカル FuguMT**（`staka/fugumt-en-ja`、Marian、**CC BY-SA 4.0**）は鍵不要だが、Node（transformers.js）で動く ONNX 版の有無は未確認 | 量は小さい：週 10 本 × TLDR 約 200 字 ≒ **月 1 万字未満**。会議カタログ（数千本）に広げると 1 回で 50 万字を超えうる |

推奨：**A＋B（英語のまま、ラベルと UI は日本語）**。系譜ノードが既に英語 TLDR を無翻訳で表示しているので、サイト全体で表示の仕方がそろう。MT を入れるかどうかは決定事項（§8 D2）。入れる場合は「機械翻訳」と明示し、原文を併記して、翻訳結果はキャッシュする（同じ TLDR を再翻訳しない）。

### 2.3 理由（`reason`）

LLM の自由文の代わりに、既にあるシグナルから**定型文**を作る（例）：

> プロフィール類似度 上位 8%（z=+1.6）／一致キーワード: retrieval augmented generation／会場: ICLR 2026（tier 1）／GitHub ★1.2k／フォロー中の著者: …

- 材料：`embeddingSimilarity`（z）、`matchedKeywords`、`venue` / `venueTier`、`githubStars`、`followReason`、`citationVelocity`。すべて `Paper` に既にある。
- 長所：検証でき、作り話（ハルシネーション）が無い。日本語で出せる（定型文なので翻訳が要らない）。
- 短所：「なぜ自分の研究に効くか」の言い換えはできない。

### 2.4 タグ（`tags`）

| 案 | 中身 | 評価 |
|---|---|---|
| **A. `TOPIC_RULES`（推奨・主）** | カタログと同じ正規表現の語彙（LLM, VLM, Diffusion, MoE, GNN, Detection …）を title+abstract に当てる。`catalog/topicRules.ts` の `classifyTags` を再利用 | 決定的。**サイトのタグチップと同じ語彙**なので、将来「今週の論文」をサイトに出すときにそのまま絞り込みに使える |
| **B. OpenAlex work keywords（推奨・補助）** | 1 本あたり最大 5 個。topic に付いた語の候補を BGE-M3 の類似度で絞った上位（OpenAlex Help「Keywords」）。データは **CC0** | 新着でも付く（§4：2026-05 の論文に 6 個）。語は細かく、`score` 付き。arXiv ID / DOI の OR フィルタで 100 本 1 credit |
| C. OpenAlex topics | 4,516 区分（domain → field → subfield → topic）。新しい分類器は title+abstract だけで判定し、引用を使わない（OpenAlex ブログ「Same topics, better assignments」） | 区分名が長い（"Topic Modeling" など）。サイトのタグより粗い。subfield での絞り込み（例：AI）には使える |
| D. S2 `s2FieldsOfStudy` | — | 実測で全件 "Computer Science"。**不採用** |

推奨：`tags = TOPIC_RULES の一致 ∪ OpenAlex keywords（score 上位 3）`。出どころを区別できるよう、JSON では `tags_rule` / `tags_openalex` を分ける（CSV は結合）。

注：OpenAlex の topics の名前付けと、keywords の精度評価には LLM が使われている（Help・ブログに記載）。こちらで LLM を呼ぶわけではないが、上流の ML である点は 2.2 と同じ。

### 2.5 キーワード拡張（`expand-keywords`）

手動の CLI なので、「候補を出して人が選ぶ」形にすれば品質の問題は小さい。

| 案 | 中身 | 評価 |
|---|---|---|
| **A. OpenAlex の keywords 共起（推奨）** | `works?search=<kw>&filter=from_publication_date:<1年前>,primary_topic.subfield.id:<AI 系>&group_by=keywords.id`（1 回 10 credits）。基準（同じ subfield 全体）に対する出現比（lift）で並べる | §4 の実測：RAG で "LLM agents", "hallucination mitigation", "knowledge graphs", "semantic search", "question answering" などが上位。subfield で絞らないと "clinical decision support" のような分野外の語も混ざる |
| **B. 略語定義の抽出（推奨）** | 上位論文の要旨から「長い形 (略語)」を Schwartz–Hearst 型の規則で抜き、同義語・略語の候補にする（RAG ⇔ retrieval-augmented generation、RLHF、DPO …） | 同義語・略語は LLM の得意分野だったが、規則で十分取れる。決定的 |
| C. S2 Recommendations | 手本論文から新着論文を返す | キーワードではなく論文。2.1 C と同じ扱い |
| D. bge-small の近傍 | 上位論文の題名の n-gram を埋め込み、キーワードとの cos 上位を出す | 実装は軽いが雑音が多い。A/B の並べ替えに使う程度 |

推奨：サブコマンド名は残し、中身を A＋B に置き換える。出力は「候補・出どころ・件数」の表で、`--write` は人が `--pick` で選んだ語だけを書く（無条件の自動追記はやめる）。

### 2.6 プロバイダーの撤去

- collect から `llmProviderFactory` / `buildLlmProviderFromConfig` / `llm` 設定ブロックを外す（lineage の provider は別系統なので残る）。
- `collect-weekly.yml` の `PAPERPILOT_GEMINI_API_KEY` / `CLAUDE_API_KEY` を collect のステップから外せる（lineage の再生成ステップは別に参照しているので、そちらは残す）。
- `PaperEvaluation` の型は lineage の `evaluateBatch` 実装が使っているので、型の削除は lineage 側の判断に合わせる。

---

## 3. API・ライセンスの根拠（要点）

| 項目 | 内容 | 出典 |
|---|---|---|
| S2 `tldr` | `fields=tldr` で `{model, text}`。データセット tldrs（58M 件）は ODC-BY、SciTLDR ベース。S2 の説明では「GPT-3 style NLP techniques」で生成した 1 文 | S2 Datasets `release/latest` の README、semanticscholar.org/product/tldr |
| S2 `embedding.specter_v2` | `fields=embedding.specter_v2` で `{model:"specter_v2", vector[768]}`。batch でも取れる（実測）。データセットは Apache-2.0 | 同 README、実測 |
| S2 abstracts / papers | ODC-BY。ただし規約 §2：S2 Data は第三者コンテンツを含み、その権利者の条件にも従う | API License Agreement（2023-05-17）§2、README |
| S2 帰属 | 規約 §4「Licensee will include an attribution to "Semantic Scholar" on its website」。論文では Kinney et al. 2023 を引用 | 同 §4（44 §5 で対応方針あり） |
| S2 Recommendations | `POST /recommendations/v1/papers`（positive / negative）、`GET /papers/forpaper/{id}?from=recent|all-cs`、最大 500 件 | api-docs/recommendations |
| OpenAlex topics | 4 domain → 26 field → 252 subfield → 4,516 topic。work に最大 3 個、`score` 付き。新しい分類器は title・abstract（・venue 名）だけで判定 | help.openalex.org「Topics」、OpenAlex ブログ |
| OpenAlex keywords | topic の語の候補（最大 30）を BGE-M3 の類似度で閾値処理し、上位 5 個を付与。`score` 付き | help.openalex.org「Keywords」 |
| OpenAlex 費用・ライセンス | データは CC0。list+filter 1 credit、search / group_by 付き search 10 credits（実測 cost 0.001 USD）。無料キーで 1 日 10,000 credits | 44 §1、実測 |
| 機械翻訳 | DeepL Free 月 50 万字（公式）。Google 月 50 万字無料・超過は自動課金。Azure F0 月 200 万字（条件は要確認）。FuguMT は CC BY-SA 4.0 | developers.deepl.com usage-limits、二次情報（料金比較記事）、HF モデルカード |

---

## 4. 実測（2026-10-11）

- **S2 の網羅性（arXiv の新着）**：S2 search/bulk で取った CS の arXiv 論文 100 本ずつ。
  | 公開日 | TLDR | SPECTER2 | 要旨 |
  |---|---|---|---|
  | 2026-10-06〜11（直近 5 日） | 93 | 100 | 100 |
  | 2026-09-28〜10-02 | 96 | 100 | 100 |
  | 2026-09-10〜14 | 94 | 100 | 100 |
  | `data/inputs` の 60 本（2026-05/06） | 58/60 | 60/60 | 60/60 |
  → 週次の collect（7 日窓）なら、TLDR は 9 割強、埋め込みはほぼ全件が付いている。日次（1 日窓）は TLDR の付与が遅れる可能性が残る（未計測）。
- **TLDR の性質**：58 本中 13 本は要旨の冒頭とほぼ同文（抽出型）。残りは要約文（例：「BLAgent is presented, a novel agentic RAG framework for file-level bug localization …」）。
- **SPECTER2 の順位の妥当性**：RAG / InstructGPT / Llama 2 を手本にした中心ベクトルで 60 本を採点すると、上位は RAG・幻覚・LLM 評価、下位は動画・医療・生体分子で、目視では妥当。cos の幅は 0.867–0.944（SD 0.020）と狭いので、**絶対値の閾値は使えず z 化が必要**（42 と同じ結論）。
- **OpenAlex keywords**：2026-05-19 の BalanceRAG に 6 個（uncertainty calibration, risk calibration, threshold selection, large language models, open-domain question answering, factuality）。topics は "Topic Modeling" / "Information Retrieval and Search Behavior" / "Adversarial Robustness in Machine Learning" で、keywords より粗くズレもある。
- **キーワード共起**：`search=retrieval augmented generation`（2026 年）の group_by keywords は 1 回 10 credits。上位は妥当だが、分野外（clinical decision support、digital twin）も混ざる → subfield で絞る。
- **S2 Recommendations**：`forpaper/ARXIV:2205.14135?from=recent` は 10 件中 9 件が FlashAttention 系・長文脈推論の 2026-08〜10 論文。

---

## 5. 品質への影響（見込み）

ラベル付きの比較はまだ無い（LLM 版が本番で動いた記録も無い）。以下は見込みで、段階 1 の評価で確かめる。

| 用途 | 失うもの | 得るもの | 見込み |
|---|---|---|---|
| 関連度 | 自由文プロフィールの細かい意図の読み取り（「〜は除く」など否定条件） | 決定性・再現性・無料・上限切れなし。42 で同モデルが主題判定 P 0.87 / R 0.77 | 上位 10 件の選択は大筋で同等。否定条件は `exclude_words` と negative 手本（Recommendations）で補う |
| 日本語要約 | 日本語で読めること、3 行の情報量 | 作り話が無い、原文に当たれる、上限切れなし | **体感の差は最も大きい**。MT を入れれば日本語は戻るが 1 文に縮む |
| 理由 | 文脈に即した説明 | 検証できる根拠 | 「なぜ選ばれたか」の透明性はむしろ上がる |
| タグ | 自由な語 | 統制語彙（サイトと同じ）・絞り込みに使える | 一貫性は上がる。細かさは OpenAlex keywords で補う |
| キーワード拡張 | 一般知識からの言い換え | 実際の文献での共起・略語 | 候補の質は同等以上（人が選ぶ前提） |

---

## 6. 何が変わるか（サイト・出力）

- **サイト（apps/web）**：変化なし。`llm*` を表示していないため。
  - 「仕組み」ページ（how-it-works）は collect の LLM に触れていないので、文言の修正も不要。
  - 将来「今週の論文」ページを作る場合は、TLDR（英語）＋日本語の定型理由＋ `TOPIC_RULES` のタグ、という形になる。系譜ノードの英語 TLDR 表示と同じ見た目にそろう。
- **CSV / JSON（`data/inputs/`）**：列とキーが変わる（§8 D4）。`llm_summary_ja` → `tldr_en`（＋任意で `tldr_ja_mt`）、`llm_reason` → `reason`、`llm_tags` → `tags`、`llm_relevance` → `relevance_z`。parity の fixture（`test/collect/fixtures/parity/*.expected.json`、e2e の expected）を更新する必要がある。
- **メール / Slack**：「要約:」行が「TL;DR:」（英語）または「TL;DR（機械翻訳）:」になる。理由の定型文を 1 行追加する。
- **帰属表示**：S2 TLDR を CSV・メールに載せる場合、出力の末尾（または JSON の meta）に「Summaries: Semantic Scholar TLDR (ODC-BY)」を入れる（44 §5-4 と同じ扱い）。MT を使う場合は提供元の表示条件にも従う。
- **鍵**：collect の LLM 鍵が不要になる。S2 鍵は無くても動く。OpenAlex は無料キー前提。

---

## 7. 段階計画

| 段階 | 内容 | 完了条件 |
|---|---|---|
| **0. 評価セット**（ライブ変更なし） | `data/inputs` の 60 本＋直近 1 週の候補（約 150 本）に「プロフィールに関連 / 非関連」を人が付ける。bge-small・SPECTER2（手本 3 本）・両者の合成で上位 10 件の precision と nDCG を出す。可能なら同じ集合に LLM 版を 1 回だけ当てて比較の基準にする（任意、ユーザー判断） | 数値表を 46 の付録に追記 |
| **1. Stage 3 の配線** | `createRunnerDeps.ts` に bge-small の `AbstractEncoder`（`topicEmbedding.ts` の埋め込み器とキャッシュを再利用）を追加。`embedding.ts` に z スコア化を追加。`buildProfile()` の前置きを英語に | `embedding.enabled: true` で errors に `stage3:` が出ない。決定性テスト（キャッシュあり / なしで同順位） |
| **2. S2 の項目追加** | `S2Source` の `SEARCH_FIELDS` に `tldr` を追加（`embedding.specter_v2` は手本論文を使う場合だけ。応答が大きいので batch で別取得）。arXiv 由来の論文は Stage 2 の後に `/paper/batch` で TLDR を一括補完 | TLDR の付与率をログに出す（9 割を下回ったら警告） |
| **3. Stage 4 の置き換え** | `llmRank.ts` を「enrich」段に置き換え：TLDR / 第 1 文、定型理由、`TOPIC_RULES`＋OpenAlex keywords。並べ替えは totalScore だけ | CSV / JSON / メールの新しい列。parity fixture の更新 |
| **4. キーワード候補** | `expand-keywords` を OpenAlex 共起＋略語抽出に置き換え。`--pick` で選んだ語だけ書く | 3 キーワードでの候補表をテストの fixture に |
| **5. 撤去** | collect の `llm` 設定・`llmProvider.ts`・workflow の不要な鍵を外す。CLAUDE.md / config のコメントを更新 | `pnpm -r typecheck` / テスト / biome が通る |
| 6.（任意）MT | D2 で採用した場合だけ。翻訳結果を `data/state/` にキャッシュ、月の文字数を記録して無料枠で止める（fail-closed で英語に戻す） | 月の使用量がログに出る |

段階 1〜3 は独立に入れられる。段階 0 の数値が悪い場合でも、2・3 の要約・理由・タグは関連度と切り離して進められる。

---

## 8. ユーザーが決めること

| # | 決定事項 | 選択肢（推奨を先頭） |
|---|---|---|
| D1 | 上流の ML 生成テキスト（S2 TLDR）を表示してよいか | (a) 表示する（「Semantic Scholar の自動要約」と明示）／(b) 要旨の第 1 文だけ（ML を一切通さない） |
| D2 | 日本語化 | (a) 英語のまま、UI と理由だけ日本語／(b) MT API（DeepL Free を推奨：カード不要・上限で止まる）／(c) ローカル FuguMT（CC BY-SA 4.0 の扱いと Node での動作を要確認）。MT も ML であり LLM ではない点を承知のうえで |
| D3 | 関連度の方式 | (a) bge-small＋任意で SPECTER2 の手本論文／(b) SPECTER2 だけ（手本論文の指定が必須）／(c) 関連度の再順位付けをやめ、Stage 2 のシグナルだけ |
| D4 | 出力の列名 | (a) 新しい列名にし、`llm_*` は 1 リリースだけ空で残す／(b) `llm_*` の名前のまま中身を入れ替える（誤解を招くので非推奨） |
| D5 | OpenAlex を週次 collect で有効にするか（タグ補助・キーワード候補に必要） | (a) 有効（無料キー、1 回数十 credits）／(b) 無効（タグは `TOPIC_RULES` だけ） |
| D6 | collect の cron を戻すか | 40 R1-2 の決定事項のまま（本文書は再開を前提にしない） |
| D7 | 段階 0 で LLM 版を 1 回だけ比較の基準に使うか | (a) 使わない（LLM 不要の方針を優先、人手ラベルだけ）／(b) 1 回だけ使う |

---

## 付録：参照したファイル

- `apps/pipeline/src/collect/stages/llmRank.ts`、`keywordExpand.ts`、`runtime/llmProvider.ts`、`runtime/createRunnerDeps.ts`、`runner.ts`、`stages/embedding.ts`、`sources/s2.ts`、`cli.ts`、`exporters/{csv,email}.ts`
- `apps/pipeline/src/lineage/llm/base.ts`（評価プロンプト）、`lineage/theme/topicEmbedding.ts`（bge-small）、`catalog/topicRules.ts`
- `apps/web/components/lineage/graph/node-card.tsx`（TLDR 表示）、`apps/web/lib/catalog-*.ts`（タグ）
- `data/config/config.yaml`、`config.daily-watch.yaml`、`.github/workflows/collect-weekly.yml`
- 設計 40・41・42・44
