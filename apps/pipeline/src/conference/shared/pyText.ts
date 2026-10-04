/**
 * Small Python-text-semantics helpers needed by the conference collectors,
 * scoped to `apps/pipeline/src/conference/**` (this task cannot touch
 * `packages/core/src/pycompat`, which has no equivalent of either helper
 * below — a follow-up allowed to edit that package should move these
 * there and delete the duplicates here).
 */

/**
 * The exact Unicode whitespace set Python's `str.split()` (no args) /
 * `str.isspace()` use. Differs from JS `\s` in two ways that matter for
 * scraped titles/abstracts:
 *   - Python additionally treats U+001C–U+001F (file/group/record/unit
 *     separators) and U+0085 (NEL) as whitespace; JS `\s` does not.
 *   - JS `\s` additionally treats U+FEFF (BOM / zero-width no-break space)
 *     as whitespace; Python does not.
 * Verified against a real CPython `str.isspace()` sweep of U+0000–U+FFFF.
 */
const PY_WHITESPACE_CHARS = "\t\n\u000b\u000c\r\u001c\u001d\u001e\u001f \u0085                 　";
const PY_WS_EDGE_RE = new RegExp(`^[${PY_WHITESPACE_CHARS}]+|[${PY_WHITESPACE_CHARS}]+$`, "g");
const PY_WS_RUN_RE = new RegExp(`[${PY_WHITESPACE_CHARS}]+`, "g");

/** TS port of Python's `" ".join(s.split())` — trim + collapse internal whitespace runs to one space. */
export function pyWhitespaceCollapse(s: string): string {
  return s.replace(PY_WS_EDGE_RE, "").replace(PY_WS_RUN_RE, " ");
}

// ---------------------------------------------------------------------------
// html.unescape — DOCUMENTED PARTIAL PORT.
// ---------------------------------------------------------------------------
//
// Python's `html.unescape` implements the full HTML5 named-character-
// reference table (~2100 entries, including semicolon-less legacy names)
// plus the HTML5 numeric-character-reference algorithm (including its
// table of invalid-codepoint substitutions for the C1 control range,
// inherited from Windows-1252). Porting the full named-entity table is out
// of this task's scope (a ~2000-entry data file, not needed by any real
// CVF Open Access page this collector has to parse).
//
// This port covers:
//   - numeric decimal (`&#169;`) and hex (`&#xA9;`) references, including
//     the HTML5 C1-control substitution table and the U+FFFD fallback for
//     surrogates / out-of-range code points — this is the part of the
//     algorithm most likely to silently corrupt text if skipped.
//   - the HTML 4 Latin-1 named entities (the accented-letter / punctuation
//     set most likely to appear in author names and abstracts) plus a
//     short list of common HTML5 punctuation entities (mdash, ndash,
//     hellip, curly quotes).
//   - a REQUIRED trailing `;` for every reference (named or numeric).
//     Python additionally recognises a fixed list of legacy entities
//     *without* a trailing semicolon (e.g. bare `&amp`); that subset is
//     NOT ported here — a semicolon-less legacy reference is left as
//     literal text instead of being unescaped. CVF Open Access's own
//     generator always emits the `;`, so this gap does not affect the
//     fixtures this collector reads, but it is a real, documented
//     divergence from CPython's `html.unescape`.
//
// Any named entity outside the table below is also left as literal text
// (not unescaped), rather than guessed at.

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  // Core HTML
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  // HTML 4 Latin-1 (ISO-8859-1) block
  nbsp: " ",
  iexcl: "¡",
  cent: "¢",
  pound: "£",
  curren: "¤",
  yen: "¥",
  brvbar: "¦",
  sect: "§",
  uml: "¨",
  copy: "©",
  ordf: "ª",
  laquo: "«",
  not: "¬",
  shy: "­",
  reg: "®",
  macr: "¯",
  deg: "°",
  plusmn: "±",
  sup2: "²",
  sup3: "³",
  acute: "´",
  micro: "µ",
  para: "¶",
  middot: "·",
  cedil: "¸",
  sup1: "¹",
  ordm: "º",
  raquo: "»",
  frac14: "¼",
  frac12: "½",
  frac34: "¾",
  iquest: "¿",
  Agrave: "À",
  Aacute: "Á",
  Acirc: "Â",
  Atilde: "Ã",
  Auml: "Ä",
  Aring: "Å",
  AElig: "Æ",
  Ccedil: "Ç",
  Egrave: "È",
  Eacute: "É",
  Ecirc: "Ê",
  Euml: "Ë",
  Igrave: "Ì",
  Iacute: "Í",
  Icirc: "Î",
  Iuml: "Ï",
  ETH: "Ð",
  Ntilde: "Ñ",
  Ograve: "Ò",
  Oacute: "Ó",
  Ocirc: "Ô",
  Otilde: "Õ",
  Ouml: "Ö",
  times: "×",
  Oslash: "Ø",
  Ugrave: "Ù",
  Uacute: "Ú",
  Ucirc: "Û",
  Uuml: "Ü",
  Yacute: "Ý",
  THORN: "Þ",
  szlig: "ß",
  agrave: "à",
  aacute: "á",
  acirc: "â",
  atilde: "ã",
  auml: "ä",
  aring: "å",
  aelig: "æ",
  ccedil: "ç",
  egrave: "è",
  eacute: "é",
  ecirc: "ê",
  euml: "ë",
  igrave: "ì",
  iacute: "í",
  icirc: "î",
  iuml: "ï",
  eth: "ð",
  ntilde: "ñ",
  ograve: "ò",
  oacute: "ó",
  ocirc: "ô",
  otilde: "õ",
  ouml: "ö",
  divide: "÷",
  oslash: "ø",
  ugrave: "ù",
  uacute: "ú",
  ucirc: "û",
  uuml: "ü",
  yacute: "ý",
  thorn: "þ",
  yuml: "ÿ",
  // Common HTML5 punctuation / symbols seen in abstracts
  mdash: "—",
  ndash: "–",
  hellip: "…",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  trade: "™",
  euro: "€",
  minus: "−",
};

/** HTML5's substitution table for numeric refs that land in the C1 control range (Windows-1252 remap). */
const C1_NUMERIC_SUBSTITUTIONS: Readonly<Record<number, number>> = {
  128: 0x20ac,
  130: 0x201a,
  131: 0x0192,
  132: 0x201e,
  133: 0x2026,
  134: 0x2020,
  135: 0x2021,
  136: 0x02c6,
  137: 0x2030,
  138: 0x0160,
  139: 0x2039,
  140: 0x0152,
  142: 0x017d,
  145: 0x2018,
  146: 0x2019,
  147: 0x201c,
  148: 0x201d,
  149: 0x2022,
  150: 0x2013,
  151: 0x2014,
  152: 0x02dc,
  153: 0x2122,
  154: 0x0161,
  155: 0x203a,
  156: 0x0153,
  158: 0x017e,
  159: 0x0178,
};

function numericRefToChar(codepoint: number): string {
  const mapped = C1_NUMERIC_SUBSTITUTIONS[codepoint];
  if (mapped !== undefined) return String.fromCodePoint(mapped);
  if (codepoint === 0x00 || (codepoint >= 0xd800 && codepoint <= 0xdfff) || codepoint > 0x10ffff) {
    return "�";
  }
  return String.fromCodePoint(codepoint);
}

const ENTITY_RE = /&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z][a-zA-Z0-9]*);/g;

/** Documented partial port of Python's `html.unescape` — see module doc above. */
export function htmlUnescape(text: string): string {
  return text.replace(ENTITY_RE, (full, body: string) => {
    if (body.startsWith("#x") || body.startsWith("#X")) {
      const cp = Number.parseInt(body.slice(2), 16);
      return Number.isNaN(cp) ? full : numericRefToChar(cp);
    }
    if (body.startsWith("#")) {
      const cp = Number.parseInt(body.slice(1), 10);
      return Number.isNaN(cp) ? full : numericRefToChar(cp);
    }
    const resolved = NAMED_ENTITIES[body];
    return resolved ?? full;
  });
}

const TAG_RE = /<[^>]+>/g;

/** `html.unescape(TAG_RE.sub(" ", text))` then whitespace-collapsed — mirrors `collect_cvf.py::_clean`. */
export function stripTagsUnescapeCollapse(text: string): string {
  return pyWhitespaceCollapse(htmlUnescape(text.replace(TAG_RE, " ")));
}
