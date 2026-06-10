"""Audit edge classification distribution by provenance bucket.

Built for issue #285 step 1: before the LLM relation prompt is rewritten,
quantify whether the LLM itself is the bottleneck for the absent
``supersedes`` / ``ablation`` / ``successor`` / ``baseline_only`` edges,
or whether the bias comes from upstream sources (foundational
allowlist, heuristic templates).

Three provenance buckets:

* **foundational** — emitted by ``_foundational_ancestor_edge`` and
  recognised here by the canonical rationale fragment
  "canonical research-lineage ancestor". Always emits ``extends`` —
  the count tells you how much of the published distribution is
  hardcoded.
* **heuristic-template** — rationale matches a value in
  ``TEMPLATE_RATIONALES``. Post-#283 only ``contrasts_year_cite`` and
  ``successor_result`` survive in production; the others were rejected
  by ``_TEMPLATE_RATIONALES_SET``.
* **llm** — anything else. These are the only edges where the prompt
  actually controls the relation choice.

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


def _is_foundational(rationale: str) -> bool:
    """Detect the foundational allowlist edge rationale fragment.

    Source: ``_lineage_classify._foundational_ancestor_edge`` always
    embeds the phrase "canonical research-lineage ancestor" in the
    rationale it emits. Detection is rationale-based instead of provenance-
    field-based because the lineage.json schema doesn't persist provenance
    explicitly.
    """
    return "canonical research-lineage" in rationale


def _is_heuristic_template(rationale: str) -> bool:
    """Detect a heuristic-emitted template rationale."""
    return rationale in set(TEMPLATE_RATIONALES.values())


def _classify_edge_provenance(rationale: str) -> str:
    if _is_foundational(rationale):
        return "foundational"
    if _is_heuristic_template(rationale):
        return "heuristic-template"
    return "llm"


def _audit_published_themes() -> dict:
    """Per-provenance relation counts across published lineage.json files."""
    per_provenance_rel: dict[str, Counter[str]] = {
        "foundational": Counter(),
        "heuristic-template": Counter(),
        "llm": Counter(),
    }
    per_theme: dict[str, dict[str, dict[str, int]]] = {}

    theme_dirs = sorted(p for p in THEMES_DIR.iterdir() if p.is_dir())
    for theme_dir in theme_dirs:
        lineage_path = theme_dir / "lineage.json"
        if not lineage_path.exists():
            continue
        data = json.loads(lineage_path.read_text(encoding="utf-8"))
        theme_breakdown: dict[str, Counter[str]] = {
            "foundational": Counter(),
            "heuristic-template": Counter(),
            "llm": Counter(),
        }
        for edge in data.get("edges", []):
            rationale = edge.get("rationale", "") or ""
            relation = edge.get("rel", "unknown")
            provenance = _classify_edge_provenance(rationale)
            theme_breakdown[provenance][relation] += 1
            per_provenance_rel[provenance][relation] += 1
        per_theme[theme_dir.name] = {
            p: dict(c) for p, c in theme_breakdown.items() if c
        }

    return {
        "per_theme": per_theme,
        "per_provenance_rel": {
            p: dict(c) for p, c in per_provenance_rel.items()
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

    for value in cache.values():
        if not isinstance(value, dict):
            continue
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
    for provenance, rel_counts in published["per_provenance_rel"].items():
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
