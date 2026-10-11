# NOTICE

PaperPilot (https://paperpilot.pages.dev, this repository) is a free,
non-commercial site run by an individual. It is not an official service of,
and is not endorsed by, any of the data providers listed below.

**日本語の要約**: コード（`apps/`、`packages/`、`schemas/` ほか）は MIT
ライセンスです（[`LICENSE`](LICENSE)）。`data/` のデータは MIT の対象では
なく、**それぞれの出典のライセンスに従います**（下の表）。要旨・引用文の
著作権は各著者・出版者にあります。削除・訂正の依頼は
[`SECURITY.md`](SECURITY.md) の非公開の窓口へ。

## 1. Code

Everything except the data described in §2 is licensed under the MIT License
(see [`LICENSE`](LICENSE)), Copyright (c) 2026 Taichi Nakamura.

## 2. Data

The files under `data/` (and the JSON the site serves from them) are **not**
covered by the MIT License. Each record follows the license of the source it
came from. The bibliographic records, abstracts and citation sentences remain
the work of their authors and publishers; PaperPilot only selects, links and
annotates them. See [`data/README.md`](data/README.md) for which directory
holds what.

| Source | What PaperPilot uses | License / terms | Attribution |
|---|---|---|---|
| [Semantic Scholar](https://www.semanticscholar.org/) (Allen Institute for AI) | references, citation contexts (one sentence shown as evidence), citation intents, `isInfluential`, TLDRs, paper IDs, citation counts. Raw API responses are cached in `data/state/lineage-cache/` | [ODC-BY 1.0](https://opendatacommons.org/licenses/by/1-0/), under the [Semantic Scholar API License Agreement](https://www.semanticscholar.org/product/api/license) | See §2.1 |
| [OpenAlex](https://openalex.org/) (OurResearch) | seed search, IDs, bibliographic metadata, keywords, topics | [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/) | Not required; thank you to OpenAlex |
| [arXiv](https://arxiv.org/) | new submissions, titles, authors, abstracts, identifiers | Descriptive metadata (incl. abstracts) is [CC0 1.0](https://info.arxiv.org/help/license/index.html) per the [arXiv API Terms of Use](https://info.arxiv.org/help/api/tou.html). Paper PDFs/sources are not redistributed | "Thank you to arXiv for use of its open access interoperability." |
| [OpenReview](https://openreview.net/) (ICLR / ICML / NeurIPS catalogs) | titles, authors, abstracts, PDF links | Metadata (title, authors, abstract) dedicated to [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/) under the [OpenReview Terms of Use](https://openreview.net/legal/terms) | Not required; links point to OpenReview |
| [ACL Anthology](https://aclanthology.org/) (ACL / EMNLP catalogs) | titles, authors, abstracts, PDF links | Material from 2016 onward: [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) ([ACL Anthology copyright FAQ](https://aclanthology.org/faq/copyright/)) | Required: author(s), title, "ACL Anthology", CC BY 4.0. Abstracts are shown as published; the catalog may shorten them (marked with "…") |
| [CVF Open Access](https://openaccess.thecvf.com/) (CVPR / ICCV catalogs) | titles, authors, PDF links | No license granted: "Copyright and all rights therein are retained by authors or by other copyright holders." | Full CVF abstracts are being removed from the site and from new data files (roadmap item R2-26). Only titles, authors and links are meant to remain |
| [Crossref](https://www.crossref.org/) | not called today (DOI matching is a possible future use) | Metadata is free to use; some abstracts may be copyrighted ([REST API docs](https://www.crossref.org/documentation/retrieve-metadata/rest-api/)) | Not required |
| [DBLP](https://dblp.org/) | not called today (venue / author disambiguation is a possible future use) | [CC0 1.0](https://dblp.org/db/about/copyright.html) | Not required |
| [GitHub REST API](https://docs.github.com/rest) | repository star counts as a popularity signal | [GitHub Terms of Service](https://docs.github.com/site-policy/github-terms/github-terms-of-service) | — |
| [BAAI/bge-small-en-v1.5](https://huggingface.co/BAAI/bge-small-en-v1.5) via [Xenova/bge-small-en-v1.5](https://huggingface.co/Xenova/bge-small-en-v1.5) | embedding model for the theme topic gate (downloaded at run time, not stored in this repository) | [MIT](https://huggingface.co/BAAI/bge-small-en-v1.5) | — |
| [sentence-transformers/all-MiniLM-L6-v2](https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2) via Xenova | offline evaluation only (not stored in this repository) | [Apache-2.0](https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2) | — |

### 2.1 Semantic Scholar (ODC-BY 1.0)

> This project contains information from the Semantic Scholar Academic Graph
> and API, which is made available under the ODC Attribution License
> (ODC-BY 1.0): https://opendatacommons.org/licenses/by/1-0/

Please cite:

- Rodney Kinney et al. "The Semantic Scholar Open Data Platform." 2023.
  [arXiv:2301.10140](https://arxiv.org/abs/2301.10140)
- Arman Cohan, Waleed Ammar, Madeleine van Zuylen, Field Cady. "Structural
  Scaffolds for Citation Intent Classification in Scientific Publications."
  NAACL 2019 (citation intents).

Derived data that PaperPilot publishes from Semantic Scholar data (the lineage
JSON under `data/published/themes/`, `paper-details-v1/`, and the cached
responses under `data/state/lineage-cache/`) is redistributed under the same
ODC-BY 1.0 terms. The published JSON schemas (`schemas/*.schema.json`) do not
allow extra metadata fields, so the license notice lives in this file and in
`data/README.md` instead of inside each JSON document.

### 2.2 Citation sentences and abstracts

Evidence sentences are short quotations from the citing papers (one sentence,
up to about 300 characters, in quotation marks, with the source and a link).
Full texts and PDFs are never redistributed.

## 3. Removal and correction requests

Rights holders and authors can ask for an abstract, citation sentence or
author name to be hidden or corrected through the private channel described
in [`SECURITY.md`](SECURITY.md) ([open a private report](https://github.com/taichiiiiiiii/automatic-paper-search/security/advisories/new)). The
procedure is in [`docs/policy/takedown.md`](docs/policy/takedown.md).
