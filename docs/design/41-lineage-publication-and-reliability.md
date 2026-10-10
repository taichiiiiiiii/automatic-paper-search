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

### D6. 関係の分類: API 中心、LLM は補助（2026-10-10 追加決定、根拠は [43](43-api-based-relation-evaluation.md)）

- すべての関係を Semantic Scholar の引用文・引用の意図・「影響の大きい引用」の印から規則（43 の v2）で分類する。根拠の引用文を一緒に残す
- LLM には、手がかりの語（「〜を基に」「〜と比べて」など）がある関係と、影響の大きい引用で手がかりがないものだけを聞く。渡すのは要旨ではなく引用文と被引用側の書誌
- LLM が使えなくても規則の分類が残るので、D3 の分類率は保たれる
- 表示は段階的に進める。まず今の種類名（extends・contrasts・baseline_only 等）に対応づけ、理由欄に引用文を出す（形式は変えない）。その後 `lineage-artifact-v2` で 5 種類（builds_on・compares_with・uses_resource・background・cites_unspecified）に切り替える
- Semantic Scholar の無料 API キーはユーザーが申請中（`PAPERPILOT_S2_API_KEY`）。キーがなくても同じデータが取れるが、共有枠で 429 になりやすい

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
| R2-8 | 厳選テーマ（GNN から）の人手監査と「監査済み」公開 | R2-5 の後 |

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
