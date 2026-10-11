# data/

このディレクトリのデータはコードの MIT ライセンスの対象ではありません。
**各レコードは、取得元のライセンスに従います。** 一覧と帰属表示の文面は
リポジトリ直下の [`NOTICE.md`](../NOTICE.md) にあります。

| パス | 中身 | 主な出典とライセンス |
|---|---|---|
| `published/<学会>/papers.json` | 学会カタログ（題名・著者・要旨・リンク）。各行の `source` が出典 | `arxiv`＝CC0、`openreview`＝CC0（メタデータ）、`acl_anthology`＝CC BY 4.0（帰属表示が必要）、`cvf`＝権利は著者に留保（要旨は R2-26 で除去予定） |
| `published/themes/`、`published/paper-details-v1/`、`published/lineage-*.json` | テーマ・学会の系譜、論文の詳細 | Semantic Scholar（ODC-BY 1.0）、OpenAlex（CC0）、arXiv（CC0） |
| `published/search-*`、`identity-aliases-v1.json`、`conferences.json` | 検索の索引、ID の対応表、学会一覧 | 上の各ソースから作った派生データ（各ソースのライセンスに従う） |
| `state/lineage-cache/` | Semantic Scholar API の応答のキャッシュと分類のキャッシュ | Semantic Scholar（ODC-BY 1.0） |
| `inputs/` | 収集した一覧（CSV・JSON・要約） | 取得元（arXiv・OpenReview・ACL Anthology・CVF など）に従う |
| `config/` | PaperPilot の設定（別名、除外リストなど） | コードと同じ MIT |

## Semantic Scholar のデータ（ODC-BY 1.0）

> This directory contains information from the Semantic Scholar Academic Graph
> and API, which is made available under the ODC Attribution License
> (ODC-BY 1.0): https://opendatacommons.org/licenses/by/1-0/
> Kinney et al., "The Semantic Scholar Open Data Platform", 2023
> (arXiv:2301.10140).

公開している JSON の schema（`schemas/*.schema.json`）は追加のフィールドを
許さないため、ライセンスの表示は JSON の中ではなく、このファイルと
`NOTICE.md` に置いています。

## 削除・訂正の依頼

要旨・引用文・著者名の非表示や訂正は、公開の Issue ではなく
[非公開の報告](https://github.com/taichiiiiiiii/automatic-paper-search/security/advisories/new)で受け付けます。手順は
[`docs/policy/takedown.md`](../docs/policy/takedown.md)。
