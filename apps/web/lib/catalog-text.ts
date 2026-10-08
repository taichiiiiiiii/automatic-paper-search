/**
 * Relevance-scanning text helpers, ported from docs/assets/app.js
 * (`highlightTerms` / `buildAbstractView` / `buildAbstractDek`). The
 * original builds an HTML string with `<mark>`; this port builds plain
 * text **segments** instead (SCR-12: "no raw shard tag is injected" /
 * "each fragment is escaped before <mark> is applied") because the
 * Next.js UI renders them as JSX text children, which React escapes by
 * construction -- there is no HTML string step for untrusted text to
 * hide inside, and `dangerouslySetInnerHTML` is never used.
 *
 * With tens of thousands of papers, the reader's real question while
 * scrolling is "is this in my field?" -- two signals answer that without
 * opening each paper: (1) an always-visible abstract dek, and (2) when
 * searching, the query is highlighted and the dek is re-anchored to the
 * first match so the matched context is on screen without expanding.
 */
import { CLAMP_MIN, SNIPPET_LEAD } from "./catalog-constants";

export interface TextSegment {
  text: string;
  mark: boolean;
}

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Splits `text` into segments, marking every case-insensitive occurrence
 * of `query`. An empty/falsy query yields the whole text as one
 * unmarked segment. Matching happens on the raw text (never on an
 * already-escaped string), so a match can never land inside an HTML
 * entity the way it could when the original built markup first.
 */
export function highlightSegments(text: string, query: string): TextSegment[] {
  if (!query) return [{ text, mark: false }];
  const re = new RegExp(escapeRegExp(query), "gi");
  const segments: TextSegment[] = [];
  let last = 0;
  let match = re.exec(text);
  while (match !== null) {
    if (match.index > last) segments.push({ text: text.slice(last, match.index), mark: false });
    segments.push({ text: match[0], mark: true });
    last = match.index + match[0].length;
    if (match[0].length === 0) re.lastIndex += 1; // never loops on a zero-width match
    match = re.exec(text);
  }
  if (last < text.length || segments.length === 0) {
    segments.push({ text: text.slice(last), mark: false });
  }
  return segments;
}

export interface AbstractView {
  segments: TextSegment[];
  len: number;
  /** True when the view opens mid-abstract (a "… " lead is shown). */
  leadEllipsis: boolean;
}

/**
 * Builds the abstract preview view. When `rawQuery` hits the abstract,
 * the window opens a little before the first match (snapped to a word
 * boundary) so the highlighted term lands inside the clamp; otherwise
 * the view starts from the top. The match index is read from the RAW
 * text, not a lowercased copy -- `toLowerCase()` is not length-preserving
 * (e.g. "İ" becomes two code units), so a lowercased index can open the
 * window one character late.
 */
export function buildAbstractView(abstract: string, rawQuery: string): AbstractView {
  if (rawQuery) {
    const i = abstract.search(new RegExp(escapeRegExp(rawQuery), "i"));
    if (i > SNIPPET_LEAD) {
      let start = i - SNIPPET_LEAD;
      const sp = abstract.lastIndexOf(" ", start);
      if (sp > 0) start = sp + 1;
      const sliced = abstract.slice(start);
      return {
        segments: highlightSegments(sliced, rawQuery),
        len: sliced.length,
        leadEllipsis: true,
      };
    }
  }
  return {
    segments: highlightSegments(abstract, rawQuery),
    len: abstract.length,
    leadEllipsis: false,
  };
}

export interface AbstractDek {
  segments: TextSegment[];
  leadEllipsis: boolean;
  /** Preview only (never the selected card): true when the view is long
   * enough to need a "続きを読む" toggle. */
  needsToggle: boolean;
}

/**
 * The single definition of an abstract dek, shared by the first paint
 * and the async full-abstract update (docs/assets/app.js keeps both
 * render paths going through one `buildAbstractDek` -- the async path
 * used to be a separate, highlight-free implementation). A preview is
 * windowed to the first match; a loaded full abstract (`isFull`) is
 * shown whole. The selected card (`isSelected`) is never clamped,
 * matching the first paint.
 */
export function buildAbstractDek(
  abstract: string,
  rawQuery: string,
  options: { isFull: boolean; isSelected: boolean },
): AbstractDek {
  const view: AbstractView = options.isFull
    ? { segments: highlightSegments(abstract, rawQuery), len: abstract.length, leadEllipsis: false }
    : buildAbstractView(abstract, rawQuery);
  const needsToggle = !options.isSelected && view.len > CLAMP_MIN;
  return { segments: view.segments, leadEllipsis: view.leadEllipsis, needsToggle };
}

/**
 * Only ever returns an http(s) URL; anything else (e.g. a `javascript:`
 * URI that slipped into source data) collapses to "#" (SCR-14). papers.json
 * is generated from arXiv/OpenAlex/CVF/OpenReview/ACL, so this is
 * defense-in-depth, not a known vector.
 */
export function safeHref(url: string | null | undefined): string {
  return url && /^https?:\/\//i.test(url) ? url : "#";
}
