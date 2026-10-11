# 50. インフラ・運用の観点からの調査（Cloudflare 無料枠 / GitHub 機能 / OSS ツール）

- 作成: 2026-10-11（JST）。調査専用。リポジトリ リポジトリ は読んだだけで、変更していない
- 前提: 無料枠のみ、保守者 1 人。サイトは Cloudflare Pages（静的 export）、API は Worker `paperpilot-themes`（Hono + KV + SQLite Durable Object）、パイプラインは GitHub Actions、データは git の `data/`
- 無料枠の数値は 2026-10-11 に公式ドキュメントから取った（Cloudflare は各ページの `index.md` 版、GitHub は docs の article API）。表には各ページの「Last updated」を書いた。GitHub docs には更新日の表示が無いので、取得日だけを書いた
- 生の取得結果: `手元の一時領域の src/`。actionlint / zizmor の出力: 同じディレクトリの `actionlint.txt`・`zizmor.txt`

---

## 0. 結論（優先順位つきの要約）

| 優先 | 提案 | 効果 | 手間 | リスク | 必要な承認 |
|---|---|---|---|---|---|
| **P0-1** | Secret scanning と push protection を有効にする（公開リポジトリは無料） | 鍵（Groq・OpenAlex・CF トークン・PAT）が誤って commit されるのを検出・阻止できる | 5 分（`gh api` 1 回） | ほぼ無い。fixture が誤検知されたら push 時に bypass する | 設定変更の承認 |
| **P0-2** | Dependabot alerts とセキュリティ更新を有効にし、`dependabot.yml` を置く（`github-actions` と `npm`/pnpm、グループ化、cooldown つき） | 現時点で `pnpm audit` が **critical 2・high 6・moderate 5** を報告（すべて開発時・ビルド時の依存。§3.4）。SHA で固定した actions も更新が届く | 30 分 | PR が増える → グループ化と週 1 回でまとめる | 設定変更・ファイル追加の承認 |
| **P0-3** | Actions の設定を締める: 「actions を完全な SHA で固定することを必須にする」を ON（いまは全部固定済みなので変化なし）。キャッシュの保持期間を 7 日 → 30〜90 日にする | 固定忘れを機械的に防ぐ。埋め込みモデルのキャッシュ（24 MB）が、手動の regen の間隔が空いても消えにくくなる | 10 分 | 小さい | 設定変更の承認 |
| **P0-4** | `develop` に ruleset を置く（削除と force push の禁止だけ。PR 必須やステータスチェック必須にはしない） | 誤った `push --force` で公開データの履歴が壊れるのを防ぐ | 10 分 | 必須チェックを足すと、bot（promote の push）が止まる → 足さない | 設定変更の承認 |
| **P1-1** | **外部の見張りを Cloudflare Worker の Cron Trigger に移す**（`/api/health`・主要ページ・`lineage-quality-v1.json` を 30〜60 分ごとに確認 → 異常時は、既存の PAT で `alert.yml` を dispatch → `GITHUB_TOKEN` で issue を作る／更新する → GitHub のメールで通知）。PAT の失効日も応答ヘッダから見張る | いまの見張りはユーザーの Mac の Hermes cron に頼っている（Mac が眠っていると何も分からない）。R1-5（PAT 失効の通知）も同じ仕組みで片づく | 半日〜1 日 | Worker のデプロイが要る。Cron Trigger は**アカウントで 5 個まで**（他プロジェクトと共有） | Worker デプロイの承認 |
| **P1-2** | CI に actionlint と zizmor を足す（`.github/**` が変わったときだけ動かす。zizmor は SARIF を code scanning に上げる） | 今回の実測: actionlint は新構文 `concurrency.queue` を誤検知 2 件・shellcheck style 4 件。zizmor（1.30.1）は medium 10 件・low 27 件（§3.3） | 2〜3 時間（誤検知の ignore 設定を含む） | ツールの誤検知で CI が赤くなる → 最初は警告だけにする | コード変更・merge の承認 |
| **P1-3** | CodeQL の default setup（`javascript-typescript` と `actions`） | 公開リポジトリは無料。Worker の入力処理と workflow の injection を静的に見る | 10 分 | 実行時間が増える（無料なので費用は 0） | 設定変更の承認 |
| **P1-4** | 予定実行を GitHub の `schedule` から外す方針を決める（collect を再開するとき）。Worker の Cron → `workflow_dispatch` で起こす | 実測で GitHub の `schedule` は **中央値 4 時間 26 分・最大 5 時間 50 分遅れていた**（§2.2）。60 日活動がないと自動で止まる規則もある | P1-1 と同時なら +1〜2 時間 | PAT の失効で予定実行も止まる → P1-1 の失効監視で補う | collect 再開の判断（design 40 §5-1） |
| **P1-5** | Pages のデプロイ失敗を Cloudflare の通知（全プランで利用可）でメールに流す | Pages 側の失敗を GitHub と別の経路で知れる | 10 分（ダッシュボード） | 直接アップロード（wrangler）でも届くかは未確認 | ダッシュボード操作 |
| **P2-1** | API 用の鍵（OpenAlex・S2・Groq・Gemini）をリポジトリの secret から environment（例 `pipeline-api`、`develop` だけ）に移す | zizmor の `secrets-outside-env` 28 件の大半を解消。PR や別ブランチの job からは読めなくなる | 2〜3 時間 | `environment:` を書き忘れると secret が黙って空になる（既知の落とし穴）→ 先頭に「鍵がある」ことを確かめる step を置く | secret の移動はユーザー作業 |
| **P2-2** | リリースの validate に「Pages の上限」チェックを足す（1 ファイル 25 MiB、ファイル数 20,000。手前の 20 MiB／15,000 で警告） | いまは最大 9.1 MB・published は 413 ファイルで余裕がある。ただ、検索インデックス（6.6 MB）が大きくなったときの事故を防ぐ | 1〜2 時間 | 小さい | コード変更の承認 |
| **P2-3** | Workers Analytics Engine に、テーマ依頼の結果（受付・拒否・上限）と見張りの応答時間を書く | 無料で 1 日 10 万点、3 か月保持。利用状況が数字で分かる（design 40 §4 の「週 10 件」の判断材料になる） | 2〜3 時間 | 小さい（書き込みが失敗しても本処理には影響しない作りにする） | Worker デプロイの承認 |
| **P2-4** | テーマ投稿フォームを公開するとき（R2-4）に Turnstile を足す | 無料で回数無制限。`Origin` ヘッダは偽装できるので、ブラウザ以外からの大量の依頼を減らせる | 半日 | フォームの UX が少し増える | R2-4 の時点で判断 |
| **P2-5** | `data/inputs`（収集の生データ。配信しない）を GitHub Releases の asset に移す（collect を再開するときに） | 再開後の git の増え方を抑える。Releases は 1 ファイル 2 GiB 未満、合計と帯域の上限なし。すでに `unarxive-v1`（1.49 GB）で使っている | 1〜2 日 | 再現性: asset の sha256 を git に残す必要がある | collect 再開の判断 |
| P3 | Vectorize・D1・Queues・R2・Browser Run・Email Routing・Upptime | 今は入れない。理由と「入れる条件」は §4 | — | — | — |

**すぐ効くのは P0 の 4 つ（設定だけ、合計 1 時間ほど）と P1-1（見張りの外部化）。** git のデータ量は今のところ問題ない（`.git` 110 MB、GitHub の推奨は 1 GB 未満）。急ぐ理由はない（§5）。

---

## 1. 現状の実測（2026-10-11）

| 項目 | 値 | 確かめ方 |
|---|---|---|
| リポジトリ | public、既定ブランチ `develop`、GitHub 上のサイズ 86.7 MB | `gh api repos/…` |
| `.git` | 110 MB（pack 107.5 MB、commit 751） | `du -sh .git`、`git count-objects -vH` |
| `data/`（作業ツリー） | 217 MB・943 ファイル（`inputs` 92 MB、`published` 77 MB、`state` 49 MB） | `du` |
| 履歴中の blob（ディスク上の圧縮後） | `data/published` 24 MB、`data/inputs` 15 MB、`data/state` 12 MB（data の commit は 2026-10 の 45 件だけ。データ移動の後） | `git rev-list --objects --all \| git cat-file --batch-check` |
| 最大のファイル | `data/inputs/iclr-2026/summary.csv` 9.1 MB。`papers_2026-06-28.csv` もほぼ同じ大きさで、学会ごとに 2 本ずつある | `wc -c` |
| 公開データのファイル数 | 413（`paper-details-v1` 256 シャード、`search-paper-ids-v1` 111） | `find` |
| Actions のキャッシュ | 9 件・328 MB（pnpm 299 MB、埋め込みモデル 24 MB、埋め込みベクトル 0.68 MB × 7） | `gh api …/actions/cache/usage` |
| artifact | 23 件。保持期間はリポジトリ設定 90 日（上限 90 日）、各 workflow は `retention-days: 14` | `gh api …/artifact-and-log-retention` |
| Releases | `unarxive-v1` に `unarxive.duckdb.gz` 1.49 GB | `gh api …/releases` |
| セキュリティ機能 | secret scanning・push protection・Dependabot security updates: **すべて無効**。Dependabot alerts: 無効（404）。code scanning: 解析なし | `gh api` |
| ブランチ保護 | `develop` は保護なし。ruleset も 0 件 | `gh api …/branches/develop/protection`、`…/rulesets` |
| Actions の権限 | `GITHUB_TOKEN` の既定は read。workflow ごとに `permissions: {}` → job ごとに最小限。third-party actions はすべて SHA で固定（ただし `sha_pinning_required: false`、`allowed_actions: all`） | `gh api …/actions/permissions` |
| environment | `cloudflare-pages-deploy`・`cloudflare-pages-production`・`github-pages`。どれも `develop` だけの branch policy | `gh api …/environments` |
| 予定実行 | `lighthouse`（月曜 02:00 UTC）、`regen-retry`（毎日 09:17 UTC）だけ。収集系は cron なし（意図的） | workflow の `on:` |
| Worker | `observability.enabled: true`（Workers Logs）。KV 1 つ、DO 1 クラス（`new_sqlite_classes`）。Cron Trigger なし | `apps/api/wrangler.jsonc` |
| 見張り | ユーザーの Mac 上の Hermes cron（`~/.hermes/scripts/paperpilot_watchdog.sh`） | runbook「運用: 秘密と期限」 |

---

## 2. 無料枠の確認（公式ドキュメント）

### 2.1 Cloudflare（Workers Free）

| 製品 | 無料枠（Workers Free） | 出典（Last updated） | PaperPilot から見た意味 |
|---|---|---|---|
| Workers | 10 万リクエスト/日、CPU 10 ms/呼び出し、subrequest 50/呼び出し、メモリ 128 MB、**Cron Trigger はアカウントで 5 個**、Worker 100 個 | https://developers.cloudflare.com/workers/platform/limits/ （2026-10-08） | 見張りの cron は 1 個で足りる。fetch の待ち時間は CPU 時間に入らないので、10 URL 程度の確認なら 10 ms に収まる見込み（実測が要る）。5 個の枠は他プロジェクトと共有なので、使用数の確認が要る |
| Cron Triggers | UTC で動く。追加・変更の反映に最大 15 分。scheduled ハンドラの実行は最大 15 分 | https://developers.cloudflare.com/workers/configuration/cron-triggers/ （2026-09-04）、wall time は https://developers.cloudflare.com/queues/platform/limits/ （2026-04-21）の表 | 遅れについての記載は無い（GitHub の `schedule` と違い「高負荷時に遅れる・落ちる」とは書かれていない） |
| Workers Logs | 1 日 20 万イベント、保持 3 日 | https://developers.cloudflare.com/workers/observability/logs/workers-logs/ （2026-10-02） | すでに有効。3 日で消えるので、障害の調査は早めに |
| Workers Builds | 月 3,000 分、同時 1、timeout 20 分 | https://developers.cloudflare.com/workers/ci-cd/builds/limits-and-pricing/ | API の Worker のデプロイ用。今の頻度なら十分 |
| KV | 読み取り 10 万/日、別キーへの書き込み 1,000/日、同じキーへの書き込み 1 回/秒、1 GB | https://developers.cloudflare.com/kv/platform/limits/ （2026-10-08） | 設定値（`accepting`・`origin_allowlist`）の読み取りだけなので問題ない |
| Durable Objects（SQLite） | 10 万リクエスト/日、13,000 GB-s/日、行の読み取り 500 万/日、書き込み 10 万/日、保存 5 GB。**無料枠を超えると、その種類の操作はエラーになる**（課金はされない） | https://developers.cloudflare.com/durable-objects/platform/pricing/ （2026-09-30）、https://developers.cloudflare.com/durable-objects/platform/limits/ （2026-06-01） | 上限カウンタに使用中。依頼の進捗状態も、この DO の SQLite に置けば D1 は要らない |
| D1 | 行の読み取り 500 万/日、書き込み 10 万/日、DB 10 個、1 DB 500 MB、合計 5 GB、Time Travel 7 日、1 呼び出しあたり 50 クエリ | https://developers.cloudflare.com/d1/platform/limits/ （2026-04-21）、https://developers.cloudflare.com/workers/platform/pricing/ （2026-10-02） | §4 参照。今は不要 |
| R2 | 月 10 GB-month、Class A 100 万/月、Class B 1,000 万/月、egress 無料。**有効にするには支払い方法の登録が要り、無料枠を超えると課金される（上限で止まらない）** | https://developers.cloudflare.com/r2/pricing/ （2026-10-01）、https://developers.cloudflare.com/r2/platform/limits/ （2026-06-08）。カードが要ることは Cloudflare Community（2026-08-03）とダッシュボードの挙動による（公式 docs には明記が見つからなかった） | 「無料枠のみ」の方針と相性が悪い。GitHub Releases で代わりになる（§4） |
| Vectorize | 保存 500 万次元、クエリ 3,000 万次元/月、index 100 個、1 index 1,000 万ベクトル（V2）、topK 100（値・メタデータなし） | https://developers.cloudflare.com/vectorize/platform/pricing/ （2026-04-21）、https://developers.cloudflare.com/vectorize/platform/limits/ （2026-08-05） | bge-small（384 次元）なら保存は約 13,000 本まで。カタログ 28,300 本（約 1,090 万次元）は**入らない** |
| Queues | 1 日 1 万操作、保持 24 時間（変更不可）、メッセージ 128 KB | https://developers.cloudflare.com/queues/platform/pricing/ （2026-04-21）、https://developers.cloudflare.com/queues/platform/limits/ （2026-04-21） | テーマ依頼の量なら十分だが、DO の alarm で再試行すれば足りる |
| Workers Analytics Engine | 書き込み 10 万点/日、読み取り（SQL）1 万回/日。保持 3 か月。1 呼び出しで最大 250 点、blob 合計 16 KB | https://developers.cloudflare.com/analytics/analytics-engine/pricing/ 、https://developers.cloudflare.com/analytics/analytics-engine/limits/ （どちらも 2026-04-23） | 依頼の件数や見張りの応答時間を残すのにちょうどよい |
| Workers AI | 1 日 10,000 Neurons。超えるには Paid が要る | https://developers.cloudflare.com/workers-ai/platform/pricing/ （2026-10-09） | 埋め込みは Actions の中（transformers.js）で済んでいるので不要 |
| Browser Run（旧 Browser Rendering） | 1 日 10 分、同時 3 ブラウザ、新規 1 個/20 秒、タイムアウト 60 秒。crawl は 1 日 5 ジョブ・100 ページ | https://developers.cloudflare.com/browser-run/limits/ （2026-09-26）、https://developers.cloudflare.com/browser-run/pricing/ （2026-04-21）。旧 URL `/browser-rendering/…` はここへ転送される | 描画後の画面の確認には使えるが、Actions の Playwright／Lighthouse（public なので無料・無制限）で足りる |
| Email Routing（Email Service に統合） | 受信は無制限（Free でも）。**Free では任意の宛先への送信は不可**。ただし**確認済みの宛先アドレスへの送信は全プランで無料**。宛先アドレス 200 個、ルール 200 個/ドメイン | https://developers.cloudflare.com/email-service/platform/pricing/ （2026-06-09）、https://developers.cloudflare.com/email-service/platform/limits/ （2026-09-25） | **Cloudflare 上の独自ドメインが前提**（`pages.dev` では使えない）。ドメイン代は無料ではない |
| Pages | 1 サイト 20,000 ファイル、1 ファイル 25 MiB、ビルド 500 回/月・同時 1、プロジェクト 100、`_redirects` 2,100、`_headers` 100 ルール | https://developers.cloudflare.com/pages/platform/limits/ （2026-09-05） | 今は 413 ファイル・最大 9.1 MB で余裕。直接アップロードが「ビルド 500 回」に入るかは記載が無い（Git 連携のビルドの上限と読める。未確認） |
| Workers Static Assets | 静的アセットへのリクエストは無料・無制限。Free は 1 バージョン 20,000 ファイル・1 ファイル 25 MiB | https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/ （2026-04-23）、移行ガイド https://developers.cloudflare.com/workers/static-assets/migration-guides/migrate-from-pages/ （2026-10-10） | 1 つの Worker でサイトと `/api` を同じオリジンにでき、独自ドメインなしで CORS をなくせる。ただし URL が `*.workers.dev` に変わる（§4） |
| Turnstile | 無料、ウィジェット 20 個、チャレンジ回数は無制限 | https://developers.cloudflare.com/turnstile/plans/ （2026-08-14） | P2-4 |
| 通知（Notifications） | Pages の「デプロイ失敗／成功／開始」通知は全プランで使える | https://developers.cloudflare.com/notifications/notification-available/ （2026-10-02） | P1-5。Workers 自体の失敗通知は一覧に無い |

### 2.2 GitHub（public リポジトリ、Free プラン）

| 機能 | 上限・条件 | 出典（2026-10-11 取得） | PaperPilot から見た意味 |
|---|---|---|---|
| Actions の分数 | public リポジトリの標準ランナーは無料 | https://docs.github.com/en/billing/concepts/product-billing/github-actions | 実行時間を気にしなくてよい |
| job / run の上限 | job 6 時間、run 35 日、matrix 256、`concurrency` の `queue: max` は 1 グループ 100 件まで | https://docs.github.com/en/actions/reference/limits | 既存の `queue: max` は仕様どおり |
| キャッシュ | 1 リポジトリ 10 GB。**7 日アクセスが無いと削除**（保持期間は設定で public なら最大 90 日）。10 GB を超えると古いものから追い出し。アップロード 200 件/分 | https://docs.github.com/en/actions/reference/workflows-and-actions/dependency-caching 、保持期間は https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/enabling-features-for-your-repository/managing-github-actions-settings-for-a-repository | 今は 328 MB で余裕。regen は手動なので、7 日空くと 24 MB のモデルを取り直す → P0-3 |
| artifact とログ | 既定 90 日。**2026-10-01 から、保持期間の設定が check・workflow run・commit status にも適用される**（それまでは 400 日以上残っていた） | https://docs.github.com/en/organizations/managing-organization-settings/configuring-the-retention-period-for-github-actions-artifacts-and-logs-in-your-organization | 90 日より古い run の記録が消える。`pages-rollback` は Deployments API の記録を使うので影響は無いと読める（run ではない）。古い run のログを障害の根拠に使う場合は注意 |
| `schedule` | **高負荷時（特に毎時 0 分）に遅れ、ひどいときは落ちる**。public リポジトリは **60 日活動が無いと予定実行が自動で止まる**。IANA タイムゾーンの指定ができる | https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows | 下の実測を参照 |
| Releases | 1 リリース 1,000 asset、**1 ファイル 2 GiB 未満、合計サイズと帯域の上限なし** | https://docs.github.com/en/repositories/releasing-projects-on-github/about-releases | 配信しない大きなデータの置き場（P2-5） |
| リポジトリのサイズ | 50 MiB で警告、100 MiB で拒否。推奨 1 GB 未満、5 GB 未満を強く推奨。`.git` 10 GB、1 ディレクトリ 3,000 エントリが目安 | https://docs.github.com/en/repositories/working-with-files/managing-large-files/about-large-files-on-github 、https://docs.github.com/en/repositories/creating-and-managing-repositories/repository-limits | 今は 110 MB。`lineage-cache/` は約 470 エントリ（作業ツリー。大半は gitignore） |
| GitHub Pages | サイト 1 GB、帯域 100 GB/月（soft）、デプロイ 10 分 | https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits | 旧サイトの転送だけなので問題ない |
| Secret scanning | public リポジトリは無料で自動スキャン。push protection は既定で無効、管理者が有効にできる | https://docs.github.com/en/code-security/secret-scanning/introduction/about-secret-scanning 、https://docs.github.com/en/code-security/secret-scanning/introduction/about-push-protection | **今は API の上で無効**（`secret_scanning.status: disabled`）→ P0-1 |
| CodeQL | public リポジトリは無料。default setup がある。対象に JavaScript/TypeScript と **GitHub Actions workflows** を含む | https://docs.github.com/en/code-security/code-scanning/introduction-to-code-scanning/about-code-scanning-with-codeql | P1-3 |
| Dependabot | pnpm v7〜v10 に対応。version updates は既定で 3 日の cooldown（セキュリティ更新には効かない）。`groups`・`multi-ecosystem-groups`・`directories` | https://docs.github.com/en/code-security/dependabot/dependabot-version-updates/about-dependabot-version-updates 、https://docs.github.com/en/code-security/reference/supply-chain-security/supported-ecosystems-and-repositories | `packageManager: pnpm@10.34.6` に対応 |
| Dependency review action | public リポジトリで使える | https://docs.github.com/en/code-security/supply-chain-security/understanding-your-software-supply-chain/about-dependency-review | PR で、脆弱な依存の追加を止められる |
| Environments | Free でも public なら required reviewers（6 人まで）・wait timer（最大 30 日）・ブランチ制限が使える | https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments | P2-1 で鍵を environment に移す |
| Rulesets | 1 リポジトリ 75 個まで | https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/about-rulesets | P0-4 |
| SHA 固定の強制 | リポジトリ設定「Require actions to be pinned to a full-length commit SHA」 | 上の Actions 設定ページ | P0-3（今は `sha_pinning_required: false`） |

**このリポジトリでの `schedule` の遅れ（実測、`gh api …/actions/runs?event=schedule`）**

- `lighthouse`（`0 2 * * 1` = 月曜 02:00 UTC、毎時 0 分）: 2026-06-01〜10-05 の 19 回で、遅れは**最小 50 分、中央値 4 時間 26 分、最大 5 時間 50 分**。9 月以降は 5 時間前後が続いている
- `regen-retry`（`17 9 * * *`、0 分を避けている）: 2026-10-10 は 09:17 予定 → 15:23 開始（**6 時間 6 分遅れ**）
- つまり「0 分を避ける」だけでは足りない。鮮度に約束がある処理（週 1 回の収集など）を GitHub の `schedule` に任せるなら、数時間ずれる前提で設計する必要がある

---

## 3. OSS ツール

### 3.1 一覧（2026-10-11 時点の最新版）

| ツール | 最新版（公開日） | 用途 | 推奨 |
|---|---|---|---|
| actionlint | v1.7.12（2026-03-30） | workflow の構文・式・shellcheck | **入れる**（P1-2）。ただし `concurrency.queue` を知らない → `-ignore 'unexpected key "queue"'` |
| zizmor | v1.30.1（2026-09-09） | workflow のセキュリティ監査（injection・権限・artifact 経由の資格情報漏れ等）、SARIF 出力 | **入れる**（P1-2） |
| Dependabot | GitHub 内蔵 | 依存更新・脆弱性アラート | **入れる**（P0-2） |
| Renovate | 44.149.3（2026-10-10） | 依存更新（pnpm catalog、lockfile maintenance、細かいスケジュール、自動 merge） | 今は Dependabot で足りる。Dependabot のグループ化で困ったら移る。Mend の GitHub App は無料だが、外部の App にリポジトリへの書き込み権限を渡すことになる |
| lychee / lychee-action | lychee v0.24.2（2026-05-01）／action v2.9.0（2026-07-09） | リンク切れの検査 | **週 1 で入れる価値あり**（P2 相当）。`how-it-works` は GitHub の文書 URL にリンクしていて、設計書の削除でリンクが切れた前例がある（今はテストで一部だけ防いでいる）。論文の外部リンク（arXiv・DOI）まで見ると遅く、相手のレート制限にも当たるので、最初は自サイトと GitHub だけに絞る |
| Upptime | v2.0.0（2020-10、リポジトリは今も更新あり） | GitHub Actions の `schedule` で死活監視し、issue と状態ページを作る | **主な見張りには不向き**: §2.2 の実測どおり `schedule` は数時間遅れるうえ、5 分ごとの commit で履歴が膨らむ（別リポジトリにする必要がある）。公開の状態ページが欲しくなったら検討 |
| step-security/harden-runner | v2.22.1 | ランナーからの外向き通信の監査・制限 | 任意。外部 API（OpenAlex・S2・arXiv）が多いので、許可リストの保守が負担になる。audit モードで様子を見る程度 |
| OpenSSF Scorecard | action v2.4.4 | リポジトリの安全性の点数化 | 任意。P0 を済ませたあとの確認用 |

### 3.2 actionlint の実測結果（v1.7.12、shellcheck あり）

- `syntax-check` 2 件: `pages-release.yml:56`・`pages-rollback.yml:30` の `concurrency.queue`。**誤検知**（GitHub では有効な構文。limits の docs に `queue: max` の記載がある）
- `shellcheck` SC2129（style）4 件: `collect-weekly.yml:209`・`conference-on-demand.yml:157`・`regen-themes.yml:198`・`theme-on-demand.yml:147`（`>> $GITHUB_OUTPUT` を 1 行ずつ書いている）。動作には影響しない
- それ以外の式・型・権限の誤りは 0 件。workflow の作りはかなりきれい

### 3.3 zizmor の実測結果（v1.30.1、`--offline`）

| 監査 | 件数 | 中身 | 対応案 |
|---|---|---|---|
| `secrets-inherit`（medium） | 5 | `pages-release.yml` を呼ぶ側の `secrets: inherit` | **意図どおり**（environment の secret を呼ばれる側に渡すには `inherit` が要る。既知の落とし穴としてスキルに記録済み）。理由を書いて zizmor の設定で除外する |
| `artipacked`（medium） | 5 | `actions/checkout` に `persist-credentials: false` が無い（promote 系の job） | promote は `git push` するので資格情報が要る。`persist-credentials: true` と明記して除外するか、push の直前にだけ認証を渡す形にする。push しない job は `false` にする |
| `self-repository`（low） | 27 | `uses: ./.github/actions/setup-pnpm` | 新しい書き方への移行の勧め。急がない |
| （auditor）`secrets-outside-env` | 28 | API 鍵がリポジトリの secret で、environment の外で使われている | P2-1 |
| （auditor）`undocumented-permissions` 16・`anonymous-definition` 25・`concurrency-limits` 5 | — | 書式の勧め | 任意 |

high は 0 件。template injection（`${{ inputs.* }}` を `run:` に直接書く）は検出されなかった。

### 3.4 依存の脆弱性（`pnpm audit`、2026-10-11）

critical 2・high 6・moderate 5。どれも本番の Worker の依存ではない。

- `tinypool`（critical）、`vitest`／`@vitest/mocker`（moderate）: テスト用の devDependency
- `postcss`（high/moderate）: `next` 経由。静的 export のビルド時だけ使う
- `sharp`（high）、`sprintf-js`（moderate）: `@huggingface/transformers` 経由。パイプライン（Actions 上）だけで使う

すぐ悪用される経路は見当たらない。ただし、**今は誰も気づけない状態**なので P0-2 が必要。

---

## 4. 入れない／保留にするもの（理由と、入れる条件）

| 候補 | 判断 | 理由 | 入れる条件 |
|---|---|---|---|
| **R2**（データを git の外へ） | 保留 | 有効にするにはカードの登録が要り、無料枠を超えると課金される（上限で止まらない）。配信しない大きなデータは GitHub Releases（2 GiB/ファイル、合計・帯域は無制限）で足りる。配信するデータは Pages（25 MiB/ファイル）で足りている | 配信するファイルが 25 MiB を超える、または Pages の 20,000 ファイルに近づく。そのときもまずシャード分割を検討する |
| **D1**（依頼の進捗 API） | 保留（design 40 §4 のとおり） | 依頼の状態は既存の SQLite DO（`QuotaCounter`）か KV に置けば、新しい製品を増やさずに済む。D1 の Free は 1 呼び出し 50 クエリ、1 DB 500 MB | 横断的な検索や集計が要る状態データが出てきたとき |
| **Vectorize**（意味検索） | 保留 | Free の保存枠（500 万次元）に、384 次元のカタログ 28,300 本（約 1,090 万次元）が入らない。クエリの埋め込みに Workers AI（1 日 1 万 Neurons）も要る | テーマや系譜のノードだけ（数千本）を対象にする場合なら入る。検索の UX の要望が出てから |
| **Queues** | 不要 | 依頼は少なく、再試行は DO の alarm でできる。Free は保持 24 時間 | 依頼が 1 日数百件を超える |
| **Browser Run** | 不要 | 1 日 10 分。描画の確認は Actions の Lighthouse／Playwright（public なので無料・無制限）でできる | Worker の見張りから、描画後の DOM を確かめたくなったら（1 日数回なら 10 分に収まる） |
| **Email Routing** | ドメインの判断待ち | Cloudflare 上の独自ドメインが前提（費用がかかる）。確認済みの宛先への送信は全プランで無料なので、ドメインを取れば見張りの通知に使える。S2 API キーの申請（フリーメールは拒否される）にも役立つ | design 40 §5-3（独自ドメイン）が「取る」に決まったとき |
| **Workers Static Assets への移行**（Pages → Worker） | 保留 | 1 つの Worker でサイトと `/api` を同じオリジンにでき、CORS が要らなくなる。ただし URL が変わり（`*.workers.dev`）、6 段のリリース（Pages の deployment API を前提にした admit・smoke・record・rollback）を作り直すことになる。危険が大きい | 独自ドメインを取るときに、まとめて検討する |
| **Upptime** | 主な見張りには使わない | §3.1 のとおり | 公開の状態ページが欲しくなったら（別リポジトリで） |

---

## 5. git の `data/` の増え方

- **今**: `.git` 110 MB。履歴中の data の blob は、圧縮後で 52 MB ほど。GitHub の推奨（1 GB 未満）までは 10 倍近い余裕がある。design 40 §4 の「`data/` が 1 GB を超えたら R2」という条件にも遠い
- **増えるのは、収集（`collect-weekly`）を再開したとき**。1 回の収集で書き換わるのは、学会ごとの `papers.json`（数 MB）、`summary.csv` と `papers_<日付>.csv`（学会あたり 5〜9 MB ずつ。中身はほぼ同じ）、`search-index-v2.json`（6.6 MB）。git の差分圧縮が効く前提でも、1 回あたり圧縮後で約 8〜20 MB、週 1 回なら**年 0.4〜1 GB** になると見積もる（粗い見積もり。再開後 1 回目の `git count-objects -vH` の差で確かめる）
- **対策**（効きそうな順）
  1. `data/inputs/*/papers_<日付>.csv` と `summary.csv` が二重になっていないかを確かめる。どちらかが派生物なら、git には片方だけを置く
  2. 配信しない生データ（`data/inputs`）を、収集 1 回ごとに GitHub Releases の asset にする（`inputs-YYYY-MM-DD`）。git には sha256 と件数の manifest だけを残す（P2-5）。R2 と違ってカードは要らない
  3. `search-index-v2.json` を学会ごとのシャードに分ける（変わった学会の分だけ書き換わる）。Pages の 20,000 ファイルにはまだ余裕がある
  4. 履歴の書き換え（`git filter-repo`）は、1 GB に近づくまでやらない（clone 済みの worktree・rollback の SHA・Deployments の記録がすべて無効になる）
- **予防の検査**（P2-2）: リリースの validate に、1 ファイル 25 MiB と 20,000 ファイルの上限チェックを足す（手前で警告）。`data-audit` に「50 MiB を超えるファイルが無い」チェックを足す（GitHub の警告の線）

---

## 6. 見張りと通知の設計案（P1-1・P1-4・P1-5 の詳細）

```text
Cloudflare Cron（30〜60 分ごと、Worker paperpilot-themes の scheduled ハンドラ。別 Worker にしてもよい）
  ├─ GET https://paperpilot.pages.dev/ , /lineage-quality-v1.json , 主要ページ
  ├─ GET /api/health（pat_configured など）
  ├─ GitHub API を 1 回呼び、応答ヘッダ github-authentication-token-expiration で PAT の残り日数を読む
  ├─ 結果を Analytics Engine に 1 点書く（P2-3。応答時間・状態コード）
  └─ 異常 or 失効 14 日前 → workflow_dispatch: alert.yml（既存の GH_DISPATCH_PAT は Actions: write を持つ）
                               └─ GITHUB_TOKEN（issues: write）で issue を作る／再発時はコメント
                                   → GitHub のメール・モバイル通知
Cloudflare Notifications: Pages の「Deployment failed」→ メール（P1-5）
```

- 利点: ユーザーの Mac が止まっていても動く。新しい秘密が要らない（既存の PAT を使い、issue は `GITHUB_TOKEN` で作る）。R1-5（PAT 失効の通知）も同じ仕組みで片づく
- Free の範囲: Cron 1 個（アカウントで 5 個まで）、subrequest 50/呼び出し（10 URL 程度なら余裕）、Worker のリクエスト 10 万/日のうち 1 日 24〜48 回
- 予定実行の置き換え（P1-4）: collect を再開するときは、同じ cron から `workflow_dispatch` で `collect-weekly` を起こす（予定時刻に起動でき、60 日無活動で止まる規則にも掛からない）。GitHub の `schedule` は残すとしても、予備にする
- 落とし穴
  - PAT が失効すると、通知と予定実行が両方止まる → 失効日の監視を必ず入れる。将来は GitHub App のトークンに替えると失効の問題がなくなる（作業は増える）
  - 今の Hermes の見張りは、すぐには止めない（1〜2 週間並べて動かし、通知の差を比べる）
  - `scheduled` ハンドラを足すには `wrangler.jsonc` に `triggers.crons` を書く。デプロイは Workers Builds 経由になる。DO の migration には触れない（rollback の制約に注意）
  - Workers Free の CPU 10 ms は I/O 待ちを含まないが、JSON の解析が重いページ（検索インデックス 6.6 MB）は取りに行かない

---

## 7. 作業の順番（案）

1. **P0 をまとめて実施**（ユーザー承認後。`gh api` で設定するだけ。合計 1 時間ほど）
   - `PATCH /repos/{r}` の `security_and_analysis`: `secret_scanning`・`secret_scanning_push_protection` を enabled
   - `PUT /repos/{r}/vulnerability-alerts`、`PUT /repos/{r}/automated-security-fixes`
   - `PUT /repos/{r}/actions/permissions`: `sha_pinning_required: true`（allowed_actions は `selected` にして、GitHub 製・`treosh/lighthouse-ci-action`・必要なら `github/codeql-action` を許可）
   - Actions の設定でキャッシュの保持期間を 30〜90 日に
   - ruleset: `develop` の削除と non-fast-forward（force push）を禁止。bypass はリポジトリ管理者
   - `.github/dependabot.yml`（`github-actions` と `npm`、`directories: ["/", "/apps/*", "/packages/*"]`、週 1、`groups` で minor/patch をまとめ、`cooldown` 7 日）
2. **P1-2・P1-3**（CI に actionlint・zizmor、CodeQL の default setup）。最初は警告だけ（`continue-on-error` か SARIF のみ）、1〜2 週間で誤検知を除いてから必須にする
3. **P1-1・P1-5**（Worker の cron で見張り＋Pages の通知）。Hermes の見張りと並べて動かす
4. **P2** は R2（系譜の公開）の進み具合に合わせる。Turnstile は R2-4（フォームの公開）と同時に、鍵の environment への移動は鍵を入れ替えるとき（Groq の廃止）に一緒にやると手戻りが少ない
5. collect の再開（design 40 §5-1）が決まったら P1-4・P2-5 をセットで

## 8. 未確認・要確認

- Cloudflare アカウントで、すでに使っている Cron Trigger の数（Free は 5 個。他プロジェクトと共有）。`wrangler` の認証が要るので今回は見ていない
- Pages の直接アップロード（`wrangler pages deploy`）が「ビルド 500 回/月」に入るか（docs に記載なし）。また、Pages のデプロイ失敗通知が直接アップロードでも届くか
- R2 にカードが要ることの公式 docs 上の記載（ダッシュボードの挙動と Community の回答では確認できた）
- 収集を再開したときの git の実際の増え方（§5 の見積もりは粗い）
- `persist-credentials` を外せる job がどれか（promote の push に要るものと要らないものの切り分け）
- GitHub の 2026-10-01 からの保持期間の変更で、`gh run list` を使う既存の運用（見張りのスクリプト・スキルの手順）が 90 日より古い run を前提にしていないか

> 生の取得結果は手元の一時領域に置いたため、リポジトリには入れていない（2026-10-11）。

---

## 9. 実装の記録（R1-6: P1-1・P1-4、2026-10-11。デプロイ待ち）

P1-1（見張りを Worker の Cron Trigger へ）と P1-4（予定実行を Worker から起こす）を、R3 の新しい回の検知（design 52 §8）の定期実行と一緒に実装した。**Worker はまだデプロイしていない**（手順は runbook「運用: Worker の見張り（R1-6）」）。

| 項目 | 内容 | 場所 |
|---|---|---|
| Cron Trigger | **1 個だけ**: `30 0 * * *`（毎日 00:30 UTC＝09:30 JST）。アカウントで 5 個までなので、週 1 回の処理も同じ cron の中で曜日で分ける | `apps/api/wrangler.jsonc` の `triggers.crons`、`src/index.ts` の `scheduled` |
| 確かめる内容 | ① サイトの `/`・`/themes/`・`/how-it-works/` と旧サイトの転送ページが 200（リダイレクトは追わない）② `/api/health` 相当（`pat_configured`・`accepting`・`dispatch_mode=live`）③ `lineage-quality-v1.json` の公開中テーマ数（kind=theme・ready・audited/unaudited）が 0 件、または KV に記録した前回の件数より減った ④ develop の `pages`・`tests`・`data-audit`・`regen-themes`・`theme-on-demand`・`regen-retry`・`conference-watch` の最新の実行が失敗（success/skipped/neutral 以外。実行中は見ない。まだ develop に無い workflow の 404 は無視）⑤ GitHub API の応答ヘッダ `github-authentication-token-expiration` で PAT の残りが 14 日未満（3 日未満で別の通知）。401/403 は「PAT の失効・権限不足」⑥ `regen-pending.json` に 5 回以上失敗したテーマ（旧スクリプトと同じ） | `apps/api/src/watchdog/checks.ts` |
| `/api/health` の確かめ方 | Worker から自分の workers.dev の URL を取りに行くのは確実でない（Worker 同士の fetch の制限）ので、同じハンドラをプロセス内で呼ぶ。KV の値と PAT の有無は分かるが、**外からの到達性は見ていない**（サイトのページの確認と、Hermes の見張りを並べて動かす期間で補う） | 同上 |
| 通知 | 問題の集まり（各問題の `key` を並べたもの）が前回の通知と変わったときだけ `alert.yml` を dispatch（入力 `status=problem`・`summary`）。同じ問題が続くときは 7 日ごとに再通知。全部直ったら `status=resolved` で 1 回。`alert.yml` は `GITHUB_TOKEN`（issues: write）で、ラベル `watchdog` の開いている issue 1 つにコメントする（無ければ作る。resolved ならコメントして閉じる）。本文で持ち主を @mention するので GitHub のメールが届く | `apps/api/src/watchdog/scheduled.ts`、`.github/workflows/alert.yml` |
| 重複の抑止 | KV（`CONFIG_KV`）のキー `watchdog_state` に、通知した問題の集まり・通知日時・公開テーマ数の基準・最後の実行日時を JSON で 1 つ保存（1 日 1 回の書き込み。Free の 1,000 回/日に十分収まる）。dispatch に失敗したら状態を進めない（次の日に同じ通知を再送）。workflow の失敗は run ID を key に含むので、新しい失敗の run は新しい通知になる | 同上 |
| テーマ数の基準 | 減ったことを 1 回知らせたら、次の日からは新しい件数を基準にする（`theme_min_generated_at` を進めて意図的に隠すこともあるため）。0 件はいつでも問題 | 同上 |
| 週 1 回の新しい回の検知（P1-4・R3） | 月曜（UTC）の実行で `conference-watch.yml` を dispatch。GitHub の `schedule:` は使わない（§2.2 の遅れと 60 日で止まる規則） | 同上 |
| `conference-watch.yml` | `groupsCli.ts --write` を実行（exit 3 の `source_blocked` は警告だけ。それ以外の失敗は commit の後で run を失敗にする）→ 中身が変わったとき（`editions` から `last_seen_at` を除いたものと `last_check.status`。時刻だけの変化では commit しない）だけ `release/cli.ts commit-push` で develop に commit → **新しい** pending-edition が出たときだけ、ラベル `conference-watch` の issue 1 つに一覧と承認用のコマンド（arXiv 経由の `conference-on-demand.yml` の dispatch）を書く。**公開は一切しない** | `.github/workflows/conference-watch.yml` |
| 安全側の作り | `scheduled` は例外を外に出さない（ネットワークの失敗も問題として報告）。`DISPATCH_MODE` が `live` でない Worker（preview・`wrangler dev`）は確かめるだけで dispatch しない。preview の設定には cron を置かない（テストで固定）。PAT はログ・本文に出さない | `scheduled.ts`、`test/wrangler-config.test.ts` |
| テスト | Worker: fetch を差し替えた単体テスト 25 件（ヘッダの解析、14 日／3 日、テーマ数の減少、run の失敗、401 を 1 回だけ、重複の抑止・再通知・解消、月曜だけ dispatch、dry-run は dispatch しない、全部の fetch が失敗しても落ちない）。workflow: 契約テスト（dispatch だけ・develop だけ・最小の権限・入力は env 経由・issue は 1 つ・公開しない・Worker が名前を指す workflow が実在する） | `apps/api/test/watchdog/scheduled.test.ts`、`apps/pipeline/test/workflows/r1-6-watchdog-workflows.test.ts` |

残り:

- Worker のデプロイ（☐ 承認）と、Cloudflare アカウントで使っている Cron Trigger の数の確認（§8）。
- デプロイ後 1〜2 週間は Hermes の見張り（`~/.hermes/scripts/paperpilot_watchdog.sh`）と並べて動かし、通知の差を比べてから Hermes 側を止める（§6）。
- 承認を「1 回の操作で公開」まで縮める仕組み（公式 proceedings のアダプタを dispatch で動かす workflow、design 52 §8.4）はまだ無い。今の issue は arXiv 経由のコマンドと、design 52 §8.3 の手順への案内まで。
- Analytics Engine への記録（P2-3）は入れていない。
