---
name: run-verification
description: PaperPilot の全検証を一括実行（Biome + typecheck + web build + Vitest 全テスト + bundle 検証 + venue 検出率 + データ監査、任意でスモーク）。ユーザーが「テスト流して」「動作確認して」「検証して」「PR を出す前にチェック」と言った時に起動する。
---

# run-verification — PaperPilot 検証ループスキル

コードは TypeScript だけ（Node 22+、pnpm 10.34.6）。Python・uv・Docker の検証はもう無い。

## いつ使うか

- 「テストを全部流して」「CI 相当のチェック」
- 「PR 前の検証」
- 「スコア計算が合っているか確かめて」
- 「merge できる状態か確かめて」（このブランチ `p5/consolidate` は P5 切替手順が終わるまで `develop` に merge しない）

## 準備

```bash
node --version          # 22 以上。20 なら npx --yes -p node@22 node -e 'console.log(process.execPath)' の Node を PATH の先頭に
pnpm --version          # 10.34.6。無ければ npx --yes pnpm@10.34.6
pnpm install --frozen-lockfile
```

## 検証の段

| 段 | 目的 | コマンド |
|---|---|---|
| L1. lint | 書式と静的検査（error は 0） | `pnpm exec biome check .` |
| L2. 型 | 全パッケージの型検査 | `pnpm -r typecheck` |
| L3. web build | 静的書き出し（web の契約テストが使う） | `pnpm --filter @paperpilot/web build` |
| L4. 全テスト | core・api・web・pipeline の Vitest | `pnpm -r test` |
| L5. bundle | 公開物の形の検査 | `pnpm exec tsx apps/pipeline/src/release/cli.ts validate bundle apps/web/out` |
| L6. venue 検出率 | 95% 以上（§9 Table 21） | `pnpm --filter @paperpilot/pipeline exec vitest run test/collect/signals/venue.test.ts` |
| L7. データ監査 | CI の `data-audit` と同じ | 下の Step 4 |
| L8. スモーク（任意） | 本物の arXiv で小さく実行 | 下の Step 5 |

## 手順

### Step 1: lint と型（必須）

```bash
pnpm exec biome check .
pnpm -r typecheck
```

### Step 2: web build → 全テスト（必須）

build を先にする。`apps/web` の契約テスト（CSP・paper-links・lineage の経路・sitemap・redirects・copy-data）は `apps/web/out` を読み、無いと skip になる。

```bash
pnpm --filter @paperpilot/web build
pnpm -r test > "$TMPDIR/pp-test.log" 2>&1; echo "exit=$?"
grep -E 'Test Files|Tests ' "$TMPDIR/pp-test.log"
```

- `head` で切らない（パッケージごとの集計が消える）。全体で 1〜1.5 分ほど。
- 件数の目安（`feat/ts-migration` 時点）: core 1,845、api 214、web 887、pipeline 2,633。このブランチでは変わり得るので、実行結果の数字を報告する。
- **合格:** 全部 pass、skip 0。skip があれば理由を報告する（リリースでは `no-skip-gate` が失敗にする）。

### Step 3: bundle と venue 検出率

```bash
pnpm exec tsx apps/pipeline/src/release/cli.ts validate bundle apps/web/out
pnpm --filter @paperpilot/pipeline exec vitest run test/collect/signals/venue.test.ts
```

`test_detection_rate_above_95_percent` が通ること。

### Step 4: データ監査（公開データ・家系図を触ったとき）

```bash
pnpm exec tsx apps/pipeline/src/lineage/theme/auditThemeSeedsCli.ts
pnpm exec tsx apps/pipeline/src/lineage/quality/auditLineageQualityCli.ts
pnpm exec tsx apps/pipeline/src/release/derived/searchIndexCli.ts --check
```

### Step 5: 収集のスモーク（任意。本物の arXiv に出る）

ネットに出るので、ユーザーが頼んだときだけ回す。出力は一時ディレクトリに置き、`data/` には書かない。

```bash
SMOKE="$TMPDIR/pp_smoke"; rm -rf "$SMOKE"; mkdir -p "$SMOKE"
cat > "$SMOKE/smoke.yaml" <<EOF
search:
  keywords: [retrieval augmented generation]
  categories: [cs.CL]
  days_back: 3
  max_results_per_keyword: 5
  exclude_words: []
sources:
  arxiv: { enabled: true, delay_seconds: 3 }
signals:
  venue: { enabled: true }
weights:
  venue: 3.0
  keyword: 0.5
pipeline:
  stage2_top_n: 3
  stage4_top_n: 3
llm:
  enabled: false
output:
  csv:  { enabled: true, dir: $SMOKE }
  json: { enabled: true, dir: $SMOKE }
incremental:
  enabled: false
  seen_ids_file: $SMOKE/seen.json
EOF
pnpm exec tsx apps/pipeline/src/collect/cli.ts --config "$SMOKE/smoke.yaml"
```

確かめること:
- `$SMOKE/papers_YYYY-MM-DD.{csv,json}` ができる
- JSON の `llm_relevance` が `null`（Stage 4 無効）
- エラーが無い（設定キーが足りないと言われたら `collect/config/types.ts` を見て足す）

### Step 6: 設定と文書の整合

- `data/config/config.yaml` のキーを `collect/config/types.ts` と `collect/runner.ts` が扱っているか
- 新しい環境変数が `data/config/.env.example` と `collect/config/env.ts` にあるか
- CLAUDE.md・README・設計書 39 の記述が実物と合っているか

### Step 7: git の状態

```bash
git status --short
git ls-files '*.py'                # 何も出ないこと（tests.yml と同じ検査）
git diff --check
```

- `.env` が出ていないこと
- `data/` の変更は意図したものだけ（builder を回して出た差分を混ぜない）
- `apps/web/out`・`node_modules` は git 管理外

## 合格条件

- [ ] L1: Biome の error 0
- [ ] L2: typecheck 通過
- [ ] L3: web build 成功
- [ ] L4: 全テスト pass、skip 0
- [ ] L5: bundle 検証 pass
- [ ] L6: venue 検出率 95% 以上
- [ ] L7: データ監査 exit 0（触った場合）
- [ ] `.env` が `git status` に出ていない
- [ ] commit・push・merge はユーザーの承認の後（`develop` / `main` に直接 push しない）

## 失敗したとき

| 症状 | 目星 | 対処 |
|---|---|---|
| 新しいテストが落ちる | まだ RED | `add-plugin` の Step 1〜2 に戻る |
| web のテストが skip | build していない | Step 2 の順で回す |
| `Unsupported engine` / 構文エラー | Node が 22 未満 | Node 22 を PATH の先頭に |
| venue 検出率が 95% 未満 | 正規表現が壊れた | `collect/signals/venue.ts` を直前の commit と比べる |
| スモークで 0 件 | 該当なし、または期間が短い | `days_back` を 14 に広げる |
| テストが本物の API に出る | `fetchImpl` の注入漏れ | テストとコードの両方を直す |
| bundle 検証が落ちる | 公開物の必須ファイル・形の崩れ | `release/validateRelease.ts` のメッセージを読む |

## 時間の目安

- 全テスト: 1〜1.5 分（2026-10 の実測）

これより明らかに遅いときは、どこかで本物の `fetch` や実時間の sleep が混ざっている可能性がある。
