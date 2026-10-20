# 40. 移行後の拡張設計（P6）— 拡張の手順・認証・無料枠・独自ドメイン

状態: 設計案 第2版（2026-10-21、第1版へのレビュー指摘 HIGH 1・MEDIUM 11・LOW 7 を反映）。実装は P5 切替（Tier C まで）の後。[39](39-typescript-cloudflare-migration.md) の P6 行を具体化する。個別機能（ログイン、マイリスト、通知、AI）は、着手時に各 1 本の設計書を足す。ここは**共通の土台と順序**だけを決める。

数値は 2026-10 時点の公式ドキュメントの記憶に基づく。**(verify)** は P6 着手前に公式ページで確認する。

## 1. 方針

1. **全部 Cloudflare の無料枠に収める。** 超えそうな機能は作らず、先に操作数を見積もる（§5）。
2. **読み取りは静的、書き込みだけ Worker。** 公開データ（論文・テーマ・家系図）は今のまま静的配信。ログインが要る機能（マイリスト、通知設定）だけ `apps/api` を通す。
3. **同じ規約で足す。** 新機能は §2 の手順どおりに足し、既存の契約テスト（パス直書き禁止、CSP、no-skip）を通す。
4. **個人データは最小限。** 持つのは、ログイン識別子（OAuth の subject。メールは任意）、マイリストの論文 ID、通知設定。加えて、レート制限のための**ハッシュ化した IP**（§3.4）。収集する前にプライバシー表記を書く。
5. **ログインの障害でテーマ投稿を止めない。** 無料枠はアカウント全体で共有されるため（§5）、ログイン系の負荷が増えても、既存のテーマ投稿が先に落ちない設計にする。

## 2. 機能を足す手順（拡張のレール）

| 足すもの | 置き場所 | 規約 |
|---|---|---|
| 新しい API ルート | `apps/api/src/routes/<name>.ts` に、Hono に依存しないハンドラ生成関数 `createXHandler(deps)` を書く。`app.ts` で生成して登録する（`themes.ts` と同じ形） | **共通ミドルウェアは今は無い。** `lib/kv-flags.ts`（origin・受付停止）と `lib/bounded-body.ts` の関数を、`themes.ts` と同じ順序（origin → 受付停止 → content-type → body サイズ）で呼ぶ。共通化する場合は P6-0 の成果物とし、既存の順序契約テスト（API-01 など）を壊さない。secret を応答・ログに出さない |
| 入力検証 | Worker で動く検証。`apps/api/src/lib/validate-input.ts` の形（手書き）を基本にする | 共有形式は JSON Schema が正本（次行）。Worker からは `node:fs` 経由の ajv を使えないため、検証関数は `apps/api` 内に置く。zod を `apps/api` の依存に足すかは P6-0 で決める |
| 新しい共有形式 | リポジトリ直下 `schemas/<name>-vN.schema.json` を追加し、`packages/core/src/schemas` の validator で検証 | 形式のバージョンはファイル名（`-v1`、`-v2`）で持つ。`$id` で相互参照する |
| 新しい画面 | `apps/web/app/<route>/` | データはブラウザ側 fetch（ビルドに埋め込まない）。インラインスクリプトを増やさない（CSP 契約テスト） |
| 新しい収集・生成 | `apps/pipeline/src/<area>/` と workflow | 出力先は `@paperpilot/core/layout` のヘルパー。`noPathLiterals` は `docs` / `paperpilot/data` / `paperpilot/output` の直書きを検出する。新しい出力先は `packages/core/src/layout/index.ts`（検査の対象外）にヘルパーを足してから使う |
| 新しい永続データ | D1 のマイグレーション（`apps/api/migrations/NNNN_*.sql`。作成ツールは P6-0 で Drizzle か手書き SQL かを決める。39 は Drizzle 前提） | §2.1 の手順に従う |
| 新しい secret・変数 | 非機密は `wrangler.jsonc`、機密は Cloudflare の secret | 同時に更新するもの: 本番とプレビューの 2 つの wrangler 設定、`apps/api/src/types.ts` の `Env`、`wrangler-config.test.ts`。値はコミットしない |

完了条件（どの機能でも）: テストはモック（外部 API を叩かない）、`no-skip-gate` 緑、プレビューで動作確認、レビューで重大・中程度 0。

### 2.1 D1 マイグレーションの適用

- 現状 `apps/api/test/wrangler-config.test.ts` は、本番・プレビューとも「D1 binding が無い」ことを assert している。P6-0 で、D1 を入れる設定とこのテストを**同時に**更新する。
- Worker は Workers Builds が develop から自動デプロイする。この経路にはテストも、マイグレーションも、no-skip-gate（`pages-release.yml` にしか無い）も無い。P6-0 で次を置く。
  - Worker 経路用の関門: `ts-ci` の Vitest（no-skip-gate 相当を含める）が緑でなければ develop に入らない（必須チェックに指定）。
  - 空の DB に全マイグレーションを順に当てるテスト。
- 適用はユーザーの手元の wrangler から行う（39 §10-6、判断待ち 11）。順序は「マイグレーション → Worker のデプロイ」。旧 Worker と新 Worker が並走しても動くよう、追加のみ（expand）を先に、削除（contract）は次のリリース以降にする。
- プレビューと本番で DB を分ける。プレビューの KV id は現在 placeholder なので、D1 と同時に実 id を入れる。

## 3. 認証とマイリスト

### 3.1 候補の比較

| 案 | 内容 | 長所 | 短所 |
|---|---|---|---|
| **A. Better Auth ＋ D1、OAuth（GitHub）のみ（推奨）** | GitHub の OAuth でログイン。セッションは D1 | TS で完結、Workers で動く、無料枠内、メール送信が不要で 2026-10-05 の「メール／SMTP は移植しない」決定と衝突しない | GitHub アカウントが要る |
| A'. A ＋ マジックリンク | メールでログイン | 利用者を広げられる | メール送信の手段が要り、上記の決定を覆す。リンクスキャナによるトークン先読み、ログイン CSRF の対策も要る。採るならユーザーの再決定を取る |
| B. Cloudflare Access | Cloudflare 側でログイン | 自分だけならすぐ使える | 無料枠は 50 ユーザーまで。2026-06-03 に workers.dev へ紐付いた Access が消えず、外すには Zero Trust Free の有効化と課金情報の入力が要った経緯がある（CLAUDE.md）。`workers.dev` を直接叩くと回避できるため、Worker 側で `Cf-Access-Jwt-Assertion` を検証するか `workers_dev` を無効にしないと穴になる。「実装ほぼ不要」ではない |
| C. 自前（パスワード） | — | — | 保管責任が重い。採らない |

推奨は A。自分だけが使うなら、先に B で始めて、必要になったら A に移ってもよい。

### 3.2 構成

- **同一サイトで Cookie を張る。** API が別オリジン（`*.workers.dev`）だと第三者 Cookie 扱いで壊れやすいので、独自ドメインで `/api/*` を同一オリジンにする（§6）。独自ドメインを使わない間は、ログイン機能を入れない。
- **Cookie の属性**: `__Host-` 接頭辞、`Secure`、`HttpOnly`、`Path=/`、`SameSite=Lax`、有効期限あり。ログイン時にセッション ID を再発行し、ログアウトとアカウント削除でサーバー側のセッションも失効させる。
- **D1 のテーブル**: Better Auth の実スキーマ（user / session / account / verification (verify)）に合わせ、さらに `saved_papers(user_id, paper_id, added_at)` と `notification_prefs` を足す。標準のままでは最小限を超えるので、次の設定にする。
  - `session.ipAddress` と `userAgent` を保存しない。
  - OAuth の access／refresh token は保存しない（ログインにしか使わない）。保存が避けられない場合は暗号化する。
  - `user.name`・`image` は GitHub のログイン名とアバター URL だけにする。
- 論文 ID は公開データの安定 ID をそのまま使い、論文本体は複製しない。公開データから論文が消えた場合（縮小ゲートで許可したとき）は、マイリストで「掲載終了」と表示し、行は残す。
- **CSRF**: `SameSite=Lax` ＋ 書き込みは JSON の POST のみ ＋ origin 検査。ログイン開始の `state` は必須。
- **origin 検査の対象**: 状態を変えるメソッド（POST／PUT／DELETE）だけに origin 検査をかける。同一オリジンの GET では、ブラウザが `Origin` を付けないことがあり (verify)、今の `resolveOrigin`（Origin が無いと拒否）のままだとマイリストの読み取りが 403 になる。GET はセッションと `Sec-Fetch-Site: same-origin` で判定する。実ブラウザ（Playwright）のテストで確かめる。
- **CSP**: 全ページ共通の指令は変えない。ただし全ページに `form-action 'self'` が固定されている（`packages/core/src/site/config.ts`）ため、`<form>` を外部の OAuth URL に送る、または POST 後に外部へ 302 する方式は止められる (verify)。**OAuth の開始は、fetch で認可 URL を受け取り `location` で移動する方式に固定**し、CSP 契約テストに遷移のテストを足す。アバター画像を表示するなら `img-src` を全ページで広げることになるため、表示しない（イニシャル表示）を既定にする。

### 3.3 プレビューと本番の分離

- OAuth アプリはコールバック URL に結び付くため、**環境ごとに別の OAuth アプリ**（client ID／secret）を作る。プレビュー用の secret は本番の Worker に置かない。
- ログインには dry-run が無い。プレビューでは、プレビュー専用の OAuth アプリと専用の D1 でだけ検証する。本番アカウントを使ったテストはしない。
- プレビューの origin は、本番と**完全一致で区別**する（origin 許可リストは KV の `origin_allowlist`）。プレビューを本番と同じ独自ドメインのサブドメインに置くと same-site になり `SameSite` の防御が効かないので、プレビューは別ドメイン（`*.pages.dev`）に置き、Cookie は `__Host-`（host-only）にする。この場合プレビューでログイン付きの API は同一オリジンにできないため、ログインの結合試験は「プレビュー専用 Worker ＋ プレビュー専用の Pages」を同じホスト名配下に置けるかを P6-0 で確かめ、できなければ本番へ出す前にユーザーの手元で手動確認する。

### 3.4 個人データの扱い

- **保管するもの**: OAuth の subject（GitHub の数値 ID）、ログイン名、マイリスト、通知設定。メールは持たない（A 案の既定）。
- **IP**: レート制限の都合で、保存前に**ハッシュ化**する（日ごとに変わる salt を使う）。生の IP を DO や D1、URL のクエリに残さない。期限切れの項目は Durable Object の alarm で消す。現在の `QuotaCounter` は期限切れバケットを消さず、IP も `ip:<生の IP>` で持つため、P6-0 で直す（§4.2、§5）。
- **削除**: 「アカウント削除」で、user・session・account・verification・saved_papers・notification_prefs を全部消す。D1 の Time Travel が過去の状態を一定期間保持する (verify)ため、即時の消去ではないことをプライバシー表記に書く。Workers のログの保持期間も同様に書く。
- **ログ**: `wrangler.jsonc` は `observability.enabled: true`。プラットフォーム側のログに URL が残る可能性がある (verify) ため、OAuth の code や token を、Worker が受ける URL のクエリに置かない。ログはアプリ側の許可リスト方式のラッパー（既存の `deps.log`）経由にし、Better Auth の logger は抑える。この契約は、アプリのコードを grep するテストだけでは守れないので、ログ設定の確認を P6-0 の手順に入れる。
- 公開ページにプライバシー表記（保管するもの、IP の扱い、削除の挙動）を足してからログインを有効にする。

### 3.5 認証まわりのレート制限と障害時

- ログイン開始とコールバックに、IP ごと・識別子ごとの上限を付ける。応答は、アカウントの有無が分からない形にする。
- DO・D1・KV のどれかが落ちた時は、**ログインとマイリストを閉じる（fail closed）が、静的な閲覧とテーマ投稿は止めない**。画面には「ログインは一時的に使えません」と表示する。
- A' を採る場合は、トークンを使い捨てにし、リンクスキャナに先読みされても消費されない確認画面（ボタンを押して初めて消費）を挟む。

## 4. 通知と AI

### 4.1 通知

- 既存の Slack 通知（P4a で移植済み）は運営者向けのまま。**利用者向けの通知**は、メール送信の再決定（A'）後に設計する。それまでは作らない。
- 先に作れるもの: ブラウザ内の「新着の差分表示」（最後に見た日時を localStorage に持つ。サーバー不要）。
- 収集は GitHub Actions のままにする（データ生成と配信を分ける）。

### 4.2 AI（要約・意味検索）

2026-10-05 に「Stage 3 embedding はやらない」と決めている。ここで足すのは**別の用途**であり、意味検索は**決定の再確認が要る**。

| 機能 | 実装案 | 注意 |
|---|---|---|
| 要約 | ビルド時（GitHub Actions）に LLM で作り、静的 JSON で配信 | 実行時の LLM 呼び出しがなく、枠の心配がない |
| 意味検索 | 論文側の埋め込みはビルド時に作れるが、**検索語の埋め込みは実行時に要る**（ブラウザでモデルを動かす＝数十 MB のダウンロード、または Workers AI を実行時に呼ぶ）。28,300 本 × 384 次元 × float32 で約 43MB になり、「1 ページ gzip 1MB 未満」の原則にも合わない | 新しい埋め込みパイプラインになる。Vectorize の無料枠 (verify) も含め、着手時に別の設計書を書き、ユーザーが方針を再決定する |
| 質問応答 | 実行時の LLM 呼び出しが必要 | Workers AI の無料枠 (verify) を超えるなら作らない |

原則: LLM は**できる限りビルド時**に呼び、静的配信にする。実行時に呼ぶ機能は、操作数の見積もり（§5）とレート制限の設計が入るまで作らない。レート制限の器は、汎用化した制限器を使う（次の P6-0）。

## 5. 無料枠の見積もり（P6 着手前に再確認）

**無料枠はアカウント単位で共有される** (verify)。プレビュー用 Worker も同じ枠を使う。ログイン系が増えると、既存のテーマ投稿が同じ日次上限で止まり得る（テーマ投稿には GitHub Issue へ逃がす degraded mode があるが、ログインには無い）。

数えるのは、リクエスト数ではなく**ルートごとの操作数**。

| 資源 | 無料枠 (verify) | 今の使い方 | 1 リクエストあたり | P6 で増える分 |
|---|---|---|---|---|
| Workers リクエスト | 10 万／日 | テーマ投稿・health | 1 | ログイン、マイリストの読み書き |
| **KV 読み取り** | **10 万／日**（キャッシュ命中が数えられるかは要確認） | `origin_allowlist`、`accepting`、`namespace_tag` の設定 3 キー。**リクエストごとに最大 2 回読む**（`lib/kv-flags.ts`。preflight と `/api/health` も読む）。テーマ一覧（manifest）は KV ではなく raw.githubusercontent.com から取る | 最大 2 | 新ルートが同じ検査を共有すると、**約 5 万リクエスト／日で KV が先に尽き、origin 検査が拒否側に倒れて全 API（テーマ投稿を含む）が 403 になる** |
| Durable Objects（SQLite） | 10 万リクエスト／日 | `QuotaCounter`（テーマ投稿のレート制限） | 1 | 汎用制限器に直し、ログイン系で使う分だけ増える |
| KV 書き込み | 1,000／日 | 受付停止スイッチ等（稀） | 0 | 使わない |
| D1 | 読み 500 万行／日、書き 10 万行／日、5 GB（1 DB あたりの上限もある (verify)） | 未使用 | 1〜3 | users、sessions、saved_papers |
| Pages 静的配信 | 帯域は実質無制限。ビルド回数の枠は Direct Upload に適用されるか要確認 | 公開 JSON の配信 | — | 変化なし |

**KV の読み取りを減らす（P6-0 の必須項目）**: 次のどれかを採り、設計に書く。
1. Worker の isolate 内メモリに、短い TTL（例 30〜60 秒）でフラグをキャッシュする。受付停止スイッチが効くまでに TTL 分の遅れが出るため、その遅れを許容できるか確認する。
2. 設定 3 キーを 1 キー（JSON）にまとめ、1 回の読み取りにする。
3. 読み取り専用ルートでは受付停止の検査を省く。

推奨は 1 と 2 の併用。

**操作数の見積もり**: 1 人が 1 日にマイリストを 20 回読み書きし、1 回あたり Workers 1・KV 1（対策後）・D1 2 とすると、Workers の 10 万／日は約 5,000 人日で尽きる。KV 対策がない場合は、約 2,500 人日で KV が先に尽きる。個人〜小規模利用なら十分。ただし、**日次 5 万リクエストを超えたら止める**ためには、使用量の通知を無料プランで受けられるか (verify) を確かめる。受けられない場合は自前で数えることになり、数える処理自体が DO・KV の枠を食うので、その設計も書く。

Workers の無料枠には、スクリプトの圧縮後サイズ（3MB とする資料もある (verify)）と CPU 時間（10ms (verify)）の上限もある。Better Auth を入れた bundle のサイズと CPU を、P6-0 の最初に測る。39 §1.1 の記述と食い違う場合は 39 を直す。

**止めるスイッチ**: デプロイ時に決まる `DISPATCH_MODE` ではなく、実行時に読む KV の `accepting`（39 §4.2-7）と同じ形のスイッチを、ログイン系にも置く。

## 6. 独自ドメイン（判断待ち 3 の整理）

| | 使わない（`*.pages.dev` ＋ `*.workers.dev`） | 使う |
|---|---|---|
| 費用 | 0 | 年 ¥1,500 前後 (verify) |
| API | 別オリジン。`connect-src` に API ホストが要り、CORS が要る | 同一オリジン `/api/*`。CORS 不要 |
| ログイン Cookie | 第三者 Cookie 扱いで不安定 | 同一サイトで安定 |
| URL の安定 | ホスト名が変わると外部リンクが切れる | ドメインを保てば、ホスティングを変えても URL が変わらない |

**推奨**: 切替（P5）の時点で独自ドメインを取る。URL を後から変えると、転送ページと sitemap・canonical をもう一度作ることになる。取らない場合は、ログイン機能は作らず、§4 のうち静的にできるものだけを足す。

**独自ドメインへ移る時の変更箇所**（P5 に入れるか、後から移るかで作業量が変わる）:
- `packages/core` の `PUBLIC_ORIGIN`（現在は `https://paperpilot.pages.dev`）と `PAGES_PROJECT_NAME`（現在は `paperpilot-pages-TODO`）
- `PRODUCTION_ORIGINS`、KV の `origin_allowlist`
- CSP の `connect-src`
- `wrangler.jsonc` の `routes`（ドメインの zone を Cloudflare に置く必要がある）と、`workers_dev` の無効化
- sitemap、canonical、転送ページ

## 7. Tier C（Python 削除）の後のリポジトリ

```
apps/web        Next 静的書き出し（画面）
apps/api        Hono Worker（API、D1、Durable Objects）
apps/pipeline   収集・生成・リリース（Node）
packages/core   共有の型・検証・layout
schemas/        共有形式の JSON Schema（正本）
data/           published | state | inputs | config
legacy/         gh-pages-site（転送ページ。Tier C の後に整理）
```

開発ルール（CLAUDE.md／README）は、Tier C の commit で TS 版に書き直す: pnpm コマンド、テストの流れ、`no-skip-gate`、パス直書き禁止、外部 API は常にモック、secret は `.env` と Cloudflare／GitHub の secret のみ。Python 前提の記述（pytest、`paperpilot/`）はすべて消す。

## 8. 実施の順序

1. **P5 切替**（独自ドメインを同時に決める）。
2. **P6-0（土台）**: 次を全部終えてから P6-1 に進む。
   - プライバシー表記。
   - Workers の bundle サイズ・CPU の測定（Better Auth 込み）。
   - KV 読み取りの削減（§5）。
   - 汎用の制限器（名前空間と値を引数化、IP のハッシュ化、期限切れの alarm 削除）。
   - D1 の基盤（§2.1）と Worker 経路の関門。
   - プレビュー用の OAuth アプリと専用 D1（§3.3）。
   - 使用量の通知手段（§5）。
   - 共通ミドルウェア化するか否かの決定（§2）。
3. **P6-1**: ログイン（A 案）とマイリスト。
4. **P6-2**: 静的な AI 成果物（要約 JSON）。意味検索は別設計書で再決定してから。
5. **P6-3**: 利用者向け通知（A' の再決定後）。

各段で「設計書 1 本 → 実装 → opus レビュー → 重大・中程度 0」を回す。

## 9. 判断待ち

1. **独自ドメインを取るか**（推奨: 取る。P5 と同時）。
2. **ログインの要否と範囲**（自分だけなら Cloudflare Access で足りるが §3.1 の注意あり。一般公開するなら Better Auth）。
3. **ログインの方式**（既定: GitHub の OAuth のみ。マジックリンクは「メール送信は移植しない」決定を覆す場合だけ）。
4. **意味検索を作るか**（作るなら「Stage 3 embedding はやらない」決定の再確認と、別設計書が前提）。
5. **利用者向け通知を作るか**（メール送信の再決定が前提）。
6. **API の入力検証に zod を足すか、手書きのままか**（§2）。
