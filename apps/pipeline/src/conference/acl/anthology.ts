/**
 * Collect ACL / EMNLP / NAACL accepted papers from the ACL Anthology XML
 * dump — TS port of `paperpilot/scripts/collect_acl_anthology.py`.
 *
 * Only the main-track volumes (`long` / `short` / `main`) are kept. Keeping
 * only known volume ids is also how a renamed track becomes invisible: the
 * XML parses fine and a thinner row list comes out, so a collection whose
 * XML carries none of those ids is treated as an incomplete fetch (CNF-06).
 * One missing volume inside the naming convention in use (`main`, or
 * `long`+`short`) also refuses to publish until the operator acknowledges
 * it with `--allow-missing-volume` (CNF-07/08/09).
 *
 * Writes the same outputs as the other three collectors
 * (`../shared/writeOutputs.ts`), so the rest of the chain is unchanged. No
 * `oral_summaries_ja.md` is written directly — the Anthology marks no
 * oral/spotlight — unless `--oral-arxiv-query` overlays arXiv-tagged
 * orals (`../shared/arxivOral.ts::oralTitlesFromArxiv`).
 */

import { XMLParser, XMLValidator } from "fast-xml-parser";
import {
  type ArxivFetchDeps,
  type ConferenceRow,
  ORAL_MALFORMED_FEED,
  ORAL_MAX_RESULTS_DEFAULT,
  ORAL_WINDOW_FILLED,
  oralTitlesFromArxiv,
  parseCliArgs,
  type WriteOutputsDeps,
  writeOutputs,
} from "../shared/index.js";

const XML_BASE = "https://raw.githubusercontent.com/acl-org/acl-anthology/master/data/xml";
const ANTHOLOGY_URL = "https://aclanthology.org/";

/**
 * Main-conference proceedings only. ACL/NAACL split the main track into
 * "long" + "short"; EMNLP uses a single "main" volume. Findings / workshops
 * / demos / industry / tutorials / srw live in their own volumes.
 */
const MAIN_VOLUMES = new Set(["long", "short", "main"]);

const TIER_1 = new Set(["NEURIPS", "NIPS", "ICML", "ICLR"]);
const TIER_2 = new Set(["AAAI", "CVPR", "ACL", "EMNLP"]);
const TIER_3 = new Set(["AISTATS", "NAACL", "ECCV", "ICCV", "IJCAI", "KDD", "WWW"]);

function venueTier(venue: string): number {
  const v = venue.toUpperCase();
  if (TIER_1.has(v)) return 1;
  if (TIER_2.has(v)) return 2;
  if (TIER_3.has(v)) return 3;
  return 0;
}

// ---------------------------------------------------------------------------
// preserveOrder-mode XML tree walking (keeps inline-markup text in document
// order, e.g. `A <fixed-case>BERT</fixed-case> Model` — Anthology titles
// frequently wrap acronyms this way to protect their casing).
// ---------------------------------------------------------------------------

type PoAttrs = Record<string, string>;
type PoNode = Record<string, unknown> & { ":@"?: PoAttrs };

const xmlParser = new XMLParser({
  preserveOrder: true,
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: false,
  // Entity decoding is done ourselves (decodeXmlEntities below), with the
  // exact semantics `ET.fromstring` (expat) uses — not fast-xml-parser's
  // own (HTML-flavored, numeric-char-ref-skipping) default — so leave
  // every `&...;` untouched here (H2/M8).
  processEntities: false,
});

// ---------------------------------------------------------------------------
// XML 1.0 (expat) entity decoding — H2/M8 of the P4 review.
//
// fast-xml-parser's validator (`XMLValidator.validate`, used in
// `tryParseXml` below) catches malformed markup (unclosed/mismatched tags,
// truncated documents, syntactically-broken numeric refs like `&#X49;`
// with an uppercase `X`) but is lenient about an *undefined* named entity
// like `&foo;` — real Python `ET.fromstring` (expat) rejects that as
// not-well-formed. The decoder below reproduces expat's entity handling
// exactly: only the five predefined XML entities, decimal (`&#NNN;`) and
// lowercase-hex (`&#xHH;`) numeric references restricted to valid XML
// `Char`s, and a bare `&` or any other named entity invalidates the whole
// document (returns `null`) the same way a `ParseError` would — this is
// NOT Python's `html.unescape` (HTML5 semantics, C1 remap, dropped
// controls, case-insensitive `#x`/`#X`), which is a different, unrelated
// port living in `../shared/pyText.ts` for CVF's HTML scraping.
// ---------------------------------------------------------------------------

const XML_PREDEFINED_ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

/** XML 1.0 `Char` production: the code points expat allows a character reference to produce. */
function isValidXmlChar(cp: number): boolean {
  return (
    cp === 0x9 ||
    cp === 0xa ||
    cp === 0xd ||
    (cp >= 0x20 && cp <= 0xd7ff) ||
    (cp >= 0xe000 && cp <= 0xfffd) ||
    (cp >= 0x10000 && cp <= 0x10ffff)
  );
}

const XML_ENTITY_OR_AMP_RE = /&([^;&]{0,64}?);|&/g;

/**
 * Decode exactly the entities `ET.fromstring` decodes, or return `null` if
 * `text` contains anything expat would reject as not-well-formed: a bare
 * `&`, an undefined named entity, a numeric reference using uppercase
 * `X` (expat requires lowercase `x`) or landing outside the XML `Char`
 * range (e.g. a lone surrogate or NUL).
 */
function decodeXmlEntities(text: string): string | null {
  if (!text.includes("&")) return text;
  let ok = true;
  const decoded = text.replace(XML_ENTITY_OR_AMP_RE, (full: string, body?: string) => {
    if (body === undefined) {
      ok = false; // a bare "&" with no entity after it
      return full;
    }
    const named = XML_PREDEFINED_ENTITIES[body];
    if (named !== undefined) return named;
    const decMatch = /^#([0-9]+)$/.exec(body);
    const hexMatch = /^#x([0-9a-fA-F]+)$/.exec(body);
    if (decMatch || hexMatch) {
      const cp = decMatch
        ? Number.parseInt(decMatch[1] as string, 10)
        : Number.parseInt((hexMatch as RegExpExecArray)[1] as string, 16);
      if (!isValidXmlChar(cp)) {
        ok = false;
        return full;
      }
      return String.fromCodePoint(cp);
    }
    ok = false; // undefined named entity (e.g. &foo;), or "&#X.." uppercase X
    return full;
  });
  return ok ? decoded : null;
}

/** Decode entities in every `#text` leaf and attribute value of a preserveOrder tree, in place. Returns `false` (document unparseable) if any value fails {@link decodeXmlEntities}. */
function decodeEntitiesInPlace(nodes: unknown): boolean {
  if (!Array.isArray(nodes)) return true;
  for (const node of nodes as PoNode[]) {
    const attrs = node[":@"];
    if (attrs) {
      for (const key of Object.keys(attrs)) {
        const decoded = decodeXmlEntities(attrs[key] as string);
        if (decoded === null) return false;
        attrs[key] = decoded;
      }
    }
    for (const key of Object.keys(node)) {
      if (key === ":@") continue;
      if (key === "#text") {
        const decoded = decodeXmlEntities(String(node[key]));
        if (decoded === null) return false;
        node[key] = decoded;
      } else if (!decodeEntitiesInPlace(node[key])) {
        return false;
      }
    }
  }
  return true;
}

function poAttr(node: PoNode, name: string): string | null {
  const attrs = node[":@"];
  if (!attrs) return null;
  const value = attrs[`@_${name}`];
  return typeof value === "string" ? value : null;
}

/** Every element anywhere under `nodes` whose tag is `tag`, in document order (ET.iter equivalent). */
function poFindAll(nodes: unknown, tag: string): PoNode[] {
  if (!Array.isArray(nodes)) return [];
  const out: PoNode[] = [];
  for (const node of nodes as PoNode[]) {
    for (const key of Object.keys(node)) {
      if (key === ":@") continue;
      if (key === tag) out.push(node);
      out.push(...poFindAll(node[key], tag));
    }
  }
  return out;
}

/** The node's own children array (what `<tag>...</tag>` contains), or `[]`. */
function ownChildren(node: PoNode, tag: string): PoNode[] {
  const value = node[tag];
  return Array.isArray(value) ? (value as PoNode[]) : [];
}

/** Elements of a (non-recursive) children array named `tag`, in document order. */
function childrenNamed(children: PoNode[], tag: string): PoNode[] {
  return children.filter((c) => tag in c);
}

/** Flattened text content of a preserveOrder children array, collapsing whitespace (`" ".join(elem.itertext()).split())` equivalent). */
function poText(children: PoNode[]): string {
  const parts: string[] = [];
  for (const node of children) {
    for (const key of Object.keys(node)) {
      if (key === ":@") continue;
      if (key === "#text") {
        parts.push(String(node[key]));
      } else {
        parts.push(poText(ownChildren(node, key)));
      }
    }
  }
  return parts.join("");
}

function collapseWhitespace(s: string): string {
  return s.split(/\s+/).filter(Boolean).join(" ");
}

/** Flattened, whitespace-collapsed text of the first `tag` found directly in `children`. */
function directText(children: PoNode[], tag: string): string {
  const match = childrenNamed(children, tag)[0];
  if (!match) return "";
  return collapseWhitespace(poText(ownChildren(match, tag)));
}

function authorName(authorNode: PoNode): string {
  const authorChildren = ownChildren(authorNode, "author");
  const first = directText(authorChildren, "first");
  const last = directText(authorChildren, "last");
  return [first, last].filter(Boolean).join(" ");
}

/**
 * Parse `xmlText` into a preserveOrder tree, or `null` if it is not
 * well-formed — same outcome as Python's `ET.fromstring` raising
 * `ParseError` (H2: fast-xml-parser's own `.parse()` does NOT reject a
 * truncated document, a mismatched closing tag, or an undefined entity on
 * its own, so both `XMLValidator.validate` (markup well-formedness) and
 * `decodeEntitiesInPlace` (entity well-formedness, M8) must pass).
 */
function tryParseXml(xmlText: string): PoNode[] | null {
  if (XMLValidator.validate(xmlText) !== true) return null;
  try {
    const root = xmlParser.parse(xmlText) as PoNode[];
    if (!decodeEntitiesInPlace(root)) return null;
    return root;
  } catch {
    return null;
  }
}

/**
 * Every `<volume id="...">` in the Anthology XML, in document order
 * (duplicates kept) — TS port of `present_volume_ids`. Returns `[]` on
 * unparseable XML, same as `ET.fromstring` raising `ParseError`.
 */
export function presentVolumeIds(xmlText: string): string[] {
  const root = tryParseXml(xmlText);
  if (root === null) return [];
  return poFindAll(root, "volume").map((v) => poAttr(v, "id") ?? "");
}

/**
 * Parse main-track papers (title, authors, abstract, url) from Anthology
 * XML — TS port of `parse_papers`. Skips volume front-matter (no authors)
 * and non-main volumes. Dedups by the Anthology paper id stub (e.g.
 * `"2025.acl-long.1"`).
 */
export function parsePapers(
  xmlText: string,
  venue: string,
  volumes: ReadonlySet<string> = MAIN_VOLUMES,
): ConferenceRow[] {
  const venueToken = venue.toUpperCase();
  const tier = venueTier(venue);
  const root = tryParseXml(xmlText);
  if (root === null) return [];

  const papers = new Map<string, ConferenceRow>();
  for (const volumeNode of poFindAll(root, "volume")) {
    const volumeId = poAttr(volumeNode, "id") ?? "";
    if (!volumes.has(volumeId)) continue;
    const volumeChildren = ownChildren(volumeNode, "volume");
    for (const paperNode of childrenNamed(volumeChildren, "paper")) {
      const paperChildren = ownChildren(paperNode, "paper");
      const stub = directText(paperChildren, "url");
      const title = directText(paperChildren, "title");
      const authorNodes = childrenNamed(paperChildren, "author");
      const authors = authorNodes.map(authorName).filter((a) => a.length > 0);
      if (!stub || !title || authors.length === 0 || papers.has(stub)) continue;
      papers.set(stub, {
        title,
        authors: authors.join("; "),
        venue: venueToken,
        venue_tier: tier,
        citation_count: 0,
        github_stars: 0,
        arxiv_id: "",
        abstract: directText(paperChildren, "abstract"),
        url: `${ANTHOLOGY_URL}${stub}/`,
        pdf_url: `${ANTHOLOGY_URL}${stub}.pdf`,
        comment: "",
      });
    }
  }
  return [...papers.values()];
}

// ---------------------------------------------------------------------------
// fetchXml (network — injected)
// ---------------------------------------------------------------------------

export interface AclFetchResponse {
  status: number;
  text(): Promise<string>;
}

export type AclFetchText = (url: string) => Promise<AclFetchResponse>;

/**
 * Fetch the Anthology XML for a collection id. Returns `null` on any
 * non-200 response. A thrown/network-level failure is retried up to
 * `numRetries` times (TS port's simplification of
 * `request_with_retry`'s broader 429/5xx backoff policy, which this
 * collector's own tests don't distinguish from a flat "fetch failed").
 */
export async function fetchXml(
  xmlId: string,
  fetchText: AclFetchText,
  options: { numRetries?: number } = {},
): Promise<string | null> {
  const numRetries = options.numRetries ?? 3;
  const url = `${XML_BASE}/${xmlId}.xml`;
  let lastError: unknown;
  for (let attempt = 0; attempt <= numRetries; attempt++) {
    try {
      const resp = await fetchText(url);
      return resp.status === 200 ? await resp.text() : null;
    } catch (e) {
      lastError = e;
    }
  }
  if (lastError) return null;
  return null;
}

// ---------------------------------------------------------------------------
// main (CNF-05..10)
// ---------------------------------------------------------------------------

export interface CollectAclMainDeps {
  fetchXmlText: AclFetchText;
  /** Only required when `--oral-arxiv-query` is given. */
  arxiv?: ArxivFetchDeps;
  /** REQUIRED — see `writeOutputs`'s module doc: the TS port never defaults to `paperpilot/output`. */
  outputRoot: string;
  now?: WriteOutputsDeps["now"];
  /** Defaults to `console.log`. */
  print?: (line: string) => void;
}

const ARG_SPEC = {
  conference: { type: "string", required: true } as const,
  venue: { type: "string", required: true } as const,
  "xml-id": { type: "string", required: true } as const,
  "oral-arxiv-query": { type: "string" } as const,
  "oral-max": { type: "int", default: ORAL_MAX_RESULTS_DEFAULT } as const,
  "clear-oral": { type: "boolean" } as const,
  "allow-missing-volume": { type: "repeated-string" } as const,
};

/**
 * Runs the collector. Returns the process exit code (0 success, 1
 * refusal — XML fetch failure, no main-track volume, an unacknowledged
 * missing volume, or zero papers parsed). Usage errors throw
 * `CliUsageError`. `IdentityError` / `InvalidConferenceSlugError` from
 * `writeOutputs` propagate rather than being caught, matching the Python
 * original.
 */
export async function runCollectAclMain(
  argv: readonly string[],
  deps: CollectAclMainDeps,
): Promise<number> {
  const args = parseCliArgs(argv, ARG_SPEC);
  const conference = args.conference as string;
  const venue = args.venue as string;
  const xmlId = args["xml-id"] as string;
  const oralArxivQuery = args["oral-arxiv-query"] as string | undefined;
  const oralMax = args["oral-max"] as number;
  const clearOral = Boolean(args["clear-oral"]);
  const allowMissingVolume = (args["allow-missing-volume"] as string[] | undefined) ?? [];
  const print = deps.print ?? ((line: string) => console.log(line));

  const xmlText = await fetchXml(xmlId, deps.fetchXmlText);
  if (xmlText === null) {
    print(`⚠️  could not fetch Anthology XML for '${xmlId}'. Nothing written.`);
    return 1;
  }

  const volumes = presentVolumeIds(xmlText);
  const found = [...new Set(volumes.filter((v) => v))].sort().join(", ") || "none";
  if (![...new Set(volumes)].some((v) => MAIN_VOLUMES.has(v))) {
    print(
      `⚠️  ${xmlId}.xml carries none of the main-track volume ids ` +
        `(${[...MAIN_VOLUMES].sort().join(", ")}); found volume ids: ${found}. Check ` +
        "--xml-id or an Anthology layout change. Nothing written.",
    );
    return 1;
  }

  const volumeSet = new Set(volumes);
  const convention = volumeSet.has("main") ? ["main"] : ["long", "short"];
  const missing = convention.filter((v) => !volumeSet.has(v)).sort();
  const acknowledged = new Set(allowMissingVolume);
  const stray = [...acknowledged].filter((v) => !missing.includes(v)).sort();
  if (stray.length > 0) {
    print(
      `⚠️  --allow-missing-volume ${stray.join(", ")} acknowledges nothing: the ` +
        `main-track convention in use is (${convention.join(", ")}) and the ids ` +
        `missing from it are (${missing.join(", ") || "none"}). Nothing written.`,
    );
    return 1;
  }
  const unacknowledged = missing.filter((v) => !acknowledged.has(v));
  if (unacknowledged.length > 0) {
    const flags = unacknowledged.map((v) => `--allow-missing-volume ${v}`).join(" ");
    print(
      `⚠️  ${xmlId}.xml has no main-track volume named ` +
        `${unacknowledged.join(", ")} (found volume ids: ${found}); collecting the ` +
        "rest would publish a half proceedings. Check the Anthology collection, " +
        `then re-run with ${flags} if this venue really has no such volume. ` +
        "Nothing written.",
    );
    return 1;
  }

  const rows = parsePapers(xmlText, venue);
  print(`parsed ${rows.length} main-track ${venue.toUpperCase()} papers from ${xmlId}.xml`);
  if (rows.length === 0) {
    print(
      `⚠️  0 papers — check --xml-id (e.g. '2025.acl'); found volume ids: ${found}. Nothing written.`,
    );
    return 1;
  }

  let orals: string[] = [];
  let overlayIsKnown = true;
  if (oralArxivQuery) {
    if (!deps.arxiv) {
      throw new Error("--oral-arxiv-query given without deps.arxiv");
    }
    const overlay = await oralTitlesFromArxiv(oralArxivQuery, venue, oralMax, deps.arxiv);
    overlayIsKnown = overlay.titles !== null;
    if (overlay.reason === ORAL_WINDOW_FILLED) {
      print(
        `⚠️  the oral overlay filled the --oral-max ${oralMax} window, so it ` +
          "was skipped: the existing oral_summaries_ja.md is kept as-is " +
          "(raise --oral-max above this window and re-run to refresh it)",
      );
    } else if (overlay.reason === ORAL_MALFORMED_FEED) {
      print(
        "⚠️  the oral overlay was skipped: arXiv returned a malformed feed, so " +
          "the fetched set is missing entries: the existing " +
          "oral_summaries_ja.md is kept as-is (re-run the collection later; " +
          "--clear-oral cannot clear what this run did not establish)",
      );
    } else {
      orals = overlay.titles ?? [];
    }
  }

  const csvPath = writeOutputs(
    conference,
    rows,
    orals,
    // An incomplete overlay is not evidence that the venue has no orals,
    // so it does not authorize removing the published list either.
    { outputRoot: deps.outputRoot, clearOral: clearOral && overlayIsKnown },
    { now: deps.now },
  );
  print(
    `✅ ${rows.length} accepted ${venue.toUpperCase()} papers (${orals.length} oral via arXiv) -> ${csvPath}`,
  );
  return 0;
}
