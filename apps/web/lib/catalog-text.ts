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
import { searchTerms, termVariants } from "./catalog-sort";
import { upgradeKnownHttps } from "./https-upgrade";

export interface TextSegment {
  text: string;
  mark: boolean;
}

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * One case-insensitive regex matching ANY of the query's whitespace-
 * separated terms (longest first, so "transformer" wins over "trans"),
 * or null for an empty query. Mirrors lib/catalog-sort.ts `searchTerms`:
 * a multi-word search matches rows containing every term, so every term
 * is what gets highlighted.
 */
export function termsRegExp(query: string, flags: string): RegExp | null {
  // `searchTerms` NFKC-normalises, so a full-width query highlights the
  // ASCII text it matched.
  const terms = [...new Set(searchTerms(query).flatMap(termVariants))].sort(
    (a, b) => b.length - a.length,
  );
  if (terms.length === 0) return null;
  return new RegExp(terms.map(escapeRegExp).join("|"), flags);
}

/**
 * Splits `text` into segments, marking every case-insensitive occurrence
 * of any of `query`'s terms (see `termsRegExp`). An empty/falsy query yields the whole text as one
 * unmarked segment. Matching happens on the raw text (never on an
 * already-escaped string), so a match can never land inside an HTML
 * entity the way it could when the original built markup first.
 */
export function highlightSegments(text: string, query: string): TextSegment[] {
  const re = query ? termsRegExp(query, "gi") : null;
  if (!re) return [{ text, mark: false }];
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
  const re = rawQuery ? termsRegExp(rawQuery, "i") : null;
  if (re) {
    const i = abstract.search(re);
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
  rawAbstract: string,
  rawQuery: string,
  options: { isFull: boolean; isSelected: boolean },
): AbstractDek {
  // #463: abstracts carry the submission's LaTeX too ("$\\Psi$-Sampler").
  const abstract = tidyTitle(rawAbstract);
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
  return url && /^https?:\/\//i.test(url) ? upgradeKnownHttps(url) : "#";
}

const SUPERSCRIPT: Record<string, string> = {
  "0": "⁰",
  "1": "¹",
  "2": "²",
  "3": "³",
  "4": "⁴",
  "5": "⁵",
  "6": "⁶",
  "7": "⁷",
  "8": "⁸",
  "9": "⁹",
  "+": "⁺",
  "-": "⁻",
  n: "ⁿ",
  i: "ⁱ",
  A: "ᴬ",
  B: "ᴮ",
  D: "ᴰ",
  E: "ᴱ",
  G: "ᴳ",
  H: "ᴴ",
  I: "ᴵ",
  J: "ᴶ",
  K: "ᴷ",
  L: "ᴸ",
  M: "ᴹ",
  N: "ᴺ",
  O: "ᴼ",
  P: "ᴾ",
  R: "ᴿ",
  T: "ᵀ",
  U: "ᵁ",
  W: "ᵂ",
  ε: "ᵋ",
  p: "ᵖ",
};
const SUBSCRIPT: Record<string, string> = {
  "0": "₀",
  "1": "₁",
  "2": "₂",
  "3": "₃",
  "4": "₄",
  "5": "₅",
  "6": "₆",
  "7": "₇",
  "8": "₈",
  "9": "₉",
  a: "ₐ",
  e: "ₑ",
  h: "ₕ",
  i: "ᵢ",
  j: "ⱼ",
  k: "ₖ",
  l: "ₗ",
  m: "ₘ",
  n: "ₙ",
  o: "ₒ",
  p: "ₚ",
  r: "ᵣ",
  s: "ₛ",
  t: "ₜ",
  u: "ᵤ",
  v: "ᵥ",
  x: "ₓ",
  "∞": "∞",
};
const BLACKBOARD: Record<string, string> = {
  R: "ℝ",
  N: "ℕ",
  Z: "ℤ",
  C: "ℂ",
  Q: "ℚ",
};
/** #521: font / text commands whose braces the source data lost
 * ("\\textDT", "\\mathcalO", "\\underline\\textF"): the command name
 * goes, the following text stays. Longest names first. */
const FONT_COMMAND_RE =
  /\\(?:operatorname|boldsymbol|underline|mathcal|mathbf|mathrm|mathit|mathsf|texttt|textit|textbf|textsf|textrm|text)(?=[A-Z0-9\\])/g;
const GREEK: Record<string, string> = {
  alpha: "α",
  beta: "β",
  gamma: "γ",
  delta: "δ",
  epsilon: "ε",
  varepsilon: "ε",
  theta: "θ",
  lambda: "λ",
  mu: "μ",
  pi: "π",
  sigma: "σ",
  tau: "τ",
  phi: "φ",
  psi: "ψ",
  omega: "ω",
  Delta: "Δ",
  Sigma: "Σ",
  Phi: "Φ",
  Psi: "Ψ",
  Omega: "Ω",
  Pi: "Π",
  Lambda: "Λ",
  Theta: "Θ",
  Gamma: "Γ",
  infty: "∞",
  times: "×",
  ell: "ℓ",
  textdegree: "°",
  log: "log",
  partial: "∂",
  star: "*",
  circ: "∘",
  nabla: "∇",
  cdot: "·",
  leq: "≤",
  geq: "≥",
  approx: "≈",
  sim: "∼",
};
const UMLAUT: Record<string, string> = {
  a: "ä",
  o: "ö",
  u: "ü",
  A: "Ä",
  O: "Ö",
  U: "Ü",
  e: "ë",
  i: "ï",
};

/** #463: paper titles arrive with the LaTeX of the submission ("$\\Psi$-Sampler",
 * "A$^2$LC", "D$^{3}$ToM"). Readers see the characters, not the markup:
 * superscripts / subscripts become Unicode where one exists, Greek letters
 * and a few symbols are translated, `\\mathcal{X}` / `\\text{x}` keep their
 * contents, and the `$` delimiters go. Unknown commands keep their name. */
export function tidyTitle(title: string): string {
  if (!title.includes("$") && !title.includes("\\")) return title;
  const script = (table: Record<string, string>, whole: string, body: string): string => {
    const out = [...body].map((ch) => table[ch] ?? null);
    return out.every((c) => c !== null) ? out.join("") : whole;
  };
  let t = title;
  // A doubled backslash before a command is an escaping slip in the source.
  t = t.replace(/\\\\(?=[A-Za-z"{(])/g, "\\");
  t = t.replace(/\\"\{?([AOUaoueiu])\}?/g, (m, c: string) => UMLAUT[c] ?? m);
  t = t.replace(/\\\\\s/g, " ");
  t = t.replace(/\\[()]/g, "");
  t = t.replace(/\\([&_%#])/g, "$1");
  t = t.replace(/\\not\s*=/g, "≠");
  t = t.replace(/\\mathbb(?:\{([A-Z])\}|([A-Z]))/g, (m, a?: string, b?: string) => {
    const c = a ?? b ?? "";
    return BLACKBOARD[c] ?? c;
  });
  t = t.replace(/\\(textdegree|varepsilon)/g, (m, name: string) => GREEK[name] ?? m);
  t = t.replace(FONT_COMMAND_RE, "");
  t = t.replace(/\\sqrt\{([^{}]*)\}/g, "√($1)");
  const scripts = (x: string): string =>
    x
      .replace(/\^\{([^{}]*)\}/g, (m, b: string) => script(SUPERSCRIPT, m, b))
      .replace(/\^([0-9a-zA-Z+ε-])/g, (m, b: string) => script(SUPERSCRIPT, m, b))
      .replace(/_\{([^{}]*)\}/g, (m, b: string) => script(SUBSCRIPT, m, b))
      .replace(/_([0-9∞]|[a-z](?![A-Za-z]))/g, (m, b: string) => script(SUBSCRIPT, m, b));
  t = scripts(t);
  t = t.replace(
    /\\(?:mathcal|mathbf|mathrm|mathsf|text|textit|textbf|texttt|textsf|textrm|mathit|operatorname|underline|boldsymbol|emph|tilde|hat|bar)\{([^{}]*)\}/g,
    "$1",
  );
  t = t.replace(/\\([A-Za-z]+)/g, (m, name: string) => GREEK[name] ?? name);
  // Second pass: scripts whose body was a command (`\\ell_{\\infty}`, `^\\circ`).
  t = scripts(t);
  t = t.replace(/\^∘/g, "°");
  t = t.replace(/\^\*/g, "*");
  t = t.replace(/(?<![\^_])\{([^{}]*)\}/g, "$1");
  t = t.replace(/\$/g, "");
  return t.replace(/\s{2,}/g, " ").trim();
}
