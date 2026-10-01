"""Build-scoped completeness tracking for the lineage builders.

The builders' failure mode this exists to remove: an upstream outage was
indistinguishable from "there is genuinely nothing there", so a transient
S2/OpenAlex failure could publish an empty or degenerate ``lineage.json``
over a good one, and the loss survived the outage.

Two surfaces, deliberately treated differently:

* **Subject resolution** — resolving what the artifact is *about* (the
  conference's Oral focus papers, a theme's discovered seeds, a deep
  build's single seed). An incomplete subject set means the artifact
  would misrepresent its own subject, so this is a hard gate: the build
  refuses to replace the published file and exits non-zero.
* **Graph expansion** — the references/citations traversal outward from
  the resolved subjects. A 300-node graph missing one node's parents is
  still worth publishing, so expansion failures are counted and recorded
  rather than fatal. They become fatal only when the result is both
  known-incomplete and worse than what is already published.

State is threaded explicitly through call arguments. It is deliberately
NOT a module global or a contextvar: ``--auto-expand`` runs two builds in
one process, and tests call the builders repeatedly in-process, so
implicit state would leak between runs.
"""

from __future__ import annotations

from dataclasses import dataclass, field


class IncompleteFetchError(RuntimeError):
    """Base for "this answer is missing data because a request failed".

    Distinct from a definitive absence (the Work is deleted, the id does
    not exist), which is a fact about the data and may be recorded.
    ``S2TransientError`` and ``OpenAlexTransientError`` derive from this
    so a caller can catch the concept rather than each provider.
    """


class IncompleteBuildError(RuntimeError):
    """Raised instead of publishing when a gate refuses the artifact.

    The builders' CLIs turn this into a non-zero exit with the message
    on stderr. It is raised BEFORE the atomic replace, so the previously
    published artifact is still in place when it propagates.
    """


@dataclass
class BuildCompleteness:
    """Per-build tally. One instance per builder invocation."""

    #: Reasons subject resolution could not be completed. Non-empty means
    #: the artifact must not be published at all.
    subject_failures: list[str] = field(default_factory=list)
    expansions_attempted: int = 0
    expansions_failed: int = 0
    #: Failures of an optional source that tops up an already-resolved
    #: subject (the legacy S2 path's OpenAlex seed top-up). Like an
    #: expansion failure they thin the artifact without misstating what
    #: it is about, so they are recorded and gate only on shrinkage.
    supplement_failures: list[str] = field(default_factory=list)

    # ---- recording ----

    def subject_failed(self, reason: str) -> None:
        self.subject_failures.append(reason)

    def expansion_attempted(self) -> None:
        self.expansions_attempted += 1

    def expansion_failed(self, reason: str | None = None) -> None:
        self.expansions_failed += 1

    def supplement_failed(self, reason: str) -> None:
        self.supplement_failures.append(reason)

    # ---- querying ----

    @property
    def subject_complete(self) -> bool:
        return not self.subject_failures

    @property
    def expansion_complete(self) -> bool:
        return self.expansions_failed == 0

    @property
    def complete(self) -> bool:
        """Nothing optional was lost: no expansion and no supplement failed."""
        return self.expansion_complete and not self.supplement_failures

    def loss_summary(self) -> str:
        parts = []
        if not self.expansion_complete:
            parts.append(
                f"{self.expansions_failed} of {self.expansions_attempted} expansion(s) failed"
            )
        if self.supplement_failures:
            parts.append(f"{len(self.supplement_failures)} supplementary source request(s) failed")
        return " and ".join(parts)

    def as_meta(self) -> dict[str, object]:
        """The ``meta.completeness`` block written into the artifact.

        ``complete`` is derived here and never set independently, so it
        cannot drift from the counters beside it. Note that nothing in
        ``_lineage_contract`` re-checks the relation after the artifact
        is written — the guarantee is this method, not a validator.
        """
        return {
            "complete": self.complete,
            "expansions_attempted": self.expansions_attempted,
            "expansions_failed": self.expansions_failed,
            "supplement_failures": list(self.supplement_failures),
        }

    def subject_gate_message(self) -> str:
        head = (
            f"subject resolution incomplete: {len(self.subject_failures)} "
            "request(s) failed for a reason that does not prove absence"
        )
        shown = self.subject_failures[:5]
        more = len(self.subject_failures) - len(shown)
        body = "\n  ".join(shown)
        tail = f"\n  ... and {more} more" if more > 0 else ""
        return f"{head}:\n  {body}{tail}"


class UnreadablePublishedArtifactError(RuntimeError):
    """Something is published at the path but its size cannot be read.

    Distinct from "nothing is published there", which is a fact and lets
    a sparse first build through. This one means the gate cannot tell
    whether it is about to shrink a good artifact.
    """


def _published_graph(path) -> tuple[list, list] | None:
    """``(nodes, edges)`` of the artifact at ``path``, read and checked once.

    Returns ``None`` only for the one case that is a genuine fact:
    nothing is published there yet. A file that exists but cannot be
    parsed, or that carries no ``nodes`` or ``edges`` array, raises
    ``UnreadablePublishedArtifactError`` — collapsing that into the same
    ``None`` would be this module's own bug in miniature, letting a
    known-incomplete build overwrite an artifact precisely because the
    artifact could not be inspected.
    """
    import json
    from pathlib import Path

    p = Path(path)
    try:
        raw = p.read_text(encoding="utf-8")
    except FileNotFoundError:
        return None
    except OSError as exc:
        raise UnreadablePublishedArtifactError(f"{p} could not be read: {exc}") from exc
    try:
        data = json.loads(raw)
    except ValueError as exc:
        raise UnreadablePublishedArtifactError(f"{p} is not valid JSON: {exc}") from exc
    nodes = data.get("nodes") if isinstance(data, dict) else None
    if not isinstance(nodes, list):
        raise UnreadablePublishedArtifactError(f"{p} carries no nodes array")
    # Edges are counted too: an expansion failure that loses citations
    # without losing papers leaves the node count untouched, so a
    # node-only comparison let a 10-node/5-edge result replace a
    # 10-node/20-edge one while reporting no regression.
    edges = data.get("edges")
    if not isinstance(edges, list):
        # Same rule as `nodes`, and the lineage contract requires both:
        # an absent key means this is not one of our artifacts, so the
        # comparison baseline would silently become zero and every edge
        # regression would read as "no regression".
        raise UnreadablePublishedArtifactError(f"{p} carries no edges array")
    return nodes, edges


def published_graph_size(path) -> tuple[int, int] | None:
    """``(node count, edge count)`` of the artifact at ``path``; see
    :func:`_published_graph` for the error contract."""
    graph = _published_graph(path)
    if graph is None:
        return None
    nodes, edges = graph
    return len(nodes), len(edges)


def focus_ids(nodes: list) -> set[str]:
    """Ids of the ``is_focus`` nodes — the papers the artifact is about."""
    return {
        node["id"]
        for node in nodes
        if isinstance(node, dict) and node.get("is_focus") is True and isinstance(node.get("id"), str)
    }


def _node_ids(nodes: list) -> set[str]:
    return {n["id"] for n in nodes if isinstance(n, dict) and isinstance(n.get("id"), str)}


def _edge_keys(edges: list) -> set[tuple[str, str]]:
    # Keyed by endpoints only: a re-classification may legitimately change
    # an edge's relation, which is not a lost edge.
    return {
        (e["src"], e["dst"])
        for e in edges
        if isinstance(e, dict) and isinstance(e.get("src"), str) and isinstance(e.get("dst"), str)
    }


def _dropped(kind: str, missing: set) -> str:
    shown = ", ".join(sorted(map(str, missing))[:3])
    more = ", ..." if len(missing) > 3 else ""
    return f"{len(missing)} published {kind} missing from the result ({shown}{more})"


def expansion_gate_blocks(
    completeness: BuildCompleteness,
    *,
    new_node_count: int,
    new_edge_count: int,
    published_path,
    new_nodes: list | None = None,
    new_edges: list | None = None,
) -> str | None:
    """Return a reason to refuse publication, or None to allow it.

    Only fires when an expansion or a supplementary source actually failed. A build whose every
    expansion succeeded publishes whatever it produced, including a
    genuinely smaller graph — that is real data, not an outage.
    """
    if completeness.complete:
        return None
    lost = completeness.loss_summary()
    try:
        graph = _published_graph(published_path)
    except UnreadablePublishedArtifactError as exc:
        return (
            f"{lost} and the "
            f"published artifact cannot be inspected to tell whether this "
            f"would shrink it ({exc}). Refusing to publish a known-incomplete "
            "build over something unreadable; re-run when the upstream "
            "recovers, or pass --allow-incomplete."
        )
    if graph is None:
        # Nothing published yet: there is nothing to regress, so a
        # sparse first build is better than none.
        return None
    prev_nodes, prev_edges = len(graph[0]), len(graph[1])
    if new_nodes is not None and new_edges is not None:
        # Totals alone let a known-incomplete build trade content for
        # content: one surviving seed can expand into as many nodes as
        # five did, a same-size focus swap reads as "no regression", and a
        # branch lost to a failed expansion can be offset by growth
        # elsewhere. Everything already published must survive.
        for kind, missing in (
            ("focus paper(s)", focus_ids(graph[0]) - focus_ids(new_nodes)),
            ("node(s)", _node_ids(graph[0]) - _node_ids(new_nodes)),
            ("edge(s)", _edge_keys(graph[1]) - _edge_keys(new_edges)),
        ):
            if missing:
                return (
                    f"{lost} and {_dropped(kind, missing)}. Refusing to replace "
                    "published content on a known-incomplete fetch; re-run when "
                    "the upstream recovers, or pass --allow-incomplete."
                )
    if new_node_count < prev_nodes or new_edge_count < prev_edges:
        return (
            f"{lost} and the "
            f"result has {new_node_count} node(s)/{new_edge_count} edge(s) "
            f"against the published {prev_nodes}/{prev_edges}. Refusing to "
            "replace a larger artifact with a smaller one produced by a "
            "known-incomplete fetch; re-run when the upstream recovers, or "
            "pass --allow-incomplete."
        )
    return None
