/**
 * Theme topic scope (R2-2b, design doc 40) — keeps a theme lineage on
 * the theme instead of drifting along whatever a seed happens to cite.
 *
 * Three consumers share this one module so they cannot disagree:
 *  - seed ranking (`discoverSeeds.ts::applySeedFilters`): a seed whose
 *    title is ABOUT the theme outranks one that only uses the theme as a
 *    method component ("SuperGlue: Learning Feature Matching With Graph
 *    Neural Networks");
 *  - root choice (`build.ts::pickRootSeed`): the root is the most central
 *    seed among the ones whose main subject is the theme;
 *  - BFS admission (`bfs.ts`): a reference/citation neighbour joins the
 *    graph only if it is topically related (see {@link TopicScope.admits}).
 *
 * The match is deliberately phrase-level, not the per-word `isTopicRelevant`
 * gate from `seedFilters.ts`: for a 3-word theme that gate needs only 2 of
 * the words anywhere in title+abstract, so "graph" + "network" or "neural"
 * + "network" lets almost any deep-learning abstract through (it is what
 * admitted "Text Data Augmentation for Deep Learning" into the GNN theme).
 * Terms are the theme itself, its `theme_aliases.json` aliases, their
 * plural/singular and space-less forms ("FlashAttention"), an initialism
 * of 3+ letters ("GNN", "MoE") and CamelCase/upper-case tokens taken from
 * the aliases ("ViT").
 *
 * R2-11 (design 41 D7 / doc 42): admission is "theme-term match only"
 * by default — the foundational allowlist and co-citation support no
 * longer admit on their own (they let ResNet/BERT/Adam into every theme);
 * both stay available as opt-in options, and the allowlist still drives
 * relation classification. When the BFS has an embedding relevance
 * score z for a candidate (`topicEmbedding.ts`), admission becomes
 * `(term match AND z >= zLo) OR z >= zHi`.
 *
 * R2-2d: short acronyms ("GNN", "MoE", "ViT") are matched CASE-SENSITIVELY
 * and kept in their written case in {@link themeTerms}: lower-case "moe" or
 * the funding-statement "MOE" (Ministry of Education) is not the theme. An
 * acronym may close a CamelCase name ("FasterMoE", "FlexMoE") but never
 * open a longer word ("MoEfication", "ViTamin", "GNNExplainer").
 */

import { codepointCompare } from "@paperpilot/core";
import { isFoundationalAncestor } from "../classify/classify.js";
import { aliasesFor, topicTermsFor } from "./seedFilters.js";

/** Tunables. Defaults are the production values; every build can
 * override them (CLI `--topic-min-support`, `--no-topic-gate`). */
export interface TopicScopeOptions {
  /** Master switch for the BFS admission gate. Seed ranking/root choice
   * still use the scope when this is false. */
  gate: boolean;
  /** A neighbour with no theme-term match is still admitted when at least
   * this many already-admitted on-topic nodes link to it (cite it or are
   * cited by it). `0` = support admission OFF (the R2-11 default): no
   * deferred support pass and no provisional citing papers. */
  minSupport: number;
  /** Admit foundational-allowlist papers regardless of topic. Off by
   * default since R2-11 (doc 42: it admitted off-topic classics); the
   * allowlist still drives relation classification. */
  admitFoundational: boolean;
  /** R2-11 embedding gate: a term-matching candidate needs z >= zLo, a
   * candidate without a term match needs z >= zHi (z = within-pool
   * standardised cosine to the theme query, `topicEmbedding.ts`). */
  zLo: number;
  zHi: number;
  /** Seed-ranking multiplier for a seed whose title uses the theme only
   * as a method component ("... with Graph Neural Networks"). */
  componentSeedWeight: number;
  /** Seed-ranking multiplier for a seed that matches only in its abstract. */
  abstractOnlySeedWeight: number;
}

export const DEFAULT_TOPIC_SCOPE_OPTIONS: Readonly<TopicScopeOptions> = Object.freeze({
  gate: true,
  minSupport: 0,
  admitFoundational: false,
  zLo: 0,
  zHi: 1.0,
  componentSeedWeight: 0.25,
  abstractOnlySeedWeight: 0.5,
});

/** How a paper relates to the theme, judged from its title first. */
export type TopicRole =
  /** Title is about the theme (or a survey of it). */
  | "subject"
  /** Title uses the theme as a tool: "... with/using/via <theme> ...". */
  | "component"
  /** Theme only in abstract/TL;DR. */
  | "abstract"
  /** No theme term anywhere. */
  | "none";

export interface TopicPaperLike {
  title?: unknown;
  abstract?: unknown;
  short_abstract?: unknown;
  tldr?: unknown;
}

/** Lower-case, every non-alphanumeric run -> one space, padded with a
 * space on both sides so a `" term "` substring test is a whole-word test. */
export function normalizeTopicText(text: string): string {
  const core = text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
  return ` ${core} `;
}

/** Connectors that make the following theme mention a method component
 * of a paper whose subject is something else. "for"/"in"/"of" are not
 * here: "Pre-training for GNNs" and "Expert Specialization in MoE
 * Language Models" are about the theme. One modifier may sit between the
 * connector and the theme ("... Using Regularized Graph Neural Networks"). */
const COMPONENT_CONNECTOR_RE =
  /\b(?:with|using|via|by|through|leveraging|utili[sz]ing|employing|based\s+on|powered\s+by|equipped\s+with)(?:\s+[\p{L}\p{N}-]+)?\s*$/iu;

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function bodyText(paper: TopicPaperLike): string {
  return [str(paper.abstract), str(paper.short_abstract), str(paper.tldr)].join(" ");
}

function addPhrase(out: Set<string>, phrase: string): void {
  const norm = normalizeTopicText(phrase).trim();
  if (norm.length < 3) return;
  const forms = [norm];
  const compact = norm.replace(/ /g, "");
  if (compact !== norm && compact.length >= 6) forms.push(compact);
  for (const form of forms) {
    out.add(form);
    // Plural / singular of the LAST word only ("graph neural network(s)").
    if (/[^s]s$/.test(form)) out.add(form.slice(0, -1));
    else if (!form.endsWith("s")) out.add(`${form}s`);
  }
}

/** Longest token treated as a case-sensitive acronym ("GNN", "MoE",
 * "ViT", "DeiT"). Longer CamelCase names ("FlashAttention") are
 * distinctive enough to match case-insensitively. */
const MAX_ACRONYM_LEN = 5;

/** An acronym term keeps its written case and its plural. */
function addAcronym(out: Set<string>, acronym: string): void {
  out.add(acronym);
  out.add(`${acronym}s`);
}

/** True for a term that is matched case-sensitively (an acronym). */
export function isAcronymTerm(term: string): boolean {
  return /\p{Lu}/u.test(term);
}

const STOP_FOR_INITIALISM = new Set(["a", "an", "the"]);
/** Function words that stay lower-case inside an initialism ("MoE"). */
const LOWER_IN_INITIALISM = new Set(["of", "for", "in", "on", "and", "to", "with", "by"]);

/** Every term that counts as "this paper mentions the theme". Phrase
 * terms are normalised lower-case and matched case-insensitively;
 * acronym terms (they contain an upper-case letter) are matched
 * case-sensitively — see {@link isAcronymTerm}. */
export function themeTerms(
  theme: string,
  aliases: readonly string[] = [],
  extraTerms: readonly string[] = [],
): string[] {
  const out = new Set<string>();
  addPhrase(out, theme);
  for (const term of extraTerms) addPhrase(out, term);
  for (const alias of aliases) {
    addPhrase(out, alias);
    // CamelCase / upper-case tokens inside a search alias ("ViT image
    // patches", "FlashAttention IO-Awareness") are names in their own right.
    for (const tok of alias.split(/[\s/]+/)) {
      const bare = tok.replace(/[^\p{L}\p{N}]/gu, "");
      const uppers = (bare.match(/\p{Lu}/gu) ?? []).length;
      if (bare.length < 3 || uppers < 2) continue;
      if (bare.length <= MAX_ACRONYM_LEN) addAcronym(out, bare);
      else addPhrase(out, bare);
    }
  }
  // Initialism of 3+ letters ("Graph Neural Network" -> "GNN", "Mixture
  // of Experts" -> "MoE"). Two-letter initialisms ("VT", "FA") are too
  // ambiguous to use.
  const words = normalizeTopicText(theme)
    .trim()
    .split(" ")
    .filter((w) => w && !STOP_FOR_INITIALISM.has(w));
  if (words.length >= 3) {
    addAcronym(
      out,
      words.map((w) => (LOWER_IN_INITIALISM.has(w) ? w[0]! : w[0]!.toUpperCase())).join(""),
    );
  }
  return [...out].sort();
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Compile one term. Phrase terms: whole words, any non-alphanumeric run
 * between words, case-insensitive (same as matching inside
 * {@link normalizeTopicText}). Acronyms: case-sensitive; may follow a
 * lower-case letter (closing a CamelCase name) but not start a longer
 * word. */
export function termRegex(term: string): RegExp {
  if (isAcronymTerm(term)) {
    return new RegExp(`(?<![\\p{Lu}\\p{N}])${escapeRegExp(term)}(?![\\p{L}\\p{N}])`, "u");
  }
  const body = term.split(" ").map(escapeRegExp).join("[^\\p{L}\\p{N}]+");
  return new RegExp(`(?<![\\p{L}\\p{N}])${body}(?![\\p{L}\\p{N}])`, "iu");
}

/** Index of the first term occurrence in `text`, or -1. */
function firstMatch(text: string, regexes: readonly RegExp[]): number {
  const t = text.normalize("NFKC");
  let best = -1;
  for (const re of regexes) {
    const m = re.exec(t);
    if (m && (best === -1 || m.index < best)) best = m.index;
  }
  return best;
}

/** Title words that mark a dataset / benchmark paper ("Cats and dogs"
 * introduces the Oxford-IIIT Pets dataset). Such papers are cited by
 * every paper that evaluates on them, so co-citation support says
 * nothing about the theme: they may only enter through a theme-term
 * match or the foundational allowlist. */
const DATASET_TITLE_RE =
  /\b(?:data\s*sets?|benchmarks?|database|corpus|corpora)\b|\b(?:dataset|benchmark)\s+for\b/i;
const DATASET_ABSTRACT_RE =
  /\b(?:introduce|introduces|introducing|present|presents|release|releases|collect|collected|construct|constructed|build|built|propose|proposes)\b[^.]{0,80}?\b(?:(?:new|novel|large|annotated)\b[^.]{0,40}?)?\b(?:data\s*set|dataset|benchmark|database|corpus)\b/i;

export function looksLikeDataset(paper: TopicPaperLike): boolean {
  if (DATASET_TITLE_RE.test(str(paper.title))) return true;
  return DATASET_ABSTRACT_RE.test(bodyText(paper));
}

export class TopicScope {
  readonly theme: string;
  readonly terms: readonly string[];
  /** Theme name, aliases and `_topic_terms` as written (deduplicated):
   * the text of the embedding query (`topicEmbedding.ts`). */
  readonly queryTerms: readonly string[];
  readonly options: Readonly<TopicScopeOptions>;
  private readonly regexes: readonly RegExp[];

  constructor(
    theme: string,
    aliases: readonly string[],
    options: Partial<TopicScopeOptions> = {},
    extraTerms: readonly string[] = [],
  ) {
    this.theme = theme;
    this.terms = themeTerms(theme, aliases, extraTerms);
    this.queryTerms = [...new Set([theme, ...aliases, ...extraTerms])];
    this.regexes = this.terms.map(termRegex);
    this.options = { ...DEFAULT_TOPIC_SCOPE_OPTIONS, ...stripUndefined(options) };
  }

  /** Scope for a theme with its `theme_aliases.json` aliases and
   * `_topic_terms` entry. */
  static forTheme(
    theme: string,
    options: Partial<TopicScopeOptions> = {},
    aliasesPath?: string,
  ): TopicScope {
    return new TopicScope(
      theme,
      aliasesFor(theme, aliasesPath),
      options,
      topicTermsFor(theme, aliasesPath),
    );
  }

  /** Title mentions a theme term. */
  matchesTitle(paper: TopicPaperLike): boolean {
    return firstMatch(str(paper.title), this.regexes) !== -1;
  }

  /** Title, abstract, short abstract or TL;DR mentions a theme term. */
  isOnTopic(paper: TopicPaperLike): boolean {
    if (this.matchesTitle(paper)) return true;
    return firstMatch(bodyText(paper), this.regexes) !== -1;
  }

  /** Subject / component / abstract-only / none — see {@link TopicRole}. */
  role(paper: TopicPaperLike): TopicRole {
    const title = str(paper.title);
    if (this.matchesTitle(paper)) {
      // Where the first term starts in the ORIGINAL title, so the
      // connector test sees the real preceding words.
      const cut = firstMatch(title, this.regexes);
      if (cut > 0) {
        // Only the clause the term sits in: "SuperGlue: Learning ... With GNNs".
        const before = title.normalize("NFKC").slice(0, cut);
        const clause = before.slice(Math.max(before.lastIndexOf(":"), before.lastIndexOf("—")) + 1);
        if (COMPONENT_CONNECTOR_RE.test(clause.replace(/[^\p{L}\p{N}]+$/u, ""))) return "component";
      }
      return "subject";
    }
    if (this.isOnTopic(paper)) return "abstract";
    return "none";
  }

  /** Seed-ranking multiplier for {@link role}. */
  seedWeight(paper: TopicPaperLike): number {
    switch (this.role(paper)) {
      case "subject":
        return 1;
      case "component":
        return this.options.componentSeedWeight;
      case "abstract":
        return this.options.abstractOnlySeedWeight;
      default:
        return this.options.abstractOnlySeedWeight;
    }
  }

  /** Root-preference rank: higher wins. An on-topic foundational-
   * allowlist paper (the curated canonical paper of a line, e.g. the ViT
   * or FlashAttention paper) > a paper whose title is about the theme
   * (surveys of the theme included) > abstract-only > component > none. */
  rootRank(paper: TopicPaperLike): number {
    const role = this.role(paper);
    if (role !== "none" && isFoundationalAncestor(paper as Record<string, unknown>)) return 4;
    if (role === "subject") return 3;
    if (role === "abstract") return 2;
    if (role === "component") return 1;
    return 0;
  }

  /** True when co-citation support may admit with `support` links
   * (support admission is off when `minSupport` is 0). */
  supportSuffices(support: number): boolean {
    return this.options.minSupport > 0 && support >= this.options.minSupport;
  }

  /** Embedding rule (R2-11): `(match AND z >= zLo) OR z >= zHi`. */
  private relevant(match: boolean, z: number): boolean {
    return (match && z >= this.options.zLo) || z >= this.options.zHi;
  }

  /** Why `paper` may join the graph, or `null` when it may not.
   * `support` = number of distinct already-admitted on-topic nodes that
   * link to it. A dataset/benchmark paper ({@link looksLikeDataset}) is
   * never admitted by support.
   *
   * `relevance` = the candidate's embedding z-score, when the embedding
   * gate is active. Then `(term match AND z >= zLo) OR z >= zHi` decides
   * (`"embedding"` = admitted on z alone; an allowlisted paper admitted
   * by the rule is reported as `"foundational"`), and support (if
   * enabled) additionally needs z >= zLo. Without it (Stage 1 / fallback)
   * a theme-term match admits; the allowlist and support only when
   * explicitly enabled (`admitFoundational`, `minSupport > 0`). */
  admits(
    paper: TopicPaperLike,
    support: number,
    relevance?: number | null,
  ): "topic" | "foundational" | "support" | "embedding" | null {
    if (!this.options.gate) return "topic";
    const match = this.isOnTopic(paper);
    const foundational = isFoundationalAncestor(paper as Record<string, unknown>);
    if (typeof relevance === "number") {
      if (this.relevant(match, relevance)) {
        if (foundational) return "foundational";
        return match ? "topic" : "embedding";
      }
      if (
        relevance >= this.options.zLo &&
        this.supportSuffices(support) &&
        !looksLikeDataset(paper)
      ) {
        return "support";
      }
      return null;
    }
    if (match) return "topic";
    if (this.options.admitFoundational && foundational) return "foundational";
    if (this.supportSuffices(support) && !looksLikeDataset(paper)) return "support";
    return null;
  }

  /** Admission for a NEWER paper citing a seed (descendants pass).
   * Citing a FlashAttention paper makes a paper a user of the theme, not
   * part of its lineage (Point Transformer V3), and one MoE mention in an
   * abstract does not make a channel-estimation paper about MoE. So:
   *  - title about the theme ("subject") -> `"topic"`;
   *  - theme only as a tool in the title or only in the abstract ->
   *    `null` by default (R2-11). Only with support admission enabled
   *    (`minSupport > 0`) is it `"provisional"`: kept only if, after the
   *    cross-node pass, at least `minSupport` on-topic NON-seed nodes
   *    link to it (`bfs.ts::confirmSupportAdmissions`);
   *  - no theme term at all -> `null`. Neither co-citation support nor
   *    the foundational allowlist (canonical ANCESTORS) applies.
   * With an embedding z-score (`relevance`): `(title about the theme AND
   * z >= zLo) OR z >= zHi` -> `"topic"`. */
  admitsDescendant(
    paper: TopicPaperLike,
    relevance?: number | null,
  ): "topic" | "provisional" | null {
    if (!this.options.gate) return "topic";
    const role = this.role(paper);
    if (typeof relevance === "number") {
      if (this.relevant(role === "subject", relevance)) return "topic";
      if (this.options.minSupport > 0 && role !== "none" && relevance >= this.options.zLo) {
        return "provisional";
      }
      return null;
    }
    if (role === "subject") return "topic";
    if (role === "none" || this.options.minSupport <= 0) return null;
    return "provisional";
  }
}

function stripUndefined<T extends object>(o: Partial<T>): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}

// ---- offline re-application to a published artifact ----

export interface ArtifactNodeLike extends TopicPaperLike {
  id: string;
  is_focus?: boolean;
}

export interface OfflineAdmission {
  kept: { id: string; title: string; reason: string }[];
  /** `support` = distinct on-topic NON-focus neighbours; `rule` says
   * which gate turned the node away. */
  dropped: { id: string; title: string; support: number; rule: string }[];
  /** Root the new rule would pick among the surviving focus nodes. */
  root: string | null;
  previousRoot: string | null;
}

/**
 * Re-apply the admission gate to an already-built lineage (eval only —
 * the real graph is rebuilt in CI). Mirrors the live rules:
 *  - a node that cites a focus node but is not cited by one (a
 *    descendant: a newer paper citing a seed) needs a title about the
 *    theme, or a theme mention elsewhere plus non-focus support
 *    ({@link TopicScope.admitsDescendant});
 *  - any other node is admitted by a theme-term match or the
 *    foundational allowlist, or else by support: at least `minSupport`
 *    distinct on-topic NON-focus neighbours (the live build confirms
 *    support after the cross-node pass the same way — two seeds citing
 *    the same generic paper is not enough);
 *  - focus nodes are kept; non-focus nodes left with no edge to a kept
 *    node are dropped, mirroring `pruneEdgelessNodes`.
 * The artifact carries only a TL;DR/short abstract (the live BFS matches
 * the full abstract), so this under-estimates topic matches.
 */
export function reapplyAdmission(
  artifact: { root?: unknown; nodes: ArtifactNodeLike[]; edges: { src: string; dst: string }[] },
  scope: TopicScope,
): OfflineAdmission {
  const byId = new Map(artifact.nodes.map((n) => [n.id, n]));
  const isFocus = (id: string): boolean => byId.get(id)?.is_focus === true;
  const neighbours = new Map<string, Set<string>>();
  const incident = new Map<string, { src: string; dst: string }[]>();
  for (const e of artifact.edges) {
    for (const id of [e.src, e.dst]) {
      if (!neighbours.has(id)) neighbours.set(id, new Set());
      if (!incident.has(id)) incident.set(id, []);
    }
    neighbours.get(e.src)!.add(e.dst);
    neighbours.get(e.dst)!.add(e.src);
    incident.get(e.src)!.push(e);
    if (e.dst !== e.src) incident.get(e.dst)!.push(e);
  }
  // At the CI depth of 1 a non-focus node entered either as a reference
  // of a seed (edge node -> focus) or as a paper citing a seed (edge
  // focus -> node); cross-node edges among non-focus nodes do not change
  // how it entered.
  const isDescendantOnly = (id: string): boolean => {
    const es = incident.get(id) ?? [];
    const citesSeed = es.some((e) => e.dst === id && isFocus(e.src));
    const citedBySeed = es.some((e) => e.src === id && isFocus(e.dst));
    return citesSeed && !citedBySeed;
  };
  const reason = new Map<string, string>();
  const rule = new Map<string, string>();
  const onTopicNonFocus = new Set<string>();
  /** Descendants with the theme only in the abstract / as a tool. */
  const provisional = new Set<string>();
  for (const n of artifact.nodes) {
    if (n.is_focus === true) {
      reason.set(n.id, `focus(${scope.role(n)})`);
      continue;
    }
    if (isDescendantOnly(n.id)) {
      const why = scope.admitsDescendant(n);
      if (why === "topic") {
        reason.set(n.id, "topic(descendant)");
        onTopicNonFocus.add(n.id);
      } else if (why === "provisional") {
        provisional.add(n.id);
      } else {
        rule.set(n.id, `descendant(${scope.role(n)})`);
      }
      continue;
    }
    const why = scope.admits(n, 0);
    if (why !== null) {
      reason.set(n.id, why);
      if (why === "topic") onTopicNonFocus.add(n.id);
    }
  }
  // One pass, like the live build: only on-topic NON-focus nodes lend
  // support, and a node admitted by support does not lend support.
  const supportOf = (id: string): number =>
    [...(neighbours.get(id) ?? [])].filter((x) => onTopicNonFocus.has(x)).length;
  for (const n of artifact.nodes) {
    if (reason.has(n.id) || rule.has(n.id)) continue;
    if (provisional.has(n.id)) {
      if (scope.supportSuffices(supportOf(n.id))) reason.set(n.id, "support(descendant)");
      else rule.set(n.id, `descendant(${scope.role(n)})`);
      continue;
    }
    if (scope.admits(n, supportOf(n.id)) !== null) reason.set(n.id, "support");
    else rule.set(n.id, looksLikeDataset(n) ? "support(dataset)" : "support");
  }
  // Prune non-focus nodes with no edge to another kept node.
  for (let changed = true; changed; ) {
    changed = false;
    for (const [id] of reason) {
      if (isFocus(id)) continue;
      const linked = [...(neighbours.get(id) ?? [])].some((x) => x !== id && reason.has(x));
      if (!linked) {
        reason.delete(id);
        rule.set(id, "edgeless");
        changed = true;
      }
    }
  }
  const kept = artifact.nodes
    .filter((n) => reason.has(n.id))
    .map((n) => ({ id: n.id, title: str(n.title), reason: reason.get(n.id)! }));
  const dropped = artifact.nodes
    .filter((n) => !reason.has(n.id))
    .map((n) => ({
      id: n.id,
      title: str(n.title),
      support: supportOf(n.id),
      rule: rule.get(n.id) ?? "support",
    }));
  const keptIds = new Set(kept.map((k) => k.id));
  const keptEdges = artifact.edges.filter((e) => keptIds.has(e.src) && keptIds.has(e.dst));
  const focus = artifact.nodes.filter((n) => n.is_focus === true).map((n) => n.id);
  const root = pickTopicalRoot(focus, keptEdges, byId, scope);
  return {
    kept,
    dropped,
    root,
    previousRoot: typeof artifact.root === "string" ? artifact.root : null,
  };
}

/** Root among `seedIds`: highest {@link TopicScope.rootRank}, then most
 * edges to on-topic nodes, then most edges, then graph-ID ascending. */
export function pickTopicalRoot(
  seedIds: readonly string[],
  edges: readonly { src: string; dst: string }[],
  papers: ReadonlyMap<string, TopicPaperLike>,
  scope: TopicScope,
): string | null {
  if (seedIds.length === 0) return null;
  const onTopic = (id: string): boolean => {
    const p = papers.get(id);
    return p !== undefined && scope.isOnTopic(p);
  };
  const degree = new Map<string, number>();
  const topicalDegree = new Map<string, number>();
  for (const e of edges) {
    for (const [self, other] of [
      [e.src, e.dst],
      [e.dst, e.src],
    ] as const) {
      degree.set(self, (degree.get(self) ?? 0) + 1);
      if (onTopic(other)) topicalDegree.set(self, (topicalDegree.get(self) ?? 0) + 1);
    }
  }
  const key = (id: string): number[] => {
    const p = papers.get(id);
    return [p ? scope.rootRank(p) : 0, topicalDegree.get(id) ?? 0, degree.get(id) ?? 0];
  };
  let best: string | null = null;
  let bestKey: number[] = [];
  for (const id of [...new Set(seedIds)].sort(codepointCompare)) {
    const k = key(id);
    if (best === null || lexGreater(k, bestKey)) {
      best = id;
      bestKey = k;
    }
  }
  return best;
}

function lexGreater(a: number[], b: number[]): boolean {
  for (let i = 0; i < a.length; i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  }
  return false;
}
