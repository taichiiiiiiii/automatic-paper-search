"""Generate expected-output fixtures for packages/core/src/slug/theme.ts from
the real Python `paperpilot/scripts/_common.py::theme_slug`.

Run with:
  uv run --extra dev python packages/core/test/slug/fixtures/gen.py

The output (theme-slug-cases.json, committed) is consumed by
packages/core/test/slug/theme.test.ts, which also compares the same probe
battery against `worker/slug.js`'s `themeSlug()` (3-way parity: Python <->
packages/core <-> the CF Worker), per docs/migration/p4-followups.md #25.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[5]
sys.path.insert(0, str(REPO_ROOT))

from paperpilot.scripts._common import theme_slug  # noqa: E402

PROBES = [
    "Mixture of Experts",
    "Direct-Preference-Optimization",
    "Vision_Transformer",
    "Vision    Transformer",
    "  Diffusion Model  ",
    "RLHF",
    "BERT 2018",
    "Reinforcement Learning from Human Feedback",
    "Retrieval-Augmented Generation",
    "../../etc/passwd",
    "MoE モデル",  # "MoE モデル"
    "モデル",  # pure CJK, no ASCII fallback
    "",
    "   ",
    "a" * 200,
    "a" * 64,
    "Café Résumé",  # combining marks via NFKD
    "100% Attention!!",
    "under_score---many---hyphens",
    "-leading and trailing-",
    "Tabs\tand\nNewlines",
    "Mixed CASE Input",
    "emoji \U0001f600 theme",
    "a",
    "0",
    "----",
]


def main() -> None:
    results = []
    for probe in PROBES:
        try:
            slug = theme_slug(probe)
            results.append({"input": probe, "slug": slug, "error": False})
        except ValueError:
            results.append({"input": probe, "slug": None, "error": True})

    out_path = Path(__file__).resolve().with_name("theme-slug-cases.json")
    out_path.write_text(json.dumps(results, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"wrote {len(results)} cases to {out_path}")


if __name__ == "__main__":
    main()
