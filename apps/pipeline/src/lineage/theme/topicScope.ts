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
   * cited by it). */
  minSupport: number;
  /** Admit foundational-allowlist papers regardless of topic (they are
   * the canonical ancestors the allowlist exists for). */
  admitFoundational: boolean;
  /** Seed-ranking multiplier for a seed whose title uses the theme only
   * as a method component ("... with Graph Neural Networks"). */
  componentSeedWeight: number;
  /** Seed-ranking multiplier for a seed that matches only in its abstract. */
  abstractOnlySeedWeight: number;
}

export const DEFAULT_TOPIC_SCOPE_OPTIONS: Readonly<TopicScopeOptions> = Object.freeze({
  gate: true,
  minSupport: 2,
  admitFoundational: true,
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
 * Language Models" are about the theme. */
const COMPONENT_CONNECTOR_RE =
  /\b(?:with|using|via|by|through|leveraging|utili[sz]ing|employing|based\s+on|powered\s+by|equipped\s+with)\s*$/i;

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

const STOP_FOR_INITIALISM = new Set(["a", "an", "the"]);

/** Every normalised term that counts as "this paper mentions the theme". */
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
      if (bare.length >= 3 && uppers >= 2) addPhrase(out, bare);
    }
  }
  // Initialism of 3+ letters ("Graph Neural Network" -> "gnn", "Mixture
  // of Experts" -> "moe"). Two-letter initialisms ("VT", "FA") are too
  // ambiguous to use.
  const words = normalizeTopicText(theme)
    .trim()
    .split(" ")
    .filter((w) => w && !STOP_FOR_INITIALISM.has(w));
  if (words.length >= 3) addPhrase(out, words.map((w) => w[0]).join(""));
  return [...out].sort();
}

/** Index of the first term occurrence in `normText` (a
 * {@link normalizeTopicText} result), or -1. */
function firstMatch(normText: string, terms: readonly string[]): number {
  let best = -1;
  for (const term of terms) {
    const at = normText.indexOf(` ${term} `);
    if (at !== -1 && (best === -1 || at < best)) best = at;
  }
  return best;
}

export class TopicScope {
  readonly theme: string;
  readonly terms: readonly string[];
  readonly options: Readonly<TopicScopeOptions>;

  constructor(
    theme: string,
    aliases: readonly string[],
    options: Partial<TopicScopeOptions> = {},
    extraTerms: readonly string[] = [],
  ) {
    this.theme = theme;
    this.terms = themeTerms(theme, aliases, extraTerms);
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
    return firstMatch(normalizeTopicText(str(paper.title)), this.terms) !== -1;
  }

  /** Title, abstract, short abstract or TL;DR mentions a theme term. */
  isOnTopic(paper: TopicPaperLike): boolean {
    if (this.matchesTitle(paper)) return true;
    return firstMatch(normalizeTopicText(bodyText(paper)), this.terms) !== -1;
  }

  /** Subject / component / abstract-only / none — see {@link TopicRole}. */
  role(paper: TopicPaperLike): TopicRole {
    const title = str(paper.title);
    if (this.matchesTitle(paper)) {
      // Find where the first term starts in the ORIGINAL title so the
      // connector test sees the real preceding words.
      const lower = title.toLowerCase();
      let cut = -1;
      for (const term of this.terms) {
        const re = new RegExp(
          `(?:^|[^\\p{L}\\p{N}])${term.split(" ").join("[^\\p{L}\\p{N}]+")}(?![\\p{L}\\p{N}])`,
          "iu",
        );
        const m = re.exec(lower);
        if (m && (cut === -1 || m.index < cut)) cut = m.index;
      }
      if (cut > 0) {
        // Only the clause the term sits in: "SuperGlue: Learning ... With GNNs".
        const before = title.slice(0, cut + 1);
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

  /** Why `paper` may join the graph, or `null` when it may not.
   * `support` = number of distinct already-admitted on-topic nodes that
   * link to it. */
  admits(paper: TopicPaperLike, support: number): "topic" | "foundational" | "support" | null {
    if (!this.options.gate) return "topic";
    if (this.isOnTopic(paper)) return "topic";
    if (
      this.options.admitFoundational &&
      isFoundationalAncestor(paper as Record<string, unknown>)
    ) {
      return "foundational";
    }
    if (support >= this.options.minSupport) return "support";
    return null;
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
  dropped: { id: string; title: string; support: number }[];
  /** Root the new rule would pick among the surviving focus nodes. */
  root: string | null;
  previousRoot: string | null;
}

/**
 * Re-apply the admission gate to an already-built lineage (eval only —
 * the real graph is rebuilt in CI). Focus nodes are kept but must
 * themselves be on-topic to lend support. Support is counted over the
 * artifact's own edges only (the live BFS also sees citations that never
 * became edges, so it can find more support), and the artifact carries
 * only a TL;DR/short abstract (the live BFS matches the full abstract),
 * so this under-estimates what a rebuild keeps. Nodes left with no edge
 * to a kept node are dropped too, mirroring `pruneEdgelessNodes`.
 */
export function reapplyAdmission(
  artifact: { root?: unknown; nodes: ArtifactNodeLike[]; edges: { src: string; dst: string }[] },
  scope: TopicScope,
): OfflineAdmission {
  const byId = new Map(artifact.nodes.map((n) => [n.id, n]));
  const neighbours = new Map<string, Set<string>>();
  for (const e of artifact.edges) {
    if (!neighbours.has(e.src)) neighbours.set(e.src, new Set());
    if (!neighbours.has(e.dst)) neighbours.set(e.dst, new Set());
    neighbours.get(e.src)!.add(e.dst);
    neighbours.get(e.dst)!.add(e.src);
  }
  const reason = new Map<string, string>();
  const onTopicAdmitted = new Set<string>();
  for (const n of artifact.nodes) {
    if (n.is_focus === true) {
      reason.set(n.id, `focus(${scope.role(n)})`);
      if (scope.isOnTopic(n)) onTopicAdmitted.add(n.id);
      continue;
    }
    const why = scope.admits(n, 0);
    if (why !== null) {
      reason.set(n.id, why);
      if (why === "topic") onTopicAdmitted.add(n.id);
    }
  }
  // One pass, like the live BFS: only on-topic nodes lend support, and a
  // node admitted by support does not lend support in turn.
  const supportOf = (id: string): number =>
    [...(neighbours.get(id) ?? [])].filter((x) => onTopicAdmitted.has(x)).length;
  for (const n of artifact.nodes) {
    if (reason.has(n.id)) continue;
    if (scope.admits(n, supportOf(n.id)) !== null) reason.set(n.id, "support");
  }
  // Prune non-focus nodes with no edge to another kept node.
  for (let changed = true; changed; ) {
    changed = false;
    for (const [id] of reason) {
      if (byId.get(id)?.is_focus === true) continue;
      const linked = [...(neighbours.get(id) ?? [])].some((x) => reason.has(x));
      if (!linked) {
        reason.delete(id);
        changed = true;
      }
    }
  }
  const kept = artifact.nodes
    .filter((n) => reason.has(n.id))
    .map((n) => ({ id: n.id, title: str(n.title), reason: reason.get(n.id)! }));
  const dropped = artifact.nodes
    .filter((n) => !reason.has(n.id))
    .map((n) => ({ id: n.id, title: str(n.title), support: supportOf(n.id) }));
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
