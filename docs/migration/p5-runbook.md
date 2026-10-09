# P5 切替手順書（runbook）

この文書は [`p5-plan.md`](p5-plan.md) §6（6.1 KV の値、6.2 手順、R-B の戻し方）を、作業者が上から順に進められるチェックリストにしたものです。順序は §9（Tier C の前倒し）に合わせて組み直しました。コマンドとパスは、リポジトリの tree か、名前を書いた commit にあることを確かめています。§6 とコードが食い違う箇所はコードに合わせ、「（計画とコードの差）」と書きました。

## この版の前提（§9 の要約）

- ブランチ `p5/consolidate` は、次をすでに含みます。
  - `83a7551` = commit B（`dataMove apply --confirm-delete docs/daily/papers.json` の結果。データを `data/{published,state,inputs,config}` へ移し、layout を p5 にし、`.github/workflows-p5` を `.github/workflows` へ移した）。
  - `24cf1c1` = Tier C の削除（`paperpilot/` の Python、`pyproject.toml`、`uv.lock`、Docker、`containers/`、`tools/`、`.github/scripts/`、`worker/`、ルートの `wrangler.jsonc`、`wrangler.legacy-rollback.jsonc`）。
  - そのあとのテスト・修正・文書の commit（`c57fb7f`、`4a33025`、`5e67d51`、`988579a`、`de597a9`）。`c57fb7f` で `legacy/gh-pages-site/` も消え、旧ページの一覧は `legacy/redirect/paths.json` に固定されました。
- だから「Merge B を停止中に作る」と「観察の後に Tier C」は、なくなりました。B と C は 1 つの merge commit（以下 `<mergeB>`）で develop に入ります。
- develop の本番は、まだ旧 `worker/`（Workers Builds、root directory `/`、ルートの `wrangler.jsonc`）と、Python の workflow と GitHub Pages で動いています。develop には `apps/` も `package.json` もありません。
- 旧 Worker へ戻す材料（`worker/rollback-entry.ts` と `wrangler.legacy-rollback.jsonc`）は、`feat/ts-migration`（`c88c966`）と `0d85e50`・`83a7551` にだけあります。`<mergeB>` の後の develop にはありません。

新しい順序:

1. P0 前提（ユーザー作業）
2. P1 オフライン確認（`p5/consolidate`）
3. P2 リハーサル（プレビュー）
4. P3 Merge A（`feat/ts-migration` → develop。動作は変わらない）
5. Phase W（Worker を `apps/api` に切り替える）
6. 切替の準備（停止の前）
7. 切替（`p5/consolidate` を merge commit で取り込む = B + C）
8. 観察と、Worker を戻せる期間の終わり

> **値（2026-10-09 確定）**: Pages プロジェクト `paperpilot`、公開 origin `https://paperpilot.pages.dev`、本番ブランチ `production`（プロジェクトの `production_branch` と照合済み）。値の置き場所は `packages/core/src/site/config.ts` と `.github/workflows/pages-release.yml`・`pages-rollback.yml` の env。

## 記号

- ☐ ユーザーの作業、またはユーザーの承認が要る手順。
- ✔ 確認点。通るまで次へ進まない。
- ↩ その手順の戻し方。
- 「（要確認）」 まだ確かめていない点。実行前に、今の Cloudflare／GitHub の挙動やコマンドを確かめる。

## コマンドの前提

- リポジトリのルートで実行します。Node 22 と pnpm 10.34.6 を使います。
- `dataMove` は `pnpm exec tsx apps/pipeline/src/release/dataMove/cli.ts`、`release/cli.ts` は `pnpm exec tsx apps/pipeline/src/release/cli.ts` の略です。
- `dataMove` の各サブコマンドは stage するだけで、commit はしません。`git diff --cached` を見てから、自分で commit します。
- `dataMove rehearse` は B の前の tree 用です（clone に `apply` をかける）。B が済んだこの branch では使いません。
- wrangler はルートには入っていません（`apps/api` の devDependency、4.147.0）。この文書では次の形で呼びます。
  - `pnpm --filter @paperpilot/api exec wrangler …`（作業ディレクトリが `apps/api` になる。ファイルのパスは `"$PWD/…"` のように絶対パスで渡す）。
  - 旧 Worker の設定を使うときだけ、ルートから `./apps/api/node_modules/.bin/wrangler … -c wrangler.legacy-rollback.jsonc`（`feat/ts-migration` の checkout で）。
- wrangler 4 の `kv` コマンドは、既定でローカルに書きます。本番に書くときは必ず `--remote` を付けます。

---

## 6.1 KV の値（本番 namespace `3e11d3e73dae42a8b94f06a9fa9de19f`）

書き込みと読み戻しは次の形です。

```
pnpm --filter @paperpilot/api exec wrangler kv key put --namespace-id=3e11d3e73dae42a8b94f06a9fa9de19f <key> <value> --remote
pnpm --filter @paperpilot/api exec wrangler kv key get --namespace-id=3e11d3e73dae42a8b94f06a9fa9de19f <key> --remote --text
```

- preview の origin や `<hash>.<project>.pages.dev` の origin は、決して許可リストに入れません。
- 値を変えるたびに `/api/health` を見ます。

| キー | Phase W | 切替 手順 1 | 切替 手順 4 | 手順 8 の後 | 観察の後 |
|---|---|---|---|---|---|
| `accepting` | `"true"` | `"false"` | `"false"` | `"true"` | `"true"` |
| `origin_allowlist` | `["https://taichiiiiiiii.github.io"]` | 同じ | `+ "https://paperpilot.pages.dev"` | 同じ | `["https://paperpilot.pages.dev"]`（転送ページが動いたら GitHub Pages を外す） |
| `namespace_tag` | `"paperpilot-themes-production"` | | | | |

---

## P0 前提（☐ ユーザー作業、デプロイなし）

1. ☐ Cloudflare Pages のプロジェクトを作る（Direct Upload）。本番ブランチ名を決める（39 §10-1）。独自ドメインを使うか決める（判断待ち 3）。決まった origin を正確に報告する。A5 に入れる。
2. ☐ Pages 用のトークンを作る。GitHub environment を 2 つ作る。
   - `cloudflare-pages-deploy`（develop のみ、secrets あり）
   - `cloudflare-pages-production`（secrets なし）
3. ☐ `paperpilot-themes` の Workers Builds（**Merge A の前に**）:
   - 今の root directory、build command、deploy command、Node のバージョン、環境変数を記録する。
   - 環境変数 `NODE_VERSION=22` を入れる。`PNPM_VERSION=10.34.6` も入れてよい。Merge A でルートに `pnpm-lock.yaml` ができると、Workers Builds は build command の前に `pnpm install --frozen-lockfile` を自動で実行します。既定の Node は 24 です（R1）。`SKIP_DEPENDENCY_INSTALL` は入れない。
   - Settings > Build > Branch control の「Enable Preview Builds」を切る（39 §10-4、R16）。
   - `p5/consolidate` と `feat/ts-migration` はすでに push 済みです。この 2 つのブランチのビルドが Workers Builds の履歴にないことを確かめる（要確認）。
4. ☐ develop のブランチ保護の必須チェック名を確かめる（R17。`tests.yml` の job `test`）。`.codex/` と Codex/Qwen 文書を残すか決める（判断待ち 8）。`docs/daily/papers.json` の削除を確定する（B に含まれています）。
5. ☐ Pages プロジェクトの設定: Web Analytics の自動挿入を切る。独自ドメインなら、そのゾーンの Rocket Loader と email obfuscation も切る。
6. ☐ この順序（§9）で進めることを承認する。特に、切替の merge で `worker/` と Python が develop から消えること。

---

## P1 オフライン確認（`p5/consolidate`）

| 項目 | 状態 |
|---|---|
| `feat/ts-migration` の `0d85e50` で test・typecheck・biome・web build・`validate bundle`・rehearse・format-only・A11 | 完了（p5-plan.md §8） |
| `dataMove verify 0d85e50 83a7551`（B 単体） | 0 で終わることを確かめた（2026-10-08、scratch clone） |
| `p5/consolidate` の HEAD で test・typecheck・biome・web build・`validate bundle` | PR の前にやり直して記録する |
| A5（本当のプロジェクト名と origin） | 未完。P0-1 の値待ち |
| A12（この文書） | 仮の印のまま。A5 の値で埋める |
| 各変更セットの `/code-review` | §8 に記録なし。PR の前に確認 |

コマンド:

```
pnpm install --frozen-lockfile
pnpm exec biome check .
pnpm -r typecheck
pnpm -r test
pnpm --filter @paperpilot/web build
pnpm exec tsx apps/pipeline/src/release/cli.ts validate bundle apps/web/out
pnpm exec tsx apps/pipeline/src/release/dataMove/cli.ts verify 0d85e50 83a7551
```

✔ 次も 0 件:

```
git ls-files paperpilot
git ls-files '*.py' ':!.codex'
git ls-files docs ':!docs/design' ':!docs/migration' ':!docs/research' ':!docs/QWEN_IMPLEMENTER.md'
```

- `dataMove verify <mergeB>^1 <mergeB>` は使えません。C が `legacy/gh-pages-site/` を消したので、B だけの形と合わず、必ず 0 以外で終わります。B の確認は、B の commit だけ（`83a7551`、作り直したときはその commit）に対して行います。

✔ すべて緑。`verify` の出力を PR に添付している。

---

## P2 リハーサル（☐ 承認、ユーザーの手元の wrangler だけ）

1. ☐ `p5/consolidate` から `apps/web` をビルドし、marker を書く。データはもう `data/` にあるので、`apply` は要りません。
   - develop に B の後の data commit がある場合は、先に「切替の準備」手順 3b で作り直したブランチから作る。

   ```
   pnpm --filter @paperpilot/web build
   SOURCE_SHA="$(git rev-parse HEAD)" RELEASE_KIND=normal REQUEST_ID= pnpm exec tsx apps/pipeline/src/release/cli.ts marker apps/web/out
   ```

   - `marker` が読む env は `SOURCE_SHA` / `RELEASE_KIND` / `REQUEST_ID` です。`RELEASE_KIND` は `normal` か `rollback` です（`release/cli.ts`）。ここでは `normal`。
2. ☐ 本番ではないブランチに上げる。プレビュー URL ができます。Cloudflare Access は任意です。

   ```
   pnpm --filter @paperpilot/api exec wrangler pages deploy "$PWD/apps/web/out" --project-name=paperpilot --branch=rehearsal
   ```

3. ☐ smoke を通す。値は `.github/workflows/pages-release.yml` と同じです。

   ```
   pnpm exec tsx apps/pipeline/src/release/cli.ts validate smoke https://rehearsal.paperpilot.pages.dev "$(git rev-parse HEAD)" --expect-bytes apps/web/out --expect-404 /__pp_smoke_missing__/ --expect-redirect /iclr-2026/lineage.html=/iclr-2026/lineage/
   ```

4. ☐ ブラウザで全種類のページを見る。CSP のコンソールエラーがないこと。テーマ投稿フォームは 403 か縮退表示になります。プレビューの origin は許可していないので、これで正常です。
5. Pages の rollback API（`POST …/deployments/{id}/rollback`）は本番のデプロイだけが対象です。プレビューでは試せません。応答の `result.id` が新しい id か、戻し先の id かは未確認です（要確認）。最初に `pages-rollback.yml` か `release/cli.ts cf-rollback` を使ったときに記録する。

✔ smoke が通る。
↩ ダッシュボードでプレビューのデプロイを消す。

---

## P3 Merge A（☐ 承認）

目的: develop に `apps/api` と pnpm workspace を入れる。Phase W を切替より前に、別の手順として行うためです。中身は `feat/ts-migration`（`worker/`、Python、`.github/workflows-p5/` を含む）なので、本番の動作は変わりません。

1. ✔ `p5/consolidate` の土台が feat に含まれている。

   ```
   git fetch origin
   git merge-base --is-ancestor 0d85e50 origin/feat/ts-migration && echo ok
   ```

2. ☐ `feat/ts-migration` → develop の PR を **merge commit** で取り込む（以下 `<mergeA>`）。

✔ 確認:
- Python の `tests.yml` が緑。
- Python の `pages.yml` が GitHub Pages を出し直す（`docs/design` と `docs/migration` が変わったため）。転送ページの手順までは `docs/migration/*` が GitHub Pages に出ます。小さな露出として受け入れる（R12）。
- Workers Builds のログ: Node 22 で `pnpm install --frozen-lockfile` が通り、旧 Worker（ルートの `wrangler.jsonc`）が再デプロイされている（R1）。ビルドが失敗しても、今の版が動き続けます。直してから先へ進む。
- `Origin: https://taichiiiiiiii.github.io` と既存テーマで `curl -X POST` すると `status: exists` が返る。dispatch は起きない。

↩ 次で戻す。ほかは何も変わっていません。

```
git revert -m 1 <mergeA>
```

---

## Phase W: Worker を apps/api に切り替える（☐ 各手順、`<mergeA>` の後の develop で）

- **W1.** ☐ KV に書く: `accepting=true`、`origin_allowlist=["https://taichiiiiiiii.github.io"]`、`namespace_tag`（値は 6.1 の表）。`kv key get --remote` で読み戻す。
- **W2.** ☐ 手元で本番設定の dry-run を通す。旧 Worker へ戻す設定もバンドルできることを確かめる（develop の checkout で。`wrangler.legacy-rollback.jsonc` は `<mergeA>` で develop に入っています）。

  ```
  pnpm --filter @paperpilot/api exec wrangler deploy --dry-run --outdir "$TMPDIR/api-dry"
  ./apps/api/node_modules/.bin/wrangler deploy --dry-run --outdir "$TMPDIR/legacy-dry" -c wrangler.legacy-rollback.jsonc
  ```

- **W3.** ☐ Workers Builds の root directory を `apps/api` にする（39 §10-7）。
  - install は自動です（ロックファイルがあると `pnpm install --frozen-lockfile`）。ルートが `apps/api` でも workspace 全体が入るかは、ビルドログで確かめる（要確認）。
  - build command は空でよい。自分で `pnpm install` を書くと二重になります。
  - deploy command は既定の `npx wrangler deploy`（`apps/api/wrangler.jsonc` を読む）。
  - `NODE_VERSION=22` が残っていることを確かめる。そのうえで最新のビルドを再実行する。
  - **root を `/` のままにして、ルートの `wrangler.jsonc` を `apps/api` に向ける案は、もう使えません。** 切替の merge でルートの `wrangler.jsonc` が消えるためです。
- **W4.** ✔ 確認:
  - `GET /api/health` が `{accepting:true, dispatch_mode:"live", pat_configured:true, kv_namespace_tag:"paperpilot-themes-production"}` を返す。
  - GitHub Pages の origin で OPTIONS を送ると、ACAO が完全一致し、`Vary: Origin` が付く。
  - 知らない origin は 403。
  - 既存テーマの POST は `exists`。
- **W5.** ☐ **旧**サイトのフォームから、本物の新しいテーマを 1 件送る。`queued` が返る。Python の `theme-on-demand` workflow が動き、GitHub Pages が更新される。
- `apps/api/wrangler.jsonc` は `migrations`（`v1`、`new_sqlite_classes: ["QuotaCounter"]`）のままにする。Worker を戻せる期間が終わるまで、DO の `exports` 形式に移さない。移すと、旧 Worker にも以前の版にも戻れなくなります。

### ↩ W（切替の前）

1. すぐに `accepting=false` にする（安全側で止める。60 秒以上待つ）。
2. 次のどちらかで戻す。
   - Workers の version rollback で、以前の apps/api の版に戻す（DO migration の後の版だけ）。

     ```
     pnpm --filter @paperpilot/api exec wrangler rollback <version-id>
     ```

   - 旧 Worker を出し直す（`QuotaCounter` は stub、migration `v1` は同じ）。develop の checkout のルートで:

     ```
     ./apps/api/node_modules/.bin/wrangler deploy -c wrangler.legacy-rollback.jsonc
     ```

3. DO 導入前の素の `worker/` には**戻さない**。Cloudflare は DO migration より前の版への version rollback を拒否します。クラスのない `worker/` を出し直すと失敗します。
4. 旧 Worker を出し直した後は、次の develop への push で `apps/api` が出し直されないようにする。例: root directory を `/` に戻し、deploy command を `npx wrangler deploy -c wrangler.legacy-rollback.jsonc` にする（要確認）。root `/` と既定の deploy command（ルートの `wrangler.jsonc`、DO クラスなし）の組み合わせには戻さない。公式に書かれていていちばん確実なのは、Settings → Builds → Disconnect でビルドを止める方法（設定を控えてから。手順は「↩ Worker（`<mergeB>` の後）」の 5）。この時点の旧 Worker は、データ移動の前なので manifest の場所と CORS（GitHub Pages）がそのまま合う。

---

## 切替の準備（停止の前。☐ push と PR だけ）

1. ✔ Phase W が済み、Workers Builds の root directory が `apps/api` である。
2. ✔ P1 のコマンドが `p5/consolidate` の HEAD で緑。
3. B が古くなっていないか確かめる。B（`83a7551`）は `0d85e50` の tree から作られています。develop にその後のデータ commit があると、B はそれを運びません。

   ```
   git fetch origin
   git log --oneline 0d85e50..origin/develop -- docs paperpilot/data paperpilot/output
   git diff --stat 0d85e50 origin/develop
   ```

   - `<mergeA>` 自身と、feat の文書 commit（`docs/design/`、`docs/migration/` だけ）は出てきてよい。2026-10-07 の時点では `0d85e50..c88c966` の差は `docs/design/39-typescript-cloudflare-migration.md` と `docs/migration/p5-plan.md` だけです。
   - **ほかのパスが出たら 3b**。出なければ 3a。

#### 3a. B がそのまま使える場合

develop を `p5/consolidate` に取り込みます。衝突は `docs/design/39-typescript-cloudflare-migration.md` だけのはずです（scratch clone で `<mergeA>` 相当の上に merge して確かめた）。

```
git switch p5/consolidate
git merge origin/develop
git checkout --ours docs/design/39-typescript-cloudflare-migration.md
git add docs/design/39-typescript-cloudflare-migration.md
git commit --no-edit
```

- `--ours` は `p5/consolidate` 側の版です。develop 側の更新が要るなら、手で足す。
- 衝突がほかにも出たら、そこで止まって原因を調べる（B が古いおそれ）。

#### 3b. develop に B の後のデータ commit がある場合（B を作り直す）

B を develop の先端で作り直し、その上に B の後の commit を載せます。`p5/consolidate` 自身は書き換えません。

```
git switch -c p5/cutover origin/develop
pnpm install --frozen-lockfile
pnpm exec tsx apps/pipeline/src/release/dataMove/cli.ts plan
pnpm exec tsx apps/pipeline/src/release/dataMove/cli.ts apply --confirm-delete docs/daily/papers.json
git diff --cached --stat
git commit -m "chore(p5): move data into data/ and flip the layout to p5 (dataMove apply)"
pnpm exec tsx apps/pipeline/src/release/dataMove/cli.ts verify HEAD~1 HEAD
git cherry-pick 83a7551..origin/p5/consolidate
```

- `apply` は develop の tree にある `dataMove`（`<mergeA>` で入った feat の版）で動きます。`83a7551` を作ったものと同じコードです。
- `--confirm-delete docs/daily/papers.json` がないと、`apply` は何も触らずに拒否します（P0-4 で削除を確定してから付ける）。
- B′（書式だけの差）は §8 の時点では不要でした。ここで develop の先端に対して format-only の確認をやり直す（p5-plan.md §8 の手順）。差があれば、B の直後に別のデータだけの commit にする。
- cherry-pick の途中の扱い（要確認。実際の衝突で判断する）:
  - `de597a9` は feat の `c88c966` と同じ文書 commit です。空になったら `git cherry-pick --skip`。`docs/` で衝突したら `p5/consolidate` 側（`--theirs`）を取る。
  - `24cf1c1` / `c57fb7f` の削除と、develop の新しい変更がぶつかったら（modify/delete）、削除を取る（`git rm <path>`）。
  - develop で旧サイトの HTML が増えていた場合、新しい B はそれを `legacy/gh-pages-site/` に移します。`c57fb7f` はその新しいファイルを消しません。残ったら `git rm -r legacy/gh-pages-site`。そのうえで `legacy/redirect/paths.json` に新しいページを手で足す（生成スクリプトはありません。要確認）。
- 以後、この文書の `p5/consolidate` は `p5/cutover` と読み替える。B の確認は `verify <新しい B>^ <新しい B>` で行う。

4. ✔ 3a か 3b の後で、P1 のコマンドと 0 件の確認をもう一度通す。workflow の契約テストが `.github/workflows` を対象に動いている。`/code-review high`。
5. ☐ ブランチを push し、develop への PR を開く。PR の CI（Node 版 `tests.yml`）が緑。必須チェック名が develop の保護と合っている（P0-4）。
6. ✔ `git rev-list --count p5/consolidate..origin/develop` が 0（develop の全部が取り込まれている）。

---

## 切替（Merge B + C）

1. ☐ KV `accepting=false`。
   ✔ `/api/health` が `accepting:false`。そこからさらに 5 分以上待つ。
2. ☐ 5 本の workflow を止める。

   ```
   gh workflow disable theme-on-demand.yml
   gh workflow disable collect-weekly.yml
   gh workflow disable collect-daily-watch.yml
   gh workflow disable regen-themes.yml
   gh workflow disable conference-on-demand.yml
   ```

   - workflow はファイル名で指定します。切替前の旧 workflow は表示名が違うものがあります（`collect-weekly.yml` は "PaperPilot Weekly Deep Survey"、`collect-daily-watch.yml` は "PaperPilot Daily Follow Watch"）。

   ✔ 全 workflow で `gh run list --status in_progress` と `gh run list --status queued` がどちらも空。途中の promoter は安全側に止まります。
3. ✔ 停止の間に、B が古くないことを確かめ直す（準備の手順 3 と 6 をもう一度）。
   - `git log --oneline 0d85e50..origin/develop -- docs paperpilot/data paperpilot/output` に、準備のときになかったデータ commit がない。
   - `git rev-list --count p5/consolidate..origin/develop` が 0。
   - 新しいデータ commit があれば、準備の 3a か 3b からやり直す（停止は続ける）。
4. ☐ KV `origin_allowlist` に `https://paperpilot.pages.dev` を足す。
5. ☐ PR を develop に **merge commit** で取り込む（以下 `<mergeB>`）。squash や rebase は使わない。R-B は `<mergeB>^1` を B の前の tree として使います。
   ✔ 確認:
   - Node 版 `pages.yml` が validate → build → admit → deploy → smoke → record まですべて緑。
   - `cloudflare-pages-production` に `cf_deployment_id` 付きの GitHub Deployment がある。
   - Node 版 `tests.yml` と `data-audit.yml` が緑。
   - Workers Builds が `<mergeB>` で `apps/api` を出し直し、成功している。ルートの `wrangler.jsonc` が消えても影響がない。
   - `/api/health` はまだ `accepting:false`（本物の POST では確かめない）。
6. ✔ 本番の確認:
   - `apps/web/out/sitemap.xml` の URL をスクリプトで全部叩き、すべて 200。
   - `/__missing__/` が 404。
   - `/iclr-2026/lineage.html?x=1#y` が `/iclr-2026/lineage/?x=1` へ 301。fragment はブラウザが保つ。
   - CSP ヘッダは `frame-ancestors` だけ。全ページに meta CSP がある。
   - ブラウザで見て CSP 違反がない。
   - 新サイトのテーマ投稿フォームが停止中の表示になる。
   - `https://paperpilot.pages.dev` からの preflight で ACAO が返る。
7. ☐ 5 本の workflow を戻す（同じファイル名の Node 版が動きます）。

   ```
   gh workflow enable theme-on-demand.yml
   gh workflow enable collect-weekly.yml
   gh workflow enable collect-daily-watch.yml
   gh workflow enable regen-themes.yml
   gh workflow enable conference-on-demand.yml
   ```

8. ☐ KV `accepting=true`。
9. ☐ **新**サイトから本物の依頼を 1 件だけ送る。Node 版 `theme-on-demand` → promote（tree 自身のコード、web build の関門）→ release → Cloudflare と進む。
   ✔ テーマが見え、記録されている。どこかで失敗したら `accepting=false` にして R-B へ。
10. ☐ `legacy-redirects.yml` を dispatch する（confirm に `REDIRECT`）。旧ページの一覧は `legacy/redirect/paths.json` です。
    ✔ `?q=`、`?theme=`、`#…` 付きの古い URL を抜き取りで開き、正しく着地する。404 の受け皿が動く。
    ☐ Search Console に新しい sitemap を登録する。

## 観察（1 週間程度）

11. 観察:
    - ☐ `collect-weekly`（またはテーマ 1 件の `regen-themes`）と `collect-daily-watch` を、それぞれ 1 回以上承認して動かす。
    - ✔ 各 run が generate → promote → release → record まで通り、`data/state` の更新が commit されている。
    - そのあと ☐ 許可リストから GitHub Pages の origin を外す（6.1 の「観察の後」）。
    - ☐ 2 回目以降の本番リリースの後で、`pages-rollback.yml` が使えることを確かめる（`target_sha` は記録済みの成功したデプロイの sha、confirm に `ROLLBACK`）。最初の 1 回は戻し先がありません。rollback API の `result.id` が新しい id かを記録する（要確認）。

## Worker を戻せる期間の終わり（☐ 承認）

12. ☐ 観察が済んだら、旧 Worker へ戻せる期間を閉じると決める。閉じるまでは次を守る。
    - `feat/ts-migration` ブランチを消さない（旧 Worker へ戻す材料は、もうそこにしかない）。
    - `apps/api/wrangler.jsonc` を DO の `exports` 形式に移さない。
13. 閉じた後にできること: `exports` 形式への移行、`feat/ts-migration` の整理。
14. この branch に入っていない §6.3 の残り（要確認）:
    - `CLAUDE.md` と `AGENTS.md` の書き直し（保護ファイル。ユーザーが適用する）。
    - `.codex/` と Codex/Qwen 文書の扱い（判断待ち 8）。
    - `.pre-commit-config.yaml` は ruff/mypy の hook がなく、汎用の hook だけ残っています。残すかを決める。
    ✔ 完了条件は 39 §8 の P5。`tests.yml` の `.py` 関門（`git ls-files '*.py' ':!.codex'` が 0 件）はこの branch に入っています。

---

## 戻し方

### ↩ R-B（`<mergeB>` の後）

`<mergeB>` は B と C を両方含みます。だから R-B は、データと一緒に Python・`worker/`・旧 workflow・`.github/scripts/` も戻します。

- `dataMove apply --reverse --before <mergeB>^` は**使えません**。`HEAD` が `apply` の結果そのものでないと拒否し、`<mergeB>` は C の削除も含むためです（scratch clone で拒否を確かめた）。
- Python の旧関門（`uv`、`pytest`、`build_pages.py`、`validate-pages-release.sh`）は、`<mergeB>` の後の tree にはありません。revert（4b）で `<mergeB>^1` から戻ってきます。4d はその後でだけ実行できます。手元に `uv` が要ります。
- carry-back → `git revert --no-commit -m 1 <mergeB>` → finish-revert が B + C の merge でも動くことは、scratch clone で確かめました（追加・変更・削除を 1 件ずつ入れた data commit で、結果は「`<mergeB>^1` + 3 件を旧パスに戻したもの」と一致）。

1. ☐ `accepting=false`。
2. `<mergeB>` の後の commit を一覧する。

   ```
   git log --oneline <mergeB>..origin/develop
   git log --oneline <mergeB>..origin/develop -- data/
   ```

3. **`<mergeB>` の後に data commit がない場合**（すぐ戻す場合。手順 7 以降の workflow はまだ何も commit していない）:

   ```
   git revert -m 1 <mergeB>
   git diff --stat <mergeB>^1 HEAD
   ```

   - ✔ 2 行目の差は、`<mergeB>` の後のデータ以外の commit の分だけ。後に commit がなければ空です（scratch clone で空になることを確かめた）。
   - そのあと手順 5 へ飛ぶ（4d の作り直しは要らない。ただし 4d の 6 の関門は、push の前に一度通すとよい）。
4. **`<mergeB>` の後に data commit がある場合**（ふつうはこちら。観察週の後でも R-B はありうるので、`collect-weekly`/`collect-daily-watch`/`regen-themes`/`conference-on-demand` がほぼ必ず動いています）。4a–4d の 4 段で進めます。

   > 注意: 4a と 4c は同じ manifest ファイルを使います。`${TMPDIR:-/tmp}` が変わらないよう、同じシェルで実行します。
   > 始める前に `git status --porcelain` が空であること。carry-back は汚れた作業ツリーを拒否します。

#### 4a. carry-back（`data/**` がまだある間に、最初に）

```
pnpm exec tsx apps/pipeline/src/release/dataMove/cli.ts carry-back --since <mergeB> --manifest "${TMPDIR:-/tmp}/carry-back.json"
```

- 変わったパスは `HEAD` から読みます。`git revert` の後では読むものが残りません。だから最初に行います。
- `<mergeB>` の後の `data/**` の追加・変更・削除を、逆向きの rule 表で旧パス（`paperpilot/…`/`docs/…`）に再現します。
- `--manifest` は必須です。上の具体的なパスを使います（手元では `$RUNNER_TEMP` が未設定で、`/carry-back.json` になってしまう）。
- 次の場合は、index に触らず全体を拒否します。
  - 変わったパスに旧パスの対応がない。例: `<mergeB>` の後に新しくできた `data/config/conference-copy/<slug>.json`（p5 にしかない）。手で片付けてからやり直す。
  - `<mergeB>` の後の変更が、収集設定の `moveEdit` キーに触れている。
  - manifest を書けない。
- そのあと、必ず次の形で、単独の commit にします。間に何も挟まない。`git add -A` は使わない。

  ```
  git commit --no-verify --allow-empty -m "rollback: carry back data since B"
  ```

  - `--allow-empty` は必須です。削除だけの carry-back は何も stage しません（B が旧パスをすでに消しているため）。素の `git commit` では commit ができず、4c が拒否します。この場合 carry-back は "nothing is staged" と表示します。
  - `--no-verify` も必須です。`.pre-commit-config.yaml` の `check-added-large-files --maxkb=500`、`end-of-file-fixer`、`trailing-whitespace` は、戻したデータを除外していません。戻したカタログ（例 `docs/<conf>/papers.json`）は 500 KB を超えることが多く、ほかの 2 つは末尾の空白や改行を書き換えます。どちらでも、commit の中身が carry-back が stage したものとずれ、4c の `[carry-back-incomplete]` で拒否されます。
  - この手順の carry-back commit は、4a も 4c の対処も、すべて `git commit --no-verify --allow-empty` です。
- ツールは自分では commit しません。`git diff --cached` を見てから、自分の名前で commit します。

**4a の途中で `git` 自体が失敗した場合**（例: いくつか stage した後で `git update-index`/`git checkout` が失敗）:

- `git reset --hard` は使わない。作業ツリーのほかの未 commit の作業を消すおそれがあります。
- `git reset --keep HEAD` も使わない。index を空にするだけで、作業ツリーはそのままです（新しい旧ファイルは untracked、変更したファイルは変更のまま）。`git status --porcelain` が空になりません。
- 代わりに次を実行します。

  ```
  git diff --cached --name-only -z | xargs -0 git restore --staged --worktree --
  ```

  - carry-back は始める前に作業ツリーがきれいなことを確かめます。だから 4a の前の index は空でした。いま stage されているのは 4a 自身が stage したもの（の途中まで）だけです。`--staged` と `--worktree` を一緒に付けると、両方を `HEAD` から戻します。`HEAD` にないパス（新しい旧ファイル）は消えます。
  - manifest に載っている `legacyPath` を全部並べる方法は使わない。途中で届かなかったパスは `HEAD` にも index にもなく、`git restore -- <そのパス>` が "did not match any file(s) known to git" で失敗し、何も戻しません。
- そのあと、carry-back が書いた manifest ファイルを消す。`git status --porcelain` が空なのを確かめる。きれいな状態から 4a をやり直す。

#### 4b. 構造の revert（必ず `--no-commit`）

```
git revert --no-commit -m 1 <mergeB>
```

- `<mergeB>` 自身の差を戻します: rule 表の移動、`LAYOUT_MODE` の切替、workflow の入れ替え（Node 版は `.github/workflows-p5/` へ戻り、Python 版が `.github/workflows/` に戻る）、`.gitignore`/`.lighthouserc.json`、そして C の削除（`paperpilot/`、`pyproject.toml`、`uv.lock`、`worker/`、ルートの `wrangler.jsonc`、`wrangler.legacy-rollback.jsonc`、`.github/scripts/` など）。
- 衝突で終了コード 1 になることがあります。**手で解決しない。** fixture の回帰テストと scratch clone で見た結果は次のとおりです。
  - **削除は衝突する**: `<mergeB>` の後の削除は rename/delete の `DU` になり、B の前のファイルを生き返らせようとする。
  - **変更はふつう衝突しない**: ただし同じ blob どうしの rename の組み合わせは任意なので、後の変更が、衝突なしで別の旧ファイルに混ざることがある。
  - **追加は衝突しないことがある**: ただし p5 側のコピーが `data/` の下に追跡されたまま残る。

#### 4c. finish-revert

```
pnpm exec tsx apps/pipeline/src/release/dataMove/cli.ts finish-revert --manifest "${TMPDIR:-/tmp}/carry-back.json"
```

- 全データパスを、manifest と B の前の tree（`<mergeB>^1`）が決める内容にします（§5.2）。stage だけします。C が消したパスも `<mergeB>^1` の内容に戻ります。
- 拒否されたら、メッセージが原因を示します。次の対処はどれも本物の commit を消しません。

**`[no-carry-back-commit]`** — `HEAD` がまだ carry-back を実行した commit のまま。4a の commit ができていません。reset するものはありません。**manifest の中身で対処が変わります（取り違えない）。**
- manifest が**削除だけ**の場合: 4a は本当に何も stage していません。

  ```
  git revert --abort
  git commit --no-verify --allow-empty -m "rollback: carry back data since B"
  ```

  （`git revert --abort` は revert が進行中のときだけ）。そのあと 4b と 4c をやり直す。
- manifest に**追加か変更が 1 件でもある**場合: carry-back は中身を stage していました。4a の `git commit` が実行されなかった（忘れた、または pre-commit hook に拒否された）だけです。`git revert --abort` は**その stage を捨てます**。そのあとの `--allow-empty` commit には何も入りません（そうすると下の `[carry-back-incomplete]` になる）。次の順で行います。
  1. `git revert --abort`（revert が進行中のときだけ）。
  2. **先に 4a をやり直す**（`data/**` はまだあるので、同じ中身がもう一度 stage される）。

     ```
     pnpm exec tsx apps/pipeline/src/release/dataMove/cli.ts carry-back --since <mergeB> --manifest "${TMPDIR:-/tmp}/carry-back.json"
     ```

  3. `git commit --no-verify --allow-empty -m "rollback: carry back data since B"`。
  4. 4b と 4c をやり直す。

**`[carry-back-incomplete]`** — `HEAD` は正しい親の上の carry-back commit で、余計なものもない。しかし manifest の全エントリの中身を持っていない（例: 追加・変更のある manifest なのに空 commit を作った）。何も変更されていません。対処は上の 2 つ目と同じです: 進行中なら revert を abort、今の `HEAD` から 4a をやり直す（新しい manifest）、`--no-verify --allow-empty` で commit、4b と 4c をやり直す。

**`[revert-auto-committed]`** — revert を `--no-commit` なしで実行した。ツールは `HEAD` が carry-back commit の直上にある `<mergeB>` の revert commit だと確かめています。その revert commit だけを落とします（`--keep` はローカルの変更を捨てずに拒否する。`git reset --hard` は使わない）。

```
git reset --keep HEAD^
```

そのあと 4b を `--no-commit` でやり直し、4c。

**`[commits-in-between]`** — `HEAD^` が carry-back を実行した commit ではない。**reset しない**（間の commit は本物の作業かもしれない）。進行中なら `git revert --abort`。今の `HEAD` から 4a をやり直す（新しい manifest。すでに中身を持つ旧パスへの carry-back は何も stage しないので、4a はいつも `--allow-empty`）。そのあと 4b と 4c。

**`HEAD changes path(s) the manifest does not name`** — `HEAD` が carry-back commit ではない。
- メッセージに「`HEAD` は carry-back commit のない B の revert commit に見える」と付いている場合:
  - （計画とコードの差）§6.2 は「`git reset --keep HEAD^`、`git commit --no-verify --allow-empty`、4b と 4c をやり直す」とだけ書いています。コードの案内は manifest の中身で分かれます。こちらに従います。
  - manifest が削除だけ: `git reset --keep HEAD^` → `git commit --no-verify --allow-empty -m "rollback: carry back data since B"` → 4b（`--no-commit`）と 4c をやり直す。
  - manifest に追加か変更がある: `git reset --keep HEAD^` → `dataMove carry-back --since <mergeB> --manifest <同じファイル>` をやり直す → `git commit --no-verify --allow-empty -m "rollback: carry back data since B"` → 4b（`--no-commit`）と 4c をやり直す。
- そうでなければ、何かする前に `git show HEAD` を確かめる。

**データパスの外の衝突**（例: B が書き換えた `.gitignore` の行を、`<mergeB>` の後にも直していた）— 手で解決し、4c をやり直す。

**B が `data/` の外へ移したファイルの、`<mergeB>` の後の変更**（`apps/web/static/assets/` の 3 つの head asset）— finish-revert は `path(s) B moved outside data/ changed after B` で拒否します。carry-back commit の中で、手で旧パスに戻す。そのあと 4b と 4c をやり直す。`legacy/gh-pages-site/` は C で消えたので、ここには当てはまりません。

**commit の前に、revert のデータ以外の半分を見る。** finish-revert が持つのはデータパスだけです。ほかの `<mergeB>` の後の変更は `git revert` 自身がまとめています。

```
git diff --cached --stat <mergeB>^1 -- . ':!data' ':!docs' ':!paperpilot/data' ':!paperpilot/output'
```

- B の前の tree に対して、`<mergeB>` の後のどの編集が残るかを示します。C の削除は `<mergeB>^1` に戻るので、ここには出ません。
- 特に、`<mergeB>` の後に**動いている Node 版 workflow**（`.github/workflows/<name>.yml`）を直していた場合、その修正は同じ名前の旧 workflow に黙って混ざります。一方、`.github/workflows-p5/<name>.yml` は `<mergeB>^1` の中身（feat の版）に戻り、修正を失います。次で一覧し、旧 workflow に当てはまらない修正は旧 workflow から外す。

  ```
  git log --oneline <mergeB>..HEAD -- .github/workflows
  ```

- 次の切替をするときは、`.github/workflows-p5/` に入れ直すのではなく、`p5/consolidate`（または `p5/cutover`）を develop の先端で作り直し、その修正を載せる（要確認）。
- そのあと 1 回だけ `git commit` する。finish-revert が空の `data/…` ディレクトリを作業ツリーに残すことがありますが、untracked で無害です。

#### 4d. B 自身の 2 つの削除と、旧サイトの派生物

ここから先は、4b で戻った Python のコードを使います。手元に `uv` が要ります。

B 自身の 2 つの削除は `<mergeB>^1` の状態で戻ります。
- `docs/search-index.json`（v1）は旧レイアウトに必要です。`"legacy"` では `searchIndex.ts` が v1 を書き、ないと `--check` が ENOENT になります。Python の `build_search_index.py` が書き、`paperpilot/tests/test_published_assets_are_parseable.py` と `test_landing_s0.py` が出荷物を読みます。`docs/assets/search.js` は v2 を読むので v1 は互換用ですが、旧の検査が要求します。
- `docs/daily/papers.json` は B の規則（ユーザー確認済み、§5.1、R19）だけで消えたものです。B の前の tree の一部なので、素の revert で戻ります。次の切替でもう一度削除を確定します（P0-4）。

これで tree は「B の前の tree + `<mergeB>` の後の全変更を旧パスに置いたもの」になります。ただし `<mergeB>^1` の v1 と、旧 Python サイトがそこから作る派生物は、戻したカタログより古いままです。旧の tree で、旧サイトだけの派生物を**全部**、次の順で作り直します。結果は revert とは別の**データだけの commit 1 つ**にします（revert を読みやすく保つため）。

1. **最初に、どのビルドよりも前に**: `<mergeB>` の後に新しくできた学会が `papers.json` 付きで戻り、旧の `index.html`/`paper-links.html` がない場合は、旧ページを手で作る。`test_catalog_nojs_fallback.py` は `index.html` のない学会を飛ばすので、放っておくと `conferences.json` からリンクされたまま旧サイトで 404 になります。p5 側で作ったときと同じ `--conference`/`--display`/`--lede` を使います。2 と 3 はこのページが先にあることを前提にします。

   ```
   uv run python -m paperpilot.scripts.scaffold_conference_page --conference <slug> --display "<display>" --lede "<lede>"
   ```

   - 呼び出し方はスクリプト自身の Usage（`<mergeB>^1` の `paperpilot/scripts/scaffold_conference_page.py`）に合わせました。3 つの引数はすべて必須です。
2. `--conference` を付けずに全学会を作り直す。各学会の `papers.json`/`paper-links.html`、`conferences.json`、学会ごとの abstract shard を一緒に作り直します。`--conference` だけのビルドでは `conferences.json` が古いまま残ります。正当な削除で縮小の関門が止めたら、該当の `--allow-shrink-for <conf>`/`--allow-shrink` を付ける（通常の流れと同じ）。関門そのものを不具合扱いしない。

   ```
   uv run python -m paperpilot.scripts.build_pages
   ```

3. **正となる**作り直し（旧サイトが実際に出すもの）。`docs/search-index.json`（v1）、`docs/search-index-v2.json`、`docs/search-paper-ids-v1/` の shard を、2 の `papers.json` から一緒に書きます。

   ```
   uv run python -m paperpilot.scripts.build_search_index
   ```

4. **検査だけ。ここでは書かない。** `searchIndexCli` の書き込み（legacy モード）は 3 と同じものを TS の移植で作るもので、本番の経路ではありません。この手順は、TS 移植が Python の結果とバイト単位で一致することの確認です。0 以外で終わったら移植の退行として調べる。TS 移植を直す。`searchIndexCli` に 3 の出力を上書きさせて「解決」しない。

   ```
   pnpm exec tsx apps/pipeline/src/release/derived/searchIndexCli.ts --check
   ```

5. 資産のバージョンと sitemap の検査。

   ```
   uv run python -m paperpilot.scripts.sync_asset_versions --check
   uv run python -m paperpilot.scripts.build_sitemap --check
   ```

   - 1 で学会ページを作った場合は、先に `--check` なしで両方を 1 回ずつ書き込みで実行し、そのあと `--check` で確かめる（作ったページで資産参照と sitemap が変わるため）。
   - そうでなければ、すぐ `--check`。revert が B の前の版と sitemap をバイト単位で戻し、どちらも戻したカタログに依存しません。0 以外なら別の何かがずれています。調べる。むやみに再実行しない。
6. 旧のリリース関門を手元で、旧 `pages-release.yml` と**同じ順・同じコマンド**で通す（`ruff`、`--extra unarxive`、「skip なし」の検査を含む。revert 後の `.github/workflows/pages-release.yml`（= `<mergeB>^1` の版）の 93–107 行）。失敗で自分のシェルが `exit 1` で落ちないよう、保存したスクリプトにせず 1 つずつ打つ。

   ```
   uv sync --frozen --extra dev --extra unarxive
   ```

   ```
   uv run --frozen --extra dev ruff check paperpilot/
   ```

   ```
   uv run --frozen --extra dev --extra unarxive pytest paperpilot/tests -q -rs 2>&1 | tee pytest-result.txt
   ```

   - `pytest-result.txt` の要約行を目で読む。`0 failed` で、`skipped`/`SKIPPED` の行がないこと。CI の検査は次で、何も見つからないことが条件です。

     ```
     grep -Eq '(^| )[0-9]+ skipped(,| in|$)|^SKIPPED ' pytest-result.txt
     ```

   - （要確認）`--extra unarxive` で既知の skip が 1 つ（duckdb）消えます。もう 1 つ、Linux 専用のテスト（`test_slide_pdf_isolation.py::test_isolated_visibility_gate_has_exact_parity_with_core`、`skipif(not sys.platform.startswith("linux"))`）は Linux 以外の手元で skip になります。報告された skip がそれ**だけ**かを確かめてから、手元の「0 failed」を CI と同等とみなす。最終的には Linux（または Docker の runner）で本物の関門を通す。

   ```
   bash .github/scripts/validate-pages-release.sh local "$(git rev-parse HEAD)" docs
   ```

   - sha を書き込まず `"$(git rev-parse HEAD)"` を使います。下のデータだけの commit の後は HEAD が動き、古い sha だと `validate-pages-release.sh` が `checkout SHA … != …` で拒否するためです。
   - この 3 つを**2 回**通す。1 回目はデータだけの commit の前（HEAD は 4c の finish-revert の commit）。2 回目はその commit の直後（HEAD はその新しい commit）。両方通ってから push する。
   - `viewer/test_search_viewer.py::test_search_frozen_evaluation` が失敗したら: 戻したカタログが `docs/search-index-v2.json` の元を変えた場合は想定どおりです（promote と同じ、frozen fixture と正当な更新の問題。A1、R9）。この fixture の生成スクリプトはありません。`paperpilot/tests/viewer/evaluate_search_frozen.mjs` が見ている内容に合わせて、`paperpilot/tests/fixtures/search-v2/frozen-eval-v1.json` の `frozen_corpus` の 3 項目を、作り直した `docs/search-index-v2.json` に合わせて手で直す。
     - `index_sha256`: `shasum -a 256 docs/search-index-v2.json`（Linux では `sha256sum`）
     - `index_bytes`: `wc -c < docs/search-index-v2.json`
     - `row_count`: `jq 'length' docs/search-index-v2.json`
     - そのあと関門を再実行する。`queries` は触らない（index ファイルから決まるのは `frozen_corpus` だけ）。

**1–6 の結果を、6 の frozen fixture の修正も含めて**、revert とは別の**データだけの commit 1 つ**にします（fixture の修正を抜くと、push 後に `pages.yml` の frozen eval で落ちる）。commit 後の 2 回目の関門が通って初めて、次の手順 5 で旧サイトが「B の前の tree + `<mergeB>` の後の全変更」と一致します。

5. ☐ push する。`docs/**` が変わると、戻った Python の `pages.yml` が動き、旧サイトを GitHub Pages に出し直します。手順 10 を実行済みなら、転送ページは上書きされます。
   - 戻った旧 workflow（`theme-on-demand.yml` など）は、切替の手順 7 で enable したままです。旧の流れで動いてよいかを確かめてから `accepting=true` に戻す（要確認）。
6. ☐ 許可リストから `https://paperpilot.pages.dev` を外す。
7. apps/api の Worker はそのまま残す。revert でルートの `wrangler.jsonc` と `worker/` が戻りますが、Workers Builds の root directory は `apps/api` のままなので、出し直されるのは apps/api です。Durable Object のカウンタは何もしなくてよい。☐ Cloudflare Pages のプロジェクトは使わずに置くか、本番デプロイを消す。

### ↩ Worker（`<mergeB>` の後）

`<mergeB>` の後の develop には `worker/` も `wrangler.legacy-rollback.jsonc` もありません。

1. ☐ すぐに `accepting=false` にする（60 秒以上待つ）。✔ `/api/health` が `accepting:false` を返す。
2. 原則は「apps/api を直して前に進める」。修正を develop に入れれば、Workers Builds が apps/api を出し直す。
3. 急ぐときは apps/api の以前の版に戻す。戻せるのは Durable Object の migration（v1）の後に出した版だけ（Cloudflare の制約）。

   ```
   pnpm --filter @paperpilot/api exec wrangler rollback <version-id>
   ```

4. 旧 Worker（`origin/feat/ts-migration` の `worker/`）は、**そのままでは代わりになりません**（2026-10-08 にコードで確認）。
   - CORS の許可は `https://taichiiiiiiii.github.io` だけで、コードに直書き（`worker/response.js` の `PAGES_ORIGIN`）。KV の `origin_allowlist` も読まない。新サイトのフォームは preflight で失敗する。
   - 重複確認で `develop/docs/themes/themes-manifest.json` を読む（`worker/themes-post.js`）。データ移動の後はこのファイルが無く 404 になり、すべての依頼が 503 になる。
   - KV の `accepting` を読まず、`/api/health` も無い。止めるには再デプロイするか、secret `GH_DISPATCH_PAT` を消すしかない。
   - dispatch の入力（`theme`、`request_id`）と `ref` は新しい `theme-on-demand.yml` と合っている。応答の形も新しいフォームが読める。KV のキーは apps/api とぶつからない。

   **決定（2026-10-08、ユーザー「推奨で進めて」）: 旧 Worker の予備は用意しない。** 切替後の戻し方は、受付停止（`accepting=false`）、apps/api の以前の版への `wrangler rollback`、修正版を develop に入れて出し直す、の 3 つ。apps/api は切替の前に Phase W で本番に出して確かめてある。旧 Worker が要るほどの事態になったら、上の 3 点を直してから出す（その場合も手順 5 で先にビルドを止める）。
5. 旧 Worker を出し直す場合は、**先に** Workers Builds を止める。止めないと、次の develop への push で apps/api に上書きされる。
   - ☐ いまのビルド設定（リポジトリ、production branch、root directory `apps/api`、build・deploy command、build watch paths、build variables の `NODE_VERSION` など）をすべて控える。
   - ☐ Dashboard → Workers & Pages → `paperpilot-themes` → Settings → Builds → **Disconnect**。切断中は push してもビルドもデプロイも起きない。
   - そのあと、用意した旧 Worker を `wrangler deploy -c wrangler.legacy-rollback.jsonc` で出す（DO の stub クラスと migration v1 を保つため、`wrangler rollback` ではなく `deploy`）。
   - ↩ 元に戻すときは Settings → Builds → **Connect** でつなぎ直し、控えた設定を入れ直す（切断で設定が残るかは公式に書かれていないので、入れ直す前提）。つないだ後の最初の develop への push か手動ビルドで、apps/api が出し直される。
   - 使わないもの: deploy command を `npx wrangler versions upload` に変える方法（DO の migration を含む版はアップロードできず失敗しうる）、Branch control の変更や Build watch paths（完全には止まらない）。
   - 出典: https://developers.cloudflare.com/workers/ci-cd/builds/#disconnecting-builds 、https://developers.cloudflare.com/workers/configuration/versions-and-deployments/rollbacks/

---

## revert で戻らないもの

次のものは revert では戻りません。

| 戻らないもの | 戻し方の場所 |
|---|---|
| Workers Builds の設定（root directory、`NODE_VERSION`、preview builds、Disconnect） | ↩ W 手順 4、↩ Worker（`<mergeB>` の後）手順 5 |
| KV の値 | 6.1 の表、R-B 手順 1・6 |
| DO の保存内容 | R-B 手順 7（何もしない） |
| Worker の版（`wrangler rollback` と旧 Worker の出し直し） | ↩ W、↩ Worker（`<mergeB>` の後） |
| Cloudflare Pages のデプロイ | P2 の ↩、R-B 手順 7、観察の `pages-rollback.yml` |
| GitHub Deployment の記録 | §6.2 に個別の手順なし（要確認） |
| GitHub Pages の中身（転送ページ） | R-B 手順 5（旧 `pages.yml` が上書き） |
| workflow の有効・無効 | 切替 手順 2・7 |

---

## 実施記録

| 日時（JST） | 段階 | 結果 |
|---|---|---|
| 2026-10-09 | P3 Merge A | PR #435 を merge commit `3287edf` で取り込み。Python `tests`・GitHub Pages の公開 5 段とも成功。旧 Worker は `exists` を返した |
| 2026-10-09 | W1 | KV の 3 キーを書き込み、`--remote` で読み戻して一致 |
| 2026-10-09 | W2 | apps/api（80.7 KiB）と旧 Worker の戻し設定（20.2 KiB）の dry-run が通った |
| 2026-10-09 | W3（代替） | ダッシュボードがボット確認で開けないため、`pnpm --filter @paperpilot/api exec wrangler deploy` で直接出した（版 `43e31d5f-b77b-400b-9330-4e513f7707c1`）。Workers Builds の root directory は `/` のまま（☐ ユーザー作業で `apps/api` に変える） |
| 2026-10-09 | W4 | `/api/health`・CORS（ACAO 完全一致と `Vary: Origin`）・知らない origin の 403・既存テーマの `exists` がすべて合格 |
| 2026-10-09 | W5 | 失敗。GitHub への dispatch が `401 Bad credentials`（`GH_DISPATCH_PAT` の失効。最後の成功は 2026-06-27）。`accepting=false` にして受付を止めた（503 `paused`）。☐ PAT を作り直して `wrangler secret put GH_DISPATCH_PAT` |
| 2026-10-09 | P2 | `d7ace34` のビルドを `--branch=rehearsal` でプレビューに出した（https://rehearsal.paperpilot.pages.dev）。`validate smoke`（marker・byte 一致・404・転送）が合格。主要 6 ページの表示と meta CSP を確認 |
| 2026-10-09 | W3（設定） | computer use でダッシュボードを操作。Workers Builds の root directory を `/apps/api` に、変数 `NODE_VERSION=22` を追加。Build command は空、Deploy command は `npx wrangler deploy`、プレビューブランチのビルドは元からオフ。ビルドの再実行はしていない（develop の `apps/api` は今動いている `p5/consolidate` 版と `wrangler.jsonc` などが違い、再実行すると本番 Worker が差し替わるため）。次に develop へ push したときに新しい設定でビルドされる |
| 2026-10-09 | Pages 設定 | `paperpilot` の `production_branch` が `production` であることを API で確認。workflow の値と一致 |
| 2026-10-09 | トークン | Cloudflare API トークン（Account: Cloudflare Pages Edit、対象はこのアカウントだけ）を作り、GitHub environment `cloudflare-pages-deploy` に `CLOUDFLARE_API_TOKEN` として登録（`/user/tokens/verify` が active、Pages プロジェクトの読み出しが 200）。GitHub fine-grained PAT（対象 `automatic-paper-search` のみ、Actions: Read and write、90 日、2027-01-07 失効）を作り、`wrangler secret put GH_DISPATCH_PAT` で登録。値はクリップボード経由で渡し、表示していない |
| 2026-10-09 | W5（再） | `accepting=true` に戻し、`/api/health` で反映を確認。旧サイト（`taichiiiiiiii.github.io`）の系譜ページはフォームが品質監査の表示で隠れているため、同じページ上からフォームと同じ POST（`{"theme":"Graph Neural Network"}`）を送った。`200 queued`（slug `graph-neural-network`、request_id `theme-2b40c196-91bd-435d-ae83-9c36cdf14a01`） |
| 2026-10-09 | W5（結果） | Worker → GitHub の dispatch は成功（run `37937991976`、`generate` 成功）。`promote` が失敗し、何も公開されていない（develop は `3287edf` のまま）。原因は `paperpilot/tests/viewer/test_lineage_core.mjs` の「theme の行がちょうど 3 件」という検査（`b890bf7`、2026-09-05 から）。新しいテーマが増えると必ず落ちるため、9 月以降は on-demand のテーマ生成が公開まで進めない。Merge A や今回の作業による退行ではない。無駄な Actions を避けるため `accepting=false` に戻した。☐ 方針の判断待ち |
| 2026-10-09 | 切替の準備 3a | develop に B 以降のデータ commit が無いことを確かめ、`origin/develop` を merge（`c75d6b4`）。衝突は `docs/design/39-…md` だけで `--ours`。`p5/consolidate..origin/develop` は 0 |
| 2026-10-09 | 切替の準備 4 | merge 後の HEAD で biome・typecheck・build・`validate bundle`・`verify 0d85e50 83a7551` が 0、0 件の確認 3 つも 0。test は core 1850・api 210・web 891・pipeline 2646 が通過（全体実行で負荷による timeout が web 1 件・pipeline 3 件出たが、単独の再実行で通過）。`/code-review` の代わりにサブエージェント 2 体でレビューし、次を直した: ① `apps/web/test/lineage/core.test.ts` の theme 3 件・conference 10 件の完全一致を「以上」に（同じ検査が W5 の promote を止めた。新サイトでも on-demand が必ず落ちていた）② `pages-release.yml` の `admit` で develop 以外の ref を失敗させる（呼び出し元が develop に promote 済みのまま deploy が緑でスキップされていた。deploy の develop 条件は契約テストどおり残す）③ `collect-daily-watch.yml` の checkout を `ref: develop` に固定。KV の `origin_allowlist` に新 origin が無い点は切替手順 4 で足す（予定どおり） |
| 2026-10-09 | 切替 1〜4 | `accepting=false` を確認、5 本の workflow を disable、実行中・待ちが 0。B が古くないことを再確認（データ commit なし、behind 0）。KV `origin_allowlist` を `["https://taichiiiiiiii.github.io","https://paperpilot.pages.dev"]` にした |
| 2026-10-09 | 切替 5（Merge B + C） | PR #436 を merge commit で取り込み（`<mergeB>` = `1a52f41`）。`tests`・`data-audit` は緑。`pages` は deploy で失敗: 呼び出し側に `secrets: inherit` が無く、reusable workflow の job に environment の秘密が空で渡っていた。5 本の呼び出し側に足して `b5557d0` で develop に入れ、`pages` が validate〜record まで緑（`cloudflare-pages-production` に `cf_deployment_id` 付きの記録）。Workers Builds は merge 直後に `apps/api` を出し直した |
| 2026-10-09 | 切替 6 | sitemap の 12 URL がすべて 200、`/__missing__/` が 404、`/iclr-2026/lineage.html?x=1` が `/iclr-2026/lineage/?x=1` へ 301、CSP ヘッダは `frame-ancestors 'self'` だけで全ページに meta CSP、ブラウザで CSP 違反なし、新 origin の preflight で ACAO。新サイトのテーマ投稿フォームは、公開できる系譜が 0 件のあいだは出ない作り（旧サイトと同じ）なので、停止中の表示は確認できない |
| 2026-10-09 | 切替 7〜9 | workflow を enable、`accepting=true`。新サイトのページ上から POST した 1 件目（run `37947503311`）は promote で失敗: `buildLineageQuality.parity.test.ts` が `as_of` を `2026-08-30` に固定していて、promote が現在時刻で作り直すと必ず落ちる。commit 済みファイル自身の `as_of` を読むように直し（`c849d09`）、promote の拒否メッセージに未追跡ファイル名を出すようにした（`843efa3`）。手元で失敗 run の candidate を使って promote を再現し、全テストが通ることを確認（最後の未追跡ファイルは macOS の NFD/NFC の差で、Linux では起きない）。2 件目（run `37949729347`）が generate → promote → release（deploy・smoke・record）まで緑。`edc1b81` で `graph-neural-network` が manifest に入り、Cloudflare に出た（品質監査前なので画面には出ない） |
| 2026-10-09 | 切替 10 | `legacy-redirects.yml` を dispatch（run `37951053999`、緑）。旧 URL（`/`、`?q=`、`?theme=`、`#…`、存在しないページ）がすべて `https://paperpilot.pages.dev` の同じパスに着地。☐ Search Console への sitemap 登録はユーザー作業 |

