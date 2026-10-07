# 39. TypeScript 全面移行と Cloudflare Pages 化 — 設計とロードマップ

- 状態: **計画（第 6 版、レビュー第 1〜5 回の指摘を反映。重大・中程度 0）**。コードはまだ書かない（CLAUDE.md フェーズ 1.5）
- 作成: 2026-10-04
- 作業ブランチ: `feat/ts-migration`。`develop` への push は Worker と Pages を自動デプロイするため、移行作業は必ずこのブランチで行う
- 無料枠の数値は **2026-10-04 に Cloudflare の現行ドキュメントで確認済み**（§1.1）

## 進捗（2026-10-07 時点、`feat/ts-migration`）

| フェーズ | 状態 |
|---|---|
| P1 土台 | 完了（CSP 方式の実証、比較ツール、Python 互換関数、スキーマ検証、TS CI） |
| P2 画面 | 完了。レビュー 3 回で重大・中程度 0。残りの差は [`docs/migration/p2-parity-gaps.md`](../migration/p2-parity-gaps.md) |
| P3 API | 完了（Hono、Durable Objects の正確な上限、空打ちモード、受付停止スイッチ） |
| P4 収集・生成 | 完了。レビュー 3 回で重大・中程度 0。残作業と判断待ちは [`docs/migration/p4-followups.md`](../migration/p4-followups.md) |
| P5 切替 | 手元（オフライン）でできる準備（tier A: A0〜A4・A6〜A11）は完了。2026-10-07 時点で、データ移動のリハーサル・形式差の確認（差 0、B′ 不要）・所要時間の計測（timeout の変更不要）が合格（[`p5-plan.md` §8](../migration/p5-plan.md)）。残りは A5・A12（Cloudflare Pages のプロジェクト名と本番 URL が必要）と、ユーザー作業（Cloudflare トークン・Pages プロジェクト・GitHub environment・Workers Builds 設定）、各段の承認 |

## 判断結果（2026-10-05、ユーザー「推奨で進めてください」）

| 項目 | 決定 |
|---|---|
| 家系図レビューの取り込み道具（`lineage_pilot/**`・`prepare/ingest_lineage_review.py`） | 移植しない。P5 で Python と一緒に削除（必要になれば TS で作り直す） |
| unarXive 用 DuckDB | 追加しない。読み取り側は「使えない」既定のまま、索引作成は移植しない |
| テーマ依頼の確認用モード（dry_run）の表示文言 | 今の仮文言のまま |
| メール通知 | TS 版では対応しない（有効にすると記録して失敗扱い）。既存設定はオフ |
| 類似度計算（Stage 3 embedding） | TS 版では対応しない（有効にすると stage3 として記録）。既存設定はオフ |
| 論文スライド（判断待ち 1） | P5 で削除（既定案どおり） |

## 0. 決定事項（ユーザー指示）

| 決定 | 出典 |
|---|---|
| TypeScript で作り直し、Cloudflare Pages に載せる | 「TypeScriptで作り直してCloudflare Pagesにしてください」 |
| 基本無料で組む | 「基本無料で組みたいです」 |
| Python を残さない（収集・生成も TypeScript へ） | 「Pythonが残っていることが気持ち悪いです」 |
| 今後広げやすい構成にする | 「今後広げやすいものにしたい」 |
| 不要なファイルを整理する | 「不要なファイルは整理して下さい」 |

運用コスト目標は現行 CLAUDE.md の「¥0〜¥1,500/月」のうち **¥0 を基本**とする（独自ドメインを使う場合のみ年 ¥1,500 前後）。

## 1. 目標構成

```
apps/web        Next.js（App Router、静的書き出し output: "export"、trailingSlash: true）
                ＋ TypeScript ＋ Tailwind CSS ＋ shadcn/ui → Cloudflare Pages
apps/api        Hono on Cloudflare Workers（D1 ＋ Drizzle、Durable Objects）
apps/pipeline   収集・カタログ生成・家系図生成・監査・promoter（Node、GitHub Actions で実行）
packages/core   データ形式（zod）、slug 規則、スコア計算、venue 判定、公開 URL 設定など共有ロジック
packages/ui     画面部品（shadcn/ui ベース、家系図描画のコア）
data/published  公開 JSON（現行 docs/ の生成物）
data/state      seen_ids、run_history、LLM 分類キャッシュ、引用キャッシュ（現行 paperpilot/data の状態）
data/inputs     学会ごとの収集結果 CSV と summary.csv（現行 paperpilot/output）
data/config     設定 yaml/json（conference-sources、theme_aliases、denylist、品質ポリシー等）
```

`data/` への移動は **P5 で 1 回だけ**行う（§7.3）。P1〜P4 の間、新しいコードは現行の場所（`docs/`、`paperpilot/data/`、`paperpilot/output/`）を**読むだけ**で、書き出しは一時ディレクトリにする（CI で、実行後に `docs/`・`paperpilot/data/`・`paperpilot/output/` の git 上の内容が変わっていないことを確かめる）。場所は `packages/core` の設定 1 か所で切り替える。

### 1.1 技術の選択と無料枠（2026-10-04 確認）

| 層 | 選択 | 無料枠の目安と注意 |
|---|---|---|
| 画面 | Next.js 静的書き出し、Tailwind、shadcn/ui | 実行時サーバー不要。インラインスクリプトの扱いは §4.4 |
| 配信 | Cloudflare Pages（Direct Upload） | 1 サイト 20,000 ファイル・1 ファイル 25MiB（現状 `docs/` 全体 513 ファイル、最大 6.3MB）。ビルドは月 500 回（Git 連携のビルドに適用。直接アップロードの扱いはドキュメントに明記なし。生成ごとのリリース回数を月数十回以内に保つ）。`_headers` は 100 ルール、`_redirects` は静的 2,000・動的 100。プレビューは無制限 |
| API | Hono on Workers Free | 1 日 10 万リクエスト（UTC 0 時にリセット）、CPU 10ms/リクエスト、スクリプトは非圧縮 64MiB まで（圧縮後の上限なし）、サブリクエスト 50/リクエスト。Pages Functions を使うと同じ枠を共有するので、Pages Functions は使わない |
| DB | D1 ＋ Drizzle | DB 1 つあたり 500MB、アカウント合計 5GB、DB は 10 個まで、1 回の呼び出しで 50 クエリまで。依頼・進捗・将来の利用者データ用。論文データ本体は D1 に入れず静的 JSON のまま |
| 正確な依頼上限 | Durable Objects（SQLite 型のみ Free で利用可） | 1 日 10 万リクエスト、稼働 13,000 GB-s/日、保存 5GB、読み取り 500 万行/日・書き込み 10 万行/日。超えるとその種類の操作はエラーになる（安全側に倒す設計と合う）。依頼数の上限カウンタ程度なら十分 |
| 収集・生成 | GitHub Actions 上の Node | 公開リポジトリの標準ランナーは無料。schedule は 60 日活動がないと止まる（現行は cron 無し） |
| 実行環境 | **Node 22 LTS**（Node 20 は 2026-04 にサポート終了） | 型除去を使えるが、安定性のため実行は tsx、テストは Vitest に統一 |
| 道具 | pnpm（corepack）、tsx、Vitest、Playwright、Biome | 無料 |

**データの置き場所**: 論文データは git にコミットした JSON のまま持ち、利用者データだけを D1 に入れる（リポジトリの pack は現在約 75MiB）。公開 JSON の合計が 1GB を超えるか、git の操作が重くなったら Cloudflare R2（無料枠 10GB）への移動を検討する。

**有料に上げる条件（参考）**: アクセスが Workers Free の上限を超えたら Workers Paid（月 $5）。その時に SSR を選べるよう、`apps/web` は OpenNext で Workers に載せ替えられる書き方を保つ。

**補足**: Cloudflare は新規には「Workers の静的アセット配信」も勧めている。ユーザー指示どおり Pages を使うが、後で Workers に寄せても `apps/web` の出力はそのまま使える。

### 1.2 採らないもの

NestJS（この規模には重い）、Go/Rust（速度が問題の処理がない）、Supabase 無料枠（非アクティブで一時停止する）、Vercel（無料プランは商用不可、Pro は予算超過）、Next.js の実行時 SSR（Workers Free の CPU 上限で不安定）、Pages Functions（Workers の無料枠を食い合う）。

## 2. データの流れ

### 現在
```
GitHub Actions（Python）→ 候補を生成（credential-free）→ promote-generated.sh が派生ビルダー 8 本と検査を走らせ
  docs/ の許可パスだけを develop に CAS promotion → pages-release.yml（6 段）→ GitHub Pages
CF Worker（worker/）→ theme-on-demand.yml を dispatch
```

### 移行後（P5 以降）
```
GitHub Actions（apps/pipeline）→ 候補を生成（credential-free）→ Node 版 promoter が派生ビルダーと検査を走らせ
  data/ の許可パスだけを develop に CAS promotion → apps/web をビルド → Node 版リリース（6 段、§4.3）→ Cloudflare Pages
apps/api（Hono）→ D1 に依頼・進捗、Durable Objects で上限 → theme-on-demand を dispatch
```

公開データ（JSON）の**中身の形式は変えない**。画面と生成処理を別々に移せるようにするため。

## 3. データ形式

- `schemas/*.schema.json`（23 本、JSON Schema）は**そのまま正本として残す**。
- `packages/core` で JSON Schema から zod の型を生成する。**P1 で 23 本すべてが変換できるか（`$ref`、`patternProperties` 等）を検証**し、変換できないものは ajv による実行時検証で補う。
- 書き出し直前の検証は**本番に新しく入るゲート**なので、範囲を決めてから入れる。P1 で次を作る:
  - 出力ごとのスキーマ有無の一覧（`papers.json`、`conferences.json`、`themes-manifest.json` など大きい出力にはスキーマが無い）と、無いものを作るか範囲外とするかの方針
  - 「公開済みの全ファイルに対して、TS の検証器と Python の jsonschema の判定が一致する」テスト（`pattern` の `\d`・`\w` の Unicode の扱い、`format: date-time`、zod の `datetime()` が `+00:00` を既定で拒否する点など）
  - 判定が一致し、公開済みデータが全部通ることを確かめてから、形式違反なら書かないゲートを有効にする
- 形式を変える時は schema → 生成コード → 両側のテストを同時に変える。

## 4. 公開先・URL・セキュリティ

### 4.1 URL が変わる

`https://taichiiiiiiii.github.io/automatic-paper-search/...` から Cloudflare Pages の URL（`<project>.pages.dev` または独自ドメイン）に変わり、**パスの接頭辞 `/automatic-paper-search` がなくなる**。影響範囲（直書き 29 ファイル）:

- 各ページの canonical、OG タグ（`og:url`、`og:image`）、`sitemap.xml` と `build_sitemap.py`
- `paperpilot-api-base` メタ、CSP の `connect-src`（workers.dev のホスト）
- Worker の `PAGES_ORIGIN`（`worker/response.js`）、`worker/*.test.mjs`、`worker/README.md`、`test_worker_request_id_contract.py`、`test_theme_csp_api_host.py`
- `search-detail.js` の `base.pathname` を使う判定と、学会ページ判定の正規表現（`-\d{4}/$`、末尾スラッシュ必須）
- `.lighthouserc.json`、README、CLAUDE.md

### 4.2 移行の方針

1. パスは**接頭辞を除いた形で保つ**（`/automatic-paper-search/cvpr-2026/` → `/cvpr-2026/`）。`trailingSlash: true` にする。
2. 公開 URL・API ホストは `packages/core` の設定 1 か所に集め、canonical・OG・sitemap・CSP・API メタをビルド時に生成する（直書きをなくす）。
3. `.html` の直リンク（`lineage.html`、`deep.html`、`paper-links.html`）は、Next の出力（`<conf>/lineage/index.html`）ではファイルが存在しないため Pages の自動転送が効かない。`_redirects` にプレースホルダー付きの規則（`/:conf/lineage.html /:conf/lineage/ 301` など）を書き、**Next の形の出力に対して**転送のテストを書く。サイト内のリンクは拡張子なしに統一する。
4. **トップに `404.html` を必ず置く**（無いと Pages は SPA とみなし、存在しないパスにも 200 を返す。空の `lineage.json` で 200/404 を区別する契約が崩れる）。存在をテストで確かめる。
5. 切替後、GitHub Pages には旧パス → 新パスの**転送用静的ページ**だけを残す（GitHub Pages は 301 を返せないため）。転送は外部ファイル `redirect.js`（`script-src 'self'` で許される）で行い、`?q=`・`?theme=`・`#...` を保ったまま新 URL に飛ばす。`<meta http-equiv="refresh">` は JS が動かない時の予備、canonical は新 URL。転送ページを GitHub Pages に上げるための最小の workflow を P5 後も残す（Python には依存しない）。新しい sitemap を Search Console に登録する。JSON を直接読んでいる外部の利用者は転送できないことを残存リスクとして記録する。
6. 移行期間中、API は**許可リストで新旧両方の origin を照合**し、一致した origin を ACAO に返す（`Vary: Origin`）。照合は完全一致のみ。プレビューの origin（`<hash>.<project>.pages.dev`）は本番 API の許可リストに入れない。切替完了後に旧 origin を外す。
7. この許可リストと「依頼受付を止めるスイッチ」は、**デプロイで上書きされない場所（KV のフラグ）に置き、リクエストごとに読む**。現行 `worker/` と `apps/api` は同じ KV の同じフラグを読む（コミットした `vars` やダッシュボードの環境変数は、develop への push で再デプロイされると上書き・巻き戻りが起きるため使わない）。許可リストも KV の値にし、独自ドメインの決定でコードを変えずに更新できるようにする。スイッチは**安全側に倒す**: フラグが無い・KV の読み取りが失敗した・別の namespace に誤って紐付いた場合は「停止」とみなし、503 `status: "paused"`（枠は消費しない）を返す。許可リストが無い・読めない時は 403。停止中の応答は画面で「現在受付を一時停止しています」と GitHub Issue での依頼リンクを出し、契約テストで固定する。状態の確認用に読み取り専用の `GET /api/health`（`accepting`、`dispatch_mode`、`pat_configured`、`kv_namespace_tag` を返し、秘密は返さない）を用意する（休眠中の `/api/themes/status` を置き換えてよい）。これらを**現行の `worker/` に develop で先に入れる**。その際は必ず、KV に `accepting` フラグと現行 origin の許可リストを**先に書き込み**、push 後に `/api/health` で受付中であることを確かめる（順序を誤ると、安全側の動作で本番の投稿フォームが止まる）（`c090c84` と同程度の小さな変更、ユーザー承認のうえ push）。これがないと、Cloudflare Pages を本番にした瞬間から投稿フォームが 403 になる。

### 4.3 公開の仕組み（現行 6 段の Cloudflare 版）

現行 `pages-release.yml` の 6 段をすべて引き継ぐ:

| 段 | 現行 | Cloudflare 版 |
|---|---|---|
| validate | SHA 形式、skip 0 の全テスト、`validate-pages-release.sh local` | 同等（Node 版の全テスト＋バンドル検査） |
| build | 再検証、配備マーカー `_paperpilot-deployment.json` | `apps/web` をビルドしマーカーを書く |
| admit | develop の祖先か、新しい差分がないか（古い成果物を捨てる） | 同等 |
| deploy | `upload-pages-artifact` → GitHub Pages | `wrangler pages deploy out --branch=<本番ブランチ> --commit-hash=$SHA` |
| smoke | 公開先のマーカーが期待 SHA か | `<本番 URL>/_paperpilot-deployment.json` を確認 |
| concurrency | `paperpilot-pages-production` で直列化 | 同じ group 名で直列化 |

- **ロールバック**: 現行は GitHub Deployments（environment `github-pages`）の成功記録を known-good の根拠にしているが、成功扱いは deploy ジョブの時点で付くため smoke に失敗した SHA も known-good になり得る（現行の弱点）。移行後は、
  - 成功の記録は **smoke ジョブが成功した時だけ**付ける。
  - Cloudflare のデプロイ ID を GitHub Deployment の payload に保存する。
  - ロールバックは再ビルドではなく、Cloudflare Pages の「過去のデプロイに戻す」機能をそのデプロイ ID で使う（再ビルドは同じバイト列にならない）。
  - ロールバックできるのは P5 以降に Cloudflare に出した SHA に限る。`pages-rollback.yml` の environment 名の参照も合わせて変える。
- **認証情報**: `CLOUDFLARE_API_TOKEN` は develop に限定した GitHub environment の deploy ジョブだけに渡す。生成・候補作成ジョブには渡さない（credential-free を保つ）。「Cloudflare Pages: Edit」権限はアカウント内の全 Pages プロジェクトに効き、プロジェクト単位に絞れない可能性がある（要確認）。残存リスクとして記録する。
- **プレビュー**: Direct Upload のプロジェクトでは、`--branch` が本番ブランチと一致しないデプロイは誰でも見られるプレビューになる。プレビューも外部公開にあたるため、**上げるのはユーザーの承認を得てから、ユーザーの手元の wrangler からだけ**行う。Pages のトークンはプロジェクト単位に絞れない可能性があり、どの環境に置いても本番ブランチに上げられる（本番と同等の権限）ため、GitHub のプレビュー用 environment には置かない。検証済みの成果物だけを上げ、必要なら Cloudflare Access（無料枠）で閉じる。本番用トークンは develop 限定 environment にだけ置き、feat ブランチの CI には Pages のトークンを一切渡さない。
- **公開対象**: `docs/design`、`docs/research`、`docs/*_IMPLEMENTER.md` は公開物に含めない（現行は docs/ ごと公開されている）。

### 4.4 CSP（Next.js と厳格な CSP の両立）

現行は全ページがメタ CSP `script-src 'self'`、`docs/lineage/index.html` は `style-src 'self'` も指定している。Next.js App Router の静的書き出しは各 HTML にインラインの `<script>self.__next_f.push(...)</script>` を出すため、そのままでは CSP に止められる。

メタ CSP は最初に読み込んだ文書のものが最後まで使われ、Next の画面内遷移（`next/link`）では次のページの HTML（とそのメタ CSP）を読まない。現行はページごとに CSP が違う（`connect-src` に Worker ホストを含むのは `/themes/` だけ、`style-src 'self'` だけなのは `/lineage/` だけ）ため、ページごとの CSP のままだと遷移先で機能が止まったり、気付かれずに緩くなったりする。

**方針: script のハッシュ以外の指令をサイト全体で 1 つにそろえる**
1. `default-src`・`connect-src`（`'self'` と API ホスト）・`style-src`・`font-src`・`img-src`・`base-uri`・`form-action` は**全ページ同じ値**にする。値は `packages/core` の設定から生成する。
2. ページごとに変わるのは `script-src` の `'sha256-...'` だけ。ビルド後の処理で各 HTML のインラインスクリプト（App Router の `self.__next_f.push(...)`）の sha256 を集め、そのページのメタ CSP に書き込む。最終成果物から取るので 1 回のデプロイ内では安定する。**ビルドをやり直すとハッシュは変わる**（Next がビルドごとに乱数のビルド ID をインラインスクリプトに埋め込むため、P1 の実証で各ページ 1 本だけ変わることを確認）。そのため「1 回ビルドしたその成果物からハッシュを取り、その成果物をそのまま公開する」を守り、smoke では配信 HTML がその成果物と一致することを確かめる。`'unsafe-inline'` は使わない。
3. スタイルは全ページ `style-src 'self'` を目指す。フォントは next/font で自サイトから配信し（Google Fonts を許可しない、`font-src 'self'`）、`style=""` 属性を出す部品（next/image、プリレンダー時に style を出す Radix/shadcn の一部）は使わないかクラスに置き換える。どうしても残る場合は `'unsafe-hashes'` ＋ハッシュで個別に許可し、その一覧を契約テストで固定する。
4. `frame-ancestors` はメタ CSP では効かないので、`_headers` に **`frame-ancestors 'self'` だけ**を書く（他の指令をヘッダーにも書くとメタ CSP と両方が適用され、ハッシュ許可が効かなくなる）。`'none'` にすると横断検索の同一オリジン iframe が壊れる。
5. Cloudflare 側の自動挿入（Rocket Loader、Web Analytics の自動挿入、メールアドレス難読化）は切る。smoke で配信された HTML 1 枚が成果物とバイト一致することを確かめる。
6. 論文データは今と同じく**ブラウザ側で fetch し、ビルド時に埋め込まない**（埋め込むと RSC のインラインスクリプトにデータが丸ごと入り、現行の「1 ページ gzip 1MB 未満」が崩れる）。
7. **P1 で先に契約テストを作る**: 書き出し結果に「ハッシュ未登録のインラインスクリプト」「許可一覧にないインライン style 属性」「`on*=` 属性」「`javascript:` URL」が 0 件。script 以外の CSP 指令が全ページで同一。各ページから画面内遷移で `/themes/` に入って投稿まで通る（Playwright）。

**P1 で実証済み**（2026-10-04、`apps/web` の最小構成: Next 15 App Router・静的書き出し・Tailwind 4 で、インライン style・`on*=`・`javascript:` は出ず、ハッシュ方式の契約テストが通った。shadcn/Radix の部品を足す P2 で同じ契約テストを再確認する）。この方式が成り立たない場合（ハッシュが不安定など）は、インラインスクリプトを出さない構成（Vite の MPA ＋ React など）に切り替え、その時点でユーザーに報告する。

### 4.5 API の置き場所と独自ドメイン

- 既存の Worker `paperpilot-themes` と KV バインディング・secret を**引き継ぐ**（新しい Worker を作るとホスト・CSP・API メタ・ACAO が再度変わるため）。
- **独自ドメインを使う場合**は、`/api/*` を Worker に振り分け、`connect-src 'self'` だけで済み CORS が不要になる。将来ログインを入れる時の Cookie（同一サイト）にも有利。拡張性の観点ではこちらが望ましい（判断待ち 3）。
- feat ブランチで Workers Builds がブランチごとのプレビュー版を上げる設定になっていないか、P1 でダッシュボードを確認する（プレビュー版が本番の KV・secret を使う恐れがある）。
- **プレビュー・開発用の API は本番の生成を起こさない**: 本番の Worker は `GH_REF: "develop"` と本物の `GH_DISPATCH_PAT` を持ち、依頼を通すと develop で本物の theme-on-demand が動き公開まで進む。プレビュー用の API は PAT を持たない **dry-run の dispatcher**（dispatch の中身を記録するだけ）にし、KV・D1・Durable Objects もプレビュー専用に分ける。
  - モードは明示の設定 `DISPATCH_MODE=dry-run|live` で選ぶ（PAT が無いことから推測しない）。
  - dry-run の応答は `status: "dry_run"` で、`queued` は決して返さない。
  - live で PAT が無い・不正なら 503（枠は消費しない）。黙って「受付済み」と答えない。
  - `GH_REF=develop` または本番 origin の時は dry-run を拒否する（設定ミスで本番が空打ちになるのを防ぐ）。本物の dispatch を通すのは P5 の切替時に、ユーザーの承認を得て 1 回だけ。
- Durable Objects を Free で使うには、マイグレーションで `new_sqlite_classes` を指定する（`new_classes` ではデプロイに失敗する）。

## 5. API（apps/api）

- 現行 `worker/` のモジュール（`themes-post.js`、`slug.js`、`validate-input.js`、`response.js`、`request-id.js`、`run-match.js` ほか）を Hono のルートにほぼそのまま移す。テストは Vitest に移植。
- 新たに解決するもの（現行の判断待ち）:
  - 依頼数の上限を Durable Objects で正確に数える（移行前からの判断待ち「Durable Object」）
  - dispatch 失敗時の枠の返却（同「枠の返却」）
  - 依頼と進捗を D1 に記録し、進捗 API を本物にする（同「休眠中の status 窓口」）
- 守る約束: GH_DISPATCH_PAT を応答・ログに出さない、origin・content-type・body サイズの検査、manifest を読めない時は「既存」と答えない（`c090c84` の内容）。

## 6. 収集・生成（apps/pipeline）

### 6.1 移植対象
sources（arXiv / S2 / OpenAlex）、signals、pipeline の各 Stage、exporters（CSV / JSON / Slack / Email）、LLM provider（groq / gemini / claude / ollama）、utils、scripts（カタログ・検索インデックス・sitemap・identity-lite・家系図・品質監査・学会の収集器）、`conference_watch/`、`identity/`、`lineage_pilot/`、`replay/`、`.github/scripts/` の promoter と検証スクリプト。

arXiv は公式の Node クライアントがないため Atom を自前で取得・解析する。現行の「Atom feed か厳密に検査する」処理を取得処理の一部として作る。

### 6.2 引き継ぐ安全対策（P1 で機械的に洗い出して対応表にする）

P1 の成果物として、`paperpilot/` と `.github/scripts/` を洗い出した「**安全対策 → 移植先 → 移植するテスト**」の対応表を作る。少なくとも次を含む:

- 収集: arXiv の「例外にならない欠損」の検出、S2 / OpenAlex の不完全キーワード・読めない item・生き残りゼロのページ、シグナルの run_failures と `degraded_signals`、`--fail-on-errors` の終了コード契約
- 出力: 原子的書き込み、同日の上書き禁止、seen_ids の退避、CSV の数式無害化（`csv_safety`）
- カタログ: 縮小ゲート、二段階公開、identity ゲート、「索引にあるのに再構築できない学会」の拒否と all-or-nothing の書き込み、identity-lite / identity coverage
- 家系図: BuildCompleteness と expansion gate（全 builder）、Groq の circuit breaker、テンプレート的 rationale の拒否と purge、分類キャッシュの統合・圧縮、theme alias のフォールバック、off-topic 除外の 5 層
- 公開: promoter の許可パスと CAS 検査、`validate-pages-release.sh`、push 競合対策
- 画面: 信頼できないテキストのエスケープ（`test_search_untrusted_text.mjs`）、slug・パスの path traversal 対策（`utils/payload.py`、`utils/github.py`）、slug 規則の一致

### 6.3 ルール
- 外部 API を叩くテストは書かない（モック必須）。
- LLM 呼び出しは `AbstractLLMProvider` 相当の共通インターフェースを経由する（絶対ルール §11 の TS 版）。
- lineage / theme の JSON は唯一の生成元を守る（絶対ルール §13・§14 の TS 版）。

## 7. 移行方式

### 7.1 一つずつ置き換える
各段階で TypeScript 版を作り、**同じ入力で Python 版と結果が一致することを確かめる**。一致した段の Python は比較対象から外し、以後その部分の Python コードは変更を凍結する。Python のファイルを消すのは **P5 の切替 commit の後**だけ（切替 commit を revert すれば現行に戻れるようにするため）。

### 7.2 一致の定義（比較ツール `apps/pipeline/parity`、P1 で最初に作る）

- **入力の固定**: 状態データ（seen_ids、キャッシュ、CSV、設定）を、比較する develop の commit SHA で固定したスナップショット（SHA を比較結果に記録する）。時計は注入し、LLM はモックかキャッシュのみ、ネットワークは遮断する。
- **JSON**: 読んだ中身で比較。浮動小数は**書式差だけ許容し、値は完全一致**（許容誤差は設けない）。
- **JSON 以外**: CSV（utf-8-sig の BOM、数式ガードの先頭アポストロフィ）、XML（sitemap）、Markdown（`oral_summaries_ja.md`）、シャードのファイル割り当て（`paper-details-v1/`、`search-paper-ids-v1/`）、`paper_id` の sha1 導出は**バイト一致**。
- **失敗系**: 失敗フィクスチャで、終了コードと「既存ファイルが変わらないこと」（縮小ゲート、不完全ビルドゲート、`--fail-on-errors`）を比較する。
- **言語差の一覧を `packages/core` の単体テストにする**:
  - 丸め（Python の `round()` は銀行丸め、JS の `Math.round` / `toFixed` は違う。スコアに影響、絶対ルール §5）
  - 並び順（Python の `sorted()` はコードポイント順、JS の `sort()` は UTF-16 コード単位順）
  - 正規表現（Python の `\w` は Unicode、JS は `/u` を付けても ASCII。slug に影響）
  - 文字処理（`lower` / `casefold`、NFKC 正規化、`ensure_ascii`）
  - 時刻の書式（Python の `isoformat()` はマイクロ秒と `+00:00` を含む。JS の Date はマイクロ秒を出せない。スキーマによっては `Z$` を要求する）。Python 互換の書式を出す関数を `packages/core` に置き、文字列で大小比較している処理がないかも確認する
- 切替時に 1 回だけ、公開 JSON の書式（数値表記・キー順・末尾改行）の変化を許容する。差分が書式だけであることを比較ツールで示してから切り替える。

### 7.3 共存期間のルール
- `develop` の現行サイト・Worker・workflow・promoter は、P5 まで**今のまま動かす**。develop には生成データの自動 commit が入り続けるので、**データは develop が正本、feat 側はデータに触らない**。feat ブランチには develop を定期的に取り込む（衝突はデータでは起きない前提）。
- P1〜P4 の新しいコードは現行の場所（`docs/` など）を読む。`data/` への移動、promoter と派生ビルダーの Node 化、workflow の paths 更新は **P5 で 1 commit にまとめる**。Python の削除と文書の書き直しはその後の別 commit に分ける（戻す時に切替だけを revert できるように）。
- ルートの `wrangler.jsonc` と `worker/` は `apps/api` が完成するまで触らない（Workers Builds が読むため）。**例外**: §4.2-7 の KV スイッチ・origin 許可リスト・`/api/health` と、判断待ち 5 の `c090c84` は、ユーザー承認のうえ develop の `worker/` に先に入れる。停止中の画面表示（paused）も、P5 までは現行の `docs/assets/theme.js` が利用者の見る画面なので、同じく承認のうえ develop に入れて Pages を再リリースする。
- 新しい CI ジョブ（Node のテスト・ビルド）は feat ブランチに追加し、既存の `tests.yml` と並行して走らせる。

### 7.4 P5 切替手順書（P4d 完了時に詳細を書く）
1. 依頼受付を止める（§4.2-7 の KV フラグ）。止めている間に来た依頼は枠を消費しない。KV は全拠点への反映に時間がかかる（60 秒以上）ため、`/api/health` が `accepting: false` を返すのを確かめ、さらに数分待ってから次へ進む。
2. 実行中の生成 run がゼロになるのを確認する（現行 promoter は途中で切り替わっても `set -euo pipefail` と CAS 検査で安全側に止まる）。
3. リハーサル: feat の成果物を**本番ではないブランチ**（プレビュー、必要なら Access で閉じる）に手元の wrangler で上げ、本番と同じ確認（smoke、CSP、転送、404）を通す（ユーザー承認）。本番ブランチへの初回デプロイは 4 の merge 後に、正規のリリース（6 段）で行う。
4. develop に merge（データ移動・workflow・promoter のパスの 1 commit を含む）。merge 後に `/api/health` でスイッチが「停止」のままか確認する（本物の POST では確かめない）。
5. Workers Builds が読むルートを `apps/api` に変える（ユーザー作業）。デプロイ後に `/api/health` で「停止」のまま・`dispatch_mode: live`・`pat_configured: true` を確認する。
6. 本番 URL の全ページ・正規リリースの smoke・API の読み取り系を確認する。
7. 依頼受付を再開する（ユーザー承認）。
8. 本物の依頼を 1 件だけ通し（ユーザー承認）、dispatch → 生成 → promotion → 公開まで通ることを確かめる。失敗したら直ちに受付を止めて 11 に進む。
9. GitHub Pages に転送ページを上げる（8 が通った後。切替 commit では旧サイトを先に消さない）。
10. Python の削除 commit は、9 の後に観察期間（1 週間程度、生成 run が正常に回ることを確認）を置いてから入れる。
11. 失敗した場合の戻し方: Python の削除 commit が既に入っていれば先にそれを revert し、次に切替 commit を revert し GitHub Pages の公開を戻す。revert では戻らないもの（Workers Builds のルート設定、D1・Durable Objects の状態、切替後に `data/` に入った生成 commit、`data/state` の seen_ids）は手順書に個別の戻し方を書く。

### 7.5 開発ルールの更新（P1）
CLAUDE.md の絶対ルール・TDD 手順・カバレッジ目標は Python を前提にしている。P1 で TS 版の規約（Vitest のカバレッジ 80%、LLM 共通インターフェース、唯一の生成元のパス、モック必須）を CLAUDE.md に追記し、`.claude/agents/*` と `.claude/skills/*` を TS 版に対応させる。

## 8. ロードマップ

| フェーズ | 内容 | 完了条件 |
|---|---|---|
| **P0 設計** | この文書、計画レビュー、不要ファイルの整理方針 | レビューで重大・中程度 0、ユーザー GO |
| **P1 土台** | 無料枠の数値確認。pnpm workspace、tsconfig、Biome、Vitest、Node 22。`packages/core`（schema → zod の検証、公開 URL 設定、言語差テスト）。比較ツール。安全対策の対応表。CSP 契約テスト。開発ルールの TS 版。Node の CI ジョブ。**今の公開物（`docs/` から design・research・`*_IMPLEMENTER.md` を除いたもの）を、ユーザー承認のうえ Cloudflare Pages のプレビューに上げる**。現行は 22 ファイルが `/automatic-paper-search/...` の絶対パスを使うため、プレビューでは `automatic-paper-search/` 配下に置いて上げる（404.html はトップにも置く）。公開経路と 404 を確かめる | プレビューで現行サイトが同じに動く（テーマ投稿は本番 Worker が許可しないため対象外）。CI 緑。対応表・スキーマ一覧・CSP 契約テストがある |
| **P2 画面** | Next.js（静的書き出し）で現行ページを再現。順番: 検索トップ → 学会カタログ → 横断検索 → テーマ（`?theme=` はブラウザ側で読む方式を維持し、投稿のたびの全体ビルドを不要にする）→ 家系図 → how-it-works。描画ロジック（`lineage-core.js` など）は部品に包んで移す。JSON のキャッシュ方針（`_headers`）を決める | 各ページがプレビューで現行と同等（画面契約テストを移植して緑）。CSP 契約テスト緑。Lighthouse が現行以上 |
| **P3 API** | `apps/api`（Hono）に現行 Worker を移植（同じ Worker 名・KV を引き継ぐ）。Durable Objects の上限、D1 の依頼・進捗、枠の返却、新旧 origin の許可リスト | 現行 `worker/` の全テスト相当が Vitest で緑。プレビュー環境で、dry-run の dispatcher を使って依頼〜進捗が通る（本物の dispatch はしない） |
| **P4a 収集** | daily-watch・weekly の収集（sources、signals、Stage、exporters、seen_ids、run_history、通知） | 比較ツールで一致（失敗系含む） |
| **P4b カタログ** | build_pages、summary、検索インデックス、identity-lite、sitemap、asset 関連、Node 版 promoter と検証スクリプト | 公開 JSON・CSV・シャードが一致。promoter の許可パス検査が同等 |
| **P4c 学会の収集器** | OpenReview / CVF / ACL / arXiv の収集器、conference_watch | 一致 |
| **P4d 家系図** | 会議・テーマ・deep の家系図生成、LLM provider、分類キャッシュ、品質監査、unarXive（判断待ち 2） | 一致（LLM はキャッシュ／モック） |
| **P5 切替** | §7.4 の手順書に従う。`data/` への移動と workflow・promoter・paths の切替を 1 commit で。Node 版 6 段リリースで Cloudflare Pages を本番に。GitHub Pages を転送ページに。Python 一式と Python を前提にした周辺（§9.3）を削除。CLAUDE.md・README・設計書を書き直す | 本番 URL で全ページ・API が動く。旧 URL から転送（クエリと # を保つ）。`git ls-files '*.py'` が 0 件（判断待ち 8 で `.codex/` を残す場合は `.codex/` を除いて 0 件） |
| **P6 拡張** | ログイン（Better Auth ＋ D1）、マイリスト、通知、AI 機能（要約・意味検索） | 機能ごとに別途設計 |

作業量の目安: Python は製品コード約 4.1 万行（うち論文スライド 1.4 万行）、テスト約 6.3 万行。フロントの JS は約 1.3 万行。複数セッションにまたがる。各フェーズの終わりにレビュー（opus）→ 修正 → 検証（haiku）を回し、重大・中程度 0 で次へ進む。

## 9. 不要なファイルの整理

### 9.1 実施済み（git 管理外の生成物、再生成できるもの）
`build/`、`dist/`、`paperpilot.egg-info/`、`.coverage`、`.mypy_cache/`、`.ruff_cache/`、`.pytest_cache/`、各 `__pycache__/`（約 67MB）。

### 9.2 今すぐ消せる候補（ユーザー確認後に実施）
| 対象 | 理由 | 消した時の影響 |
|---|---|---|
| `docs/FLASH_IMPLEMENTER.md` | 自ら「履歴文書」と明記。参照は `docs/QWEN_IMPLEMENTER.md` からのリンクのみ | そのリンクを外す |
| `scripts/spike_r2_cas.py`、`infra/r2/cas-spike.md` | 2026-05 の一回限りの検証 | なし |
| `CHANGELOG-archive.md` | 過去ログ（CHANGELOG.md から参照のみ） | 参照リンクを外す |
| develop に取り込み済みのローカルブランチ 2 本（`codex/issue-432-*`、`codex/issue-433-*`） | 内容は develop にある | なし |

未取り込みのローカル `codex/*` ブランチ 34 本は、消すと作業内容が失われるため**残す**（判断待ち 4）。

### 9.3 移行の各フェーズで消すもの
| 対象 | 消す時期 |
|---|---|
| `docs/search-index.json`（v1、画面は v2 だけを使う） | P5（promoter と検証スクリプトが参照しているため、Node 化と同時に外す） |
| `docs/daily/papers.json`（daily-watch の古い出力） | P5（feat 側はデータに触らないため。以前の削除は自動判定で止められたので、必ず確認を取る） |
| Python 一式（`paperpilot/`、`pyproject.toml`、`uv.lock`、`.venv`） | P5 |
| Python を前提にした周辺: `.github/scripts/paper_slide_workflow.py`、`tools/render_og_image.py`（TS で作り直す）、`docker/`・`Dockerfile`・`docker-compose.yml`・`containers/`、`publish.yml`（Python パッケージのビルド）、`.pre-commit-config.yaml` の ruff、シェル内のインライン Python（`promote-generated.sh`、`validate-pages-release.sh`、`pages-release.yml`） | P5 |
| 古い設計書（`docs/design/` の stale 表示のもの 9 本） | P5 の書き直しで統合・削除 |
| ルートの `worker/`（`apps/api` に移植済みのもの）と `wrangler.jsonc` | P5（§7.4 の 5 が通った後） |
| `worker/paper-slide-*`、`paper-slides-on-demand.yml` | 判断待ち 1 に従う |
| `tests.yml`（Python の CI）、`data-audit.yml` | P5（Node 版に置き換えた後） |
| `archive/`（原本 docx） | 残す（履歴資料） |

**ユーザー判断が要るもの**: `AGENTS.md`・`PAPERPILOT_PROFILE.md`・`docs/QWEN_IMPLEMENTER.md` と `.codex/`（ホストの Codex CLI と Qwen の運用に使う文書・道具。契約テストが参照）。

**消さないもの**: 6 学会の空の `lineage.json`（約 290B）。画面が「家系図なし」を 404 ではなく 200 で判定するために意図して置いている。

## 10. ユーザーにしか出来ない作業（P1 で必要）

1. Cloudflare ダッシュボード → Workers & Pages → Create → Pages → 「Direct Upload」でプロジェクトを作成（名前の例: `paperpilot`）。**本番ブランチ名**（例: `production`）を決める。
2. My Profile → API Tokens → Create Token → 「Cloudflare Pages: Edit」権限のトークンを作成。
3. GitHub リポジトリの Settings → Environments に deploy 用 environment を作り（develop のみ許可）、その environment の Secrets に `CLOUDFLARE_API_TOKEN` と `CLOUDFLARE_ACCOUNT_ID` を登録。
4. Workers Builds（`paperpilot-themes`）がブランチごとのプレビュー版を上げる設定になっていないか確認。
5. 独自ドメインを使うかどうかの決定（§4.5）。
6. プレビュー用の Worker・KV・D1・Durable Objects の作成（PAT は設定しない）。プレビュー Worker へのデプロイは、ユーザーの手元の wrangler からだけ行う。Workers のデプロイ用トークン（Workers Scripts: Edit）もアカウント全体に効く可能性があり、本番 `paperpilot-themes` を上書きし得る。その保管場所を決める（判断待ち 11）。
7. P5 で Workers Builds のルートディレクトリを `apps/api` に変更。
8. プレビューへの公開、本番切替のリハーサル、本物の dispatch の各回で承認。

## 11. リスクと対策

| リスク | 対策 |
|---|---|
| Next.js のインラインスクリプトで CSP が壊れる／緩む | ページごとのハッシュ CSP（§4.4）。P1 で契約テストを先に作る。成り立たなければ構成を変えて報告 |
| 公開の安全機構（exact SHA、admit、smoke、ロールバック）が移行で抜ける | 6 段すべての Cloudflare 版（§4.3） |
| 状態データ（seen_ids、分類キャッシュ、入力 CSV）を失う | `data/state`・`data/inputs`・`data/config` に移し、P5 で workflow と同じ commit で移動 |
| 公開 URL が変わり、検索流入・外部リンクが切れる | 接頭辞を除いたパス対応表、転送ページ、新 sitemap、canonical |
| 移植で安全対策が抜け、壊れたデータが公開される | 対応表（§6.2）と比較ツール（失敗系含む）で一致を確認してから切替 |
| develop への push で Worker / Pages が意図せず変わる | 移行は feat ブランチ。P5 まで develop の現行構成に触らない（例外は §7.3 に列挙した Worker の小変更だけ）。Workers Builds のブランチプレビュー設定を確認 |
| プレビューで未検証の候補や設計資料が公開される | 検証済みのみ上げる。design・research を公開対象から外す。必要なら Access で閉じる |
| Python と JS の言語差で結果がずれる | 言語差の単体テスト、浮動小数の値完全一致 |
| P4 が長期化し二重管理が続く | P4 を 4 段に分け、一致した段の Python は変更を凍結する（削除は P5） |

## 12. 判断待ち（GO の前に決めたいこと）

1. **論文スライド**（`paperpilot/paper_slides/` 約 1.4 万行 ＋ `worker/paper-slide-*` ＋ 関連 workflow・コンテナ。休眠中だが最近まで開発・テスト済み）: 移植する／移植せず削除する。**既定案: P5 で削除**（必要になれば TS で作り直す）。
2. **unarXive**（引用文脈 DB。任意機能だが workflow 5 本が使う）: **既定案: P4d で移植**（DuckDB には Node 版がある）。
3. **独自ドメイン**を使うか（使えば API を同一オリジン `/api/*` にでき、CORS 不要・将来のログインに有利。年 ¥1,500 前後）。
4. **ローカルの未取り込み `codex/*` ブランチ 34 本**: **既定案: 残す**。
5. **現行 Worker の修正 `c090c84`**（ローカルのみ）: Hono 版完成まで現行 Worker が本番で動くため、**既定案: 確認のうえ push**。
6. **`docs/research`（市場調査）を公開し続けるか**: **既定案: 公開対象から外す**。
7. **Slack / Email 通知と Google Sheets 連携（`sync_to_sheets.py`）**: 移植する／捨てる。**既定案: Slack・Email は移植、Sheets 連携は使っていなければ削除**。
8. **Codex/Qwen 運用文書と `.codex/`**: 残す／削除する（P5 の完了条件に影響）。
9. **CSP をサイト全体で 1 つにそろえる**（§4.4）: これにより、今は `/themes/` だけが許している API への接続を全ページで許すことになる。**既定案: そろえる**（そろえないと Next の画面内遷移で機能が壊れる。代わりに画面内遷移を使わない MPA にする手もある）。
10. **依頼受付を止めるスイッチと origin 許可リストを現行 Worker に先に入れる**（§4.2-7）: **既定案: P1 中に、承認を得て develop に push**。
11. **Cloudflare のトークンの保管場所**（Pages・Workers とも、§4.3・§10-6）: **既定案: プレビューと Worker のデプロイはユーザーの手元の wrangler からのみ。GitHub には本番の Pages 公開用トークンだけを develop 限定 environment に置く**（P5 以降、Worker は Workers Builds が develop から自動デプロイ）。
12. 移行前からの判断待ち（docs/daily の削除、Oral 判定、embedding 正規化式、劣化 run のスタンプ方針、weekly のページ送り、S2 の日付絞り込み、weekly の S2 厳格さ）は、該当フェーズで移植する時に決める。
