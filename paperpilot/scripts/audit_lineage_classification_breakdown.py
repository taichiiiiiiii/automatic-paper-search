"""Audit edge classification distribution by provenance bucket.

Built for issue #285 step 1: before the LLM relation prompt is rewritten,
quantify whether the LLM itself is the bottleneck for the absent
``supersedes`` / ``ablation`` / ``successor`` / ``baseline_only`` edges,
or whether the bias comes from upstream sources (foundational
allowlist, heuristic templates).

Five provenance buckets (new 5-enum closed set, post PR #290):

* **context_pattern** — unarXive citation-context regex matched.
* **intent_map** — S2 intent label matched ``_INTENT_RELATION_MAP``; also
  the normalized bucket for legacy ``heuristic-template`` edges whose
  rationale is ``TEMPLATE_RATIONALES["successor_result"]``.
* **year_cite** — year / citation-count contrast heuristic; also the
  normalized bucket for legacy ``heuristic-template`` edges whose rationale
  is ``TEMPLATE_RATIONALES["contrasts_year_cite"]``.
* **foundational_allowlist** — title matched
  ``lineage_foundational_allowlist.json``; normalizes legacy ``foundational``
  edges (recognized by the canonical rationale fragment
  "canonical research-lineage").
* **llm** — LLM provider returned a valid classification (or anything else
  that doesn't match the above categories).

For **new** lineage.json files (post PR #290) the ``provenance`` field is
read directly from each edge dict.  For **legacy** files (no ``provenance``
field) a rationale-string fallback normalizes the old 3-bucket values into
the new 5-enum set.

Also reads ``paperpilot/data/lineage-cache/classifications.json`` (the
persistent LLM call cache) to expand the measurement window beyond the
two published themes, giving the prompt-rewrite decision a larger
denominator.

Usage:

    uv run python -m paperpilot.scripts.audit_lineage_classification_breakdown
    uv run python -m paperpilot.scripts.audit_lineage_classification_breakdown --json

Exit code is always 0 — this is a read-only audit, not a CI gate.
"""

from __future__ import annotations

import argparse
import json
import sys
from collections import Counter
from pathlib import Path

from paperpilot.llm.base import TEMPLATE_RATIONALES

REPO_ROOT = Path(__file__).resolve().parents[2]
THEMES_DIR = REPO_ROOT / "docs" / "themes"
CLASSIFICATIONS_CACHE = (
    REPO_ROOT / "paperpilot" / "data" / "lineage-cache" / "classifications.json"
)

# Min rationale length below which we treat a cache entry as a stale
# malformed record (from an older code version). The current prompt
# demands "30-200 chars" so anything below 30 is suspect.
_MIN_WELLFORMED_RATIONALE_CHARS = 30

# Ordered stable 5-enum closed set for provenance buckets (post PR #290).
# Used to initialize all Counters up-front and to iterate in fixed order.
_NEW_ENUMS: tuple[str, ...] = (
    "context_pattern",
    "intent_map",
    "year_cite",
    "foundational_allowlist",
    "llm",
)

# Legacy rationale-string → new enum normalization map.
# Covers ALL 6 heuristic templates in TEMPLATE_RATIONALES, not just the 2
# post-#283 survivors: pre-#283 lineage.json files may still carry edges
# with `supersedes_year_cite` / `ablation_year_cite` / etc. rationales
# from the era before the dead-path removal. Without an explicit mapping
# those edges would silently fall into the "llm" bucket and inflate it.
# Code-reviewer MEDIUM (#285 PR2).
# Drift-guard test asserts BOTH subset (keys ⊆ TEMPLATE_RATIONALES.values())
# AND completeness (every TEMPLATE_RATIONALES value has a mapping).
_LEGACY_TEMPLATE_TO_ENUM: dict[str, str] = {
    TEMPLATE_RATIONALES["extends_methodology"]: "intent_map",
    TEMPLATE_RATIONALES["successor_result"]: "intent_map",
    TEMPLATE_RATIONALES["baseline_only_background"]: "intent_map",
    TEMPLATE_RATIONALES["contrasts_year_cite"]: "year_cite",
    TEMPLATE_RATIONALES["supersedes_year_cite"]: "year_cite",
    TEMPLATE_RATIONALES["ablation_year_cite"]: "year_cite",
}

# Module-level dedup for the forward-compat warning. Without this we'd
# emit one stderr line per edge with an unknown provenance, polluting
# CI logs. Code-reviewer MEDIUM (#285 PR2).
_warned_provenance_values: set[str] = set()


def _classify_edge_provenance(edge: dict) -> str:
    """Classify one lineage edge into the 5-enum provenance bucket.

    Field-first: if ``edge["provenance"]`` is present and is a known enum
    value it is returned as-is.  Unknown future values (forward-compat) are
    passed through after emitting a warning to stderr.

    Fallback for legacy lineage.json files (no ``provenance`` field):
    normalizes the old 3-bucket rationale-based classification into the new
    5-enum set.
    """
    field = edge.get("provenance")
    if field:
        # Dedup: warn once per unknown value across the whole audit run
        # (a 200-edge lineage with a new enum would otherwise produce
        # 200 identical warnings).
        if field not in _NEW_ENUMS and field not in _warned_provenance_values:
            _warned_provenance_values.add(field)
            print(
                f"WARNING: unknown provenance value {field!r} — "
                "forward-compat passthrough; update _NEW_ENUMS if "
                "this is a new intentional enum.",
                file=sys.stderr,
            )
        return str(field)

    # Legacy fallback: derive bucket from rationale string.
    rationale: str = edge.get("rationale", "") or ""

    if "canonical research-lineage" in rationale:
        return "foundational_allowlist"

    if rationale in _LEGACY_TEMPLATE_TO_ENUM:
        return _LEGACY_TEMPLATE_TO_ENUM[rationale]

    return "llm"


def _audit_published_themes() -> dict:
    """Per-provenance relation counts across published lineage.json files."""
    per_provenance_rel: dict[str, Counter[str]] = {enum: Counter() for enum in _NEW_ENUMS}
    per_theme: dict[str, dict[str, dict[str, int]]] = {}

    theme_dirs = sorted(p for p in THEMES_DIR.iterdir() if p.is_dir())
    for theme_dir in theme_dirs:
        lineage_path = theme_dir / "lineage.json"
        if not lineage_path.exists():
            continue
        data = json.loads(lineage_path.read_text(encoding="utf-8"))
        theme_breakdown: dict[str, Counter[str]] = {enum: Counter() for enum in _NEW_ENUMS}
        for edge in data.get("edges", []):
            relation = edge.get("rel", "unknown")
            provenance = _classify_edge_provenance(edge)
            # Forward-compat: if _classify_edge_provenance returned a
            # known-but-future enum value (warned to stderr at first
            # sight), add the bucket on demand. Without setdefault the
            # increment would KeyError because we only pre-initialized
            # _NEW_ENUMS keys. Code-reviewer HIGH (#285 PR2).
            theme_breakdown.setdefault(provenance, Counter())[relation] += 1
            per_provenance_rel.setdefault(provenance, Counter())[relation] += 1
        per_theme[theme_dir.name] = {
            p: dict(c) for p, c in theme_breakdown.items() if c
        }

    # Preserve the canonical 5-enum order in the output, then append
    # any future enums that came in via the forward-compat path so they
    # remain visible in the report.
    canonical_then_future = list(_NEW_ENUMS) + [
        p for p in per_provenance_rel if p not in _NEW_ENUMS
    ]
    return {
        "per_theme": per_theme,
        "per_provenance_rel": {
            p: dict(per_provenance_rel[p]) for p in canonical_then_future
        },
    }


def _audit_classifications_cache() -> dict:
    """Distribution across the persistent LLM call cache.

    Wider denominator than the published lineage — captures every LLM
    call ever cached, including edges that were ultimately not published
    (e.g. dropped at the foundational-allowlist short-circuit).
    """
    if not CLASSIFICATIONS_CACHE.exists():
        return {"available": False}

    cache = json.loads(CLASSIFICATIONS_CACHE.read_text(encoding="utf-8"))
    wellformed_rel: Counter[str] = Counter()
    short_rel: Counter[str] = Counter()
    unrelated = 0
    # #310: tally entries per producing LLM ("name:model") so a mixed-
    # provider cache (post Groq->Gemini regen) is attributable. Entries
    # written before the field existed lack a ``model`` key and fall into
    # the "(legacy/none)" bucket — useful to see how much of the cache
    # predates the provenance work.
    by_model: Counter[str] = Counter()

    for value in cache.values():
        if not isinstance(value, dict):
            continue
        by_model[value.get("model") or "(legacy/none)"] += 1
        relation = value.get("relation")
        rationale = (value.get("rationale") or "").strip()
        if relation == "unrelated":
            unrelated += 1
            continue
        if not relation:
            continue
        if len(rationale) >= _MIN_WELLFORMED_RATIONALE_CHARS:
            wellformed_rel[relation] += 1
        else:
            short_rel[relation] += 1

    return {
        "available": True,
        "total_entries": len(cache),
        "unrelated_dropped": unrelated,
        "wellformed_rel": dict(wellformed_rel),
        "short_rationale_rel": dict(short_rel),
        "by_model": dict(by_model),
    }


def _percent_table(counter_dict: dict[str, int]) -> dict[str, str]:
    total = sum(counter_dict.values())
    if total == 0:
        return {}
    return {
        k: f"{v} ({v * 100 / total:.1f}%)"
        for k, v in sorted(counter_dict.items(), key=lambda kv: -kv[1])
    }


def _print_human(published: dict, cache: dict) -> None:
    print("=== Published lineage (docs/themes/*/lineage.json) ===")
    for provenance in _NEW_ENUMS:
        rel_counts = published["per_provenance_rel"].get(provenance, {})
        total = sum(rel_counts.values())
        print(f"\n[{provenance}] n={total}")
        for rel, descr in _percent_table(rel_counts).items():
            print(f"  {rel}: {descr}")

    if cache.get("available"):
        print(
            "\n=== Persistent LLM cache "
            "(paperpilot/data/lineage-cache/classifications.json) ==="
        )
        print(
            f"total entries: {cache['total_entries']} "
            f"(unrelated dropped: {cache['unrelated_dropped']})"
        )
        wf = cache["wellformed_rel"]
        print(f"\n[wellformed >= {_MIN_WELLFORMED_RATIONALE_CHARS} chars] n={sum(wf.values())}")
        for rel, descr in _percent_table(wf).items():
            print(f"  {rel}: {descr}")
        sh = cache["short_rationale_rel"]
        if sh:
            print(f"\n[short < {_MIN_WELLFORMED_RATIONALE_CHARS} chars (stale?)] n={sum(sh.values())}")
            for rel, descr in _percent_table(sh).items():
                print(f"  {rel}: {descr}")
        # #310: per-producer tally so a mixed-provider cache stays auditable.
        bm = cache.get("by_model", {})
        if bm:
            print(f"\n[by model (#310)] n={sum(bm.values())}")
            for model, descr in _percent_table(bm).items():
                print(f"  {model}: {descr}")
    else:
        print("\n(classifications cache not present)")

    print("\n=== Diagnosis ===")
    llm_pub = published["per_provenance_rel"].get("llm", {})
    if llm_pub:
        pub_total = sum(llm_pub.values())
        pub_missing = [
            r for r in (
                "supersedes",
                "ablation",
                "baseline_only",
                "successor",
            )
            if llm_pub.get(r, 0) == 0
        ]
        if pub_missing:
            print(
                f"Published LLM-only subset (n={pub_total}): "
                f"{', '.join(pub_missing)} = 0 emits."
            )
    if cache.get("available"):
        wf = cache["wellformed_rel"]
        cache_missing = [
            r for r in ("supersedes", "ablation") if wf.get(r, 0) == 0
        ]
        if cache_missing:
            print(
                f"Persistent LLM cache wellformed (n={sum(wf.values())}): "
                f"{', '.join(cache_missing)} = 0 emits across all cached calls. "
                f"Prompt is the bottleneck for these relations."
            )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--json",
        action="store_true",
        help="Emit machine-readable JSON instead of the human report.",
    )
    args = parser.parse_args()

    published = _audit_published_themes()
    cache = _audit_classifications_cache()

    if args.json:
        print(json.dumps({"published": published, "cache": cache}, indent=2, ensure_ascii=False))
    else:
        _print_human(published, cache)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
