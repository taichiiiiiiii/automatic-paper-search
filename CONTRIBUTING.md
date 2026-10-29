# Contributing / 貢献のしかた

PaperPilot は個人が運営する、非営利のサイトです（[`NOTICE.md`](NOTICE.md)）。Issue と Pull Request を歓迎します。

## Issue

- **系譜の誤り**（関係の種類・根拠の誤り）: 系譜ページの「誤りを報告」から開くと、必要な欄が自動で入ります。
- **バグ・提案**: Issue のテンプレートを選んでください。
- **脆弱性、削除・訂正の依頼、個人情報**: 公開の Issue ではなく、[`SECURITY.md`](SECURITY.md) の非公開の窓口へ。

## Pull Request

1. 先に Issue を立て（または既存の Issue を選び）、`<種類>/<Issue番号>-<内容>` のブランチを切ります（例: `fix/123-wrong-relation`）。
2. コミットのメッセージは `fix(scope): …` / `feat(scope): …` の形にし、`Refs #123` を付けます。
3. Pull Request の本文に `Fixes #123` と、変更の内容・確認した数字を書きます。
4. 手元で次を通してください。`pnpm install` のあと、
   - `pnpm exec biome check .`（整形と lint）
   - `pnpm -r typecheck`
   - `pnpm -r test`（`apps/pipeline` はほかに `pnpm --filter @paperpilot/pipeline test:system`）
5. CI（`tests`）が通ってから、マージします。

Node 22 と pnpm 10 が要ります（`package.json` の `packageManager` を参照）。

## データについて

- `data/` の内容は、定期実行と、サイトのフォームからの依頼で **GitHub Actions が自動で更新**します。手でデータのファイルを編集した Pull Request は受け付けません（再生成で上書きされ、監査の hash も合わなくなります）。直したいときは、生成のコード（`apps/pipeline`）を直してください。
- 系譜の関係の判定は、LLM を使わず、API の情報（引用文・意図など）から規則で行います。規則を変えるときは、`apps/pipeline/test/lineage/theme/` の正解付きの例（`relationR242.test.ts` など）に、誤りの文を足して確かめます。
- データの出典とライセンスは [`NOTICE.md`](NOTICE.md) と [`data/README.md`](data/README.md) にあります。

## 書いてはいけないもの

秘密（API キー・トークン）、個人のメールアドレス、作業場所のパス、個人情報。Issue・Pull Request・コミット・文書のどれにも書かないでください。
