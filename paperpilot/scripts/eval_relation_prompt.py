"""Evaluate a relation classifier against the human-labeled gold set.

Issue #285 step 3+: computes precision / recall / macro-F1 of any
prediction column in ``paperpilot/tests/fixtures/relation_gold_set.jsonl``
against the ``gold_rel`` field.

Two modes:

* ``--predictor=current`` (default) reads the static ``current_rel``
  field from the fixture — this is the snapshot of what the LLM emitted
  for each pair under the current prompt. Use this to establish the
  baseline macro-F1 without spending any LLM tokens.
* ``--predictor=live`` calls ``provider.classify_relation`` for each
  pair using the parent/child {title, year, abstract} bundled in the
  fixture, then scores the live response. Use this to measure a
  prompt rewrite before merging.

Live mode accepts an optional ``--provider`` flag:

* ``--provider=auto`` (default) selects the first available provider
  using the same priority logic as ``build_lineage`` (Groq → Gemini).
* ``--provider=groq`` forces Groq; raises if ``PAPERPILOT_GROQ_API_KEY``
  is absent.
* ``--provider=gemini`` forces Gemini; raises if
  ``PAPERPILOT_GEMINI_API_KEY`` is absent.

Note: ``--provider=claude`` is intentionally excluded until PR-B adds
``ClaudeProvider.classify_relation``.

Usage:

    uv run python -m paperpilot.scripts.eval_relation_prompt
    uv run python -m paperpilot.scripts.eval_relation_prompt --predictor=live
    uv run python -m paperpilot.scripts.eval_relation_prompt --predictor=live --provider=gemini
    uv run python -m paperpilot.scripts.eval_relation_prompt --confidence=high

Exit code is 0 unless ``--gate-macro-f1=<float>`` is passed and the
score falls below it (CI gate use). Without the gate it's always 0.
"""

from __future__ import annotations

import argparse
import json
import sys
from collections import defaultdict
from collections.abc import Iterable
from pathlib import Path
from typing import Literal

REPO_ROOT = Path(__file__).resolve().parents[2]
FIXTURE = (
    REPO_ROOT / "paperpilot" / "tests" / "fixtures" / "relation_gold_set.jsonl"
)


def _load_records() -> list[dict]:
    records = []
    if not FIXTURE.exists():
        raise FileNotFoundError(
            f"gold fixture missing: {FIXTURE}. See issue #285 step 2."
        )
    for line in FIXTURE.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line:
            continue
        record = json.loads(line)
        if record.get("_doc"):
            continue
        records.append(record)
    return records


def _filter_by_confidence(
    records: list[dict],
    confidence: Literal["all", "high"],
) -> list[dict]:
    if confidence == "all":
        return records
    return [r for r in records if r["confidence"] == "high"]


def _predict_static(records: list[dict]) -> list[str | None]:
    """Read the snapshot ``current_rel`` field — no LLM call."""
    return [r["current_rel"] for r in records]


def _load_env_for_provider() -> dict:
    """Load .env secrets for provider construction.

    Extracted into its own function so tests can monkeypatch it without
    touching the real filesystem or environment.
    """
    from paperpilot.utils.config_loader import load_env

    return load_env(REPO_ROOT / "paperpilot" / ".env")


def _build_eval_provider(choice: str):  # -> AbstractLLMProvider
    """Return a configured LLM provider for the eval live predictor.

    Args:
        choice: One of ``"auto"``, ``"groq"``, ``"gemini"``.
                ``"claude"`` is intentionally excluded until PR-B.

    Returns:
        A concrete ``AbstractLLMProvider`` instance.

    Raises:
        ValueError: When *choice* is not a recognised value.
    """
    from paperpilot.llm.gemini_provider import GeminiProvider
    from paperpilot.llm.groq_provider import GroqProvider

    _base_cfg: dict = {"enabled": True, "temperature": 0.1, "timeout_seconds": 30}

    if choice == "auto":
        from paperpilot.scripts.build_lineage import build_provider

        provider, _delay = build_provider()
        return provider

    env = _load_env_for_provider()

    if choice == "groq":
        return GroqProvider(
            {**_base_cfg, "model": env.get("groq_model") or "llama-3.3-70b-versatile"},
            api_key=env.get("groq_api_key"),
        )

    if choice == "gemini":
        return GeminiProvider(
            {**_base_cfg, "model": env.get("gemini_model") or "gemini-2.5-flash"},
            api_key=env.get("gemini_api_key"),
        )

    raise ValueError(f"unknown provider: {choice!r}")


def _predict_live(
    records: list[dict],
    provider_choice: str = "auto",
) -> list[str | None]:
    """Run ``classify_relation`` against each pair via the live LLM.

    Args:
        records: Gold-set records with ``parent`` / ``child`` sub-dicts.
        provider_choice: Which provider to use — ``"auto"`` (default),
            ``"groq"``, or ``"gemini"``.  See module docstring for details.

    Raises:
        RuntimeError: When the chosen provider is disabled (missing API key).
    """
    provider = _build_eval_provider(provider_choice)

    if not provider.enabled:
        # When --provider=auto and no key is set, `_build_eval_provider`
        # raises from inside `build_lineage.build_provider()` before we
        # ever see a disabled provider here. The RuntimeError below
        # only fires for explicit choices, so naming the literal env
        # var is safe (we never reach this with provider_choice="auto").
        # Code-reviewer LOW: drop the misleading PAPERPILOT_AUTO_API_KEY
        # interpolation by listing the per-provider key directly.
        env_var = {
            "groq": "PAPERPILOT_GROQ_API_KEY",
            "gemini": "PAPERPILOT_GEMINI_API_KEY",
        }.get(provider_choice, "the provider's API key env var")
        raise RuntimeError(
            f"--provider={provider_choice} requested but the required "
            f"API key is missing in paperpilot/.env. Check {env_var}."
        )

    # Code-reviewer MEDIUM: surface which provider --provider=auto
    # resolved to so operators don't get silent cross-provider results.
    # Goes to stderr so machine-readable --json stays clean.
    print(
        f"[eval_relation_prompt] provider={provider.name} "
        f"(choice={provider_choice}, model={getattr(provider, 'model', '?')})",
        file=sys.stderr,
    )

    predictions: list[str | None] = []
    for record in records:
        a = {
            "title": record["parent"]["title"],
            "year": record["parent"]["year"],
            "abstract": record["parent"]["abstract"],
        }
        b = {
            "title": record["child"]["title"],
            "year": record["child"]["year"],
            "abstract": record["child"]["abstract"],
        }
        result = provider.classify_relation(a, b)
        predictions.append(result.relation if result is not None else None)
    return predictions


def _macro_f1(
    gold: Iterable[str],
    pred: Iterable[str | None],
) -> dict:
    """Compute per-class precision / recall / F1 plus macro averages.

    Records where ``pred`` is None (LLM call failed) count as a wrong
    answer for the gold class (precision/recall computed against gold).
    """
    gold_list = list(gold)
    pred_list = list(pred)
    assert len(gold_list) == len(pred_list)

    classes = sorted(set(gold_list) | {p for p in pred_list if p is not None})
    tp: dict[str, int] = defaultdict(int)
    fp: dict[str, int] = defaultdict(int)
    fn: dict[str, int] = defaultdict(int)

    for g, p in zip(gold_list, pred_list, strict=True):
        if p is None:
            fn[g] += 1
            continue
        if g == p:
            tp[g] += 1
        else:
            fp[p] += 1
            fn[g] += 1

    per_class: dict[str, dict[str, float | int]] = {}
    f1_sum = 0.0
    for cls in classes:
        prec_den = tp[cls] + fp[cls]
        rec_den = tp[cls] + fn[cls]
        precision = tp[cls] / prec_den if prec_den else 0.0
        recall = tp[cls] / rec_den if rec_den else 0.0
        f1 = (
            2 * precision * recall / (precision + recall)
            if (precision + recall) > 0
            else 0.0
        )
        per_class[cls] = {
            "tp": tp[cls],
            "fp": fp[cls],
            "fn": fn[cls],
            "precision": round(precision, 3),
            "recall": round(recall, 3),
            "f1": round(f1, 3),
        }
        f1_sum += f1

    accuracy = sum(1 for g, p in zip(gold_list, pred_list, strict=True) if g == p) / len(gold_list)
    macro_f1 = f1_sum / len(classes) if classes else 0.0
    return {
        "n": len(gold_list),
        "accuracy": round(accuracy, 3),
        "macro_f1": round(macro_f1, 3),
        "per_class": per_class,
    }


def _print_report(metrics: dict, predictor: str, confidence: str) -> None:
    print("=== relation prompt eval ===")
    print(f"predictor: {predictor}    confidence-filter: {confidence}")
    print(f"n: {metrics['n']}    accuracy: {metrics['accuracy']:.3f}    macro-F1: {metrics['macro_f1']:.3f}")
    print()
    print(f"{'class':<14} {'tp':>3} {'fp':>3} {'fn':>3}  {'prec':>5}  {'rec':>5}  {'f1':>5}")
    for cls, m in sorted(metrics["per_class"].items()):
        print(
            f"{cls:<14} "
            f"{m['tp']:>3} {m['fp']:>3} {m['fn']:>3}  "
            f"{m['precision']:>5.2f}  {m['recall']:>5.2f}  {m['f1']:>5.2f}"
        )


def _build_arg_parser() -> argparse.ArgumentParser:
    """Build and return the argument parser for this script.

    Extracted so tests can import and invoke it without calling ``main()``.
    """
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--predictor",
        choices=("current", "live"),
        default="current",
        help="current = static current_rel snapshot; live = call classify_relation now",
    )
    parser.add_argument(
        "--provider",
        choices=("auto", "groq", "gemini"),
        default="auto",
        help=(
            "Provider for --predictor=live. auto = first available (Groq→Gemini); "
            "groq / gemini = force that provider (key must be set in paperpilot/.env). "
            "claude is deferred to PR-B."
        ),
    )
    parser.add_argument(
        "--confidence",
        choices=("all", "high"),
        default="all",
        help="Filter gold records by confidence band.",
    )
    parser.add_argument(
        "--gate-macro-f1",
        type=float,
        default=None,
        help="If set, exit 1 when macro-F1 falls below this threshold (CI gate).",
    )
    parser.add_argument(
        "--json",
        action="store_true",
        help="Emit JSON metrics instead of the human report.",
    )
    return parser


def main() -> int:
    args = _build_arg_parser().parse_args()

    records = _filter_by_confidence(_load_records(), args.confidence)
    if not records:
        print("(no records after confidence filter)", file=sys.stderr)
        return 0

    if args.predictor == "current":
        predictions = _predict_static(records)
    else:
        predictions = _predict_live(records, provider_choice=args.provider)

    metrics = _macro_f1((r["gold_rel"] for r in records), predictions)

    if args.json:
        print(json.dumps(metrics, indent=2, ensure_ascii=False))
    else:
        _print_report(metrics, args.predictor, args.confidence)

    if args.gate_macro_f1 is not None and metrics["macro_f1"] < args.gate_macro_f1:
        print(
            f"\nGATE FAILED: macro-F1 {metrics['macro_f1']:.3f} < "
            f"{args.gate_macro_f1:.3f}",
            file=sys.stderr,
        )
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
