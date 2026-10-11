/**
 * R2-26 (design doc 51 §4, user decision D1=A): source links and abstract
 * attribution for one catalog row.
 *
 *  - The paper-page link is labelled with the row's real source (CVF Open
 *    Access / ACL Anthology / OpenReview / arXiv), never "arXiv" for a
 *    non-arXiv page; a matched arXiv version gets its own "arXiv" link.
 *  - Every shown abstract carries its source and licence; ACL Anthology
 *    abstracts (CC BY 4.0) also name the authors, the title, the licence
 *    and that the list view shortens them.
 *  - R3-3: PMLR abstracts (CC BY 4.0, rows keyed by their OpenReview
 *    forum) name the authors, the title and the PMLR volume, and the row
 *    gets a "PMLR" link to the paper's PMLR page (`abstract_url`).
 *  - A withheld abstract (`abstract_source: "none"`, a CVF abstract
 *    without a licensed replacement) is explained instead of shown.
 *
 * DOM-free so it is unit-tested directly (test/catalog/catalog-attribution.test.ts).
 */
import {
  ABSTRACT_LICENSE,
  ABSTRACT_SOURCE_LABEL,
  authorCredit,
  isAbstractSource,
  isCatalogSource,
  pmlrVolumeFromUrl,
  SOURCE_LABEL,
} from "@paperpilot/core/licensing";
import type { CatalogPaper } from "./catalog-core";

const ARXIV_ID_RE = /^\d{4}\.\d{4,5}(v\d+)?$/;

export interface CatalogLink {
  label: string;
  url: string;
}

/** Links shown under a catalog row, in display order. */
export function catalogLinks(paper: CatalogPaper): CatalogLink[] {
  const links: CatalogLink[] = [];
  const pageUrl = typeof paper.arxiv_url === "string" ? paper.arxiv_url : "";
  const pdfUrl = typeof paper.pdf_url === "string" ? paper.pdf_url : "";
  const source = isCatalogSource(paper.source) ? paper.source : null;
  if (pageUrl) {
    // Legacy rows without `source` were all arXiv-hosted only when the URL
    // says so; otherwise fall back to a neutral label.
    const label =
      source !== null
        ? SOURCE_LABEL[source]
        : /^https?:\/\/(www\.|export\.)?arxiv\.org\//.test(pageUrl)
          ? "arXiv"
          : "論文ページ";
    links.push({ label, url: pageUrl });
  }
  const arxivId = typeof paper.arxiv_id === "string" ? paper.arxiv_id : "";
  if (source !== "arxiv" && ARXIV_ID_RE.test(arxivId)) {
    links.push({ label: "arXiv", url: `https://arxiv.org/abs/${arxivId}` });
  }
  const pmlrUrl = pmlrPageUrl(paper);
  if (pmlrUrl && pmlrUrl !== pageUrl) links.push({ label: "PMLR", url: pmlrUrl });
  if (pdfUrl) links.push({ label: "PDF", url: pdfUrl });
  return links;
}

/** The row's PMLR page (`abstract_url` of a PMLR abstract), or "". */
function pmlrPageUrl(paper: CatalogPaper): string {
  if (paper.abstract_source !== "pmlr") return "";
  const url = typeof paper.abstract_url === "string" ? paper.abstract_url : "";
  return pmlrVolumeFromUrl(url) === null ? "" : url;
}

export interface AbstractAttribution {
  withheld: false;
  /** "要旨" or "要約" (TLDR). */
  kind: "要旨" | "要約";
  /** Credit before the licence link, e.g. "出典: arXiv". */
  source: string;
  licenseLabel: string;
  licenseUrl: string;
  /** Extra remark after the licence link (may be ""). */
  note: string;
}

export interface WithheldAbstract {
  withheld: true;
  text: string;
}

export const WITHHELD_ABSTRACT_TEXT =
  "要旨は掲載していません（出典の CVF Open Access が転載を許諾しておらず、同じ論文の arXiv 版や Semantic Scholar の要約も見つからなかったため）。原文はリンク先で読めます。";

/**
 * Attribution for the abstract shown on `paper`, or a withheld notice.
 * `null` only for legacy rows without `abstract_source` (pre-R2-26
 * catalogs), which show no label.
 */
export function abstractAttribution(
  paper: CatalogPaper,
): AbstractAttribution | WithheldAbstract | null {
  const src = paper.abstract_source;
  if (!isAbstractSource(src)) return null;
  if (src === "none") return { withheld: true, text: WITHHELD_ABSTRACT_TEXT };
  const license = ABSTRACT_LICENSE[src];
  if (license === null) return null;
  const base = { withheld: false as const, licenseLabel: license.label, licenseUrl: license.url };
  if (src === "acl_anthology") {
    const credit = authorCredit(paper.authors);
    return {
      ...base,
      kind: "要旨",
      source: `出典: ${credit ? `${credit}, ` : ""}“${paper.title}”, ACL Anthology`,
      note: "（一覧では冒頭のみ表示）",
    };
  }
  if (src === "pmlr") {
    const credit = authorCredit(paper.authors);
    const volume = pmlrVolumeFromUrl(pmlrPageUrl(paper)) ?? "PMLR";
    return {
      ...base,
      kind: "要旨",
      source: `出典: ${credit ? `${credit}, ` : ""}“${paper.title}”, ${volume}`,
      note: "（一覧では冒頭のみ表示）",
    };
  }
  if (src === "s2_tldr") {
    return {
      ...base,
      kind: "要約",
      source: `出典: ${ABSTRACT_SOURCE_LABEL.s2_tldr}`,
      note: "（著者による要旨ではありません）",
    };
  }
  return {
    ...base,
    kind: "要旨",
    source: `出典: ${ABSTRACT_SOURCE_LABEL[src]}`,
    note: src === "arxiv" && paper.source !== "arxiv" ? "（同じ論文の arXiv 版の要旨）" : "",
  };
}
