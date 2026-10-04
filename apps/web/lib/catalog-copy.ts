/**
 * Per-conference display copy, ported verbatim from the current
 * docs/<conf>/index.html pages' hero/meta text (`<h1 class="hero__title">`,
 * `hero__tagline`, `hero__lede`, `name="description"`, the footer's
 * "Source: ..." line). None of this lives in conferences.json (that file
 * is numbers + top tags only), so it has to be its own static map here
 * rather than derived at build/runtime.
 *
 * `display` is always the title minus " <em>採択論文</em>" -- every
 * current page follows the same "<Display> 採択論文" heading pattern, so
 * the "採択論文" emphasis is applied once in the hero component instead
 * of being duplicated into this data.
 */

export interface CatalogCopy {
  display: string;
  description: string;
  tagline: string;
  lede: string;
  source: string;
}

export const CATALOG_COPY: Record<string, CatalogCopy> = {
  "aaai-2026": {
    display: "AAAI 2026",
    description:
      "AAAI 2026 採択論文のフィルタブル一覧。タイトル・著者・要旨での検索、トピックタグ、採択形式（Oral / Poster）、並び替えで絞り込めます。",
    tagline: "AAAI Conference on Artificial Intelligence。",
    lede: "arXiv 上で AAAI 2026 採択と明記された投稿を自動収集した一覧です。キーワード検索・トピックタグ・並び替えで気になる論文をすぐに見つけられます。",
    source: "arXiv · Auto-tagged · MIT License",
  },
  "acl-2025": {
    display: "ACL 2025",
    description:
      "ACL 2025 採択論文のフィルタブル一覧。タイトル・著者・要旨での検索、トピックタグ、採択形式（Oral / Poster）、並び替えで絞り込めます。",
    tagline: "Annual Meeting of the Association for Computational Linguistics。",
    lede: "ACL Anthology の本会議採択論文を全件収録した一覧です。キーワード検索・トピックタグ・並び替えで気になる論文をすぐに見つけられます。",
    source: "ACL Anthology · Auto-tagged · MIT License",
  },
  "cvpr-2025": {
    display: "CVPR 2025",
    description:
      "CVPR 2025 採択論文のフィルタブル一覧。タイトル・著者・要旨での検索、トピックタグ、採択形式（Oral / Poster）、並び替えで絞り込めます。",
    tagline: "IEEE/CVF Conference on Computer Vision and Pattern Recognition。",
    lede: "CVF Open Access の全採択論文を収録した一覧です。キーワード検索・トピックタグ・並び替えで気になる論文をすぐに見つけられます。",
    source: "CVF Open Access · Auto-tagged · MIT License",
  },
  "cvpr-2026": {
    display: "CVPR 2026",
    description:
      "CVPR 2026 採択論文のフィルタブル一覧。タイトル・著者・要旨での検索、トピックタグ、採択形式（Oral / Poster）、並び替えで絞り込めます。",
    tagline:
      "The IEEE/CVF Conference on Computer Vision and Pattern Recognition（コンピュータビジョン分野の最高峰会議）。",
    lede: "CVF Open Access の全採択論文を収録した一覧です。 キーワード検索・トピックタグ・並び替えで、気になる論文をすぐに見つけられます。",
    source: "CVF Open Access · Auto-tagged · MIT License",
  },
  "eccv-2024": {
    display: "ECCV 2024",
    description:
      "ECCV 2024 採択論文のフィルタブル一覧。タイトル・著者・要旨での検索、トピックタグ、採択形式（Oral / Poster）、並び替えで絞り込めます。",
    tagline: "European Conference on Computer Vision。",
    lede: "arXiv 上で ECCV 2024 採択と明記された投稿を自動収集した一覧です。キーワード検索・トピックタグ・並び替えで気になる論文をすぐに見つけられます。",
    source: "arXiv · Auto-tagged · MIT License",
  },
  "emnlp-2025": {
    display: "EMNLP 2025",
    description:
      "EMNLP 2025 採択論文のフィルタブル一覧。タイトル・著者・要旨での検索、トピックタグ、採択形式（Oral / Poster）、並び替えで絞り込めます。",
    tagline: "Conference on Empirical Methods in Natural Language Processing。",
    lede: "ACL Anthology の本会議採択論文を全件収録した一覧です。キーワード検索・トピックタグ・並び替えで気になる論文をすぐに見つけられます。",
    source: "ACL Anthology · Auto-tagged · MIT License",
  },
  "iccv-2025": {
    display: "ICCV 2025",
    description:
      "ICCV 2025 採択論文のフィルタブル一覧。タイトル・著者・要旨での検索、トピックタグ、採択形式（Oral / Poster）、並び替えで絞り込めます。",
    tagline: "International Conference on Computer Vision。",
    lede: "CVF Open Access の全採択論文を収録した一覧です。キーワード検索・トピックタグ・並び替えで気になる論文をすぐに見つけられます。",
    source: "CVF Open Access · Auto-tagged · MIT License",
  },
  "iclr-2026": {
    display: "ICLR 2026",
    description: "ICLR 2026 採択論文のフィルタブル一覧。Oral / Poster / トピック別に検索できます。",
    tagline:
      "The 14th International Conference on Learning Representations (Rio de Janeiro, April 23–27, 2026).",
    lede: "OpenReview の採択論文を全件収録し、Oral / Poster の採択区分つきで掲載しています。 タグ・採択形式・自由検索で絞り込めます。",
    source: "OpenReview · Auto-tagged · MIT License",
  },
  "icml-2025": {
    display: "ICML 2025",
    description:
      "ICML 2025 採択論文のフィルタブル一覧。タイトル・著者・要旨での検索、トピックタグ、採択形式（Oral / Spotlight / Poster）、並び替えで絞り込めます。",
    tagline: "International Conference on Machine Learning。",
    lede: "OpenReview の採択論文を全件収録し、Oral / Spotlight / Poster の採択区分つきで掲載しています。キーワード検索・トピックタグ・並び替えで気になる論文をすぐに見つけられます。",
    source: "OpenReview · Auto-tagged · MIT License",
  },
  "neurips-2025": {
    display: "NeurIPS 2025",
    description:
      "NeurIPS 2025 採択論文のフィルタブル一覧。タイトル・著者・要旨での検索、トピックタグ、採択形式（Oral / Spotlight / Poster）、並び替えで絞り込めます。",
    tagline: "Conference on Neural Information Processing Systems。",
    lede: "OpenReview の採択論文を全件収録し、Oral / Spotlight / Poster の採択区分つきで掲載しています。キーワード検索・トピックタグ・並び替えで気になる論文をすぐに見つけられます。",
    source: "OpenReview · Auto-tagged · MIT License",
  },
};

/** Falls back to a generic-but-honest copy set for any conference added
 * to conferences.json before this map is updated -- never silently
 * renders `undefined`. */
export function getCatalogCopy(slug: string): CatalogCopy {
  return (
    CATALOG_COPY[slug] ?? {
      display: slug,
      description: `${slug} 採択論文のフィルタブル一覧。タイトル・著者・要旨での検索、トピックタグ、採択形式、並び替えで絞り込めます。`,
      tagline: "",
      lede: "",
      source: "Auto-tagged · MIT License",
    }
  );
}
