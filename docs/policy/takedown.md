# 削除・訂正の依頼を受ける手順

決定：design 51 §8 の D2＝A（2026-10-11、ユーザー決定）。非公開の窓口は当面
GitHub の非公開の脆弱性報告（Security advisories）を使う。独自ドメインを
用意したら、メール（Cloudflare Email Routing）に移す（design 40 §5 と連動）。

## 窓口

| 種類 | 窓口 | 公開されるか |
|---|---|---|
| 削除・訂正の依頼（権利者・ご本人）、個人情報、プライバシー、脆弱性 | [非公開の報告（Report a vulnerability）](https://github.com/taichiiiiiiii/automatic-paper-search/security/advisories/new) | されない（運営者だけが読める） |
| 系譜の誤り・リンク切れなど、公開してよい報告 | [GitHub Issue](https://github.com/taichiiiiiiii/automatic-paper-search/issues) | される |

- サイトでは、フッターの「削除依頼」と「仕組み」の #privacy 節から非公開の報告へリンクしている。
- 公開の Issue に個人情報や削除依頼が書かれたら、運営者は Issue の本文を
  隠すか削除し（GitHub の「Hide」/「Delete」）、非公開の報告で出し直すよう案内する。

## 手順

1. **受付**（受け取った日を記録）。非公開の報告に返信し、受け付けたことを伝える。
   内容が足りなければ、対象（URL・論文）と、ご本人・権利者であることの説明を頼む。
2. **一時非表示**（**受付から 3 営業日以内**）。権利者・ご本人からの依頼は、判断の前に表示を止める。
   - 学会カタログの要旨：元データ `data/inputs/<学会>/` の該当行の要旨を空にし、
     `pnpm exec tsx apps/pipeline/src/catalog/buildPagesCli.ts` と
     `pnpm exec tsx apps/pipeline/src/release/derived/searchIndexCli.ts` で
     `data/published/<学会>/papers.json` と要旨の shard（`data/published/paper-details-v1/`）を作り直す
     （README「学会カタログを作る・更新する」）。`data/published` だけを手で直すと、次の作り直しで戻るので不可。
     develop に入れると CI の `pages` がサイトを作り直す。
   - 系譜の引用文・要旨：該当テーマの成果物（`data/published/themes/<slug>/`）から
     該当 edge の excerpt を消すか、テーマを `theme_min_generated_at` で一時的に非表示にする
     （design 41 R2-25 の手順）。
   - 著者名：該当の行から著者名を除く。
   - 個人情報を含むテーマ名：公開リポジトリの Actions の実行（workflow_dispatch の入力）を
     `gh run delete <id>` で消し、テーマの成果物があれば削除する。
   - 抑止リスト（`suppressions.json`、design 51 C4）はまだ無い。できるまでは上の手作業で行う。
3. **判断**。design 51 §2〜§4（ライセンスと引用の要件）に照らして、
   「非表示を続ける」「訂正して戻す」「表示を続ける（理由を説明）」のどれかを決め、依頼者に返信する。
   CC0・CC BY のデータでも、ご本人・権利者からの依頼は原則として非表示を続ける。
4. **記録**。下の表に 1 行足す（依頼者の氏名・連絡先は書かない。公開リポジトリのため）。
   非公開の報告そのものは閉じる（Close）。advisory は公開（Publish）しない。
5. **上流への案内**（必要なら）。誤りの元が Semantic Scholar・OpenAlex などにある場合は、
   各サービスの訂正窓口を依頼者に案内する。

## 記録

| 受付日 | 対象（URL・論文） | 種類 | 一時非表示 | 判断と日付 |
|---|---|---|---|---|
| （まだない） | | | | |
