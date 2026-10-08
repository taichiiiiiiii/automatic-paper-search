/**
 * Build-scoped completeness tracking for the lineage builders — TS port of
 * `paperpilot/scripts/_fetch_state.py`.
 *
 * The builders' failure mode this exists to remove: an upstream outage was
 * indistinguishable from "there is genuinely nothing there", so a
 * transient S2/OpenAlex failure could publish an empty or degenerate
 * `lineage.json` over a good one, and the loss survived the outage.
 *
 * Two surfaces, deliberately treated differently:
 *
 * - **Subject resolution** — resolving what the artifact is *about* (the
 *   conference's Oral focus papers, a theme's discovered seeds, a deep
 *   build's single seed). An incomplete subject set means the artifact
 *   would misrepresent its own subject, so this is a hard gate: the build
 *   refuses to replace the published file and exits non-zero.
 * - **Graph expansion** — the references/citations traversal outward from
 *   the resolved subjects. A 300-node graph missing one node's parents is
 *   still worth publishing, so expansion failures are counted and
 *   recorded rather than fatal. They become fatal only when the result is
 *   both known-incomplete and worse than what is already published.
 *
 * State is threaded explicitly through call arguments (a `BuildCompleteness`
 * instance passed around), mirroring the Python original's dataclass. It
 * is deliberately NOT a module-level singleton: `--auto-expand` runs two
 * builds in one process, and tests call the builders repeatedly in the
 * same process, so implicit shared state would leak between runs.
 *
 * Safety contracts: LIN-01 (subject gate), LIN-02 (expansion/supplement
 * gate), LIN-03 (unreadable published artifact is not an absent one),
 * LIN-04 (`meta.completeness` is derived from the counters, never set
 * independently).
 */

import { readFileSync } from "node:fs";

/** Base for "this answer is missing data because a request failed".
 *
 * Distinct from a definitive absence (the Work is deleted, the id does
 * not exist), which is a fact about the data and may be recorded as such.
 * Provider-specific transient errors should extend this so a caller can
 * catch the concept rather than each provider's own error class.
 */
export class IncompleteFetchError extends Error {}

/** Raised instead of publishing when a gate refuses the artifact.
 *
 * The builders' CLIs turn this into a non-zero exit with the message on
 * stderr. It must be thrown BEFORE the atomic replace, so the previously
 * published artifact is still in place when it propagates.
 */
export class IncompleteBuildError extends Error {}

/** Something is published at the path but its size cannot be read.
 *
 * Distinct from "nothing is published there", which is a fact and lets a
 * sparse first build through. This one means the gate cannot tell whether
 * it is about to shrink a good artifact.
 */
export class UnreadablePublishedArtifactError extends Error {}

/** Per-build tally. One instance per builder invocation. */
export class BuildCompleteness {
  /** Reasons subject resolution could not be completed. Non-empty means
   * the artifact must not be published at all. */
  readonly subjectFailures: string[];
  expansionsAttempted: number;
  expansionsFailed: number;
  /** Failures of an optional source that tops up an already-resolved
   * subject (the legacy S2 path's OpenAlex seed top-up). Like an
   * expansion failure they thin the artifact without misstating what it
   * is about, so they are recorded and gate only on shrinkage. */
  readonly supplementFailures: string[];

  constructor(init?: {
    subjectFailures?: readonly string[];
    expansionsAttempted?: number;
    expansionsFailed?: number;
    supplementFailures?: readonly string[];
  }) {
    this.subjectFailures = init?.subjectFailures ? [...init.subjectFailures] : [];
    this.expansionsAttempted = init?.expansionsAttempted ?? 0;
    this.expansionsFailed = init?.expansionsFailed ?? 0;
    this.supplementFailures = init?.supplementFailures ? [...init.supplementFailures] : [];
  }

  // ---- recording ----

  subjectFailed(reason: string): void {
    this.subjectFailures.push(reason);
  }

  expansionAttempted(): void {
    this.expansionsAttempted += 1;
  }

  /** `reason` is accepted for parity with the Python signature (unused
   * there too — the per-failure reason isn't tallied, only the count). */
  expansionFailed(_reason?: string | null): void {
    this.expansionsFailed += 1;
  }

  supplementFailed(reason: string): void {
    this.supplementFailures.push(reason);
  }

  // ---- querying ----

  get subjectComplete(): boolean {
    return this.subjectFailures.length === 0;
  }

  get expansionComplete(): boolean {
    return this.expansionsFailed === 0;
  }

  /** Nothing optional was lost: no expansion and no supplement failed. */
  get complete(): boolean {
    return this.expansionComplete && this.supplementFailures.length === 0;
  }

  lossSummary(): string {
    const parts: string[] = [];
    if (!this.expansionComplete) {
      parts.push(`${this.expansionsFailed} of ${this.expansionsAttempted} expansion(s) failed`);
    }
    if (this.supplementFailures.length > 0) {
      parts.push(`${this.supplementFailures.length} supplementary source request(s) failed`);
    }
    return parts.join(" and ");
  }

  /** The `meta.completeness` block written into the artifact.
   *
   * `complete` is derived here and never set independently, so it cannot
   * drift from the counters beside it. Note that nothing downstream
   * re-checks the relation after the artifact is written — the guarantee
   * is this method, not a validator. */
  asMeta(): {
    complete: boolean;
    expansions_attempted: number;
    expansions_failed: number;
    supplement_failures: string[];
  } {
    return {
      complete: this.complete,
      expansions_attempted: this.expansionsAttempted,
      expansions_failed: this.expansionsFailed,
      supplement_failures: [...this.supplementFailures],
    };
  }

  subjectGateMessage(): string {
    const head =
      `subject resolution incomplete: ${this.subjectFailures.length} ` +
      "request(s) failed for a reason that does not prove absence";
    const shown = this.subjectFailures.slice(0, 5);
    const more = this.subjectFailures.length - shown.length;
    const body = shown.join("\n  ");
    const tail = more > 0 ? `\n  ... and ${more} more` : "";
    return `${head}:\n  ${body}${tail}`;
  }
}

/** `[nodes, edges]` of the artifact at `path`, read and checked once.
 *
 * Returns `null` only for the one case that is a genuine fact: nothing is
 * published there yet. A file that exists but cannot be parsed, or that
 * carries no `nodes` or `edges` array, throws
 * `UnreadablePublishedArtifactError` — collapsing that into the same
 * `null` would be this module's own bug in miniature, letting a
 * known-incomplete build overwrite an artifact precisely because the
 * artifact could not be inspected.
 */
function publishedGraph(path: string): [unknown[], unknown[]] | null {
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch (exc) {
    const err = exc as NodeJS.ErrnoException;
    if (err.code === "ENOENT") {
      return null;
    }
    throw new UnreadablePublishedArtifactError(`${path} could not be read: ${String(exc)}`);
  }
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (exc) {
    throw new UnreadablePublishedArtifactError(`${path} is not valid JSON: ${String(exc)}`);
  }
  const nodes =
    data !== null && typeof data === "object" && !Array.isArray(data)
      ? (data as Record<string, unknown>).nodes
      : undefined;
  if (!Array.isArray(nodes)) {
    throw new UnreadablePublishedArtifactError(`${path} carries no nodes array`);
  }
  // Edges are counted too: an expansion failure that loses citations
  // without losing papers leaves the node count untouched, so a
  // node-only comparison let a 10-node/5-edge result replace a
  // 10-node/20-edge one while reporting no regression.
  const edges = (data as Record<string, unknown>).edges;
  if (!Array.isArray(edges)) {
    // Same rule as `nodes`, and the lineage contract requires both: an
    // absent key means this is not one of our artifacts, so the
    // comparison baseline would silently become zero and every edge
    // regression would read as "no regression".
    throw new UnreadablePublishedArtifactError(`${path} carries no edges array`);
  }
  return [nodes, edges];
}

/** `[node count, edge count]` of the artifact at `path`; see
 * `publishedGraph` for the error contract. */
export function publishedGraphSize(path: string): [number, number] | null {
  const graph = publishedGraph(path);
  if (graph === null) {
    return null;
  }
  const [nodes, edges] = graph;
  return [nodes.length, edges.length];
}

/** Ids of the `is_focus` nodes — the papers the artifact is about. */
export function focusIds(nodes: readonly unknown[]): Set<string> {
  const out = new Set<string>();
  for (const node of nodes) {
    if (
      node !== null &&
      typeof node === "object" &&
      (node as Record<string, unknown>).is_focus === true &&
      typeof (node as Record<string, unknown>).id === "string"
    ) {
      out.add((node as Record<string, unknown>).id as string);
    }
  }
  return out;
}

function nodeIds(nodes: readonly unknown[]): Set<string> {
  const out = new Set<string>();
  for (const n of nodes) {
    if (
      n !== null &&
      typeof n === "object" &&
      typeof (n as Record<string, unknown>).id === "string"
    ) {
      out.add((n as Record<string, unknown>).id as string);
    }
  }
  return out;
}

function edgeKeys(edges: readonly unknown[]): Set<string> {
  // Keyed by endpoints only: a re-classification may legitimately change
  // an edge's relation, which is not a lost edge. Python keys by the
  // tuple (src, dst); we join with a separator that cannot appear in a
  // valid paper id (both are checked to be strings beforehand) to get an
  // equivalent hashable key.
  const out = new Set<string>();
  for (const e of edges) {
    if (
      e !== null &&
      typeof e === "object" &&
      typeof (e as Record<string, unknown>).src === "string" &&
      typeof (e as Record<string, unknown>).dst === "string"
    ) {
      out.add(`${(e as Record<string, unknown>).src}\u0000${(e as Record<string, unknown>).dst}`);
    }
  }
  return out;
}

function setDifference<T>(a: ReadonlySet<T>, b: ReadonlySet<T>): Set<T> {
  const out = new Set<T>();
  for (const x of a) {
    if (!b.has(x)) out.add(x);
  }
  return out;
}

function dropped(kind: string, missing: ReadonlySet<string>): string {
  const sorted = [...missing].map(String).sort();
  const shown = sorted.slice(0, 3).join(", ");
  const more = missing.size > 3 ? ", ..." : "";
  return `${missing.size} published ${kind} missing from the result (${shown}${more})`;
}

export interface ExpansionGateInput {
  newNodeCount: number;
  newEdgeCount: number;
  publishedPath: string;
  newNodes?: readonly unknown[] | null;
  newEdges?: readonly unknown[] | null;
}

/** Return a reason to refuse publication, or `null` to allow it.
 *
 * Only fires when an expansion or a supplementary source actually
 * failed. A build whose every expansion succeeded publishes whatever it
 * produced, including a genuinely smaller graph — that is real data, not
 * an outage.
 */
export function expansionGateBlocks(
  completeness: BuildCompleteness,
  { newNodeCount, newEdgeCount, publishedPath, newNodes, newEdges }: ExpansionGateInput,
): string | null {
  if (completeness.complete) {
    return null;
  }
  const lost = completeness.lossSummary();
  let graph: [unknown[], unknown[]] | null;
  try {
    graph = publishedGraph(publishedPath);
  } catch (exc) {
    if (exc instanceof UnreadablePublishedArtifactError) {
      return (
        `${lost} and the published artifact cannot be inspected to tell ` +
        `whether this would shrink it (${exc.message}). Refusing to ` +
        "publish a known-incomplete build over something unreadable; " +
        "re-run when the upstream recovers, or pass --allow-incomplete."
      );
    }
    throw exc;
  }
  if (graph === null) {
    // Nothing published yet: there is nothing to regress, so a sparse
    // first build is better than none.
    return null;
  }
  const [prevNodes, prevEdges] = [graph[0].length, graph[1].length];
  if (newNodes != null && newEdges != null) {
    // Totals alone let a known-incomplete build trade content for
    // content: one surviving seed can expand into as many nodes as five
    // did, a same-size focus swap reads as "no regression", and a branch
    // lost to a failed expansion can be offset by growth elsewhere.
    // Everything already published must survive.
    const checks: [string, Set<string>][] = [
      ["focus paper(s)", setDifference(focusIds(graph[0]), focusIds(newNodes))],
      ["node(s)", setDifference(nodeIds(graph[0]), nodeIds(newNodes))],
      ["edge(s)", setDifference(edgeKeys(graph[1]), edgeKeys(newEdges))],
    ];
    for (const [kind, missing] of checks) {
      if (missing.size > 0) {
        return (
          `${lost} and ${dropped(kind, missing)}. Refusing to replace ` +
          "published content on a known-incomplete fetch; re-run when the " +
          "upstream recovers, or pass --allow-incomplete."
        );
      }
    }
  }
  if (newNodeCount < prevNodes || newEdgeCount < prevEdges) {
    return (
      `${lost} and the result has ${newNodeCount} node(s)/${newEdgeCount} ` +
      `edge(s) against the published ${prevNodes}/${prevEdges}. Refusing ` +
      "to replace a larger artifact with a smaller one produced by a " +
      "known-incomplete fetch; re-run when the upstream recovers, or pass " +
      "--allow-incomplete."
    );
  }
  return null;
}
