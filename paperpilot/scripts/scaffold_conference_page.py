"""Scaffold docs/<slug>/index.html for a new conference catalog page.

Derives the page from the canonical no-lineage catalog template
(docs/cvpr-2026/index.html) by substituting the conference identifiers and the
hero lede, and writes an empty docs/<slug>/lineage.json so the viewer's
optional lineage probe resolves 200 instead of logging a 404. Run this AFTER
build_pages.py has written docs/<slug>/papers.json.

Using the live cvpr-2026 page as the template (rather than a separate copy)
means structural / first-timer-UX improvements to the catalog automatically
flow into newly scaffolded conferences.

Usage:
    uv run python -m paperpilot.scripts.scaffold_conference_page \\
        --conference neurips-2026 --display "NeurIPS 2026" \\
        --lede "The Conference on Neural Information Processing Systems。arXiv 上で NeurIPS 2026 採択と明記された投稿を自動収集した一覧です。キーワード検索・トピックタグ・並び替えで気になる論文をすぐに見つけられます。"
"""

from __future__ import annotations

import argparse
import json
import re
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
DOCS = ROOT / "docs"
TEMPLATE_CONF = "cvpr-2026"
TEMPLATE_DISPLAY = "CVPR 2026"

_LEDE_RE = re.compile(r'(<p class="hero__lede">).*?(</p>)', re.DOTALL)

_EMPTY_LINEAGE_NOTE = (
    "Lineage not generated for this conference; the catalog list works "
    "without it. The empty file keeps the viewer's optional lineage probe "
    "at 200 instead of 404."
)


def scaffold(conference: str, display: str, lede: str, *, docs_root: Path | None = None) -> Path:
    """Write docs/<conference>/index.html (+ empty lineage.json). Returns the html path."""
    docs = docs_root if docs_root is not None else DOCS
    if conference == TEMPLATE_CONF:
        raise ValueError(f"refusing to overwrite the template conference '{TEMPLATE_CONF}'")

    template = (docs / TEMPLATE_CONF / "index.html").read_text(encoding="utf-8")
    html = template.replace(TEMPLATE_DISPLAY, display).replace(TEMPLATE_CONF, conference)

    html, n = _LEDE_RE.subn(rf"\g<1>\n      {lede}\n    \g<2>", html)
    if n != 1:
        raise RuntimeError(f"expected exactly one hero__lede block in template, replaced {n}")

    out_dir = docs / conference
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "index.html").write_text(html, encoding="utf-8")

    lineage: dict[str, Any] = {
        "root": None,
        "nodes": [],
        "edges": [],
        "meta": {"source": "none", "conference": conference, "note": _EMPTY_LINEAGE_NOTE},
    }
    (out_dir / "lineage.json").write_text(
        json.dumps(lineage, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    return out_dir / "index.html"


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--conference", required=True, help="slug, e.g. neurips-2026")
    ap.add_argument("--display", required=True, help='display name, e.g. "NeurIPS 2026"')
    ap.add_argument("--lede", required=True, help="hero lede sentence(s); may contain inline HTML")
    args = ap.parse_args()

    out = scaffold(args.conference, args.display, args.lede)
    print(f"✅ wrote {out} (+ lineage.json)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
