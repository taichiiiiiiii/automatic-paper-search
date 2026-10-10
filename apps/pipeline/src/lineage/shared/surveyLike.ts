/**
 * Survey / review detection shared by every lineage consumer (R2-15).
 *
 * A survey or review only organises the works it cites: it never extends,
 * succeeds, supersedes or contrasts them. Detection used to be title-only
 * and spread over three regexes (relation guard, S2 rule set, seed
 * ranking), so a review whose title has no survey word — "Graph neural
 * networks for materials science and chemistry" (Communications
 * Materials 2022, abstract: "In this Review, we provide an overview …")
 * — slipped through and was published as the citing side of four
 * `extends` edges. This module is the one place that decides; it looks at
 *
 *  1. the publication type, when the source gave one (OpenAlex Work
 *     `type: "review"`, carried on the paper as `publicationType`;
 *     Semantic Scholar `publicationTypes: ["Review", …]`);
 *  2. the title (survey/review/overview/tutorial/primer/…, plus the
 *     phrases "a comprehensive", "recent advances", "challenges and
 *     opportunities", "state of the art" in a survey position);
 *  3. the abstract / short abstract / TL;DR ("we review", "in this
 *     survey", "we provide an overview", "comprehensive overview", …);
 *  4. (R2-16) the venue, for venues that publish only surveys / reviews /
 *     tutorial overviews (ACM Computing Surveys, IEEE Communications
 *     Surveys & Tutorials, IEEE Signal Processing Magazine, Foundations
 *     and Trends, Annual Review of …, Nature Reviews …). The second review
 *     found "Geometric Deep Learning: Going beyond Euclidean data" (IEEE
 *     SPM) as the citing side of an `extends` edge.
 *
 * Whole words only, so "reviewer", "surveillance" or "review-based
 * recommendation" do not match.
 */

export interface SurveyPaperLike {
  title?: unknown;
  abstract?: unknown;
  short_abstract?: unknown;
  tldr?: unknown;
  /** OpenAlex Work `type` ("article", "review", "preprint", …). */
  publicationType?: unknown;
  /** OpenAlex raw field name, when a raw Work-shaped dict is passed. */
  type?: unknown;
  /** Semantic Scholar `publicationTypes` ("Review", "JournalArticle", …). */
  publicationTypes?: unknown;
  /** Venue / journal name (theme node `venue`). */
  venue?: unknown;
}

/** Venues whose articles are surveys / reviews / tutorial overviews. */
const REVIEW_VENUE_RE =
  /\b(?:computing\s+surveys|surveys\s+(?:and|&)\s+tutorials|signal\s+processing\s+magazine|foundations\s+and\s+trends|annual\s+reviews?\s+of|nature\s+reviews|physics\s+reports|artificial\s+intelligence\s+review)\b/i;

/** The venue only publishes surveys / reviews / tutorial overviews. */
export function isReviewVenue(paper: SurveyPaperLike): boolean {
  const v = paper.venue;
  return typeof v === "string" && REVIEW_VENUE_RE.test(v.normalize("NFKC"));
}

/** Survey words anywhere in the title (whole words). `review` must not be
 * followed by a hyphen ("Review-based Recommendation"); `perspective`
 * only as "Perspective(s) on/of …" or after a colon, so "Multi-perspective
 * Matching" is not a survey. */
const TITLE_WORD_RE =
  /\b(?:surveys?|reviews?(?!-)|overview|tutorial|primer|literature\s+review|systematic\s+review|introduction\s+to|perspectives?\s+(?:on|of|for)\b)\b/i;

/** Survey phrases in the title. */
const TITLE_PHRASE_RE =
  /\b(?:a\s+comprehensive\b|recent\s+(?:advances|progress|developments|trends)\b|challenges\s+and\s+opportunities\b|opportunities\s+and\s+challenges\b|state[\s-]of[\s-]the[\s-]art\s+(?:and|in|on|of|review|survey)\b)/i;

/** Position-anchored forms kept from the seed-ranking regex
 * (`discoverSeeds.ts`, #209): "A Survey …", "Roadmap for …",
 * "Foo: A Perspective", "X: the state of the art". */
const TITLE_ANCHORED_RE =
  /^(?:an?\s+)?(?:comprehensive\s+|brief\s+|short\s+|recent\s+)?(?:survey|review|tutorial|overview|perspective|roadmap|primer)\b(?!-)|:\s*(?:an?\s+|the\s+)?(?:survey|review|tutorial|overview|perspective|roadmap|primer|state[\s-]of[\s-]the[\s-]art)\b/i;

/** First-person / self-referential survey statements in an abstract.
 * "we review" excludes the related-work aside of a method paper ("we
 * briefly review …", "we review related work"). */
const ABSTRACT_RES: readonly RegExp[] = [
  /\bwe\s+(?:comprehensively\s+|systematically\s+|critically\s+|extensively\s+)?review\b(?!\s+(?:the\s+)?(?:related|background|prior\s+work\s+in))/i,
  /\b(?:in\s+)?this\s+(?:review|survey|tutorial|overview)\b/i,
  /\b(?:in\s+)?this\s+(?:article|paper|work|chapter)\s+(?:we\s+)?(?:reviews?|surveys?)\b/i,
  /\bwe\s+(?:comprehensively\s+|systematically\s+)?survey\b/i,
  /\bwe\s+(?:provide|present|give|offer)\s+(?:an?\s+|the\s+)?(?:(?:comprehensive|systematic|thorough|brief|broad|detailed|extensive|up-to-date|concise)\s+)*(?:overview|survey|review)\b/i,
  /\bcomprehensive\s+(?:overview|survey|review)\b/i,
  /\bwe\s+summari[sz]e\s+(?:the\s+)?recent\b/i,
];

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** Publication-type metadata says "review" (OpenAlex or S2). */
export function hasReviewPublicationType(paper: SurveyPaperLike): boolean {
  for (const t of [paper.publicationType, paper.type]) {
    if (typeof t === "string" && t.trim().toLowerCase() === "review") return true;
  }
  const s2 = paper.publicationTypes;
  if (Array.isArray(s2)) {
    return s2.some((t) => typeof t === "string" && t.trim().toLowerCase() === "review");
  }
  return false;
}

/** Title-only survey test (for callers that only have a title, e.g. the
 * S2 rule set's `citingTitle`). */
export function isSurveyLikeTitle(title: unknown): boolean {
  if (typeof title !== "string" || !title.trim()) return false;
  const t = title.normalize("NFKC");
  return TITLE_WORD_RE.test(t) || TITLE_PHRASE_RE.test(t) || TITLE_ANCHORED_RE.test(t);
}

/** Abstract / short abstract / TL;DR survey test. */
export function isSurveyLikeAbstract(paper: SurveyPaperLike): boolean {
  const text = [str(paper.abstract), str(paper.short_abstract), str(paper.tldr)]
    .join(" ")
    .normalize("NFKC")
    .replace(/\s+/g, " ");
  if (!text.trim()) return false;
  return ABSTRACT_RES.some((re) => re.test(text));
}

/** True when `paper` is a survey / review / overview article. */
export function isSurveyLike(paper: SurveyPaperLike | null | undefined): boolean {
  if (!paper || typeof paper !== "object") return false;
  return (
    hasReviewPublicationType(paper) ||
    isSurveyLikeTitle(paper.title) ||
    isSurveyLikeAbstract(paper) ||
    isReviewVenue(paper)
  );
}
