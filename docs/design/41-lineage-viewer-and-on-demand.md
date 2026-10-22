# 41. 系譜ビューアの作り込みとオンデマンド生成 — 設計案

- 状態: **設計案 第2版**（第1版へのレビュー第1回〔Opus: 重大4・中程度7・軽微3〕と、進捗表示への助言〔Fable〕を反映。再レビュー前）
- 作成: 2026-10-22
- 作業ブランチ: `feat/ts-migration`
- 前提: [39](39-typescript-cloudflare-migration.md)（移行計画）、[40](40-post-migration-extension.md)（移行後の拡張）
- ユーザー要望（2026-10-22）: 系譜ビューアを作り込む。サイトに分野名を入れて少し待てば系譜ができる形にする。中心は ①待ち時間の体験 ②ビューアの見た目と操作 ③生成の速さ ④公開できる系譜を実際に出すこと

## 0. 最初に押さえること

**いま本番で動いているのは Python と `docs/assets/*.js` で、`apps/*` は P5 の切替前のため、公開サイトには出ていない。**

- 本番のオンデマンド生成は `.github/workflows/theme-on-demand.yml:198` の `uv run --frozen python -m paperpilot.scripts.build_theme_lineage`。品質判定も Python（`promote-generated.sh` から `build_lineage_quality.py`）。利用者が見る画面は P5 まで `docs/assets/theme.js`（39 §7.3）
- したがって、TS 側（`apps/web`・`apps/pipeline`）に入れる改善は **P5 の切替で初めて本番に効く**。develop の Python や workflow を変える作業は、39 §7（Python は一致確認後に凍結）に反するため、ユーザー承認のうえ別枠で扱う
- 作業は次の 2 つに分けて考える。**A: P5 の前に TS 側で仕上げておくもの**（切替の時点で効く）。**B: 今すぐ本番に効かせるもの**（develop の変更が要り、承認が必要）。この文書の項目は、断りがなければ A

## 1. 現状（2026-10-22 に読んで確認した事実）

### 1.1 すでにあるもの

- 入力から生成までの流れ: テーマ投稿フォーム（`apps/web/components/themes/ThemeRequestForm.tsx`）→ Worker（`apps/api/src/routes/themes.ts`）→ `theme-on-demand.yml` → 5 秒ごとの確認 → 完成したら系譜の木へ移動（上限 12 分）。入力は分野名（テーマ文字列）で、今のまま使う
- TS の生成器: `apps/pipeline/src/lineage/theme/`。新しい契約（`relation`・`confidence`・構造化 provenance・`seed_paper_id`・`schema_version`）で出力し、`validateLineageArtifact` で検証済み（`build.ts:464,493`）。ただし**本番の生成経路ではない**（§0）
- ビューアは 3 系統: テーマ家系図（`components/themes/LineageTree.tsx`、1,203 行）、一論文の Focus View（`components/lineage/focus/`）、学会別グラフ（`components/lineage/graph/`）

### 1.2 公開できる系譜が 0 件の理由

- 公開中の 3 テーマ（flash-attention、mixture-of-experts、vision-transformer）は旧形式（`schema_version` なし、edge は `rel`/`conf`、provenance は文字列、`seed_paper_id` なし）。`artifact_contract_v1` と `edge_semantics_complete` が落ちる。**再生成していないことが原因で、判定の厳しさが原因ではない**
- 人手で「テーマに合っている」と確認した記録（golden fixture、`paperpilot/data/lineage-audit-fixtures-v1.json`）が 0 件（`collections: []`）。fixture が無い collection の `golden_fixture` は **unknown** になり（`buildLineageQuality.ts:433-434`）、audit_status も unknown になる（同:662-666）
- **帰結: 今のオンデマンドは、生成に成功しても必ず「品質監査を通過しませんでした」で終わる。** 表示の条件は audit_status が passed であること（`core.ts:619,764-768`）、確認処理は passed 以外を failed として返し（`data-themes.ts:149-154`）、画面が不合格の文言を出す（`ThemeRequestForm.tsx:168-175`）。速くしても、§2.2 が決まるまで利用者には何も見えない
- 学会別 10 件と deep 14 件は、空のデータ・孤立ノード・catalog との不整合も抱えており、後回しにする
- 判定は fail closed のまま変えない

### 1.3 生成が遅い理由（コードからの見積もり。実測はまだ）

- 全体は 8〜15 分と推測。外部 API 呼び出しが直列、リリース用 workflow が Python のフルテスト（`pages-release.yml:97-107`、skip が 1 件でも失敗）まで走らせる、ブラウザが完成に気づくのはサイト公開（deploy）の後、の 3 点が大きいと見ている
- 進捗表示（`ThemeRequestForm.tsx:220-222`）は経過時間で決めた疑似ステップ。status API は常に 503（休眠、`themes.ts:277-292`）
- 3.5 秒の待ちは Semantic Scholar 経由のときだけで、主な取得元の OpenAlex には無い。当初の「数分」は過大かもしれない
- **リリースの検証は 20〜30 分と見積もる記述がある**（p5-plan 277 行、A11）。一方ブラウザの待ち上限は 12 分（`themes-request.ts:45`、根拠は generate の 15 分）。切替後は、ほぼ全件がブラウザ側で先に時間切れになる可能性がある。この数字が実測か見積もりかは文書から判別できない
- 現行の 30 秒ごとの status 確認は、毎回 `resolveOrigin` で KV を 1 回読む。1 件あたり約 24 リクエスト・KV 読み 24 回を無駄に使い、40 §5.1 が指摘した「外から枯らせる」経路になっている

### 1.4 ビューアの粗い点（影響の大きい順）

1. 大きなグラフでズームと全体表示（fit）が無い
2. テーマ家系図にスマホ向けの設定が無い
3. 選んだノードが URL に出ず、共有できない
4. 根拠（evidence）の一覧は Focus View にしか無く、他の 2 つから行く道が弱い
5. loading / error の文言と見た目が 3 系統で不統一。失敗文言が「S2 / Groq」前提（`ThemeRequestForm.tsx:150`）で、主な取得元の OpenAlex と合わない
6. キーボード操作（矢印でノード間を移動）が無い
7. `LineageTree` 本体の描画とキー操作のテストが無い（レイアウトと URL 状態は純関数テストのみ）

## 2. 設計

### 2.1 公開できる系譜を出す（④）

1. 3 テーマを再生成する。TS 版を使うか、develop 側の Python を使うかは、§0 の A/B と合わせて決める。どちらも外部 API と LLM キーを使うので、実行前にユーザー承認
2. 孤立ノード（次数 0 で root でも focus でもない node）の扱いは、**判定を通すための刈り込みにならないよう、規則を先に文書で決める**。規則は Python 版と TS 版の両方に入れ、一致確認（39 §7.2）をやり直す
3. golden fixture は人手の確認が要る。候補（focus 全件と 20 件以下のサンプル、理由つき）を Claude が出し、**ユーザーが `on_topic` を確認する**。自動で埋めない
4. fixture は `input_sha256` に紐づく（`buildLineageQuality.ts:439`）。再生成で中身が変わったら、**sha だけを付け替えて古い確認結果を流用してはならない。** 付け替えてよいのは、変わったノードと新しいノードをユーザーが確認し直し、`reviewer` と `reviewed_at` も更新した場合に限る。これを CLI の受け入れ条件にする
5. quality manifest を再生成して、通過件数を確認する

### 2.2 オンデマンドで作った系譜の扱い（判断待ち）

- (a) 推奨: 自動チェックだけを通った結果を「**人の確認なし**」のラベルつきで、監査済みとは別枠に出す。**監査済みの表示条件（`core.ts:760` と Focus View）は変えず、別のルート・別の読み込み経路にする。** `artifact_contract_v1` と `input_sha256` の照合は必須のまま残し、「人の確認なし」と分かる表示を必ず付ける。監査済みの部品（Focus View）には載せない
- (b) 公開しない: ユーザーが確認して通ったものだけを出す。入力してもすぐには見られない
- (a) は fail closed の方針の例外になるため、ユーザーの決定が要る。**決まるまで、速度と待ち時間の作業は利用者に結果が見えない**ので、§3 でこの判断を先頭に置く

### 2.3 生成を速くする（③）

1. **実測**（読むだけ）: 直近の Actions 実行履歴で各ステップの時間を測る。リリースの検証が 20〜30 分という見積もり（§1.3）も、ここで実測か見積もりかを確かめる
2. 引用元取得の並列化（TS 側は実装済み、`8e165bc4`）。OpenAlex の ID だけ最大 4 件を同時に取り、Semantic Scholar は直列のまま。出力の順序は変えない。**効くのは P5 の切替後**（§0）
3. シードごとの references・citations 取得と LLM 分類の並列化。**Groq の無料枠は RPM のほかに TPM 12,000・TPD 100,000 がある**ので、並列にすると 429 が増え、circuit breaker が早く作動するおそれがある。実測で律速が TPM かを確かめてから決める
4. LLM 分類キャッシュ: `classifications.json` は git の管理下にある（`.gitignore:32-33`）が、promote の許可パスに含まれていない（`promote-generated.sh:41-47`）。つまり実際は「キャッシュがまっさら」ではなく、**新しく分類した結果が develop に書き戻されず捨てられている**可能性がある。`actions/cache` を足す前にこれを確かめる。利用者の入力でキャッシュが汚染されない対策（キー設計、検証してから使う）も書く
5. オンデマンドで重いテストを省く: 省いてよい条件は「**最後に公開した SHA との差分が、許可されたデータのパスだけ**」と決め、機械的に検査する。満たさない（develop に未公開のコードが入っている）ときは全部のテストを走らせる（fail closed）。省略は検証を弱めるので、別途レビューする
6. 結果を deploy より先に画面へ返す: 検証済みの release だけを表示する契約（§2.5）と衝突する。正本の SHA と品質判定に紐づける条件を明記できるまで、案のままにする。1〜5 の結果を見て判断する

### 2.4 待ち時間の体験（①）— 進捗はブラウザが GitHub の公開 API を直接読む

Fable の助言による推奨案。Cloudflare 側の消費はゼロで、むしろ減る。

- **やめるもの**: 30 秒ごとの Worker の status 確認（常に 503 を返すのに KV を消費する。§1.3）
- **データの流れ**:
  1. POST が `queued` を返したら、60 秒ごと（5 秒ではない）に `GET /repos/{owner}/{repo}/actions/workflows/theme-on-demand.yml/runs?event=workflow_dispatch&per_page=20`（認証なし。60 回/時/IP）
  2. `display_title`（run-name）を **末尾一致** `" / " + request_id` で照合する（`includes` は使わない。テーマ名は `[A-Za-z0-9 _-]{2,80}` で、公開されている他人の request_id をテーマ名にして「含む」run を作れるため）
  3. 見つかったら `GET /actions/runs/{id}/jobs` を 60 秒ごと。段階は、未発見・queued=キュー待ち、`generate` 実行中=生成中、`promote`=develop へ反映、`release / *`=検証・公開中、run 成功だが slug 未掲載=公開待ち、manifest と quality 合格=完了。段階は戻らない
  4. 403/429 か `x-ratelimit-remaining: 0` のときは、その run の問い合わせを止め、「進捗を取得できません（受付済み）」と経過時間を出す。manifest の確認は続ける
  5. 失敗: run が failure / cancelled / timed_out なら既存の失敗表示。run 成功かつ `promote.changed=false`（release を skip）は「公開内容に変更なし」と Issue・既存テーマへの導線。`admit` が stale なら「次の公開で反映」。いまはこれらがすべて 12 分の時間切れに潰れている
- **完了の判定**は今までどおり manifest と quality。GitHub の表示は進捗の案内にだけ使い、完了や表示可否の判断には使わない
- **変更するファイル**: `packages/core/src/site/config.ts`（CSP の `connect-src` に `https://api.github.com`、owner/repo/workflow 名の定数を 1 か所に）、`apps/web/lib/themes-request.ts`（段階の定義、`matchRunByRequestId`、`stageFromRun`、レート制限判定）、`apps/web/lib/data-themes.ts`（`fetchThemeRunStatus` を GitHub 向けに、fetch を注入）、`ThemeRequestForm.tsx`（疑似ステップの 3 本の `setTimeout` を削除、status から段階を導出）、`apps/pipeline/test/workflows/*`（job id と run-name の末尾 `/ ${{ inputs.request_id }}` を固定するテスト）、`docs/migration/safety-contracts.md` の SCR-37 の行
- **テスト（すべてモック）**: `stageFromRun` の行列（入れ子の `release / validate`、未知の job 名は無視）、末尾一致が「含む」の混同と改行つき id を拒否、レート制限で GitHub 呼び出しが止まり manifest は続く、fake timers で「GitHub 不通のまま 3 分経っても段階が進まない」、GitHub 呼び出しは 1 分に 1 回以下、成功かつ release skip の専用文言、失敗のリンクは `safeRunUrl` 経由、unmount で全停止、CSP テストで `api.github.com` がちょうど 1 回
- 失敗文言から「S2 / Groq」前提を外し、取得元に依らない表現にする
- 実装前に確かめる（読むだけ、手で 1 回）: 認証なしで 60 回/時/IP、`Access-Control-Allow-Origin: *`、入れ子の workflow の job が `release / <job>` で列挙されること、`display_title` に run-name が入ること。確かめられなければ案を直す

### 2.5 ビューアの見た目と操作（②）

小さい順に進める。CSP（インラインのスクリプト・スタイル禁止）を守り、SVG 属性と CSS module で実現する。

- S: スマホ向けの @media と余白、fit ボタン、選択ノードを URL（`?focus=`）に出す、loading / error の文言を共通化。**`?focus=` は検証済みの ID だけを受け付け、解決できないときは「何も無い」と同じ表示にする**（`core.ts:957-967` の方針）
- M: SVG の viewBox によるズームと移動を共通の hook にする（+/- ボタン、`0` で fit、ホイールは Ctrl 併用時のみ）。凡例・関係フィルタ・検索を共通部品にする。ノード詳細に根拠の要約を出し、Focus View へ行く導線をつける。矢印キーでノード間を移動する
- L（別途判断）: テーマ家系図と学会別グラフの描画・レイアウト・型を 1 つにまとめる。大きなグラフ向けのクラスタ折りたたみ。**検証済みの release だけを表示する契約は保つ**
- すべてに、描画とキー操作のコンポーネントテストを足す

## 3. 実装の進め方

- 順序: **§2.2 の判断** → §2.3 の実測 → §2.5 の S → §2.4（§5 の判断後）→ §2.5 の M → §2.3 の 3〜5 → §2.1（再生成と確認記録。承認後）
- 各ステップで、実装 → 別のエージェントによるレビュー → 修正 → 機械的な確認、を回し、重大・中程度の指摘が 0 になってから次へ進む
- モデル（ユーザー指示 2026-10-22、`~/.claude/CLAUDE.md`）: 実装は Sonnet、レビューは Opus（実装とは別のエージェント）、方針・設計の相談役は Fable、読むだけの調査は Sonnet、機械的な確認は Haiku
- テスト: 外部 API を叩くテストは書かない（`fetch` を注入してモック）

### 受け入れ条件

- 生成時間: 実測のうえ、中央値と p90 の目標を決めて本書に書く（実測前は数値を置かない）
- 公開できる系譜: 監査済みで 3 本以上（flash-attention・mixture-of-experts・vision-transformer を目標）。判定は緩めない
- Vitest のカバレッジ 80% 以上。外部 API を叩くテストが 0 件
- 進捗表示: 実ジョブの状況に連動し、GitHub が不通でも段階が勝手に進まない
- CSP: `connect-src` の追加が `api.github.com` の 1 件だけ

## 4. ユーザー承認が要る操作

- 生成器の実行（外部 API と API キーを使う）、workflow の起動
- 公開データ（`docs/themes/**`）の更新を含む commit の develop への反映、Pages・Worker の公開、develop 側の Python・workflow の変更（§0 の B）
- golden fixture の `on_topic` の確認（ユーザー本人が行う）

## 5. 判断待ち

1. オンデマンドで作った系譜の扱い（§2.2 の (a) か (b)）
2. 確認記録の作成の進め方（Claude が候補を出し、ユーザーが確認する形でよいか）
3. 3 系統のビューアの統合（§2.5 の L）を今回やるか、別の機会にするか
4. **CSP に `https://api.github.com` を足してよいか**（39 §4.4-1 は CSP を契約扱い）。副作用として、閲覧者の IP が進捗の確認ごとに GitHub に届く。リポジトリが非公開になると、進捗は黙って「取得できません」の表示に落ちる
5. **待ち上限の契約（SCR-40）の変更**: 「run が実行中の間は時間切れにしない」へ変えるか。リリース検証が 20〜30 分なら、12 分では切替後にほぼ全件が時間切れになる。実測（§2.3 の 1）の後に決める
6. 今すぐ本番に効かせる作業（§0 の B）をやるか、P5 まで待つか

## 6. 未確認のこと

- 実際の生成時間の内訳（§1.3 は推測）とリリース検証の実測時間
- 無料枠（GitHub Actions の分数、Worker・KV の上限）に対する、オンデマンド 1 件あたりの消費量
- 学会別・deep の系譜を公開基準に載せるための作業量
- GitHub 公開 API の挙動（§2.4 の「実装前に確かめる」の 4 点）
