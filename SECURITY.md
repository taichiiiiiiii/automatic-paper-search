# Security policy and private contact / セキュリティと非公開の窓口

## Reporting privately / 非公開で報告する

Use GitHub's private vulnerability reporting:
**[Report a vulnerability](https://github.com/taichiiiiiiii/automatic-paper-search/security/advisories/new)**
(Security tab → "Report a vulnerability"). Only the maintainer can read the
report. Please do not open a public issue for the cases below.

GitHub の「Report a vulnerability」（非公開の報告）を使ってください。
内容は運営者だけが読めます。次の件は公開の Issue に書かないでください。

- Security vulnerabilities in the site, the API Worker or the workflows.
  サイト・API（Worker）・workflow の脆弱性。
- **Removal or correction requests** from rights holders or authors (an
  abstract, a citation sentence, an author name, a theme request that contains
  personal information). The procedure is in
  [`docs/policy/takedown.md`](docs/policy/takedown.md).
  権利者・ご本人からの**削除・訂正の依頼**（要旨、引用文、著者名、個人情報を
  含むテーマ名など）。手順は [`docs/policy/takedown.md`](docs/policy/takedown.md)。
- Privacy questions. プライバシーに関する問い合わせ。

A GitHub account is needed for now. An e-mail address will be added once the
site has its own domain.
いまは GitHub アカウントが必要です。独自ドメインを用意したら、メールの窓口を
追加します。

Ordinary data errors (a wrong relation, a broken link) can go to
[public issues](https://github.com/taichiiiiiiii/automatic-paper-search/issues).
系譜の誤りやリンク切れなど、公開してよい報告は Issue へどうぞ。

## What to include / 書いてほしいこと

- The page URL or paper (title / arXiv ID). 対象のページの URL か論文。
- For removal requests: how you are related (author, rights holder) and the
  reason. 削除依頼の場合：ご本人・権利者であることの説明と理由。
- For vulnerabilities: steps to reproduce and the impact. 脆弱性の場合：再現手順と影響。

## Response / 対応の目安

- Acknowledgement within 3 business days. 受付の連絡：3 営業日以内。
- Removal requests from rights holders or authors: the content is hidden
  temporarily within 3 business days of receipt, before a final decision.
  権利者・ご本人からの削除依頼：受付から 3 営業日以内に、判断の前でも一時的に非表示にします。

## Supported versions

Only the live site (https://paperpilot.pages.dev) and the `develop` branch are
maintained.
