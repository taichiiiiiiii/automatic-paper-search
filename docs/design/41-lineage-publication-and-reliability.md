# 41. 系譜の公開方針と生成の信頼性

- 決定: 2026-10-10（ユーザーと合意）
- 背景: [40](40-post-cutover-roadmap.md) の R2 で、系譜が 1 件も公開できない原因を調べた結果、作りの問題が 3 つ見つかった
  1. LLM が壊れても誰も気づかない（2026-08 にキー失効・モデル終了。約 2 か月、推測の関係で「成功」していた）
  2. テーマ外の判定が、題名一致などの規則の積み重ねで場当たり的
  3. 「依頼してすぐ生成」と「公開には人手監査が必須」が両立していない（依頼された系譜は永久に公開されない）

## 決定

### D1. 公開方針: 混合

| 区分 | 条件 | 表示 |
|---|---|---|
| 監査済み | 自動検査を通り、かつ人手監査に合格 | 「監査済み」の印。通常の棚に並ぶ |
| 未監査 | 自動検査だけ通った（依頼テーマはまずここ） | 「未監査（自動生成）」と明示。依頼者はすぐ見られる |
| 非公開 | 自動検査に不合格 | 出さない（fail-closed は維持） |

- 人手監査は、厳選したテーマ（トップに並べるもの）だけに行う
- 自動検査は今の機械的な検査（形式・孤立ノード・関係の端点など）に、D3 の分類率と D4 のテーマ外率を加える
- テーマ投稿フォームは、未監査の公開ができるようになった時点で出す

### D2. LLM の調達: 無料枠のまま

- Groq（`openai/gpt-oss-120b`）を主、Gemini の無料枠を予備にする。主が上限・障害のときは予備に切り替える
- 成功した分類はキャッシュし、作り直しで同じ組を聞き直さない
- 1 日の上限に当たったら、残りは翌日に続ける
- **トークン節約（R2-20、ブランチ `roadmap/r2-20-groq-budget`）**: 無料枠は 1 モデルあたり 200K トークン/日の移動窓（1 回あたり実測 約 1,450 トークン、gpt-oss は推論トークンも使う）。次のように使用量を減らす
  - 1 日上限の 429 でも、解除までが 10 分以内なら待ってから続ける（移動窓なので数秒〜数分で空く）。10 分を超える、解除時刻が不明、または 1 回の実行の待ち時間の上限（既定 20 分）を超えるときだけ打ち切る
  - gpt-oss には `reasoning_effort: "low"` と `max_completion_tokens`（1 回答 768、まとめて聞くときは 1 件増えるごとに +256）を送る。上限で切れた回答（`finish_reason: "length"`）は失敗として扱い、読まない。`PAPERPILOT_GROQ_REASONING_EFFORT`・`PAPERPILOT_GROQ_MAX_COMPLETION_TOKENS` で変更できる
  - 引用文の質問は BFS の後に最大 6 組をまとめて 1 回で聞く（`PAPERPILOT_CONTEXT_BATCH_SIZE`）。回答が壊れていたり一部の組が抜けていたりしたら、その組だけ 1 組ずつ聞き直す。キャッシュは組ごと
  - 引用文の質問は `openai/gpt-oss-20b` に先に聞き、120b を予備にする（`PAPERPILOT_GROQ_CONTEXT_MODEL`、`off` で無効）。Groq の料金表では 20b も 120b と別の行で 30 RPM・1K RPD・8K TPM・200K TPD（https://console.groq.com/docs/rate-limits 、2026-10-10 確認。上限はモデルごと）。20b の答えの質は未評価なので、最初の再生成で確認する
  - 規則の結果で関係が変わりようのない組は LLM に聞かない（手順・アブレーションの文、3 件以上をまとめて引用し被引用論文を名指ししない文だけの組）
  - キャッシュの鍵を「質問の意味の版」（`CONTEXT_SEMANTIC_VERSION`・`CLASSIFY_SEMANTIC_VERSION`）と入力データにした（キャッシュ v4）。文言だけの修正では聞き直さない。質問・種類・入力の範囲を変えたときだけ版を上げる。v3 の鍵の答えも読み、v4 に移す
  - 1 回の実行（＝1 テーマ）で使えるトークンを 6 万までにする（`PAPERPILOT_GROQ_RUN_TOKEN_BUDGET`、0 で無効）。使い切ったら Groq を止め、予備（Gemini）か規則に回す
  - 見積もり（引用文の質問、最近の CI の件数、文字数÷4 でトークン換算）: GNN 19 回×1,450 ≈ 27.6K → 約 9.3K、ViT 26.1K → 約 9.8K、FA 27.6K → 約 10.8K（6 組で 1 回 約 3,600 = 1 組 約 600。上限いっぱいでも 1 組 約 690）。しかも 20b の枠を使うので 120b の枠はほぼ減らない。要旨の質問（GNN で 9〜12 回）は 1 回 約 1,450 → 約 1,150。GNN 全体で 42.8K → 約 21K（120b の枠は 約 12K）。変更のない組の再生成は 0

### D3. LLM が使えないとき: 公開を止めて知らせる

- 関係のうち LLM で分類できた割合が **8 割未満** なら、その生成は失敗として扱う。前の版を残し、公開しない
- 失敗は Actions の失敗として見えるようにし、本番の見張り（watchdog）でも知らせる
- 上限切れが原因なら、後で自動的に作り直す

### D4. テーマ外の判定方法: 調査してから決める

- 候補: OpenAlex の topics/concepts、論文の埋め込みの類似度、今の規則、およびこれらの組み合わせ
- 既存 4 テーマの候補論文に人手の正解を付け、精度・再現率・費用・CI での重さで比べてから決める（R2-4）

### D5. 人手監査の範囲: ノード＋強い主張の関係

- ノードは今どおり全件（20 件まで）テーマ内か判定する
- 関係は、`contrasts`・`supersedes` など強い主張のものを全件確認し、誤りがあれば不合格または修正
- 監査記録（`lineage-audit-fixtures-v1`）に関係の判定を加える
- **実装（R2-8）**: 強い主張は方針の `strong_relations`＝`contrasts`・`supersedes`・`extends`・`successor`（画面で系譜の線として見える 4 種類）。ノードの判定には `metadata_ok`（題名・年・著者・識別子が正しいか）と `note` を付けられ、`metadata_ok: false` は不合格。関係の `wrong` は `corrected_relation` があっても不合格（修正は反映しないので、作り直して監査し直す）
  - 監査の下書きは `apps/pipeline/src/lineage/quality/auditDraftCli.ts`。`draft --theme <slug> --out-dir <dir>` で日本語の監査シート（`.audit.md`）と判定欄が空の JSON（`.audit-pending.json`）を作る。監査者は JSON の `on_topic`・`metadata_ok`・`verdict`・`auditor`・`audited_at` を埋め、`import --draft <json>` で監査記録の 1 件に変換する（品質表の判定を試算して表示。`--write` で `lineage-audit-fixtures-v1.json` に追記）。第二審査の見立ては `suggestion` 欄にあり、監査者が `accept_suggestions_for_unset: true` にしたときだけ未記入の欄に使う
    - R2-29（2026-10-11）: シートの冒頭に「まとめ」（ノード・強い関係の種類と根拠の内訳、要確認の数、見立てをすべて採用したときに監査記録が合格するかの試算）を置いた。強い関係ごとに根拠（Semantic Scholar の引用文・arXiv HTML 本文の引用文・引用側の要旨・基礎文献リスト・題名の版）と確認用のリンク（arXiv HTML のページなど）を出し、引用文を使わない規則（基礎文献リスト・題名の版）には「引用文なし」の注意を付けない。掲載先が DBLP の会場キャッシュ（`dblp_venues.json`、`--dblp-cache`）と一致するノードは「（DBLP）」とリンクを付ける。第二審査の見立ては `suggest --draft <json> --from <suggestions.json>` で `suggestion` 欄だけに入れる（判定欄は触らない。下書きにない項目を挙げたファイルは拒む）

### D6. 関係の分類: API 中心、LLM は補助（2026-10-10 追加決定、根拠は [43](43-api-based-relation-evaluation.md)）

- すべての関係を Semantic Scholar の引用文・引用の意図・「影響の大きい引用」の印から規則（43 の v2）で分類する。根拠の引用文を一緒に残す
- LLM には、手がかりの語（「〜を基に」「〜と比べて」など）がある関係と、影響の大きい引用で手がかりがないものだけを聞く。渡すのは要旨ではなく引用文と被引用側の書誌
- LLM が使えなくても規則の分類が残るので、D3 の分類率は保たれる
- 表示は段階的に進める。まず今の種類名（extends・contrasts・baseline_only 等）に対応づけ、理由欄に引用文を出す（形式は変えない）。その後 `lineage-artifact-v2` で 5 種類（builds_on・compares_with・uses_resource・background・cites_unspecified）に切り替える
- Semantic Scholar の無料 API キーはユーザーが申請中（`PAPERPILOT_S2_API_KEY`）。キーがなくても同じデータが取れるが、共有枠で 429 になりやすい
- R2-24（2026-10-11）: テーマの生成は既定で LLM を使わない（`PAPERPILOT_LINEAGE_LLM=off`）。手がかりのない組は参考文献リストで確認した引用（`api_citation`、baseline_only）になる。下の「実装メモ（R2-24）」

### D7. テーマ外の判定: 埋め込みと語の一致の併用（根拠は [42](42-topic-relevance-evaluation.md)）

- 段階 1（基礎論文の一覧や共引用だけでの採用をやめる）と、段階 2（`bge-small-en-v1.5` の埋め込みと語の一致の組み合わせ）の両方を入れる
- モデルや推論が使えないときは語の一致だけに戻り、そのことを成果物の `meta` に記録する
- 入ったら方針の `theme_min_generated_at` を進め、古い規則の成果物を非公開にする

## 作業（40 の R2 を置き換える）

| # | 作業 | 状態 |
|---|---|---|
| R2-4 | テーマ外の判定方法の調査と比較（D4） | 調査済み（[42](42-topic-relevance-evaluation.md)。推奨は小さな埋め込みモデルと語の一致の併用。採否は 43 の結果と合わせて決める） |
| R2-5 | 公開の区分（D1）と監査範囲（D5）: 品質表・core の判定・web の表示・監査記録の形式 | 済み（2026-10-10 develop。Worker の `/api/health` に CORS を追加） |
| R2-6 | LLM の信頼性（D2・D3）: 予備の提供元、分類率の検査、失敗時の自動再実行、見張りへの追加 | 済み（2026-10-10 develop。Gemini のキーは未登録＝予備なしで動作） |
| R2-9 | 関係の種類分けを API（Semantic Scholar の引用意図・引用文など）で行えるかの調査 | 済み（43） |
| R2-10 | D6 の実装（API 中心の関係分類、表示は今の種類名＋引用文） | 済み（2026-10-10 develop。下の実装メモ） |
| R2-11 | D7 の実装（埋め込みによるテーマ外の判定） | 済み（2026-10-10 develop。段階 1＋段階 2、`meta.topic_gate` を記録。評価セットで本番の経路が P 0.87 / R 0.77 を再現。`theme_min_generated_at` はマージ時に進める。詳細は [42](42-topic-relevance-evaluation.md) の「組み込み（R2-11）」） |
| R2-12 | `lineage-artifact-v2`（5 種類＋根拠欄）と web の表示 | R2-10 の後 |
| R2-7 | 依頼フォームの公開と、本番での依頼→未監査公開の通し確認 | R2-5・R2-6 の後 |
| R2-8 | 厳選テーマ（GNN から）の人手監査と「監査済み」公開 | 済み（2026-10-11。4 テーマを Taichi Nakamura が監査し、本番で「監査済み」。シートは `docs/audit/`。作り直すと監査は無効） |
| R2-28 | 引用文の追加の出どころ（arXiv HTML）、Crossref の参考文献、DBLP の会場（[47](47-apis-and-oss.md) 推奨 1〜3） | 実装（2026-10-11、ブランチ。既定は off。下の実装メモ） |
| R2-31 | 第二審査（R2-29）の指摘: Shazeer ← Eigen の contrasts → extends、混ざった OpenAlex 記録（引用の年の逆転）と会議論文の年のずれ | 実装（2026-10-11、ブランチ `roadmap/r2-31-contrast-cue`。下の実装メモ） |
| R2-35 | 依頼テーマ（Low-Rank Adaptation）の品質: QLoRA の欠落と、埋め込みだけで入った古い別分野の論文 | 済み（2026-10-12 merge・本番反映。LoRA 74→75 論文、QLoRA 入り） |
| R2-32 | 会議の系譜を LLM なしで作り、テーマと同じ根拠・検査で公開する（13 会議・14 deep がすべて blocked だった） | 済み（2026-10-12 merge。ICML 2025 を未監査で公開: 138 論文・367 関係。他の会議は 1 つずつ作る） |
| R2-37 | 作り直しで公開中のテーマが非公開になる事故（2026-10-12、LoRA）の再発防止: 自動の作り直しの条件、regen と依頼の引数の一致、公開中より悪い版で置き換えない検査 | 済み（2026-10-12 merge。publish guard・`--match-published`） |
| R2-38 | `extends` の適合率: ベンチマーク・データセット・枠組み・道具・評価手順を「使う」引用文（we adopt / use / follow X）を継承と読まない | 済み（2026-10-12 merge。extends 適合率 0.63→1.00、監査済み 4 テーマは不変） |
| R2-39 | `extends` の手がかりの係り先: 複数の引用を含む文で別の論文に掛かる手がかり、自分の節・表への言及、第三者が主語の extend、公開モデル・学習データ・テンプレート・設定の利用、論文でない記録（"Open Source"）の節点 | 実装（2026-10-14、ブランチ `roadmap/r2-39-cue-target`。NeurIPS 2025 の extends 適合率 0.27→1.00、監査済み 4 テーマは不変。下の実装メモ） |
| R2-40 | 規則で決める強い関係は強い言い回しだけから（D-R2-40）: adopt / use / follow / based on / inspired by などの弱い言い回しでは `extends` にしない | 実装（2026-10-20、ブランチ `roadmap/r2-40-strict-cues`。CVPR 2025 の extends 適合率 0.28→1.00、ICLR 2025 0.17→1.00。公開ファイルは作り直していない。下の実装メモ） |

## 実装メモ（2026-10-10）

- **分類率（D3）の定義**: 関係のうち、根拠のある分類（LLM・Semantic Scholar の引用意図・引用文のパターン・題名の版・基礎論文の一覧）の割合。年と引用だけからの推測（`citation_heuristic`・`year_cite`）だけを「未分類」と数える。根拠の出どころを問わないので、関係の分類を API に切り替えてもそのまま使える
  - 生成時: 8 割未満なら書き出さず、終了コード 5 で失敗（`--min-classified-rate`、方針の `theme_min_evidence_classified_rate`）。上限切れが原因なら `regen-pending.json` に記録し、`regen-retry.yml` が毎日 09:17 UTC に作り直す（最大 5 回）
  - 品質表でも同じ値を `evidence_classified_rate` として検査する（公開済みの古い成果物にも効かせるため）
- **`generator_current`**: 方針の `theme_min_generated_at`（いまは 2026-10-10T05:00:00Z、R2-2d の規則が入った時刻）より前に作られたテーマは公開しない。生成の規則を大きく変えたら、この時刻を進める
- **初回の結果**: 未監査で公開 2（graph-neural-network・mixture-of-experts）、非公開 2（vision-transformer は分類率 45%、flash-attention は古い規則での生成）。監査済みは 0（R2-8 で GNN から）

## 実装メモ（R2-10、D6 の段階 1）

- **流れ**（`apps/pipeline/src/lineage/theme/s2Relations.ts`）: 関係ごとに、引用する側の論文の Semantic Scholar 参考文献（`/paper/{id}/references`、`contexts,intents,isInfluential`）を引き、規則 v2（`classify/apiRelations.ts`。評価と同じコード）で分類する。基礎論文の一覧と題名の版（`foundational_allowlist`・`title_version`）は今までどおり先に決まる
  - 手がかりの語（〜を基に・〜と違い・〜より良い・データを使う、結果表の行）があるか、`isInfluential` で文脈がある関係だけ LLM に聞く。渡すのは引用文（最大 4 文）と被引用側の題名・著者・年（`llm/contextPrompt.ts`、`relation-prompt-v3-context`、R2-16 で v4）。要旨の prompt（`relation-prompt-v2`、R2-16 で v4）
  - 種類名への対応: builds_on→`extends`、compares_with は「〜と違い」の語が被引用側だけを指す（引用文が 1 本だけを引いている）ときか LLM が対比と答えたときだけ `contrasts`、それ以外の compares_with・uses_resource・background→`baseline_only`
  - S2 に引用文も意図もない関係（`cites_unspecified`）と、S2 が引用側を知らない関係は今までの道（`--llm-strict` なら要旨の LLM、使えなければ年と引用の推測＝未分類）
  - LLM が使えないときは規則の結果が残る。来歴の方式は `s2_context_rule`（契約・JSON Schema・web の閉じた集合に追加。分類率では「分類済み」）。理由欄は日本語の一文＋引用文（240 字まで）
  - 無効にするときは `PAPERPILOT_S2_RELATIONS=off`
- **S2 のキャッシュ** `data/state/lineage-cache/s2_references.json`（regen-themes.yml が classifications.json と一緒に昇格。theme-on-demand は昇格しない）
  - 形: `entries[<引用側のグラフ id>] = { s2: <S2 に問い合わせた id（ARXIV:… / DOI:… / S2 id）。null は S2 にない論文>, fetched_at, pairs: { <被引用側のグラフ id>: { i: intents, c: 引用文（最大 4 文×400 字）, f: isInfluential } | null（S2 の参考文献に無い） } }`
  - 生成で実際に聞いた組だけを残す（参考文献を全部残すと 1 本約 40 KB になるため）。90 日（S2 にない論文は 14 日）で期限切れ。ほかの組が必要になったら、その回に 1 度だけ取り直して足す
  - 読み方の例: `jq '.entries["openalex:W…"].pairs' data/state/lineage-cache/s2_references.json`
  - 速さ: 鍵なし 1.1 秒に 1 回、鍵（`PAPERPILOT_S2_API_KEY`、`x-api-key`）あり 1 秒に 1 回。429 は `Retry-After` か 2〜60 秒の指数で待ち、6 回で諦める（その回は「S2 データなし」扱い、キャッシュしない）
- **見積もり**（R2-9 のキャッシュで今の 4 テーマの関係を置き換えた場合）: LLM が動けば分類率はどれも 100%。LLM が止まっても flash-attention 80%（4/5）、graph-neural-network 83%（29/35）、mixture-of-experts 92%（11/12）、vision-transformer 91%（99/109）で、D3 の 8 割を満たす。LLM の呼び出しは 1 テーマあたり 2〜31 回（引用文の prompt 1〜21、要旨の prompt 1〜10）

## 実装メモ（R2-16、関係の根拠の厳格化）

第二審査（`ERROR_PATTERNS` 2・3・4・7・8・9）と UX 確認（P1-4・P1-5）で見つかった誤りを、引用文の扱いで直した。

- **規則 v3**（`classify/apiRelations.ts::classifyApiRelationV3`、本番の `classifyS2Pair` が使う。v1・v2 は評価用に残す）。引用文を 1 文ずつ見る
  - 使える文だけを見る（`classify/citedTarget.ts`）: 参考文献の行（`[17] Tri Dao, …`）、番号だけの文（`[19, 41].`）、40 字未満、番号を除いて英字 25 字未満は捨てる
  - その文が被引用論文を指すかを決める: 題名の前半（コロンの前）・その頭字語（PVT）・最初の単語（Swin）・第一著者の「et al.」、または推定した参考文献番号（参考文献の行、名前の直後の番号、1 本だけを引く文の多数決）が文にあれば「名指し」。1 本だけを引く文も被引用論文を指すとみなす。3 本以上を引いて名指しのない文、別の番号だけを引く文は「背景」まで
  - 否定の手がかりを先に見る: 実験設定の踏襲（`we follow [x] and train …`、`following [x], we use …views`、`same setting as`）、`for (a) fair comparison`、アブレーション（`we also try … in [11]`）、比較語（outperform・surpass・compared with）。これらは `compares_with` か `uses_resource`（どちらも `baseline_only`）で、`builds_on` にはならない
  - 継承の手がかりは引用側が主語のときだけ（we・our・「this paper/work」で始まる文）。`adapted from`・`built upon`・`based on`・`extends` を受け身でも拾い、S2 の意図より優先する（Swin → Video Swin は extends）
  - 比較語は被引用論文を名指ししていれば一人称がなくても比較とみなす（`outperforming PVT-Small [34]`）
  - 「意図＝methodology かつ influential」の弱い規則は、被引用論文を名指しする文があるときだけ
- **contrasts**: 規則で「〜と違い」が被引用論文を名指しする（または 1 本だけを引く）文にあるときだけ。引用文の LLM が対比と答えても、規則側にその手がかりがなければ `baseline_only`。要旨だけの LLM・unarXive の文型・推定の contrasts は `relationGuard` で `baseline_only` に直す（規則 0）。サーベイ・データセットの端点の規則はそのまま
- **引用文の表示**: 規則を発火させた文で、被引用論文を指す文だけを出す。発火した文が出せないとき・背景の規則で該当する文がないときは「被引用論文を特定できる引用文はない。」と書く。引用文の LLM には使える文だけを渡す
- **理由欄**: 規則の理由は題名の短い名前（コロンの前、無ければ 32 字まで）で書く。LLM の理由の「A」「B」「論文 A」「B (名前)」は短い名前に置き換える（`titleizeRationale`）。基礎文献の理由は日本語で、ファイル名を出さない
- **prompt**: 要旨の prompt は `relation-prompt-v4`（contrasts を候補から外す・サーベイは baseline_only のみ・題名の短い名前で書く・例も名前入り）。会議・深掘りの系譜も同じ prompt なので同じ版にした。引用文の prompt は `relation-prompt-v4-context`（両論文の短い名前を渡し、A/B と書かないよう指示）。キャッシュの鍵は prompt 本文の hash と版を含むので、古い答えは使われない
- **基礎文献リスト**: 引用の記録（S2 の意図・引用文）がある組には使わない。BFS では S2 が先（R2-13 から）で、`deriveRelation` でも意図か引用文があればリストの extends を出さない
- **引用と年代だけの推定（`citation_heuristic`）**: 関係を `successor` から `baseline_only` に変えた。契約の関係には「未分類」がなく、`successor` は研究の流れの継承を主張してしまう（Swin → ConvNeXt は競合なのに後継と表示された）。`baseline_only` は「引用しているが継承は主張しない」最も弱い値で、理由欄は「関係の種類は未分類」と書く。分類率（D3）は方式で数えるので変わらない
- **総説の判定**: 掲載誌でも判定する（ACM Computing Surveys、IEEE Communications Surveys & Tutorials、IEEE Signal Processing Magazine、Foundations and Trends、Annual Review of、Nature Reviews など）
- **公開中の 4 テーマでの試算**（S2 キャッシュのみ、LLM なし。`data/published` は書き換えない）: 第二審査で指摘された関係のうち、この作業の範囲の 31 本で正しいものが 5 本 → 31 本。範囲外の 3 本（PVT v2 の版検出、改訂版による逆向き 2 本）は別の作業。contrasts 2 → 0、successor 6 → 1（残りは要旨 LLM の LINE → SDNE）、英語の基礎文献の理由 14 → 0、A/B だけの理由 11 → 0、番号だけの引用文 2 → 0。R2-9 の手作業ラベル 79 本では、builds_on の適合率 6/12 → 4/6、完全一致 60 → 61

## 実装メモ（R2-21、GNN の発展系の関係の取りこぼし）

GNN の系譜（36 ノード・143 辺）が `lineage_relation_share` 0.063（基準 0.10）で止まった。辺を 1 本ずつ見て、規則の取りこぼしを直した。基準は緩めていない。

- **原因の内訳**（143 辺）
  - 総説が引用する側の辺が 43 本ある。`citing_survey` の規則で必ず `baseline_only` になる
  - S2 の組がない辺が 25 本ある。うち 14 本は OpenAlex の誤ったレコード「Advances In Deep Learning On Graphs (GSP'18 Workshop)」(W2964321699) につながる。これは Defferrard の講義資料に ChebNet の被引用 4,973 件が誤って統合されたもので、S2 では引けない。「Identifying Resilient Communities in Road Networks」(2025, 被引用 1,570) も同じく怪しい
  - 正規の起点どうしの辺が欠けている。GAT → GCN と GraphSAGE → GCN がない。OpenAlex の GAT（W2766453196、Cambridge のリポジトリ版）の `referenced_works` に GCN が入っておらず、S2 の参考文献を見るのは OpenAlex の参考文献が空のときだけ（R2-13）だから
  - 引用文が S2 の側で別の文献に付いている例が多い（GCN ← GNN 2009 の「we consider a two-layer GCN」など）。S2 の methodology 意図だけでは、GNN では手作業の 8 本中 0 本が継承だった。v2 で弱い規則を外した判断はそのまま正しい
  - 公開中の発展系の関係 9 本のうち、手作業で正しいと見たのは VGAE ← GCN の 1 本（ARMA ← CayleyNets は判断保留）。誤りは、引用文の LLM が背景・比較・利用の組を extends にしたもの（過平滑化 ← GCN、GAT ← MoNet、GraphLIME ← GraphSAGE、DGCNN ← DCNN）と、要旨の LLM の 2 本（GAT ← PATCHY-SAN、ARMA ← MoNet の successor）
- **規則の修正**（`classify/citedTarget.ts`、`classify/apiRelations.ts`。v3 の中だけで、v1・v2 は変えない）
  - 著者名の書き方を別名に足した。2 人なら「Kipf and Welling」「Kipf & Welling」、3 人なら「Hamilton, Ying, and Leskovec」。「Hamilton, William L.」のような「姓, 名」の形も読む。前は第一著者を「L.」と読み、別名が空になっていた
  - PDF の取り出しで分かれたアクセントをたたむ（「Veliˇckovi´c」→「Velickovic」）
  - 手法名を引用文から読む。被引用論文自身の引用の直前に書かれた名前の形の語を、その組の別名にする。例は「GCN (Kipf and Welling 2017)」「GraphSAGE (Hamilton, Ying, and Leskovec 2017)」、推定番号が 16 のときの「GRAPHSAGE [16]」、「network (GCN) [4]」。題名に手法名のない手法論文（GCN・GraphSAGE・GAT・DiffPool）が多いため。GNN・CNN・MoE などの総称は使わない
  - 適合率のための歯止めを入れた。著者の引用に a/b 付きの年（「Hamilton et al. (2017b)」）があるとき、同じ文に同じ著者が別の年で出るとき（「Kipf & Welling, 2017 … 2016」）は名指しとみなさない。文が引く 1 本が別の著者の著者年引用（S2 が別の文献に付けた文）なら「single」でなく「other」にする
  - 継承の手がかりを足した。「… GCN [21] and DCNN [3] … as particular instances of our approach」（MoNet が先行手法を一般化する）、「our framework subsumes …」、「we use the “mean” variant of GraphSAGE [16]」。「our work … a particular instance of MoNet」は向きが逆なので拾わない
- **試算**（S2 キャッシュと引用文 LLM のキャッシュのみ。新しい LLM 呼び出しなし、`data/published` は書き換えない。公開中の各辺を `deriveS2Relation` に通し直す使い捨てのスクリプトで計算）
  - 4 テーマのうち変わったのは GNN の 1 本だけ。MoNet ← GCN が baseline_only から extends になった（規則 `phrase_build`、引用文は「Such a construction allows to formulate previously proposed … GCN [21] and DCNN [3] on graphs as particular instances of our approach.」）。本番では手がかりのある組なので引用文の LLM にも聞く
  - 割合は GNN 0.063 → 0.070、MoE 0.267、ViT 0.265、FA 0.204（3 テーマは変わらない）。規則の builds_on は GNN 8 → 9 で、ほかのテーマは同数
  - GNN の手作業 30 本（継承 5、継承でない 25）での結果。公開の関係: 適合率 1/7 → 2/8、再現率 1/5 → 2/5。規則だけ: 適合率 2/6 → 3/7、再現率 2/5 → 3/5。増えた誤りはない
- **残る課題**（この作業の範囲外）
  - GNN が 0.10 に届かないのは本当に根拠がないため。数え方を変えて通すことはしなかった。総説が引用する側の 43 本を分母から外すと、ちょうど 10/100 = 0.100 で通る。ただしこの 43 本は規則上いつも `baseline_only` になるので、外すこと自体は筋が通る。それでも、今の発展系の関係はほとんどが LLM の誤りで、外せば誤りの多い系譜が公開されてしまう。変えるなら利用者が決める
  - DiffPool ← GraphSAGE は規則では extends。しかしキャッシュにある引用文 LLM の答え（gpt-oss-20b、「GraphSAGE 実装をベースに利用」）が baseline_only に上書きしている。LLM が誤って extends にする組も 4 本ある
  - 弱い規則（methodology 意図 + influential + 名指し）は FA で誤りが多い（Performer ← Sparse Transformer・Reformer・Longformer、FlashAttention ← Longformer・SMYRF）。FA の 0.204 は、この誤り 5 本を除くと約 0.11 になる
  - 起点どうしの辺の欠けは、OpenAlex の参考文献が空でなくても S2 の参考文献で補えば直る（S2 への問い合わせは増える）。OpenAlex の誤ったレコードは、同一性の検査で落とせば直る

## 実装メモ（R2-22、強い関係の適合率）

D5 の原則を生成側で守るようにした。**強い関係（extends・successor・supersedes・contrasts）は、被引用論文を名指しし、継承・置換・対比の手がかりの語を含む引用文で裏付けられるときだけ出す。それ以外は `baseline_only`（参照（背景））にする。** 公開の基準（`theme_min_lineage_share` 0.10 など）は変えていない。

- **評価用の手作業ラベル**（`apps/pipeline/test/fixtures/lineage-eval/relation-precision-r222.json`、58 本）: 4 テーマで公開中の強い関係すべて（R2-8 の監査の下書きの判定と R2-21 の GNN の手作業）と、規則の難しい例。各辺に S2 の引用文・意図、キャッシュにある引用文 LLM の答え、正解（強い関係として正しいか・引用文で裏付けられるか・引用文）を持つ。`relationPrecisionR222.test.ts` が本番の経路（`deriveS2Relation`＋`guardRelation`）で全件を再判定する
- **規則 v3 の変更**（`classify/apiRelations.ts`・`classify/citedTarget.ts`）
  - 弱い規則（S2 の methodology 意図 + influential + 名指し）は `builds_on` にしない（`background`、規則名 `intent_methodology_influential` は残す）。FA で関連研究の列挙・限界の指摘・実験設定の踏襲を extends にしていた（Performer ← Sparse Transformer・Routing Transformer・Longformer、FlashAttention ← Longformer・SMYRF）
  - 実験設定の踏襲を否定の手がかりに足した: 「model as in Child et al.」（モデルの大きさ・層数の写し）、「hyperparameters directly from [10]」、「subsample … following Hamilton et al.」。「Following [x], we report/accuracy/results」も踏襲
  - 被引用論文が「[8, 15]」のように他の文献と同じ番号の組でしか示されない文の継承の語は数えない（MoCo v3 ← ViT の「based on Siamese networks」）。版の系列名（「FlashAttention algorithms … [2, 3, 4]」で FlashAttention-2）は名指しとみなす
  - 継承の手がかりを 2 つ足した: 文頭の「Following [39], we place the MoEs …」（V-MoE ← GShard。元の規則は大文字の F を拾えなかった）、「Motivated by the Swin Transformer’s [19] success, we propose …」
- **LLM は確認か格下げだけ**（`theme/s2Relations.ts::mergeContextAnswer`）
  - 引用文の LLM は、規則が出した extends / contrasts を確認する（LLM の答えを使う）か、`baseline_only` に下げることしかできない。規則に手がかりがない組の extends は出さず、規則の辺の理由欄に「引用文の LLM は extends と判定したが…採らない」と書き残す。規則の結果が強い関係でない組は LLM に聞かない（省略の理由 `no_strong_claim`。オフラインの再実行で、キャッシュにない問い合わせが 40 → 6 に減る）
  - 規則の extends を LLM が下げてよいか: データで決めた。公開中の 3 例のうち、LLM が「被引用論文の話で、利用・比較だ」と読んだ 2 例（Hash Layers ← BASE「architecture … and hyperparameters directly from [10]」、VR-GCN ← GraphSAGE「subsample … following Hamilton et al.」）は下げて正しく、「被引用論文の話ではない」と答えた 1 例（DiffPool ← GraphSAGE「We use the “mean” variant of GRAPHSAGE [16]」）は誤り。そこで、`refers_to_cited=false` の格下げは、引用文が被引用論文を語（題名・頭字語・著者・手法名）で名指ししているときは無視する。番号だけで示しているときは受け入れる（S2 の付け違いがありうるため）
  - LLM の理由が自分の関係と矛盾する文（extends なのに「対照的にする」）のときは、関係は LLM のまま、理由は規則の文に置き換える
- **要旨だけの LLM などの強い関係**（`theme/relationGuard.ts` 規則 3）: extends・successor・supersedes・ablation は、`s2_context_rule`、引用文の LLM、`title_version`、`foundational_allowlist` のときだけ残す。要旨だけの LLM・`intent_map`・unarXive の文型・推定は `baseline_only` にし、理由欄に元の判定を残す（「引用文の裏付けがないため extends を baseline_only に補正（要旨だけの LLM の判定は参考として残す）。元の判定: …」）。基礎文献リストは引用の記録がない組にしか使われず、ViT の 5 本は監査の下書きですべて正しかったので例外として残した
- **A/B の残り**（`citedTarget.ts::titleizeRationale`）: 「Bは」「のAを」のように仮名・漢字に接した A/B を置き換えていなかった（仮名も Unicode の文字なので「語の一部」と判定していた）。ラテン文字・数字・「_」「-」に接するときだけ語の一部とみなす
- **誤って統合されたレコード**（`theme/nodeIdentityGuard.ts`、`build.ts` で辺の確定後に適用、結果は `meta.suspect_records`）
  - 落とす: 題名が催し・資料（workshop・tutorial・lecture・slides・talk など）か、置き場が Zenodo / Figshare で、かつ被引用が 500 以上。または S2 の被引用数が分かっていて OpenAlex がその 5 倍超かつ 300 超多い。起点（focus）は落とさず印だけ
  - 印だけ: 出版から 2 年以内で年 1,000 件以上引用されている論文
  - GNN では「Advances In Deep Learning On Graphs (GSP'18 Workshop)」（W2964321699、ChebNet の 4,973 件）を落とし、その 14 本の辺も消える。「Identifying Resilient Communities in Road Networks」（2025、1,570 件）は印だけ。S2 の被引用数はまだ生成に渡していない（下の残る課題）
- **試算**（S2 キャッシュと引用文 LLM のキャッシュのみ、新しい LLM 呼び出しなし、`data/published` は書き換えない。使い捨てのスクリプトで公開中の各辺を通し直し、品質表と同じ `themeGateChecks` で判定）

| テーマ | 強い関係 公開中 → 後 | lineage_relation_share 公開中 → 後 | 分類率 | 今の基準での公開 |
|---|---|---|---|---|
| graph-neural-network | 9 → 3（143 → 129 辺） | 0.063 → 0.023 | 0.888 → 0.953 | 非公開のまま |
| mixture-of-experts | 16 → 3 | 0.267 → 0.050 | 0.850 → 0.850 | 未監査で公開 → 非公開 |
| vision-transformer | 13 → 9 | 0.265 → 0.184 | 0.878 → 0.878 | 未監査で公開のまま |
| flash-attention | 11 → 4 | 0.204 → 0.074 | 0.944 → 0.944 | 未監査で公開 → 非公開 |

  - 残る強い関係は 19 本すべて手作業で正しい: GNN は VGAE ← GCN・MoNet ← GCN・DiffPool ← GraphSAGE、MoE は Expert Choice ← Shazeer・V-MoE ← GShard・GShard → Expert Choice（contrasts）、ViT は TransUNet・Video Swin・Swin-Unet・Swin V2（supersedes）と基礎文献リストの 5 本、FA は版の 3 本と Blackwell ← FlashAttention-2
  - 手作業ラベルでの適合率（判断保留 1 本を除く）: 公開中 29/48 = 0.60 → 19/19 = 1.00。正しい強い関係 31 本のうち残るのは 19 本（引用文で裏付けられる 14 本はすべて残る。消えた 12 本は引用文の手がかりがない、引用文がない、または S2 にない組: Eigen → Shazeer、MMoE 系 4 本、GShard → Switch、Shazeer → V-MoE、Swin ← ViT、ViViT ← ViT、MoCo v3 ← ViT、SwinIR ← Swin、FlashDecoding++ ← FlashAttention）
  - **分類率（D3）は下がらない**: `classificationGate.ts` は方式で数え、`citation_heuristic`・`year_cite` だけを未分類とする。規則の `baseline_only`（`s2_context_rule`）も、補正した要旨の LLM（方式 `llm` のまま）も分類済み。GNN が上がるのは、落としたレコードの 14 本のうち 10 本が推定の辺だったため
- **残る課題**
  - MoE と FA は作り直すと `lineage_relation_share` で非公開になる（基準は変えていない）。D5 の原則どおりの結果で、裏付けのない強い関係を基準を通すために残すことはしなかった。公開に戻すには、引用文の取りこぼし（MoE で S2 に引用文がない組、「inspired by [54] … [26]」のように 2 本を引く文）を減らすか、基準そのものを利用者が見直す
  - 生成の規則が変わったので、作り直してから `theme_min_generated_at` を進める（skill の手順どおり。この作業では進めていない）
  - S2 の被引用数を同一性の検査に渡していない（S2 の参考文献の取得は被引用側の `citationCount` も返すが、キャッシュに残していない）。テーマ外のノード（FA の DeepSeek-V3.2、ViT のレーダーの論文、MoE の Conditional Channel Gated Networks）はこの検査の対象外で、話題の判定（D7）の課題

## 実装メモ（R2-23、引用文で裏付けられる強い関係の取りこぼし）

R2-22 の後、手作業ラベルで正しい強い関係 31 本のうち残るのは 19 本だった（適合率 19/19）。**適合率を保ったまま、引用文（または引用元の論文自身の文）で裏付けられる強い関係を拾い直した。** D5 の原則（被引用論文を名指しし、手がかりの語を含む文が必要）と公開の基準（`theme_min_lineage_share` 0.10）は変えていない。LLM の新しい呼び出しはしていない。S2 と OpenAlex への問い合わせは調査用に少量（参考文献の再取得 103 件、被引用側の /citations 2 件、OpenAlex の要旨 2 件、S2 の著者 8 件のバッチ）で、結果は作業用のディレクトリに置き、`data/state` は書き換えていない。

- **調べたこと（作業の指示 a〜e）**
  - (a) S2 は 1 組に引用文を何本も返す（再取得した 304 組のうち 78 組が 5 本以上、最大 21 本）。キャッシュが **4 本で切っていた**ため、裏付けの文が落ちていた（ViViT ← ViT「We propose … inspired by … [18]」、MoCo v3 ← ViT「our modified ViT」、Swin ← ViT の対比の文はどれも 5 本目以降）。被引用側の `/citations` は同じ引用の記録を返すだけで、文は増えない
  - (b) 複数の文献を引く文: 被引用論文の番号が推定できないと「inspired by [54] who … [26]」を名指しと判定できなかった。文脈どうしで共通の番号がちょうど 1 つならそれを被引用論文の番号とする（V-MoE ← Shazeer で 54）。逆に、手がかりの語が別の文献にかかる文（「prior works [8, 15] …, we study the frameworks that are based on Siamese networks, including MoCo [19]」の [15]、「… pooling layers based on the Graclus method [16]」の ChebNet）を除くため、**手がかりの語から節の終わり（「.」「;」）までに被引用論文の名前か番号があること**を条件にした（番号だけで示し複数の文献を引く文では、手がかりの直後の番号の組に含まれること）。「GCN [26] … as particular instances of our approach」は被引用論文が手がかりの前に来る型なので例外
  - (c) 手がかりの語: 既存の規則が「builds upon」「based on」「adopt」「extend」「variant of」をすでに持っていた。足したのは「our modified ViT」（自分の改変版として名指し）、対比の主語としての引用元の自称（題名の「:」の前。「These merits make Swin Transformer suitable …, in contrast to previous Transformer based architectures [19]」）、文頭の「While / Whereas X …, we / our …」の対比。自称は継承の主語には使わない（「… a special case for GShard」「the Swin Transformer is manually adapted from a standard Transformer」のように目的語であることが多い）
  - (d) 要旨: 引用文に強い手がかりがないとき、**引用元の論文自身の要旨の 1 文**が被引用論文を語で名指しし、手がかりの語の句（次の「,」まで）にその名前があれば根拠にする（規則名 `abstract_build` / `abstract_contrast`、方式は `s2_context_rule` のまま、理由欄は「（引用元の論文の要旨から規則で判定）。要旨: "…"」）。要旨は生成側がすでに持っている OpenAlex の要旨（転置索引から復元）で、新しい取得はしない。S2 の要旨は出版社が伏せることがあるので使わない。表示は引用文と同じく 1 文・約 300 字で、サイトは出典を「新しい論文の要旨」と表示する（`apps/web/lib/lineage/evidence.ts`、how-it-works にも一文を足した）。引用文の LLM は要旨を見ないので、要旨の根拠の辺には聞かない（省略の理由 `abstract_evidence`）
  - (e) 版の違い: S2 は arXiv 版と会議版を 1 件にまとめていた（Switch・PVT・Segmenter・ShiftViT はどれも 1 件で、引用文 0 本）。版をまたいで集めても増えない。MMoE（KDD 2018）と AdaMV-MoE（ICCV 2023）など**出版社が参考文献を伏せている論文**（`data: null`、再取得した 103 件中 6 件）は引用元側から取れない。被引用側の `/citations` には引用文があった（MMoE ← Eigen は Eigen の被引用 501 件の中にある）が、文は「… is inspired by the MoE model [21] and the recent MoE layer [16, 31]」で主語が切れ、番号の組を Shazeer と共有するので裏付けにならない。被引用数の多い論文（ViT など数万件）では 10 ページでも探し切れないので、実装はしていない
- **実装**（`classify/apiRelations.ts`・`classify/citedTarget.ts`・`theme/s2Citations.ts`・`theme/s2Relations.ts`）
  - S2 のキャッシュは 1 組あたり最大 12 本・各 400 字（以前は 4 本）。4 本以上を新しい上限で保存した組には `x: 1` を付け、印のない 4 本の組は次の生成で引用元の論文を 1 回だけ取り直す（取り直せなければ保存済みの 4 本を使う）。今のキャッシュでは 57 件の引用元が対象。`s2 citations summary` に `context refreshes=` を足した
  - **引用文を増やすと既存の規則の誤りも増える**ので、同時に否定の手がかりを足した: 実験のための構造の写し（「We use the same architecture as Kipf & Welling (2017)」）、データセットごとの設定の行（「PPI and Reddit: We use …」）、学習の手順（「We adopt learning rate warmup [16] for 40 epochs」）、分析・計測の手順の踏襲（「we follow Brown et al. (2020) and include all adjectives … our analysis」「we measure the runtime … following [20]」）、「Based on DeiT and Swin, we systematically analyze …」、「We use … similar to MobileNetV3 and LeViT」。ほかに、他の文献と共有する番号の組での対比は対象を特定しない（「Unlike CNN backbone networks [53, 21] …」）、「us-ing」（PDF の改行のハイフン）の us を一人称にしない、「we propose a strong baseline model SwinIR」の baseline を比較とみなさない
  - LLM の答えが規則と別の強い関係のとき（Shazeer ← Eigen: 規則は contrasts、キャッシュの LLM は extends）の理由欄の注記を「規則の手がかり … がない」から「食い違う」に直した（関係は R2-22 どおり baseline_only）
- **評価用の手作業ラベル**（`test/fixtures/lineage-eval/relation-precision-r223.json`、`relationPrecisionR223.test.ts`）: R2-22 の 58 本を 12 本の引用文と要旨の全文で更新し、新しく見えた文で裏付けられる 6 本を判定し直した（V-MoE ← Shazeer、Swin ← ViT、MoCo v3 ← ViT、ViViT ← ViT、SwinIR ← Swin、Shazeer ← Eigen）。公開中の辺 1 本（Switch → Expert Choice の contrasts、正）を足した。さらに、再取得した参考文献の中で R2-23 の規則が強い関係を変える組から 19 本を手作業で判定して `rule_cases` に入れた（規則の変化から選んだので難しい例に偏る）。R2-22 の 4 本の信号での回帰は `relationPrecisionR222.test.ts`（19 → 21 本、適合率 1.00）

| ラベル | R2-22 の規則 | R2-23 の規則 |
|---|---|---|
| R2-22 の 58 本（4 本の引用文） | 19/19（適合率 1.00）、再現率 19/31 | 21/21（1.00）、21/31（V-MoE ← Shazeer、SwinIR ← Swin） |
| 更新した 59 本（12 本の引用文＋要旨） | 23/23（1.00）、23/32 | **25/25（1.00）、25/32**（引用文で裏付けられる正しい関係 20/21） |
| rule_cases 19 本 | 5/14（0.36） | 7/8（0.88） |
| 合計 78 本 | 28/37（0.76） | **32/33（0.97）**、32/39 |

  - R2-22 の規則のまま引用文を 12 本にすると、rule_cases で誤りが 9 本出る（上の否定の手がかりが要る理由）。R2-23 の誤り 1 本は MAE の「Following [15], we adopt an extra BatchNorm layer」で、実装の細部の踏襲を V-MoE の「Following [39], we place the MoEs on every other layer」（設計の採用、正）と規則で見分けられない（本番では引用文の LLM が確認する対象）
  - 残る取りこぼし 7 本: FlashDecoding++ ← FlashAttention（手がかりの文なし）、MMoE 系 3 本と AdaMV-MoE ← Expert Choice（参考文献が伏せられている、または背景だけ）、Switch ← GShard（引用文 0 本）、Shazeer ← Eigen（規則と LLM の食い違い）
- **広い範囲の確認**（公開中の辺以外も含む、規則だけ）: 再取得した 97 件の参考文献 5,122 組（引用文のある組）で、R2-22 の規則＋4 本と R2-23 の規則＋12 本＋要旨を比べると 36 組が変わる。新しい強い関係 17 本のうち手作業で正しいのは 15 本（誤りは上の MAE と、「But different from RPE …」を Swin の対比とした 1 本）。強い関係から外れた 19 本はどれも誤りだった（データセット・比較実験の相手・「skip connections を適用できる」・複数の文献の対比など）
- **試算**（公開中の各辺を通し直し、品質表と同じ `themeGateChecks`。R2-22 と同じく落とすレコードを除く。A は今のキャッシュの 4 本の引用文、B は 12 本に取り直した引用文と OpenAlex の要旨。新しい LLM 呼び出しなし、キャッシュにない引用文 LLM の答えは規則のまま）

| テーマ | 強い関係 R2-22 後 → A → B | lineage_relation_share R2-22 後 → A → B | 今の基準での公開（B） |
|---|---|---|---|
| graph-neural-network | 3 → 3 → 3 | 0.023 → 0.023 → 0.023 | 非公開のまま |
| mixture-of-experts | 3 → 4 → 5 | 0.050 → 0.067 → 0.083 | 非公開のまま |
| vision-transformer | 9 → 10 → 13 | 0.184 → 0.204 → 0.265 | 未監査で公開 |
| flash-attention | 4 → 4 → 4 | 0.074 → 0.074 → 0.074 | 非公開のまま |

  - 増えた 6 本はすべて手作業で正しい: V-MoE ← Shazeer（extends）、Expert Choice ← Switch（contrasts）、Swin ← ViT（contrasts）、MoCo v3 ← ViT・ViViT ← ViT（extends）、SwinIR ← Swin（要旨、extends）。分類率は変わらない（GNN 0.953、MoE 0.850、ViT 0.878、FA 0.944）
  - 本番では引用文が増えた組の引用文 LLM の問い合わせはキャッシュに当たらない（入力が変わる）。聞くのは規則が強い関係を出した組だけなので、4 テーマの試算で 9 件
- **残る課題**
  - MoE（0.083）・FA（0.074）・GNN（0.023）はまだ基準に届かない。MoE は参考文献が伏せられた論文（MMoE・AdaMV-MoE）と引用文のない組（Switch ← GShard）、FA は版の系列（FA-2/3）以外の辺に継承の文がないことが原因で、規則で拾える裏付けの文は残っていない。基準を下げるか、引用元の本文（arXiv の LaTeX、design 44 §3）から文を取るかは利用者の判断
  - 生成の規則と S2 キャッシュの形が変わったので、テーマを 1 本ずつ作り直してから `theme_min_generated_at` を進める（この作業では進めていない）
  - 文脈から読む手法名が部品の略称を拾うことがある（SwinIR の「Swin Transformer layer (STL) [56]」から「STL」を Swin の名前とみなし、「We show the effects of … STL number」を引用文に選ぶ）。強い関係には影響しないが、背景の辺の引用文の選び方の課題

## 実装メモ（R2-24、LLM なしの系譜生成）

利用者の方針「系譜は LLM なしで、API（Semantic Scholar の引用文・意図・isInfluential、OpenAlex の参考文献、題名の版、基礎文献リスト）で作る」を、テーマ・会議・深掘りの 3 つの生成で選べるようにし、**テーマの既定を LLM なしにした**。D5（強い関係は被引用論文を名指しする手がかりの文が要る）と公開の基準（分類率 0.8、`theme_min_lineage_share` 0.10）は変えていない。新しい LLM 呼び出しはしていない。S2・OpenAlex への新しい問い合わせもしていない（R2-23 で取った作業用キャッシュで試算）。

- **LLM を呼んでいた所**（2026-10-11 の develop）

| 生成 | 呼び出し | 決めていたこと | 前の「LLM なし」の扱い |
|---|---|---|---|
| テーマ | 引用文の prompt（`theme/s2Relations.ts`、`relation-prompt-v4-context`、gpt-oss-20b、6 組ずつ）。BFS・被引用側・遅延分・ノード間の辺のすべての組（`bfs.ts::classifyPair`、`applyDeferredS2Relations`） | 規則の extends / contrasts を確かめるか baseline_only に下げるだけ（`mergeContextAnswer`、R2-22 から作ることはできない） | 規則の結果がそのまま残る |
| テーマ | 要旨の prompt（`llm/base.ts` の `classifyRelation`、`classify.ts::deriveRelation`、`--llm-strict ambiguous` のとき）。S2 に組がない・引用文も意図もない組 | 関係の種類。ただし強い関係は `relationGuard` の規則 0・3 で baseline_only に直るので、実質は「辺を残すか（unrelated・低い確信度なら捨てる）」と、分類率で未分類に数えられないこと | 年と引用の推測 → `citation_heuristic`（未分類）。年が 6 年以上離れた組は辺なし |
| 会議（`conference/buildLineage.ts`、collect-weekly） | 要旨の prompt（`classifyCachedV2`） | 関係の種類 | 失敗時は `deriveRelation` の推測。鍵がなければ workflow が生成をやめて前回を残す |
| 深掘り（`deep/buildDeepLineage.ts`） | 要旨の prompt（`completeJson`） | 関係の種類 | 失敗した組は辺なし。鍵がなければ `buildProvider` が投げて生成できない |
| 会議（OpenAlex 版、`buildConferenceLineage.ts`） | なし | — | すべて `citation_heuristic` の successor 0.4（下の残る課題） |

- **切り替え**: `PAPERPILOT_LINEAGE_LLM=on|off`（`lineage/shared/lineageLlm.ts`、on/off 以外は誤りとして止める）。テーマの CLI は `--lineage-llm on|off` が優先で、無指定は **off**。off のときは `--llm-strict` を無視して（標準エラーに書く）プロバイダを作らない（LLM の鍵が要らない）。会議・深掘りは無指定なら on のまま（評価していないため）で、off のときはプロバイダを作らず S2 の引用文（`s2_references.json` のキャッシュを共有）で分類する。成果物の `meta.lineage_llm` に `off` を記録する
- **LLM なしの分類**（`theme/noLlmRelation.ts`、テーマの BFS と会議・深掘りで共通）: 題名の版 → S2 の引用文・意図の規則（`deriveS2Relation`、LLM なしなので規則の結果が確定）→ LLM を使わない規則（`deriveRelation`: unarXive の文型・S2 の意図・基礎文献リスト）→ 残りは新しい方式 **`api_citation`**
  - `api_citation` は「参考文献リストで引用を確認した。関係の種類を述べる引用文はない」という辺で、関係はいつも `baseline_only`（参照/背景）、確信度 0.5、理由欄は「〜は〜を引用している（OpenAlex / Semantic Scholar の参考文献リストで確認。関係の種類を述べる引用文はないため参照/背景として扱う）。」。前の推測（`year_cite` → `citation_heuristic`）と、年が離れていて推測もなかった組（LLM ありなら要旨の prompt に聞いていた組）がこれになる。S2 が影響の小さい引用（`isInfluential: false`）とした組は前と同じく捨てる
  - 出すのは S2 の問い合わせが答えた組だけ（`citationListSource`）: S2 の参考文献にある組（出どころ Semantic Scholar）、S2 が引用側の参考文献を持つがこの組がない・S2 に引用側がない組（出どころは BFS が取ったリスト、ふつうは OpenAlex）。**S2 にその回つながらなかった組（`fetch-failed`）と、S2 の関係分類を切っているとき（`PAPERPILOT_S2_RELATIONS=off`）は前のまま `citation_heuristic`**。引用文を読んでいないのに読んだように見せないため
  - 契約・JSON Schema（v1・v2）・web の閉じた集合・監査の内訳に `api_citation` を足した。web の表示名は「参考文献リスト（引用の事実のみ）」
- **分類率（D3）の数え方**: `api_citation` は「分類済み」に数える。主張は「引用している」だけで、それは参考文献リストという API の記録で裏付けられているので、主張と根拠が合っている。未分類（`citation_heuristic`・`year_cite`）として残るのは、LLM ありで LLM が答えなかった組と、LLM なしで S2 に届かなかった組で、どちらも本当に「読むべき根拠を読めなかった」組。S2 が落ちた回は分類率が下がって生成が止まり（終了コード 5）、前の版が残る。生成時のログに `citation-only (api_citation)=N` と `lineage-llm: off — api_citation=…, s2_unreachable=…` を出す（`ClassifiedRate.referenceOnly`）。系譜として意味のある関係が少ないグラフは、これまでどおり `lineage_relation_share` が止める
- **引用文の LLM の下げを規則で置き換え**: R2-22 で LLM の下げが正しかった 2 本のうち、VR-GCN ← GraphSAGE は R2-23 の規則（「subsample … following Hamilton et al.」などの設定の踏襲）で既に baseline_only。Hash Layers ← BASE Layers は「we adopt the BASE Layer setup [10] and code base」が `we … adopt` の継承の手がかりに当たっていたので、**他の研究の実験設定・コードベースを使う文**（`adopt/use/reuse/borrow … setup / code base / experimental setting`）を否定の手がかり（`phrase_protocol`）に足した。再取得した参考文献 5,122 組で規則だけを比べると、変わるのはこの 1 組だけ
- **手作業ラベルでの比較**（`relationPrecisionR224.test.ts`。強い関係の適合率・再現率。「LLM あり」はキャッシュの引用文 LLM の答えを使う本番の経路）

| ラベル | LLM あり | LLM なし（R2-24 の規則） | LLM なし（規則の追加前） |
|---|---|---|---|
| R2-22 の 58 本 | 21/21（1.00）、再現率 21/31 | 22/22（1.00）、22/31 | 22/23（0.96、Hash Layers が誤り） |
| R2-23 の 59 本 | 25/25（1.00）、25/32 | 26/26（1.00）、26/32 | 26/27（0.96） |
| R2-23 の rule_cases 19 本 | 7/8（MAE の 1 本が誤り）、7/7 | 同じ | 同じ |

  - 違いは Shazeer ← Eigen の 1 本だけ: 規則は「While Eigen et al. (2013) uses two stacked MoEs …, our convolutional application of the MoE allows …」を名指しの対比として contrasts にする。LLM ありではキャッシュの答え（extends）と食い違うので baseline_only だった。手作業ラベルは強い関係（種類は extends）なので強い関係としては正しいが、**種類は一致しない**（種類まで合う数は LLM あり・なしとも 24）。監査では種類の違いとして見つかる
- **4 テーマの試算**（公開中の各辺を通し直し、品質表と同じ `themeGateChecks`。R2-23 で 12 本に取り直した S2 キャッシュと要旨、落とすレコードを除く。「LLM あり」は今の develop の規則＋キャッシュの答え、R2-24 の規則でも同じ数）

| テーマ | 強い関係 LLM あり → なし | lineage_relation_share | 分類率 | 今の基準での公開（LLM なし） |
|---|---|---|---|---|
| graph-neural-network（129 辺） | 3 → 4 | 0.023 → 0.031 | 0.953 → 1.00 | 非公開のまま（関係の割合） |
| mixture-of-experts（60 辺） | 5 → 6 | 0.083 → 0.100 | 0.850 → 1.00 | 未監査で公開（ちょうど基準） |
| vision-transformer（49 辺） | 13 → 13 | 0.265 → 0.265 | 0.878 → 1.00 | 未監査で公開（変わらず） |
| flash-attention（54 辺） | 4 → 4 | 0.074 → 0.074 | 0.944 → 1.00 | 非公開のまま（関係の割合） |

  - 強い関係の違いは 2 本: GNN の MoNet ← DCNN（規則の extends「… GCN [26] and DCNN [2] on graphs as particular instances of our approach」。キャッシュの LLM が「利用している」として下げていたが、手作業ラベルは extends で正しい）と、MoE の Shazeer ← Eigen（上の contrasts。種類は手作業ラベルと違う）。MoE が基準ちょうどに届くのはこの 1 本による
  - 方式の内訳（LLM なし）: GNN は `s2_context_rule` 117・`api_citation` 26（S2 にある組 8、S2 の参考文献に無い組 18）、MoE は 39・21、ViT は 36・7（ほかに基礎文献 5・題名の版 1）、FA は 48・3（題名の版 3）。LLM ありで要旨の LLM の答えだった辺と `citation_heuristic`（GNN 16・MoE 9・ViT 6・FA 3）はすべて `api_citation` に、引用文 LLM の答えだった辺は規則の結果になった（LLM ありの `llm` は GNN 11・MoE 16・ViT 1）
  - 試算は公開中の辺の集合のまま。本番の LLM なしの生成では、LLM ありなら要旨の LLM が捨てていた組（unrelated と答えた組）も `api_citation` として残るので、辺は少し増えうる（試算できない）。試算では S2 に届かない組がないので分類率は 1.00 だが、本番で S2 が 429 で落ちた組は `citation_heuristic` のままになる
- **workflow**: regen-themes.yml と theme-on-demand.yml の生成の段に `PAPERPILOT_LINEAGE_LLM: ${{ vars.PAPERPILOT_LINEAGE_LLM || 'off' }}` を置いた。LLM の鍵（Groq・Gemini）は env に残るが、off では読まれないので登録がなくても動く。リポジトリ変数を `on` にすれば前の LLM の経路に戻る。`--result-json` に `lineage_llm` を足し、`regenPending.ts` は `lineage_llm: off` の回を上限切れとして記録しない（off では LLM の上限に当たらないので、regen-retry.yml は何も再実行しない）。collect-weekly.yml の会議の系譜は `vars.PAPERPILOT_CONFERENCE_LINEAGE_LLM || 'on'`（既定は今まで通り）で、off のときは「LLM の鍵がなければ生成しない」見張りを飛ばし、S2 の鍵を渡す
- **テスト**: `noLlmRelation.test.ts`（`api_citation` の形・契約・分類率、出してよい条件、BFS での振る舞い）、`noLlmBuilders.test.ts`（会議・深掘りでプロバイダを作らない、引用文の規則と `api_citation`）、`relationPrecisionR224.test.ts`（上の表、Hash Layers の規則）、`classificationGate.test.ts`（CLI の既定・環境変数・誤記、regen-pending）、`build.test.ts`（off でプロバイダを作らない、S2 なしなら分類率で止まる）、workflow の env
- **残る課題**
  - 生成の規則が変わったので、テーマを 1 本ずつ LLM なしで作り直して確かめ、そのあと `theme_min_generated_at` を進める（この作業では作り直しも時刻の変更もしていない）
  - MoE が基準に届くのは種類の食い違う Shazeer ← Eigen の contrasts による。監査で種類が違うと判定されれば監査は通らない（作り直しが要る）
  - 会議・深掘りの既定は LLM ありのまま。LLM なしにするには会議の系譜を 1 つ作り直して比べる（S2 の参考文献を引用側ごとに 1 回引くので、鍵なしでは時間がかかる）
  - OpenAlex 版の会議の系譜（`buildConferenceLineage.ts`）は根拠なしに successor 0.4 を出している。`api_citation`（baseline_only）に変えるのが筋だが、公開中の会議の成果物が変わるので別の作業にする

### R2-25 公開の構造検査を「割合」から「本数」へ（2026-10-11）

- `lineage_relation_share`（発展系の関係が全体の 10% 以上、R2-17）をやめ、`lineage_relation_count`（発展・後継・置き換え・対立・ablation が 3 本以上、方針の `theme_min_lineage_edges`）に替えた。方針に `theme_min_lineage_share` を書いた場合だけ、割合の検査も行う
- 理由: R2-22 以降、強い関係は名指しと手がかりの語を含む引用文（または題名の版・基礎論文の一覧）がある場合だけ付く。正直に作ると大半は「参照（背景）」になり、割合は引用の多さで決まって質を表さなくなった（R2-23 の手元の作り直しで MoE 8.3%・FA 7.4%・GNN 2.3%、強い関係の正しさは 97%）。「総説の周りの背景だけの星形」を落とすという元の目的は、本数の下限で満たせる
- 同時に `theme_min_generated_at` を 2026-10-11T02:14:52Z に進めた。R2-22〜R2-24 の前に作った版（誤った「発展」を含む）は、作り直すまで公開しない
- ユーザーの判断: 2026-10-11（「根拠付きの強い関係が 3 本以上」案を承認）

## 実装メモ（R2-28、arXiv HTML の引用文・Crossref の参考文献・DBLP の会場）

[47](47-apis-and-oss.md) の推奨 1〜3 を、LLM なしの系譜生成に**選んで使える追加の根拠**として入れた。D5（強い関係は被引用論文を名指しし、手がかりの語を含む引用文が要る）と公開の基準は変えていない。LLM は使っていない。3 つとも**既定は off**（CI ではリポジトリ変数で `on` にする）で、1 実行あたりの上限がある。

- **arXiv HTML の引用文**（`theme/arxivHtml.ts`・`theme/arxivHtmlSource.ts`、`s2Relations.ts::deriveS2Relation`）
  - 対象は「S2 の組に使える引用文がない」組だけ: S2 が組を持つが文が 0 本（または使える文がない）、S2 の参考文献にない、S2 に引用元がない。S2 に届かなかった組（`fetch-failed`）は対象外（R2-24 の止める仕組みをそのまま残す）
  - 引用元の arXiv ID: ノード自身の ID → S2 の問い合わせ ID（`ARXIV:…`）→ S2 の `externalIds`（引用元 1 本につき 1 回、`s2_references.json` の項目に `ax` として保存）
  - `https://arxiv.org/html/<id>`（LaTeXML）を取得し、`<li id="bib.bibN">` の参考文献と被引用論文を arXiv ID → DOI → 題名（正規化した題名が項目に含まれる。3 語未満は第 1 著者の姓も要る）→ 題名の語の 85% 以上＋第 1 著者の姓（一意のときだけ）で対応付ける。本文の `<p class="ltx_p">` を文に分け（`et al.`・`Fig.`・頭文字では切らない）、`href="#bib.bibN"` を含む文を引用文とする。図・表・キャプション・脚注・見出し・参考文献は除く。上限は S2 と同じ 12 本 × 400 字
  - **使い方は「強い関係を足すだけ」**: その文を R2-23 の規則にそのまま通し、手がかりの規則（`cue`）で、被引用論文を特定でき引用できる文による extends / contrasts になったときだけ、その辺を使う。それ以外は S2 だけの結果のまま（背景の辺は変わらず、辺の増減もない）。方式は `s2_context_rule` のままで、根拠は `evidence.source: arxiv_html`、理由欄は「（arXiv HTML（arXiv:2101.03961v3）の本文の引用文から規則で判定）。引用文: "…"」。web は出典を「arXiv HTML」、判定方法を「arXiv HTML の引用文」と表示し、本文へのリンクを付ける（`apps/web/lib/lineage/evidence.ts`・`EdgeEvidence.tsx`、how-it-works の説明と出典欄にも一文足した）
  - 作法: robots.txt（`Allow: /html`、`Crawl-delay: 15`）に従い、1 本ずつ、要求の開始の間隔は 15 秒以上。`/e-print`・`/src` は使わない。1 実行の取得は `PAPERPILOT_ARXIV_HTML_MAX_FETCHES`（既定 40 本 = 10 分）まで。429・403・5xx が来たらその実行では arXiv への要求をやめる（再試行の繰り返しはしない）。User-Agent に連絡先（`PAPERPILOT_CONTACT_EMAIL`、なければ `PAPERPILOT_OPENALEX_EMAIL`）
  - キャッシュ `data/state/lineage-cache/arxiv_html_contexts.json`（新規、regen-themes が promote）: 引用元の arXiv ID ごとに版（`v3`）、取得日、HTML の有無、**聞かれた組の bib 番号と引用文だけ**を持つ。HTML 自体は保存も再配布もしない。有効期限 180 日（HTML なしは 30 日）。版が変わると組を捨てる
- **規則の追加 2 つ**（`classify/apiRelations.ts`。S2 の引用文にも効く）
  - 被引用論文が主語で、文末の関係節で引用元が採り入れている文（「Lepikhin et al. (2020) adapts … which we also follow.」）を継承の手がかりにした。その 1 本だけを引き、語で名指ししている文に限る
  - 比較の語の間に 4 語まで許した（「comparing the proposed ARMA layer with GNNs layers based on polynomial filters, namely … CayleyNets」の「based on」を継承と読んでいた）
  - S2 の引用文（R2-23 で取り直した 97 本の参考文献 5,122 組）で規則だけを比べると、変わるのは 1 組だけ: DeiT ← timm の「for a direct comparison and … we use for each model the definition in the same GitHub [52] repository」が extends → baseline_only（正しい修正）
- **Crossref の参考文献**（`theme/crossrefReferences.ts`、`bfs.ts` のノード間の辺）
  - OpenAlex にも S2 にも参考文献がない引用元（S2 が論文を知らない、または参考文献 0 件。古いキャッシュは「聞いた組が 3 つ以上ですべてなし」で判定。`s2_references.json` に件数 `n` を保存）で DOI があるものだけ、Crossref の `reference[]` で同じグラフのノードを探す（DOI・arXiv ID・題名）。見つかった組は `api_citation`（参照/背景、「Crossref の参考文献リストで確認」）。引用文はないので強い関係にはならない
  - 作法: `mailto` 付き（polite pool）なら同時 3・10 件/秒、なしなら同時 1・5 件/秒。429・403 でその実行は止める。1 実行 `PAPERPILOT_CROSSREF_MAX_REQUESTS`（既定 50）件まで。キャッシュ `crossref_references.json`（DOI ごとに参考文献を 1 件 200 字以内に縮めて保存、180 日）
- **DBLP の会場**（`theme/dblpVenues.ts`、`build.ts`）
  - 会場が arXiv・CoRR・空などのノードを、DBLP SPARQL（`sparql.dblp.org`、CC0）で引く。DOI（ノードの DOI と arXiv の DataCite DOI。DBLP は出版社の大文字小文字のまま持つので両方）で DBLP の題名を取り、題名の完全一致で全レコードを取る。CoRR 以外で、正規化した題名が同じ、年がノードの −1〜+3 年、著者の姓が 1 人以上一致するレコードだけを採り、最も早いもの（同年なら会議）にする。`venue_tier` も計算し直す（DBLP の略称 `NIPS`・`J. Mach. Learn. Res.` を表に足した）
  - 10 ノードずつ 2 問い合わせ、1 秒以上の間隔、1 実行 `PAPERPILOT_DBLP_MAX_QUERIES`（既定 20）まで。キャッシュ `dblp_venues.json`（ノードごと、90 日）。検索 API（Anubis の画面が出る）は使わない
- **workflow**: regen-themes.yml・theme-on-demand.yml の生成の段に `PAPERPILOT_ARXIV_HTML`・`PAPERPILOT_CROSSREF_REFERENCES`・`PAPERPILOT_DBLP_VENUES`（いずれも `vars.… || 'off'`）、`PAPERPILOT_ARXIV_HTML_MAX_FETCHES`（既定 40）、`PAPERPILOT_OPENALEX_EMAIL`（既存の秘密 `OPENALEX_EMAIL`）を足した。regen-themes は 3 つのキャッシュを package・promote する（空のファイルを置いた）
- **評価**（作業用ディレクトリ、`data/published` は書き換えていない。arXiv の HTML はローカルに 35 本あり、足りない分を 15 秒間隔で取得: 合計 15 本、すべて 200 か 404。S2 は `externalIds` のための少数の問い合わせのみ）

| ラベル（強い関係の適合率・再現率、LLM なし） | R2-24 | R2-28 |
|---|---|---|
| R2-22 の 58 本 | 22/22（1.00）、再現率 22/31 | 23/23（1.00）、23/31 |
| R2-23 の 59 本 | 26/26（1.00）、26/32 | **27/27（1.00）、27/32** |
| R2-23 の rule_cases 19 本 | 7/8（MAE の 1 本） | 同じ |
| LLM あり（キャッシュの答え）の R2-23 の 59 本 | 25/25、25/32 | 26/26、26/32 |

  - 増えた 1 本は **Switch ← GShard**（「… which we also follow」）。ラベルは successor（extends でも可）で、強い関係として正しい。ViT の基礎文献リストの辺 3 本（PVT・Segmenter・RevViT ← ViT）は関係は同じ extends のまま、引用文の裏付けが付いた（「we build upon the vision transformer ViT [19]」など）
  - 新しいテスト `relationPrecisionR228.test.ts`（引用文を記録した 10 組、`relation-precision-r228.json`）と `r228EvidenceSources.test.ts`（解析・作法・キャッシュ・Crossref・DBLP の記録済みの応答・既定 off）

| テーマ（公開中の辺を本番の LLM なしの経路で通し直し） | 強い関係 前 → 後 | arXiv HTML の対象の組 / 文献の対応 / 文あり / 強い関係 | 自動検査 |
|---|---|---|---|
| graph-neural-network（131 辺） | 4 → 4 | 合計 48 / 39 / 36 / 4（4 テーマ、取得 30 本・HTML なし 3） | 合格のまま |
| mixture-of-experts（67 辺） | 6 → **7**（Switch ← GShard） | 〃 | 合格のまま |
| vision-transformer（49 辺） | 13 → 13（基礎文献リストの 3 本が引用文の根拠に） | 〃 | 合格のまま |
| flash-attention（57 辺） | 4 → 4 | 〃 | 合格のまま |

  - 公開中の版との再現の食い違いは 0 本（HTML を使わない場合）。新しい強い関係はすべて手作業で正しい
  - 4 テーマで arXiv の取得は 30 本（15 秒間隔で約 8 分）。1 テーマなら上限 40 本で 120 分の枠に十分収まる
  - **DBLP**: 会場が arXiv などのノード 41 本のうち 24 本を直した（12 問い合わせ）。例: FlashAttention → NeurIPS、FlashAttention-2 → ICLR、Switch → J. Mach. Learn. Res.、PipeMoE → INFOCOM、ScheMoE → EuroSys、GraphSAGE → NIPS、DeepMoE → UAI。手で見て誤りはない。残る 17 本は DBLP に会議版がない（CoRR だけ）か題名が違う
  - **Crossref**: S2 の参考文献がない引用元は 4 テーマで 7 本。DOI があり Crossref が参考文献を返したのは PipeMoE（41 件）・AdaMV-MoE（93 件）・ScheMoE（55 件）で、同じグラフの論文がそれぞれ 6・11・5 本載っていた。ただし 3 本とも OpenAlex に参考文献がある（62・131・30 件）ので、今の条件（OpenAlex も S2 もないとき）では**4 テーマで辺は増えない**。OpenAlex の参考文献にあっても辺になっていない組（ScheMoE ← GShard など 10 組）は、ノード間の辺の条件（起点・新しさ）で外れたもので、Crossref の有無とは別の課題
- **残る課題**
  - 有効にするかは利用者の判断（リポジトリ変数 `PAPERPILOT_ARXIV_HTML` など）。有効にしたら 1 テーマずつ作り直して、`arxiv html summary` の行（取得数・BLOCKED の有無・HTML から作った強い関係の数）を確かめる
  - 取りこぼしの残り 5 本（LLM なし）: FlashDecoding++ ← FlashAttention（手がかりの文がない）、MMoE ← Eigen・MMoE ← Shazeer（KDD 版のみで arXiv HTML がない）、AdaMV-MoE ← MMoE・AdaMV-MoE ← Expert Choice（引用元の arXiv ID が解決できず HTML を引けない。47 では CVF の PDF の文も背景だけ）。LLM ありではこれに Shazeer ← Eigen（規則と LLM の食い違い）が加わる。MMoE 系は OpenAlex の GROBID XML（鍵と費用が要る、47 §2.2）でしか取れない
  - 「As in Shazeer et al. (2018); Lepikhin et al. (2020), Switch Transformers simplifies …」のような「As in X, 我々の手法は」の型は手がかりにしていない（複数の文献を引くため）
  - DBLP の会場は会議・論文誌の略称（`INFOCOM`・`EuroSys`）で表示される。`venue_tier` の表にない会場は preprint 扱いのまま

## 実装メモ（R2-31、範囲の対比より継承・引用の年の逆転・会議論文の年）

R2-29 の監査の下書き（第二審査）が挙げた生成側の誤り 2 つを直した。D5 と公開の基準は変えていない。LLM は使っていない。

- **「While X …, our <X の使い方> of …」は継承**（`classify/apiRelations.ts`）
  - 誤り: MoE の Shazeer ← Eigen が contrasts で公開されていた。引用文「While Eigen et al. (2013) uses two stacked MoEs …, our convolutional application of the MoE allows …」を R2-23 の対比の型（「While X …, our …」）で読んでいた。Shazeer らは本文で「Our work builds on this use of MoEs」と書いており、R2-23 のラベルも extends。ただしこの文は Eigen を名指ししない（前の文の「this use」を指す）ため S2 の引用文に入っておらず、規則からは見えない
  - 規則: 被引用論文を特定できる「While/Whereas X …, 」の文で、主節が「our ＋（2 語まで）＋ application / use / usage / version / variant / instantiation / extension / generalization / adaptation of」（引用元が X と同じものを自分の形で使う）なら、範囲の違いを述べる文として**継承（extends）**にする。次のときは対比のまま: 同じ文に明示の対比（unlike・in contrast to/with・differ(s/ent) from・as opposed to）か置き換え（instead of・rather than・replace）がある、または同じ組の別の文が被引用論文を明示的に対比している（`contrast` が立つ文）か比較を主張している（outperform・compared with・fair comparison などの `phrase_compare`）。理由欄の引用文はその「While …」の文のまま、確信度は対比と同じ 0.7
  - 「While in BERT the decoder can be trivial …, we found that …」（MAE ← BERT、ラベル contrasts）は主節が「we found」なので対比のまま
  - **手作業ラベル**: R2-22 の 58 本・R2-23 の 59 本・R2-23 の rule_cases 19 本・R2-28 の 10 組で、LLM なしの適合率 1.00 と強い関係の本数は不変（R2-22 22/31、R2-23 26/32、rule_cases 7/8）。Shazeer ← Eigen の種類がラベル（extends）と一致するようになった。LLM あり（キャッシュの答え）では、規則とキャッシュの答え（builds_on）が一致して強い関係として残るので R2-22 21 → **22**/31、R2-23 25 → **26**/32 に増え、R2-24 の「LLM あり・なしの食い違い 1 本」がなくなった
  - **広い範囲の確認**（R2-23 で取り直した 97 本の参考文献 5,122 組、規則だけ）: 変わるのは 1 組だけ（Shazeer ← Eigen、contrasts → extends。手作業で正しい）。5,122 組のうち「While/Whereas」の文で contrasts になるのは 2 組（この組と MAE ← BERT）
  - テスト: `scopeContrastR231.test.ts`（新規。明示の対比・比較・置き換えが勝つこと、MAE ← BERT が変わらないこと）、`cueRecallR223`・`relationPrecisionR222/R223/R224` の期待値を更新
- **引用の年の逆転と会議論文の年**（`theme/recordChronology.ts`、`build.ts`）
  - 引用の年の逆転: グラフ内でそのノードを引く論文の年が、ノードの最も早い年（年、または arXiv ID の年が早ければそれ）より 2 年以上前なら「逆転」とする。焦点でないノードは、引く論文の半分以上が逆転し、かつ逆転が 2 本以上か 3 年以上の差のときに**落とす**（辺も落ちる）。それ以外の逆転は印を付けるだけ。焦点のノードは印だけ。`meta.suspect_records` に `chronology_inversion:<逆転数>/<引く論文数>@<最大の差>` として R2-22 の記録と同じ形で入る（同じノードは 1 件にまとめる）。GNN の W4322614756（題名・DOI は 2025 年の GIScience の道路網の論文だが、OpenAlex では 2019〜2021 年の GNN 論文が引く混ざった記録。グラフ内では ARMA（2021）が引く）は `young_high_citations` の印に加えてこれで落ちる。ARMA（TPAMI 2021、arXiv 2019）のように雑誌版の年が遅いノードは arXiv の年で見るので逆転にならない
  - 会議論文の年: OpenAlex の年が独立した年と**ちょうど 1 年**ずれる会議論文は、その年に直す。出どころは (1) R2-28 の DBLP のキャッシュ（`conf/…` の記録で年があるとき。DBLP を on にした実行だけ）、(2) IEEE の会議論文の DOI が持つ開催年（`10.1109/<会議>.<年>.<番号>`、会場の名前が conference/proceedings/symposium/IJCNN など）。arXiv ID の年がノードの年以前のノード（arXiv が先の論文。GCN: arXiv 2016、ICLR 2017）は直さない。2 年以上のずれは別の版・別の記録なので直さない。直したノードに触れる辺の理由欄の「「題名」(旧年)」も新しい年に書き換え、`meta.year_corrections`（`{id, title, from, to, source}`）に残す。Gori ら「A new model for learning in graph domains」は 2006 → **2005**（DOI `10.1109/ijcnn.2005.1555942`）
  - DBLP の問い合わせは増やしていない（R2-28 と同じく会場が arXiv などのノードだけ）。会議論文の年を DBLP で確かめるには対象を広げる必要がある（残る課題）
  - テスト: `recordChronologyR231.test.ts`（公開中の GNN の該当ノード 29 本・辺 35 本を記録した `fixtures/record-chronology-r231.json` から作った写しで確かめる。公開中のファイルそのものは見ない）
- **4 テーマの試算**（公開中の各辺を本番の LLM なしの経路で通し直し、S2・arXiv HTML はキャッシュから。ネットワークなし。その後でノードの検査と品質表と同じ `themeGateChecks`。作り直す前の版は公開中と完全に一致＝再現の食い違い 0）

| テーマ | ノード 前 → 後 | 辺 前 → 後 | 強い関係 前 → 後 | 自動検査 |
|---|---|---|---|---|
| graph-neural-network | 35 → **34**（W4322614756 を落とす。Gori の年 2006 → 2005） | 131 → 130 | 4（extends 4）→ 4 | 合格のまま |
| mixture-of-experts | 22 → 22 | 67 → 67 | 7（extends 4・contrasts 3）→ 7（**extends 5・contrasts 2**） | 合格のまま |
| vision-transformer | 21 → 21 | 49 → 49 | 13 → 13 | 合格のまま |
| flash-attention | 15 → 15 | 47 → 47 | 4 → 4 | 合格のまま |

  - 公開中の 4 テーマに 2 つのノードの検査をかけて引っかかるのは、上の 2 本（W4322614756 を落とす、Gori の年）だけ
  - OpenAlex からの作り直し（R2-30 の手順、depth 1・seeds 5）は前の版では 4 テーマとも完了したが、後の版は OpenAlex の鍵なしの 1 日の予算が尽きて（`daily budget exhausted`、00:00 UTC に戻る）比べられなかった。CI では鍵があるので影響しない
- **残る課題**
  - MoE・GNN を作り直して監査の下書きを作り直す（GNN はテーマ外の M-NMF・ConvE が残る。標本のテーマ外の割合は別に確かめる）
  - 「Our work builds on this use of MoEs」のように被引用論文を名指ししない継承の文は、S2 の引用文にも arXiv HTML の引用文にも入らない（前後の文が要る）
  - 会議論文の年の確認を DBLP で広げるか（会場が arXiv 以外のノードも問い合わせる。1 実行の問い合わせの上限内）

### R2-26 要旨の出典・ライセンスと別論文の要旨（2026-10-11）

- 詳細は design 51 §9。系譜に関わる点だけ記す
- 題名と要旨の整合検査（R2-17）を `@paperpilot/core/abstract-sanity` に移し、「造語の題名に触れず別の固有名を導入する要旨」を別論文の要旨と判定する規則を足した。flash-attention の Longformer（OpenAlex W3015468748 の要旨が別論文「Murmurative Attention」）が該当。生成側（OpenAlex の要旨、`citingAbstractOf`）と表示側（公開済み成果物の読み込み時）で外す。r222/r223 の固定データは arXiv の要旨に差し替え、適合率テストは不変
- 根拠パネルの引用文は、途中から始まる・途中で終わる抜粋に「…」を付け、出典の行に引用元の著者名（et al.）を入れた

## 実装メモ（R2-35、依頼テーマの略称・テーマより前の別分野の論文・被引用の多い後継の取りこぼし）

依頼で作った「Low-Rank Adaptation」（69 ノード、未監査）の 2 つの誤りを直した。LLM は使っていない。監査済みの 4 テーマの成果物は変わらない（下の試算）。

- **原因 1: QLoRA が入らない**
  - OpenAlex の LoRA（W3168867926 = arXiv 2106.09685、Hu ら）は 1 つの記録で、題名は Zenodo の別記録と混ざって壊れている（R2-34 で S2 の題名に差し替え済み）。ICLR 版などの別 ID は無い（題名検索で確認）ので、別名として合わせる記録は無い。OpenAlex の被引用数は 2,510（S2 は 24,206）
  - QLoRA の OpenAlex の記録は arXiv 版（W4378509449）・NeurIPS 版（W7133233472）とも `referenced_works` が 0。DoRA・LoRA+ も 0。だから `cites:W3168867926` は QLoRA を決して返さない（返すのは参考文献を持つ雑誌・会議の記録だけ）
  - S2 の `/citations` は新しい順で、`offset + limit < 10000` の上限がある。LoRA の 1 ページ目は 2026 年の論文 1,000 本だけで、2023 年の QLoRA には届かない
  - さらにテーマの語は「low rank adaptation」と頭字語「LRA」だけで、「LoRA」は語ではなかった。QLoRA は種（DoRA・LoRA+）の参考文献としては候補に上がっていたが、題名・要旨に語が無く z = 0.57 < zHi で門に落ちていた。VeRA・AdaLoRA・rsLoRA・HydraLoRA も埋め込みだけで入っていた
  - 種の選び方（`meta.seeds`/`canonical_seeds`）: サーベイの参考文献から正準の手法論文を最大 5 本（`canonicalSlots = ceil(seeds/2)`）、残りを検索の候補から。初回（depth 1・seeds 5・width 8）は 13 ノードで疎（15 未満）だったため `--auto-expand` が depth 2・seeds 10・width 12 で作り直し、それが公開された（`meta.depth = 2`・種 10 本）
- **原因 2: 2013〜16 年の話者適応などが入る**
  - depth 2 で、埋め込みだけで入った「Low-rank plus diagonal adaptation」（2016、z 2.2）の参考文献が展開され、音声認識の話者適応の論文 6 本が埋め込み（z ≥ 1.0、語の一致なし）で入った。互いに引き合う塊になって `confirmWeakAdmissions` の対象外（z ≥ zHi）
  - Adafactor（2018）・「To Tune or Not to Tune?」（2019）も埋め込みだけ。GaLore・Flora・rsLoRA が背景として引くだけ
- **直したこと**
  - **種が定義する略称を語にする**（`topicScope.ts::deriveThemeAcronyms`・`TopicScope.withDerivedTerms`、`build.ts`）: 種の題名・要旨で「<テーマ名> (X)」「<テーマ名>, or X」の X が、テーマ名（と別名）の内容語の頭文字を順に表し、2 本以上の種が同じものを定義していれば、テーマの語に足す。埋め込みの問い合わせ文は変えない。4 文字以上で大文字小文字が混ざる略称は、前に文字が付いた名前（QLoRA・PRILoRA・OLoRA）にも一致する（右側は従来どおり語の境界。LoRaWAN・Lora は一致しない）。LoRA のテーマで「LoRA」が足される。GNN・MoE・ViT は既に語なので何も足されない。ログ `topic terms: derived acronym(s) from the seeds: …`
  - **埋め込みだけのノードは展開しない**（`bfs.ts`、`TopicScopeOptions.expandEmbeddingOnly`、既定 false）: 題名・要旨にテーマの語が無いノードの参考文献は別分野の近所なので、depth 2 以降で広げない（支持で入ったノードと同じ扱い）。CI の depth 1 では影響なし
  - **種より前の、埋め込みだけのノードには引用文の裏付けを求める**（`bfs.ts::confirmPreSeedEmbeddingAdmissions`、`preSeedYears`、既定 1）: 埋め込みだけで入り、最も早い種の年より 2 年以上前のノードは、語のある（または対象外の）ノードとの辺で、引用文の手がかりのある強い関係（extends/successor/supersedes/contrasts、`api_citation`・推測・基礎論文の一覧は除く）が無ければ、相互参照の後で落とす。背景としての引用は何本あっても数えない（doc 42 で共引用の支持を切ったのと同じ理由: 隣の分野の古典は多くのテーマ内の論文に背景として引かれる）。候補どうしの辺も数えない。ログ `topic gate: dropped pre-seed embedding-only node …`
  - **被引用の多い後継を探す**（`s2Expansion.ts::rankedCiters`・`s2Citations.ts::searchByCitations`、既定 off、`PAPERPILOT_S2_DESCENDANT_SEARCH=on`、候補数 `PAPERPILOT_S2_DESCENDANT_CANDIDATES` 既定 16）: 1 テーマに 1 回、S2 の bulk 検索（テーマ名・別名・略称の OR、被引用数の降順、最も早い種の年以降）の上位を OpenAlex の ID に寄せ、各候補の S2 参考文献（キャッシュあり、関係分類と共用）でその種を引いているものだけを、その種を引く論文の候補に足す。その後は今までどおり要旨・門・幅で絞る。検索や参考文献が取れないときは展開の失敗として記録（終了コード 4、公開中のファイルは残る）。ワークフローは `vars.PAPERPILOT_S2_DESCENDANT_SEARCH || 'off'`
  - 種を引く論文の並びは OpenAlex と S2 の被引用数の大きい方で（`bfs.ts::bestCitationCount`。OpenAlex は arXiv だけの論文を少なく数える。QLoRA 500 対 5,951）
- **試算**（基準 = develop 0e2326b。同じ日に記録した HTTP の答えを両方に再生（`test/system/support/fixtureFetch.ts` の記録と再生）。埋め込みあり・LLM なし・`--primary-source openalex`。4 テーマは depth 1・seeds 5・width 8、基準の再生は公開中の成果物とノード・辺の数まで一致）

| テーマ | 基準 | 変更後 | 増えた | 減った |
|---|---|---|---|---|
| flash-attention | 14 ノード / 46 辺 | 同じ（`generated_at` 以外バイト一致） | なし | なし |
| graph-neural-network | 34 / 141 | 同じ（バイト一致） | なし | なし（M-NMF・ConvE は語の一致で入っているので残る） |
| mixture-of-experts | 21 / 65 | 同じ（バイト一致） | なし | なし |
| vision-transformer | 20 / 48 | 同じ（バイト一致） | なし | なし |
| low-rank-adaptation 初回（1/5/8） | 13 / 18 | 13 / 25（まだ疎 → 作り直し） | QLoRA、C-LoRA | LMF（2013、音声の低ランク分解）、LRPD（2016） |
| low-rank-adaptation 作り直し（2/10/12、公開される方） | 85 / 338 | 79 / 345（検索 on: 82 / 361） | QLoRA（辺 29 本、LoRA → QLoRA を含む）、PEFT の 7 本（Scaling Down to Scale Up、MeZO、SLoRA、SPT ほか）、ラマン分光の応用 1 本。検索 on でさらに SPoT・LoSparse・SliceFine | 話者適応 8 本（2013〜16）、Adafactor、To Tune or Not to Tune?、アダプタ系 4 本（Bapna 2019、Unsupervised Domain Adaptation with Adapter、Hierarchical Domain Adaptation、LLaMA-Adapter。埋め込みだけのノードを広げなくなったため）、LoRA-SB（幅の競合） |

  - 監査済み 4 テーマで埋め込みだけで入ったノード（FA の Routing Transformer・Rabe & Staats など 4 本、GNN 2 本、MoE 3 本、ViT 2 本）は、どれも最も早い種の年の 1 年前以降なので新しい規則の対象外
  - 検索 on の LoRA: 上位 16 本のうち種を引くのは 13 組。OpenVLA・Stable Video Diffusion・AnimateDiff などの応用は門で落ちる（LoRa 無線の論文も検索には出るが同じく落ちる）。この回は QLoRA が略称だけで既に入っていたので、検索の上乗せは 3 本
- **公開中の LoRA を作り直した**（テーマの CLI そのもの、依頼と同じ引数 `--depth 1 --seeds 5 --width 8 --since-year 2018 --llm-strict ambiguous --primary-source openalex --auto-expand`、LLM なし、検索は既定の off。HTTP は同じ日の記録を再生し、無いものだけ取りに行った）: 69 ノード / 261 辺 → **74 / 327**。QLoRA が入り、話者適応 8 本・Adafactor・To Tune or Not to Tune? が消えた。初回 13 ノードで作り直しになるのは前と同じ。その後 `generateThemesManifestCli`・`computeThemeQualityCli`・`buildLineageQualityCli --as-of 2026-10-12T09:36:46Z`。区分は変わらない（監査済み 4・未監査 1）
- **残る課題**
  - 「Accelerating Ill-Conditioned Low-Rank Matrix Estimation via Scaled Gradient Descent」（2020）は Riemannian Preconditioned LoRA の引用文で extends（手がかりあり）なので残る。「Low-Rank Matrix Recovery With Scaled Subgradient Methods」（2021）は最も早い種と同じ年なので対象外。年の窓を 0 にすると FA の 2021 年のノード（監査でテーマ内）が落ちるので広げていない
  - LoRA → QLoRA は baseline_only（S2 の引用文に手がかりの文が無い）
  - 応用の題名（「…via Low-Rank Adaptation」で別の課題）は従来の規則のまま
  - 検索 on は利用者の判断（リポジトリ変数）。on にしたら 1 テーマずつ作り直し、`ranked descendant search: candidates=…, verified seed citers=…` の行を見る
- テスト: `topicGateR235.test.ts`（新規: 略称の導出・一致、種より前の埋め込みだけのノード、depth 2 で展開しないこと、検索の候補の確かめ・失敗の記録・キャッシュ）、システムテスト `themeDescendantSearch.system.test.ts`（実 CLI で検索 on: 引く候補だけが後継として入る、検索が 503 なら終了コード 4 で公開中のファイルはバイト一致。合成の記録 `fixtures/theme-descendant-search`）、`r228EvidenceSources`・`r2-6-regen-reliability` に既定 off の確認を追加

## 実装メモ（R2-37、作り直しで公開中のテーマを隠さない）

- **事故**（2026-10-12）: 依頼で作った Low-Rank Adaptation（未監査で公開、74 ノード / 327 辺）は、初回（depth 1・seeds 5・width 8）が 13 ノードで疎だったので `--auto-expand` が depth 2・seeds 10・width 12 で作り直したものだった。その後 `regen-themes.yml`（run 38243384558）が `--auto-expand` なしの depth 1 で作り直し、21 ノード / 39 辺・発展系の関係 2 本（`lineage_relation_count` 2 < 3）になった。生成は完全で分類率も基準を超えていたので、書き込み前の検査（完全性の exit 4、分類率の exit 5）はどれも止めず、リリースで公開中のテーマが blocked の版に置き換わって消えた。R2-35 の後は depth 1 でも 21 ノード（15 以上）になるので、ノード数だけを見る従来の `--auto-expand` でも作り直さなかった
- **直したこと**
  - **公開の検査を使い回す**（`theme/publishGuard.ts`）: 成果物の区分を、リリースが品質表を作るのと同じ `buildLineageQuality.collectionRow`（方針 `lineage-quality-policy-v1.json`）で出す。数値を二重に持たない。`collectionRow` は書き込む前のバイト列を `payload` で受け取れるようにした
  - **自動の作り直しの条件**（`cli.ts`）: `--auto-expand`（依頼）は、初回が疎（15 ノード / 5 辺 未満）なときに加えて、**初回が公開の検査で blocked になるとき**（発展系の関係・分類率・ノード数・辺の数・サーベイの割合など、方針の基準のどれか）にも 1 回だけ作り直す。作り直しが blocked で初回が公開できる版なら初回を残す（LIN-18）
  - **regen と依頼の引数を揃える**: `regen-themes.yml` は依頼と同じ `--depth 1 --seeds 5 --width 8 --since-year 2018 --llm-strict ambiguous --primary-source openalex` に `--match-published` を付ける。公開中の `meta.depth` が指定より深い（＝依頼で作り直された）テーマは最初から作り直しの引数（depth 2・seeds 10・width 12）で作る。depth 1 の結果が blocked なら 1 回だけ広げて作り直す。疎であることだけでは広げない（監査済みの FA は 14 ノードで、疎を理由に広げると別のグラフになる）。監査済みの 4 テーマは公開中の版が depth 1 で、検査を全部通っている（R2-35 の再生で depth 1 の作り直しが公開中とノード・辺の数まで一致）ので、`--match-published` で作り直しても広がらない
  - **公開中より悪い版で置き換えない**（`regressionRefusal`、書き込みの直前に `build.ts` の `publishGuard`）: 公開中（監査済み・未監査）のテーマを、(1) 品質表で blocked になる版、(2) 公開中の半分未満のノードの版（`--allow-shrink`、ワークフローの入力 `allow_shrink=true` で許す）で置き換えようとしたら、書き込まずに終了コード 6（`EXIT_REGRESSION_REFUSED`）。公開中のファイルはバイト一致のまま。`::error::` の行に公開中の区分・大きさと、新しい版で落ちた検査を出す。blocked のテーマ（サイトに出ていない）と新しいテーマは守る対象外
  - **監査済みのテーマの作り直し**: 監査は成果物の sha256 に結びついているので、作り直した版は品質表で `golden_fixture` が failed になり、**未監査ではなく blocked（非公開）になる**（`publicationTier`）。これも (1) として止め、利用者が再監査するつもりで作り直すときだけ `--allow-reaudit`（入力 `allow_reaudit=true`）で通す。この挙動（監査が古くなったら非公開）は今回変えていない。古い監査を「未監査」として公開し続けるかは利用者の判断
  - **ワークフロー**: `regen-themes.yml` は終了コード 6 を「refused」として数え、ジョブの要約にテーマと理由を書き、ほかのテーマを昇格した後で `verdict` を失敗にする。`theme-on-demand.yml` は従来どおり `--auto-expand`（6 なら昇格しない）
- **テスト**: `publishGuard.test.ts`（区分の判定が方針の値を読むこと、監査の結びつき、置き換えの可否の表）、`cli.publishGuard.test.ts`（事故の再現: depth 1 の blocked な作り直しが exit 6 でファイルがバイト一致、`--match-published` の引数、初回が blocked なときの作り直し、LIN-18、縮小と再監査の許可）、ワークフローの約束 `r2-37-regen-guard.test.ts`（依頼と regen の引数の一致、入力は env 経由、exit 6 の扱いと `verdict`）、システムテスト `regenGuard.system.test.ts`（実 CLI と記録した HTTP: 発展系の関係が基準に届かない作り直しは exit 6 で `data/published` がバイト一致、`--match-published` で広げた作り直しが取れなくても同じ、縮小と再監査）。ほかのシステムテストは監査済みの FA を作り直すので `--allow-reaudit` を付けた（`support/scenarios.ts`）
- 凍結した FA の成果物・監査・方針を `test/lineage/theme/fixtures/publish-guard/` に置いた（公開中のデータを直接読まない）

## 実装メモ（R2-32、会議の系譜を LLM なしで作り直す）

### 調査（2026-10-12 時点の品質表）

会議の系譜 13 件・deep 14 件はすべて blocked だった。`golden_fixture` が `unknown` なのは監査が無いだけで、未監査として公開するのを妨げない。止めていたのは次の自動検査。

| 対象 | 状態 | 落ちていた検査 | 原因 |
|---|---|---|---|
| aaai-2026, acl-2025, cvpr-2025, cvpr-2026, emnlp-2025, iccv-2025, icml-2025, neurips-2025 | 空の置き物（`{root:null,nodes:[],edges:[],meta:{source:"none"}}`） | `artifact_contract_v1`（`schema_version`・`clusters` なし）、`root_focus_resolve`（root も focus もなし）。そもそも `availability=unavailable` | 系譜を作っていない。web の probe を 404 にしないための置き物 |
| acl-2026, iclr-2025, icml-2026 | ファイルなし | `artifact_present` | 同上 |
| iclr-2026 | 旧 Python の LLM 版（`build_lineage.py`、158 ノード / 63 辺） | 契約 476 件（`schema_version`・辺の `relation`/`confidence`/`provenance` なし）、`catalog_seed_ids`（焦点に `seed_paper_id` なし 12 件）、`edge_semantics_complete` 63 件、`orphan_node_count` | 契約 v1 より前の形式。作り直すしかない |
| eccv-2024 | 旧 OpenAlex 版（`build_conference_lineage.py`、82 ノード / 73 辺はすべて `successor`） | 契約、`catalog_seed_ids`、`edge_semantics_complete`、`root_focus_resolve`（root null） | 同上。辺は引用を `successor` と読み替えただけ（根拠なし） |
| deep 14 件（iclr-2026） | 旧 LLM 版 | 契約、`deep_manifest_contract`（manifest が旧形式の裸の配列）、`deep_manifest_identity`、`catalog_seed_ids`、`edge_semantics_complete` | ICLR 2026 の目録は OpenReview のみで arXiv id が 0 件なので、arXiv で結ぶ deep の身元検査は作り直しても通らない |

既存の生成器:
- `conference/buildLineage.ts`（collect-weekly が使用）: Oral 論文だけを arXiv id → S2 で解決する。ICLR/ICML/NeurIPS 2025–26 の目録は OpenReview のみ（arXiv id 0 件）なので焦点が 0 件になり、空のグラフしか作れない。既定は LLM あり。テーマの公開検査（分類率・関係数など）も R2-37 の置き換え防止も無い
- `conference/buildConferenceLineage.ts`: OpenAlex のみ、辺は引用＝`successor` の推定（根拠なし）。どのワークフローからも呼ばれていない
- `deep/buildDeepLineage.ts` と `generateDeepManifest.ts`: 論文 1 本の深い系譜（LLM）。どのワークフローからも呼ばれていない
- `conference-on-demand.yml` は目録だけ、`regen-retry.yml` はテーマだけを扱う

目録の身元の網羅（系譜の種に使えるか）: ICLR 2026 と ICML 2025 はどちらも arXiv id 0 件・OpenReview id 100%。S2 の会場検索（`venue=ICML&year=2025`）は 2,689 件を被引用数順に返し、上位 1,000 件の 92%（917 件）が目録の題名と完全一致した。ICML 2025 は開催から 1 年以上たち被引用もあるので、こちらを 1 件目に選んだ。

### 決めたこと（会議の系譜とは何か）

- **会議の系譜 =「その回で最も影響の大きかった採択論文が、どこから来て何を生んだか」**。分野別の小さな系譜（クラスタ）は焦点のタグで `clusters` に分けるだけにして、別の成果物にはしない
- **種**: その回の目録の論文を S2 の被引用数で並べた上位 12 本（`--seeds`）。S2 の会場検索 1 回で順位を取り、目録の行と arXiv id、なければ正規化した題名の完全一致で結ぶ（題名が目録側・検索側のどちらかで重複したら結ばない）。サーベイは種にしない。順位は `data/state/lineage-cache/conference_seeds.json` に 30 日保存し（上位 300 件）、その間の作り直しは同じ種になる
- **祖先・子孫**: 種ごとに S2 の参考文献（影響ありの印 → 被引用数の順に 6 本）と引用している論文（被引用数の順に 6 本）。その後、今回読んだ参考文献リスト（種と子孫）でグラフ内の引用をすべて辺にする（cross-node）。辺の無い論文と種は落とす
- **関係の根拠はテーマと同じ**（`theme/noLlmRelation.ts::classifyPairApiOnly`）: 題名の版 → S2 の引用文の規則（任意で arXiv HTML の引用文）→ LLM なしの規則 → `api_citation`。LLM は使わない（切り替えも置かない）。強い関係には引用文の手がかりが要る（D5）
- **身元**: ノードの id は S2 の paperId。焦点は目録の `paper_id` を `seed_paper_id` に持ち、目録の OpenReview id と S2 の arXiv / DOI を別名に持つ（他のノードと重なる別名は付けない）
- **公開の検査はテーマと同じ**: 会議の行にもテーマの自動検査（`evidence_classified_rate`・`edge_density`・`node_count`・`review_share`・`lineage_relation_count`）を同じ基準値で掛け、`generator_current` は新しい方針キー `conference_min_generated_at`（2026-10-12T14:00:00Z）で判定する（`conferenceGateFromPolicy`）。旧生成器の成果物は契約を通っても公開されない。監査が無ければ「未監査」で公開
- **書き込み前の検査もテーマと同じ**: 会場検索の失敗は終了コード 4（公開中のファイルはそのまま）、展開の失敗による縮小も 4、分類率が基準未満は 5、R2-37 の置き換え防止（公開中の会議の系譜を blocked になる版や半分未満のノードの版で置き換えない）は 6（`--allow-shrink` で縮小だけ許す）。`publishGuard.ts` は対象（theme / conference と目録 id）を受け取るようにした
- **抄録**: 公開するのは目録の抄録のうち CC0 / CC-BY のもの（焦点だけ）。S2 の抄録は判定（サーベイの判定など）に読むが書き出さない
- **ワークフロー**: 作り直しは手動の `conference-lineage-regen.yml`（入力 `conferences` 必須、`allow_shrink`）。`collect-weekly.yml` の系譜の手順も同じ CLI・同じ既定値で呼ぶ（引数を渡さない＝一致をワークフローの約束テストで確認）。週次は **すでに新しい生成器の系譜を持つ会議だけ**を作り直し、新しい会議は手動の作り直しで始める。どちらも LLM のキーを読まない

### 結果（ICML 2025、ローカル、S2 キーなし）

- 138 ノード / 367 辺（`baseline_only` 349・`extends` 17・`contrasts` 1）、焦点 12（すべて目録の行に結びつき OpenReview の別名あり）、根拠は `s2_context_rule` 364・`api_citation` 3（分類率 100%）、レビューの割合 0.072、cross-node で 239 辺
- 品質表では **未監査**（自動検査はすべて通過、`golden_fixture` は unknown）。他の行の区分は変わらない（監査済み 4・未監査はテーマ 1 ＋ ICML 2025）
- S2 への要求は 103 回（429 が 7 回、待って再試行）、約 3 分。順位を保存した後の作り直しも 114 回（参考文献・引用のリストは毎回取り直す）で、**辺は 1 本も変わらず**、違いは被引用数の数件の増減だけだった
- **残る問題（監査の前に直すべきもの）**: `extends` 17 本のうち「X を土台に拡張した」と読めるのは Hi Robot → MemER、π0 → Hi Robot など数本で、多くは「ベンチマーク／枠組み X を使う（we adopt X）」という利用の文だった。これはテーマと同じ規則（`s2_context_rule` の adopt / follow の扱い）の問題で、テーマにも同じ偏りがある（上の R2-22・R2-23 のメモ）。また 1937 年のノードや、2024 年の論文が 2025 年の種を `extends` する年の逆転（改訂された preprint）が 1 本ある。未監査で出すことはできるが、監査（D5）では誤りになる辺が多い見込み。規則の直しはテーマと一緒に行う（別の項目）
- ICLR 2026 は S2 の会場の付け方が未確認（この作業では要求していない）。最初の手動の作り直しで `edition ranking: … matched=` の行を見る

### deep の系譜（14 件）について

**廃止を推奨する**。理由: (1) どのワークフローも作っていない（生成器は LLM 版のみ）、(2) ICLR 2026 の目録に arXiv id が無いので、arXiv で結ぶ manifest の身元検査は作り直しても通らない、(3) 会議の系譜の焦点 1 本の周辺がほぼ同じ情報を持つ。進め方: `data/published/iclr-2026/deep-*.json` と `deep-manifest.json`、web の `/[conf]/deep/` と関連テスト、品質表の deep の行を 1 つの変更で消す（web の経路を消すので利用者の確認を取ってから）。残すなら、`editionLineageCli --seeds 1` 相当の 1 本版として作り直し、manifest を OpenReview id でも結べるように直す必要がある。

### 確認

- テスト: `test/lineage/conference/editionLineage.test.ts`（目録との結び付け、順位の保存、会議の検査、会議の置き換え防止）、ワークフローの約束 `r2-32-conference-lineage-workflows.test.ts`（手動のみ、LLM の鍵なし、collect-weekly との引数・env の一致、終了コード 6、キャッシュの昇格）、システムテスト `conferenceEdition.system.test.ts`（記録した S2 の応答で ICML 2025 を 3 種で作る: 決定的、会議の行に同じ検査、基準を満たせば未監査、置き換え防止で exit 6 とバイト一致、S2 の 503 で exit 4）
- 作り直しの実行（利用者の確認の後）: `gh workflow run conference-lineage-regen.yml --ref develop -f conferences=icml-2025`（ほかの会議は 1 件ずつ、要約の `edition ranking` と区分を見てから）

## 実装メモ（R2-38、「使う」引用を `extends` にしない）

ICML 2025 の会議の系譜（R2-32）の `extends` 17 本のうち、継承と言えるのは 3 本（Hi Robot → MemER、π0 → Hi Robot、ReAct → REMem）だけで、残りは「ベンチマーク X を使う（we adopt Embench [54], a benchmark …）」「X の F1 の計算を使う」「一番使われている枠組み ReAct を使う」「広く使われるプロービングの手法に従う」などの利用の文だった。原因は v3 規則の build の手がかりに `we adopt / use / employ / follow`・`based on` が入っていて、その目的語を見ていなかったこと。D5（強い関係には被引用論文を名指しする手がかりの文が要る）と公開の基準は変えていない。LLM・API の新しい呼び出しはない（すべてキャッシュから）。

R2-38 は `develop` に統合済み（`29fcff6`）。その後の品質表確認で、ICML 2025 の実在する引用先ハブが `popularity_sinks` に数えられ、公開検査を不必要に止める別の問題が見つかった。引用文の出典が記録され、LLM 分類ではない辺は引用根拠を持つものとしてハブ数から除外する修正を `dc957e6` に追加した。LLM 分類辺と根拠のない辺は引き続き数える。回帰テスト `popularitySinkEvidence.test.ts` がこの区別を検証する。この修正は監査規則の補正であり、公開データの再生成・公開を行ったものではない。

### 規則（`classify/apiRelations.ts`、新しい規則 id `phrase_usage` → `uses_resource` → baseline_only）

build の手がかりが被引用論文に当たった文を、次のときは「利用」に下げる。
- **強い手がかり**（extend / build on / extension of / variant・version of / modified / adapted・derived from / inspired by / motivated by / generalize / improve upon / 「our … の particular instance」）は継承として残す。ただしその手がかりの目的語（直後の数語）や受け身の主語が資源・手順の名詞のときは下げる（「inspired by the Embench [54] prompting format」「these extended experiments」「the separation gap experiment is extended to …」）
- **弱い手がかり**（adopt / use / employ / follow / based on / borrow / reuse / leverage）は、次のどれかで下げる
  - 目的語・主語が資源・手順の名詞: benchmark・dataset・task・environment・metric・F1・BLEU・score・calculation・evaluation・protocol・setup・configuration・hyperparameters・experiments・annotations・labels・difficulty levels・toolkit・library・codebase・code・implementation・prompt・template・format・judge・rubric・splits・checkpoints・weights・probing など
  - 同格で資源として紹介される（「X [54], a benchmark designed for …」「V-IRL (…), a real-world navigation task」）
  - 「Following / Inspired by / Based on X, we calculate / compute / measure / evaluate / report / find …」（計測の手順）
  - 目的語が既製の道具（widely-used / standard / most popular / official / default / open-source、「a 2-layer Transformer」、framework）や学習の部品（loss / objective / optimizer / regularizer）
  - 「follow X … and choose / set …」（設定値の踏襲）
  - 被引用論文の題名がベンチマーク・データセット・道具（Bench・benchmark・dataset・suite・toolkit・library・gym・arena など）、引用元の論文の題名が評価の研究（Benchmarking・…Bench・comparative study・evaluating・understanding・「Is … enough」）、または S2 の意図が分かっていて methodology を含まない
- 弱い `based on` は、直後の数語に被引用論文の名前・番号が無ければその文の手がかりにしない（「bootstrap reasoning based on positive traces … (Chu et al., 2025)」）
- `phrase_usage` は否定の手がかり（`phrase_protocol`・`phrase_ablation` と同じ）として扱い、引用文の LLM には回さない

### 評価用の手作業ラベル（`test/lineage/theme/fixtures/relation-usage-eval-r238.json`、`relationUsageR238.test.ts`）

公開中の 6 件（ICML 2025 と 5 テーマ）の強い関係すべてと、規則を通し直して強くなった辺、計 58 本。S2 の引用文・意図・isInfluential（arXiv HTML 由来の辺はその引用文）と、手作業ラベル（genuine / usage（種類つき）/ other / genuine_contrast、判断の分かれるものは borderline）を入れた。監査済み 4 テーマの 28 本は監査の判定（すべて correct）をそのまま使った。ICML の S2 の要旨は公開しない方針なので、要旨は公開中の理由欄に引かれた 1 文だけ。ラベルは論文単位（引用元が被引用論文の方法を土台にしているか）。

| 対象（規則で判定する辺） | 公開中の `extends`（適合率、再現率） | R2-38（適合率、再現率） | `contrasts` 公開中 → R2-38 |
|---|---|---|---|
| ICML 2025 | 3/17 = 0.18、3/3 | **3/3 = 1.00、3/3** | 1/1 → 1/1（V-IRL ← SFT が extends から contrasts に。許容と判定） |
| 監査済み 4 テーマ（FA・GNN・MoE・ViT） | 19/19 = 1.00、19/19 | 19/19 = 1.00、19/19（変化なし） | 3/3 → 3/3 |
| Low-Rank Adaptation（未監査） | 5/7 = 0.71、5/6 | 2/2 = 1.00、2/6 | 3/4 → 3/4 |
| 全体 | 27/43 = 0.63、27/28 | **24/24 = 1.00、24/28** | 7/8 → 7/8 |

- 失った正しい `extends` 4 本はすべて LoRA（SiRA・LoRA-GA・Composing ← LoRA、Q-BLoRA ← QLoRA）。どれも論文としては LoRA の発展だが、規則が引いていた文は「LoRA の既定の設定に従う」「公式のコードと設定に従う」「these extended experiments」などで、継承の手がかりの文ではない（D5 では根拠の誤り）。継承を述べる文（「To increase the capacity of LoRA … we propose SiRA」）には手がかりの語が無い
- 残る判断の分かれ目: REMem ← ReAct（「we adopt a ReAct-style agent」、genuine と判定）、REMem ← HippoRAG 2（F1 の計算に加え、同義の辺を HippoRAG 2 に倣って足す。usage と判定）、ProfBench ← PaperBench（ルーブリックの評価を倣う。usage と判定）

### 影響（オフラインの試算。公開ファイルは書き換えていない）

公開中の各辺を今のキャッシュ（`s2_references.json`・`arxiv_html_contexts.json`、ICML は会議の参考文献キャッシュの S2 要旨）で通し直し、品質表と同じ自動検査（テーマは `themeGateFromPolicy`、会議は `conferenceGateFromPolicy`）に掛けた。

| 対象 | 強い関係 公開中 → 現行規則の通し直し → R2-38 | 公開の検査（強い関係 3 本以上ほか） | 監査 |
|---|---|---|---|
| flash-attention | 4 → 4 → 4 | 通過 | 影響なし（辺・理由欄とも同一。R2-35 の記録で作り直した成果物もバイト一致） |
| graph-neural-network | 4 → 4 → 4 | 通過 | 同上 |
| mixture-of-experts | 7 → 7 → 7 | 通過 | 同上 |
| vision-transformer | 13 → 13 → 13 | 通過 | 同上 |
| low-rank-adaptation | 11 → 11 → 6（extends 7 → 2、contrasts 4 のまま） | 通過 | 未監査 |
| icml-2025 | 18 → 17 → 4（extends 17 → 3、V-IRL ← SFT が contrasts に） | 通過（4 本） | 未監査 |

- ICML の通し直しでは PropRAG ← HippoRAG 2 の contrasts が消えるが、これは要旨の取り方の差（公開時は S2 の要旨、キャッシュに無い）で R2-38 とは関係がない。本番で作り直せば残る見込みで、その場合 ICML は強い関係 5 本
- LoRA の通し直しでは公開中と 2 本ずれる（Composing の要旨・SoRA の要旨。公開時と節点の要旨が違うため）。R2-38 の差は上の 7 本
- 会議の生成器は関係で節点を落とさない（null の辺だけ落とす）ので、ICML の節点・辺の数は変わらない。テーマは強い関係で弱い入り口の節点を残す（R2-30・R2-35）ので LoRA の作り直しでは節点が減る可能性がある（R2-35 の記録は depth 2 の分が足りず、完全な作り直しの試算はできなかった）
- 監査済み 4 テーマは作り直しても監査は無効にならない（出力が変わらない）。作り直しが要るのは ICML 2025（`conference-lineage-regen.yml`）と LoRA（`regen-themes.yml`）の 2 件で、どちらも未監査

### 確認

- テスト: `relationUsageR238.test.ts`（評価用ラベルで ICML と全体の適合率 0.9 以上、監査済みの 28 本が変わらない、usage の 13 本が extends にならない、`usageReason` を評価用の実際の文で確認）、既存の R2-22〜R2-28 の評価テストはそのまま通る。システムテスト `conferenceEdition.system.test.ts` の記録（ICML 2025 の 3 種）は、強い関係 2 本がどちらも利用の文（「we adopt V-IRL …, a real-world navigation task」など）だったので、未監査に届くことを確かめる緩い方針の最小本数を 2 → 0 にした（厳しい方針で `lineage_relation_count` だけが落ちることは同じ）
- 試算の道具（作業用、リポジトリ外）: 公開中の辺の通し直し・キャッシュ全体の比較・R2-35 の記録での作り直し

## 実装メモ（R2-39、手がかりの係り先と「使う」引用の追加）

公開した NeurIPS 2025 の会議の系譜（136 論文・590 関係）の `extends` 44 本を手で判定すると、継承と言えるのは 12 本だけだった。誤りの多くは R2-38 の「使う」ではなく、手がかりの係り先の取り違え: 複数の論文を引く文で手がかりが別の論文に掛かる（「We adopt enhancements of GRPO [16] proposed by DAPO [4]」を DeepSeekMath に、「We adopt the zero residual-block initialization [13], which adaLN-zero [35] also follows」を DiT に）、自分の節への言及（「building on the observations … discussed in Section 3」を引用している 3 本すべてに）、第三者が主語（「Flow Matching methods [28, 1, 30] extend this framework」）、拡張の行き先（「can readily extend to … PPO [37]」）。D5 と公開の基準は変えていない。LLM・API の新しい呼び出しはない。

### 規則

- **係り先（`citedTarget.ts::cueGovernor`）**: 手がかりの目的語（手がかりの後ろ、括弧の外の「,」「;」「.」や which / while などまで、最大 12 語）で最初に出る引用（番号・著者年・被引用論文の名前）が被引用論文のものなら係る。別の論文が先なら係らない。「proposed by / introduced in / released by X」があれば X が持ち主。節・図・表・式・付録・アルゴリズムの番号や、引用のない this / these / the former は自分（self）。能動の extend / build on などの主語の節に引用があり we / our が無ければ第三者。extend・generalization の後の「to X」は行き先。目的語が 12 語以上で引用が無ければ遠すぎる。手がかり自体が被引用論文を含む（「Following [39], we …」）なら係る。どれでもなければ従来の節単位の判定。「such as / e.g. / including」の列挙は列挙全体に係る（Reformer ← SMYRF の unlike を保つ）
- **引用の無い文**: これまで手がかりは無条件に被引用論文に係るとしていたが、被引用論文の名前が手がかりの範囲にある時だけにした（「Building upon this, we introduce VRPO」「Based on the setup in Section 4.3」「based on GURU」）
- **別名**: 分野の語だけの題名の前半（「Reinforcement Learning: A Survey」）や先頭語の flow / diffusion / reinforcement / generative は論文の名前にしない
- **「使う」の追加（`apiRelations.ts::usageReason`、`phrase_usage`）**: 名詞に analyses・practices・recipes・training data などを追加。弱い手がかりで、公開モデル（「Qwen-14B model」「-Instruct」「models released by」「publicly released」）、役割（「as the RL algorithm / testbed / baseline」）、値の指定（「= 0.28」「10% probability」「t ∈ [30, 40]」）は利用。「Following / Inspired by / Based on / Building on X, …」の主節の先頭が資源・設定（prompt template、all experiments、the standard GRPO framework）なら強い手がかりでも利用。引用符の中（「“<think>…</answer>” template」）は 1 語に数える
- **論文でない記録（`shared/bogusRecord.ts`、会議の系譜の生成器）**: 題名が 1〜2 語の普通の単語だけで、年・著者 2 人以上・会場のどれかが無いか会場が辞書・定義集（"Definitions"・Qeios など）の記録は節点にしない。S2 が DAPO（「An Open-Source LLM RL System」）への参照を Qeios の定義項目 "Open Source" に結び付け、DAPO の引用文が載った辺が 2 本できていた。"Deep learning"（Nature）や年・著者の無い "The Claude 3 Model Family" は残す

### 評価（`test/lineage/theme/fixtures/relation-cue-target-eval-r239.json`、`relationCueTargetR239.test.ts`）

NeurIPS 2025 の extends 44 本に手でラベルを付けた（genuine 12・usage 15・misattributed 8・self_ref 6・third_party 1・other（論文でない節点）2。判断が分かれるものは borderline）。genuine には継承を述べる文の一部（`genuine_evidence`）を付け、引用文がそれでない extends は正解に数えない厳しい採点もした。R2-38 の 58 本と合わせて採点する。

| 対象 | 公開中の `extends`（適合率、再現率） | R2-39（適合率、再現率） |
|---|---|---|
| NeurIPS 2025 | 12/44 = 0.27、12/12 | **11/11 = 1.00、11/12**（厳しい採点も 11/11。論文でない節点の 2 本は生成器が落とす） |
| ICML 2025 | 3/17 = 0.18 | 3/3 = 1.00（R2-38 と同じ） |
| 監査済み 4 テーマ | 19/19 | 19/19（変化なし） |
| Low-Rank Adaptation | 5/7 | 2/2（R2-38 と同じ） |
| 合計（R2-38 + R2-39） | 39/87 = 0.45、39/40 | **35/35 = 1.00、35/40** |

- 失った genuine 1 本: Open-Reasoner-Zero ← DeepSeek-R1。継承を述べる文は「This two-stage approach follows DeepSeek-R1 [2]」だけで主語が一人称でない。公開中の根拠の文（「We adopt the PPO [4] …, diverging from the GRPO used in DeepSeek-R1-Zero [2]」）は PPO に掛かる誤り
- MiMo ← DeepSeekMath は残り、根拠の文が見出しの「… with Extended Generation Budget …」から「We employ a modified version of GRPO …」に変わる
- 判断の分かれ目（borderline）: 「we adopt GRPO as the RL algorithm」「We adopt the PPO as the core RL algorithm」を利用とした（R2-38 の「the most popular framework, ReAct」と同じ扱い）。「Inspired by the derivation of VP-SDE」（CPS ← Score SDE）、「architecture follows DiT, except the modifications」（Transition Models ← DiT）、「self-rollout … following (Yang et al., 2026)」（WorldPlay ← LongLive）は継承とした

### 影響（オフラインの試算。公開ファイルは書き換えていない）

公開中の各辺を今のキャッシュ（`s2_references.json`・`arxiv_html_contexts.json`、会議は参考文献キャッシュの S2 要旨）で develop の規則と R2-39 の規則で通し直した。キャッシュの全ペア（S2 1,669 組・arXiv HTML 134 組）も両方の規則で比べた。

| 対象 | 強い関係 公開中 → develop の規則 → R2-39 | 公開の検査 | 監査 |
|---|---|---|---|
| flash-attention / graph-neural-network / mixture-of-experts / vision-transformer | 4 / 4 / 7 / 13 → 同じ → 同じ | 通過 | 影響なし（全辺の関係・理由欄が develop の規則の通し直しと同一。キャッシュの全ペアでもこの 4 テーマの関係・引用文は 1 つも変わらない） |
| low-rank-adaptation | 5 → 6 → 7（VeRA ← LoRA が contrasts: 「Unlike Hu et al. (2022), who used …, we introduce …」） | 通過 | 未監査 |
| icml-2025 | 5 → 4 → 5（Igniting VLMs ← Hi Robot が contrasts: 「Unlike pipeline designs … (e.g., … Hi Robot (64) …), we adopt …」） | 通過 | 未監査 |
| neurips-2025 | 48 → 47 → 15（extends 13・contrasts 2）。論文でない節点の辺を除くと 14 | 通過 | 未監査 |

- NeurIPS の 14 本のうち Video-R1 ← DeepSeek-R1（要旨の「Inspired by DeepSeek-R1's success …」）は通し直しで要旨が入った時だけ出る。本番で作り直すと 13〜14 本の見込み。どれも強い関係 3 本以上を保つ
- 「論文でない記録」は NeurIPS の "Open Source" だけに当たる（公開中の 15 件の系譜、678 節点）。作り直すとその枠には参考文献の次の順位の論文が入る（オフラインでは参考文献の一覧がキャッシュに無いので試算できない）
- 監査済みのテーマの R2-35 の記録（作り直しの再生）は作業用ディレクトリの整理で消えていたので、作り直しのバイト一致は確かめていない。上の全辺の一致とキャッシュ全ペアの比較で、作り直しの入力（関係）が変わらないことを確かめた
- 作り直しが要るのは NeurIPS 2025（`conference-lineage-regen.yml`）。ICML 2025 と LoRA は contrasts が 1 本増えるだけなので急がない

### 確認

- テスト: `relationCueTargetR239.test.ts`（NeurIPS の 44 本: 適合率 0.9 以上（厳しい採点も）、誤った係り先・自分への言及・第三者の 15 本が extends にならない、usage は gold か許容の範囲、MiMo の根拠の文、`cueGovernor`・`usageReason`・別名・`isBogusPaperRecord` を実際の文で確認）。R2-22〜R2-38 の評価テストはそのまま通る（R2-23 の Reformer ← SMYRF の unlike は列挙の扱いで保つ）
- 試算の道具（作業用、リポジトリ外）: 公開中の辺の通し直し、キャッシュ全ペアの比較、評価セットの採点

## 決めたこと（2026-10-20、ユーザー「どんどん進めて下さい」= 推奨案で承認）

| # | 判断 | 決定 | 理由 |
|---|---|---|---|
| D-R2-40 | 規則で決める強い関係（拡張・対比・置き換え）の扱い | ★A: 判定は強い言い回し（build on / build upon / extend / variant of / adaptation of / unlike / in contrast to / replace など）が引用先に係るときだけにする。弱い言い回し（adopt / use / follow / based on / inspired by）は「引用のみ」。画面では強い関係を「引用文から推定した候補」として引用文と一緒に見せ、断定しない | R2-38・R2-39 の規則追加後も、新しい分野（CVPR 2025）で拡張の正しさが約 4 割。分野ごとの言い回しを足し続けても終わらないため、適合率を優先し、表示も控えめにする |
| D-R2-41 | deep の系譜（ICLR 2026 の 14 件） | 廃止する。ファイル、manifest、`/[conf]/deep/` のページとテストを削除 | 作る仕組みが LLM 版しかなく、OpenReview の ID だけの一覧では公開の検査を通らない。会議の系譜で同じ内容が見られる |

保留（ユーザーの確認待ち）: 監査済みテーマを作り直したときに「未監査」へ戻して公開を続けるか（公開範囲が変わるため）、sprintf-js の Dependabot 通知を tolerable_risk で閉じるか（外部操作）。

## 実装メモ（R2-40、強い言い回しだけで強い関係を決める）

D-R2-40（ユーザー承認、2026-10-20）の実装。LLM・API の新しい呼び出しはない。D5 と公開の基準（強い関係 3 本以上など）は変えていない。画面の「引用文から推定した候補」の表示は別の作業（web 側）で行う。

### 規則（`classify/apiRelations.ts`・`classify/citedTarget.ts`）

- **強い言い回し**（`STRONG_BUILD_CUES`）: build on / build upon / built on top of、extend X、extension / variant / version / adaptation / modification / instantiation / application of X、adapted / derived from X、generalize / subsume X、improve upon X、「our … の particular instance」、「our modified X」（`ownVariantOf`）。これが被引用論文に係るときだけ `builds_on`（→ `extends`）にする。これまでの build の判定（R2-23 の一人称・係り先）を狭めるだけで、広げない（両方を満たす時だけ）
- **弱い言い回し**（`WEAK_BUILD_CUES`）: adopt / use / employ / leverage / utilize / borrow / reuse / modify / adapt、follow(ing)、based on、inspired by、motivated by。被引用論文に係っても `uses_resource`（規則 `phrase_usage`、baseline_only）。同じ文に対比・比較の手がかりがあればそちらを優先する
- 強い言い回しの上に R2-38・R2-39 の判定を残す: 目的語が資源・手順（「built on top of the X library」「these extended experiments」）、計測（「…, we calculate」）、同格の資源、主節の資源・既定の設定、係り先（別の論文・自分の節・第三者）。次を加えた
  - 強い言い回しの目的語が公開モデル（「builds upon a pre-trained LLM model [53]」）、他の研究の知見（「We build on recent studies (A; B) which identify …」）、モデルの大きさの版（「the ViT-large version of DepthAnythingV2 [38]」）なら利用
  - 被引用論文の題名がデータセット・ベンチマーク（「ImageNet: A large-scale hierarchical image database」）なら強い言い回しでも利用（これまでは弱い言い回しのみ）
  - 係り先（`cueGovernor`）: 「extend X with / using / via Y」の Y は道具（被引用論文が with より前に無ければ係らない。「We extend the patch-level pathway with MM-DiT blocks [9]」）、同格の版は前の論文のもの（「LightningDiT (Yao et al., 2025), a variant of DiT」）、関係節の主語が別の論文（「Point3R [95] and StreamVGGT [106], which extend CUT3R and VGGT [87]」）、別の論文を説明する分詞（「GenEx [33], a … model built upon stable video diffusion [5]」）は第三者
  - 名詞だけの「generalization」（能力の意味）と「modification of + 動名詞」は手がかりにしない
  - 「While X …, we / our …」の対比は、被引用論文が while の節にある時だけ対比にする（「While a common practice involves SDEs, we adopt CPS [40]」は CPS との対比ではない）
- **消した規則（強い言い回しだけの判定で不要になったもの）**: R2-28 の「…, which we also follow」、R2-38 の弱い言い回し専用の判定（既製の道具・学習の部品・論文の種類のうち評価研究・S2 の意図）、R2-39 の弱い言い回し専用の判定（公開モデル・役割の as・値の指定・follow and set）、弱い based on の係り先の判定。`usageReason` は強い言い回しの文だけを受け取る

### 評価（`test/lineage/theme/fixtures/relation-strict-eval-r240.json`、`relationStrictR240.test.ts`）

公開中の CVPR 2025（2026-10-13T17:25:07Z）と ICLR 2025（2026-10-13T16:50:32Z）の、規則で決めた強い関係すべて（extends 32 + 18、contrasts 2 + 4。CVPR の title_version の supersedes 1 本は対象外）に論文単位の手作業ラベルを付けた。CVPR の extends: genuine 9・usage 20・misattributed 3、ICLR の extends: genuine 3・usage 13・other 2（知見・系統の例）、contrasts: genuine_contrast 5・other 1（「Unlike existing benchmarks (A; B; C)」、contrasts も許容）。genuine には継承を述べる文の一部（`genuine_evidence`）を付けた。R2-38・R2-39 の評価セットと合わせて採点した（「develop の規則」= R2-39 の規則、いずれも公開時と同じ入力）。

| 対象 | extends 公開中（適合率、再現率） | develop の規則 | R2-40 | contrasts develop → R2-40（適合率、再現率） |
|---|---|---|---|---|
| CVPR 2025 | 9/32 = 0.28、9/9 | 9/32 = 0.28、9/9 | **6/6 = 1.00、6/9** | 2/2、2/2 → 2/2、2/2 |
| ICLR 2025 | 3/18 = 0.17、3/3 | 3/18 = 0.17、3/3 | **1/1 = 1.00、1/3** | 4/4、3/3 → 4/4、3/3 |
| NeurIPS 2025 | 12/42 = 0.29、12/12 | 11/11 = 1.00、11/12 | 5/5 = 1.00、5/12 | （ラベルなし） |
| ICML 2025 | 3/17 = 0.18、3/3 | 3/3 = 1.00、3/3 | 2/2 = 1.00、2/3 | 1/1、0/1 → 1/1、0/1 |
| 監査済み 4 テーマ | 19/19 | 19/19 | 8/8 = 1.00、8/19 | 3/3、3/3 → 3/3、3/3 |
| Low-Rank Adaptation | 5/7 = 0.71、5/6 | 2/2 = 1.00、2/6 | 1/1 = 1.00、1/6 | 3/4、3/3 → 3/4、3/3 |
| 合計 | 51/135 = 0.38、51/52 | 47/85 = 0.55、47/52 | **23/23 = 1.00、23/52** | 13/14 = 0.93、11/12 → 13/14 = 0.93、11/12 |

- 引用文が継承を述べる文かも確かめる厳しい採点でも全対象で 1.00
- contrasts の誤り 1 本は LoRA ← DyLoRA（「unlike LoRA paper … which they count only LoRA specific parameters」、数え方の違い）で、R2-38 から変わらない。ICML の 0/1 は PropRAG ← HippoRAG 2（要旨の取り方の差、R2-38 のメモ）
- 失った genuine（再現率の低下）は、継承が弱い言い回しでしか書かれていない辺: CVPR の MoVieS ← VGGT（「MoVieS is built on … VGGT」は主語が手法名で一人称でない）、STream3R ← DUSt3R（「We reformulate DUSt3R」）、MonSter++ ← IGEV（「follows IGEV」）、ICLR の TC-Light ← IC-Light（「we adapt IC-Light into a … video diffusion model」）、LoopFormer ← Saunshi et al.（「we follow the overall approach of …」）。NeurIPS の LLaDA → MMaDA（「we adopt the … strategy introduced in LLaDA」）など、テーマの V-MoE ← GShard（「Following [39], we place the MoEs …」）なども同じ。D-R2-40 は適合率を優先する判断なので、これらは引用のみになる
- R2-23 の規則の例（rule cases）にあった既知の誤り（MAE ←「Following [15], we adopt an extra BatchNorm layer」）も弱い言い回しなので消えた

### 影響（オフラインの試算。公開ファイルは書き換えていない）

公開中の各辺を今のキャッシュ（`s2_references.json`・`arxiv_html_contexts.json`、会議は参考文献キャッシュの S2 要旨）で develop の規則と R2-40 の規則で通し直し、品質表と同じ自動検査に掛けた。R2-40 で新しく強くなった辺は 1 本もない（強い関係は develop の規則の部分集合）。

| 対象 | 強い関係 公開中 → develop の規則 → R2-40 | 公開の検査（3 本以上ほか） | 監査 |
|---|---|---|---|
| flash-attention | 4 → 4 → 3（supersedes 3 のみ） | 通過（ちょうど 3 本） | 監査済みの強い関係 4 本のうち弱い言い回しは 1 本（Blackwell 版 ← FA-2「We follow the FlashAttention algorithms」） |
| graph-neural-network | 4 → 4 → 4 | 通過 | 弱い言い回し 0 本 |
| mixture-of-experts | 7 → 7 → 3（extends 1、contrasts 2） | 通過 | 7 本のうち 4 本（V-MoE ← Shazeer「inspired by」、Expert Choice ← Shazeer「we adopt the idea」、Switch ← GShard「which we also follow」、V-MoE ← GShard「Following [39]」） |
| vision-transformer | 13 → 13 → 7（extends 5、contrasts 1、supersedes 1） | 通過 | 13 本のうち 6 本（TransUNet・PVT・ViViT・RevViT ← ViT、SwinIR・Swin-Unet ← Swin。following / follow / inspired by / based on / motivated by） |
| low-rank-adaptation | 5 → 7 → 6（extends 1、contrasts 5） | 通過 | 未監査（MultiLoRA ← LoRA「we follow [6] to use …」が落ちる） |
| icml-2025 | 5 → 5 → 4（extends 2、contrasts 2） | 通過 | 未監査（REMem ← ReAct が落ちる） |
| neurips-2025 | 14 → 14 → 7（extends 5、contrasts 2） | 通過 | 未監査 |
| iclr-2025 | 22 → 22 → 4（extends 1、contrasts 3） | 通過 | 未監査 |
| cvpr-2025 | 35 → 35 → 9（extends 6、contrasts 2、supersedes 1） | 通過 | 未監査 |

- 監査済み 4 テーマは作り直さない（監査が入力の sha256 に結び付いているため）。作り直すと、合計 28 本の監査済みの強い関係のうち 11 本（FA 1・MoE 4・ViT 6）が引用のみになる。どれも監査では「正しい」だったが、根拠の文は弱い言い回し。ViT と MoE は 3 本以上を保ち、FA はちょうど 3 本（supersedes だけ）
- 会議の生成器は関係で節点を落とさないので、会議の節点・辺の数は変わらない。LoRA は強い関係が弱い入り口の節点を残すため（R2-30・R2-35）、作り直しで節点が減る可能性がある（publish guard が半分未満を拒否する）
- 作り直しの対象（未監査、1 件ずつ、各回の後に `python3 scripts/strong_edges.py https://paperpilot.pages.dev/<id>/lineage.json` で強い関係の引用文を読む）: `gh workflow run conference-lineage-regen.yml --ref develop -f conferences=cvpr-2025` → `iclr-2025` → `neurips-2025` → `icml-2025`、テーマは `gh workflow run regen-themes.yml --ref develop -f themes="Low-Rank Adaptation"`

### 確認

- テスト: `relationStrictR240.test.ts`（56 本のラベル、各対象の extends 適合率 0.9 以上（厳しい採点も）と最低の正解数、contrasts 適合率、弱い言い回しの実際の文 16 本が `builds_on` にならない、強い言い回しの文 7 本は `builds_on`、`cueGovernor` の第三者・道具・同格、`usageReason` の公開モデル・知見・大きさの版、ImageNet、while の対比）。R2-22〜R2-39 の評価テストは、弱い言い回しで決まっていた辺の期待を「引用のみ」に直し（一覧で固定）、強い言い回しに置き換えた文で同じ経路（arXiv HTML の帰属、要旨の build）を確かめる形にした。システムテスト `regenGuard.system.test.ts` の記録（FA の作り直し）は強い関係が 4 → 3 本になり、拒否の理由の数字だけ直した
- 通したもの: pipeline の単体テスト（266 ファイル）、システムテスト（`failureInjection.system.test.ts` の Hugging Face 4 件は develop でも同じく失敗する。2026-10-19 の `code-links.json` 更新でキャッシュが新しく、HF への問い合わせが起きないため。R2-40 とは無関係）、core、typecheck、biome、`auditLineageQualityCli.ts`（FAIL なし）
- 試算の道具（作業用、リポジトリ外）: 評価セットの採点、公開中の辺の通し直し（develop / R2-40）


### R2-40 の反映（2026-10-21）

新しい判定で作り直し、すべて未監査で公開中: CVPR 2025（143 論文・強い関係 10）、ICLR 2025（130・5）、NeurIPS 2025（135・9）、ICML 2025（138・5）、Low-Rank Adaptation（91・6）。NeurIPS 2025 はキーなし S2 の 429 で 3 回続けて取得が欠け（exit 4、公開版は保持）、会議の作り直しだけ S2 の再試行を 10 回に増やして（`PAPERPILOT_S2_MAX_ATTEMPTS`）通した。監査済みの 4 テーマは作り直していない。


### R2-42 強い関係の誤り 3 型（2026-10-23）

ICCV 2025・EMNLP 2025 を公開した後、強い関係 13 本の引用文を手で読んだ。正しいのは 9 本（約 69%）。誤り 4 本の型と対応:

| 型 | 例 | 対応 |
|---|---|---|
| 新しい評価セットを既存のデータセットの拡張として紹介する文 | PixelThink ← LISA（「ReasonSeg の extended version」） | `INTRODUCED_RESOURCE` → `phrase_usage` |
| 形容詞が続く対象を comma で切って使用名詞を見落とす | When Users Change Their Mind ← WebArena（「high-quality, human-verified tasks from WebArena-Lite」） | `objectWindow` が形容詞の comma を越える |
| 比較の列挙の中の対比 | Think Right ← AdaptThink（「Different from the above baselines」） | `BASELINE_LIST_CONTRAST` → `compares_with`（対比にしない） |
| 手法名のある対象の引用（残り 1 本） | WebAgent-R1 ← WebRL（「an extension of GRPO (Qi et al.)」） | 未対応（名前から論文を引く表が要る。`relationR242.test.ts` に `it.fails` で記録） |

- テスト: `relationR242.test.ts`（11 本。3 本は赤→緑、1 本は既知の漏れ）。`test/lineage` 全体（1,336 本）も通過。
- 通し直し: 公開中の強い関係 71 本（会議 8、テーマ 5）を新旧の規則で比べた。変わったのは上の 3 本だけで、監査済みの 4 テーマは変化なし。

- 反映（2026-10-23）: ICCV 2025 と EMNLP 2025 を作り直した（ともに未監査で公開中）。ICCV 2025 は強い関係 7 → 6（PixelThink ← LISA が消えた）、EMNLP 2025 は 6 → 4（Think Right ← AdaptThink、WebArena の件が消えた）。残る誤りは WebAgent-R1 ← WebRL の 1 本（既知の漏れ）。EMNLP 2025 は公開の下限（3 本）に 1 本の余裕。2026 年開催の AAAI・ICLR と ACL 2025 は強い関係が 3 本未満で非公開のまま（Semantic Scholar の上位論文と目録の一致が少ない）。


### R2-43 サイトから入力した分野の家系図（2026-10-23）

Retrieval-Augmented Generation を実際にフォームから依頼して確かめた。

| 事実 | 内容 |
|---|---|
| 所要時間 | 入力から公開の処理の終わりまで 32 分（生成ジョブ約 17 分）。最初の試行は生成ジョブの 15 分の上限に当たり、家系図の生成が終わった直後に打ち切られて何も出なかった |
| 区分 | 論文 84・関係 295、強い関係 0 → 公開の下限（3）に届かず blocked。引用文が取れたのは 1,314 組のうち 184 組（キーなし S2 の 429 が 68 回） |
| 論文の選び方 | 中核は入るが、被引用 3〜40 の応用事例が多く混ざる。OpenAlex の記録の誤り（Self-RAG に別論文の著者・DOI、RAGAS の題名が別論文）が残る |

決定（ユーザー承認）: 強い関係が少ない分野も「関係の判定が少ない」と明記して未監査で公開する。実装: `theme_min_lineage_edges` = 0、会議は `conference_min_lineage_edges` = 3、ページの注記（`fewRelationsNote`）、上限・待ち時間・文言を 40/50 分に揃えた。

未対応（次の作業）: 論文の選び方（応用事例の足切り）、OpenAlex の記録の誤り（著者・DOI・題名を S2 で直す）、名前から派生を推定する規則（LoRA で評価すると適合率が約 7 割で、強い関係には足りない）、失敗時の画面の説明。

### R2-44 OpenAlex の記録の誤りを S2 で直す（2026-10-23）

RAG の系譜で見つかった 2 種類の誤りを、論文ごとの Semantic Scholar の引用数の取得（`s2CitationCounts.ts`、250 件ずつ）と同じ呼び出しで直す。`fields` に `title,authors.name` を足し、arXiv id を持つ論文だけを対象にする（arXiv id は OpenAlex の記録とは独立した同一性の手がかり。DOI だけの論文は直さない）。

| 誤り | 例 | 対応 |
|---|---|---|
| 著者が別の論文のもの | Self-RAG に Quanzhi Fu ほか、DOI は 2026 年の別論文 | S2 の著者と姓が 1 つも合わない → 著者を S2 のものにし、その記録の DOI（別の論文のもの）を外す |
| 題名が別の論文のもの | RAGAS（arXiv 2309.15217）が「Design and Evaluation of a RAG Architecture for OWASP…」 | 既存の `titlesDisagreeStrongly` か、語の重なりが半分未満 → 題名を S2 のものにし、別の記録から来た要約も消す |

キャッシュ（`s2_citation_counts.json`）の項目に `t`（題名）と `a`（著者）を足した。`t` のない古い項目は 1 度だけ取り直す。直した件数はログの `identity corrected=` に出る。
未対応: 論文の選び方（被引用が少ない応用事例の足切り。評価用データが先に要る）、失敗した依頼の再入力（進行中の記録が 50 分残る）。

### R2-45 低インパクトの末端を落とす（2026-10-23）

依頼した分野には、題名の語は合っても、グラフの中の誰からも引用されず、被引用も少ない応用事例（大学のチャットボット、製造の品質管理など）が混ざり、系譜を薄めていた（RAG 84 件のうち約 14 件）。`lowImpact.ts::pruneLowImpactLeaves` を、弱い入り口の検査（R2-30）と古い論文の検査（R2-35）の後に 1 回だけ掛ける。

- 落とす条件（すべて）: 種でも焦点でもない／被引用 30 未満／1 年以上前の論文／グラフの誰からも引用されない／辺に強い関係（extends・supersedes・contrasts・successor）がない。
- 公開中の系譜への試算（落ちる数）: RAG 14/84、LoRA 10/91、MoE 3/21（Speechmoe2 ほか応用事例）、FlashAttention・ViT・GNN は 0。監査済みの 4 テーマは作り直さないので変わらない。
- 1 回だけにする理由: 末端を落とすと別の節点が末端になるが、規則を予測できる形に保つため、その分は次の作り直しに任せる。

### R2-46 実験の道具の説明は拡張ではない（2026-10-24）

サイトから入力した Diffusion Models（21 論文、強い関係 3）の読み取りで見つかった 4 つ目の型。SVDiff ← Latent Diffusion が「extends」だった。S2 の引用文 8 件を全部渡したときだけ、「Our main experiments were conducted using StableDiffusion [51], which is a popular variant of latent diffusion models」が、マーカー [51] が被引用論文に解決されて「variant of」の強い手がかりとして効いていた（1 件ずつ渡すと `context_no_cue`）。実験をどの道具で行ったかの説明なので、拡張ではなく利用。

- 対応: `EXPERIMENT_TOOL`（「experiments were conducted using / we conduct experiments with / the model we experiment with / conduct our experiments based on」）に当たり、かつ first-person の extend / build の動詞がない文は `usageReason` = `experiment_tool`（`phrase_usage`）。
- テスト: `relationR242.test.ts` に S2 の 8 件の引用文を全部入れた RED→GREEN の事例と、実験の文の中の「we extend」が拡張のまま残る事例を足した。`test/lineage` 1,346 本が通過。公開中の強い関係 72 本の通し直しで変わるものはなし。
- 同じ読み取りで、強い関係 3 件のうち 2 件は「基礎文献リストに基づく規則」（`foundational_allowlist`）の拡張だった（引用しているだけ）。根拠の文は画面に「基礎文献を引用しており…拡張として残している」と出る。件数にも入るので、強い関係の数は「引用文から確かめた関係」より多く見える。扱いは未決定（既存の監査済みテーマが使っている規則のため、勝手に変えない）。

### R2-47 失敗した依頼を画面に出し、再依頼できるようにする（2026-10-24）

画面（`ThemeRequestForm`）は 6 回の確認ごとに Worker の `GET /api/themes/status` を呼んで失敗・中止の実行を表示する作りだったが、Worker 側の status は何も返さない休止状態（503）だった。そのため、失敗した依頼は画面にそのまま「生成中」と出続け（最後は 50 分の待ち時間切れ）、進行中の記録（50 分）が再入力を失敗した実行に誘導していた。

- 実装（`apps/api/src/lib/run-status.ts`）: 配信に使う PAT（`actions:write` は読み取りを含む）で theme-on-demand の最近の 30 実行を読み、題名の末尾が依頼 ID の実行を公開用の形（status・conclusion・html_url・時刻・題名）に絞って返す。依頼 ID ごとに 15 秒だけ覚え（isolate ごと）、画面が数秒ごとに聞いても GitHub への呼び出しは 15 秒に 1 回。取れないときは従来どおり 503。
- status 路（`GET /api/themes/status?request_id=…`）: 依頼 ID が正しい形でなければ 400、実行が見つかれば `{ok, status: "run", run}`、GitHub に聞けなければ 503。画面側は変更なし（`failureFromRun` が「生成に失敗しました / 生成が中止されました / 生成がタイムアウトしました」を出す）。
- 再依頼: 進行中の記録がある分野を再送信したとき、その実行が終わっていて成功でなければ（failure・cancelled・timed_out）記録を解放して新しく配信する。実行中・成功・見つからない・GitHub に聞けない場合は従来どおり同じ実行を追う。
- テスト: `test/routes/themes-run-status.test.ts`（実行の選択と公開用の形、15 秒の記憶、PAT なし・不正 ID・GitHub の失敗、status 路の 200/400/503、失敗した実行のあとの再送信が配信される／実行中・成功・未発見・取得失敗では追う）。API の 267 本が通過。
- Worker のデプロイを伴う。

### R2-48 深さ 1 で終わる分野を減らす・重複で全体を落とさない（2026-10-24）

Diffusion Models は深さ 1（種 5・幅 8）で 21 論文のまま公開され、Score-based 系や Imagen・Palette・D3PM が入らなかった。手元で同じ分野を深さ 2（種 10・幅 12）で作ると 56 論文（+35。Imagen、Palette、D3PM、eDiff-I、T2I-Adapter、Imagic、Null-text Inversion、概念消去の系列など。応用の末端は低インパクト除去が落とした後の数）。

| 変更 | 内容 |
|---|---|
| 自動拡張の下限 | 当初は `SPARSE_NODES` を 15 → 30 にしたが、実測（run 40159291498）で Diffusion Models が 47.6 分（S2 の 429 が 123 回）かかったため取りやめ、15 に戻した。代わりに R2-49（先に出して、あとで広げる）にした |
| 重複で全体を落とさない | 同じ論文が 2 つの ID（S2 と OpenAlex）で入り、片方に辺があると `cannot remap endpoint-bound provenance` で作成全体が失敗した（Diffusion Models の深さ 2 で再現）。辺の根拠の hash は両端の ID に結び付くので付け替えられないため、統合で消える ID に付いた辺だけを落とし（`dropEdgesOfMergedNodes`、件数を警告に出す）、作成は続ける。今回は 1 ノード統合・5 辺を落として 56 論文・433 辺 |
| 実験の道具 | 「we use X as our backbone, which is built on Y」（実験の土台の説明）も `experiment_tool` の利用扱い |

深さ 2 の強い関係 7 件の読み取り: 5 件は基礎文献リスト（DDPM を引用）の規則、1 件は「conditional variant of DDIM をデコーダに使う」（Diffusion Autoencoders ← DDIM、妥当）、1 件は上の実験の道具（Multi-Concept Customization ← LDM、利用なので直した）。

### R2-49 先に出して、あとで広げる（2026-10-25）

R2-48 の最初の案（深さ 1 が 30 論文未満なら、同じ実行の中で深さ 2 に作り直す）は、実測で Diffusion Models が 47.6 分かかった（生成ジョブ 40 分の上限すれすれ）。訪問者は最初の結果を 12 分で見られるのに、拡張を待たされる形になるので、2 回に分ける。

- 最初の実行（Worker が配信）: これまでどおり深さ 1（疎なら R2-37 の自動拡張）。昇格・公開まで終わると、その結果が深さ 1 で 30 論文未満なら、`upgrade` ジョブが同じワークフローを `expand=true` で配信し直す（`GITHUB_TOKEN` の `workflow_dispatch` は新しい実行を起こす。権限は `actions: write` のみ）。
- 拡張の実行: 深さ 2・種 10・幅 12 を最初から作る（浅い 1 回目を重ねない）。公開の保護（`publishGuard`）は同じで、公開中より悪い版は置き換えない。`expand` が true の実行からはさらに配信しない（連鎖しない）。
- 画面は最初の公開で完了と見なす。拡張版は、あとからデータが入れ替わる（再読み込みで見える）。
- テスト: `test/workflows/r2-49-quick-then-upgrade.test.ts`（入力、2 つの生成の段の条件、`upgrade` の出力と条件・権限・配信内容）。ワークフロー関係 487 本通過。

実測（RLHF、run 40162620416）: 1 回目は成果物のアップロードが GitHub 側の通信タイムアウトで失敗（生成は成功、約 20 分）。再実行の 1 回目が 14 論文だったため、R2-37 の自動拡張が同じ実行の中で深さ 2 を作り、40 分の上限で打ち切られた。疎な結果の拡張が先の実行に残っていたのが原因（R2-49 は 30 論文未満を後で広げるが、15 論文未満の「疎」は実行内で広げていた）。

R2-50: `--defer-sparse-expansion` を追加し、on-demand の最初の実行に付ける。疎（15 論文未満・5 辺未満）でも公開の下限を通れば、そのまま出して、`upgrade` ジョブが後で広げる（昇格条件は 30 論文未満または 5 辺未満）。公開の下限を通らない結果（ブロック）だけは、従来どおり同じ実行の中で広げる。

### R2-51 取得結果を実行間で使い回す（2026-10-25）

Semantic Scholar の API キーは取れない。AI2 は 2024 年 9 月から、無料ドメインのメール（Gmail など）と第三者向けアプリの申請を受け付けていない（公式 X の告知）。キーなしの共有枠では、GitHub Actions の実行は毎回空のキャッシュから始まり（`cache hits 0`）、429 の待機に 30 分近くを使う。RLHF の拡張版は 2 回とも、展開 63〜65 件のうち 2〜6 件が S2 に届かず、不完全な取得として公開を拒否された（run 40168805070、40170798652）。

- 実行の前に、上流の生の取得結果（S2 の参照・被引用数・種の参照・展開、arXiv HTML、Crossref、DBLP、GitHub stars）のキャッシュを復元し、終わりに（失敗した実行でも）保存する。`actions/cache` の復元・保存を分け、鍵は `upstream-fetch-cache-v1-<run_id>-<attempt>`、復元は接頭辞で最新を拾う。
- 分類器のキャッシュ（`classifications.json`）は入れない。分類規則がコミットで変わるので、古い結果を拾う危険がある。埋め込みとモデルは既存のキャッシュのまま。
- 失敗した取得は「見つからない」として保存されない（本当の未発見だけが 14 日、参照一覧は 90 日の有効期限つき）。
- テスト: `test/workflows/r2-51-fetch-cache.test.ts`。
