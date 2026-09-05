"""Scaffold docs/<slug>/index.html for a new conference catalog page.

Derives the page from the canonical no-lineage catalog template
(docs/cvpr-2026/index.html) by substituting the conference identifiers and the
hero lede, and writes an empty docs/<slug>/lineage.json that satisfies the
strict lineage-artifact-v1 contract (schema_version, root null, empty
nodes/edges/clusters, meta) so the viewer's optional lineage probe resolves
200 instead of logging a 404. The stub is self-validated with the shared
contract validator before it is written. Run this AFTER build_pages.py has
written docs/<slug>/papers.json.

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
import html as html_module
import json
import re
from pathlib import Path
from typing import Any

from paperpilot.scripts._lineage_contract import (
    LINEAGE_ARTIFACT_VERSION,
    validate_lineage_artifact,
)

ROOT = Path(__file__).resolve().parents[2]
DOCS = ROOT / "docs"
TEMPLATE_CONF = "cvpr-2026"
TEMPLATE_DISPLAY = "CVPR 2026"

_LEDE_RE = re.compile(r'(<p class="hero__lede">).*?(</p>)', re.DOTALL)
_CONFERENCE_RE = re.compile(r"^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])$")
_RESERVED_CONFERENCE_PATHS = frozenset(
    {
        TEMPLATE_CONF,
        "assets",
        "daily",
        "design",
        "how-it-works",
        "paper-details-v1",
        "paper-slides-v1",
        "research",
        "search-paper-ids-v1",
        "themes",
    }
)

_EMPTY_LINEAGE_NOTE = (
    "Lineage not generated for this conference; the catalog list works "
    "without it. The empty file keeps the viewer's optional lineage probe "
    "at 200 instead of 404."
)
_PRODUCER_NAME = "paperpilot.scripts.scaffold_conference_page"


def _empty_lineage(conference: str) -> dict[str, Any]:
    """Build the contract-valid empty lineage stub without guessing any paper.

    An empty graph must keep ``root`` null and nodes/edges/clusters empty;
    fabricating a root or seed identity is forbidden by the v1 contract.
    """

    lineage: dict[str, Any] = {
        "schema_version": LINEAGE_ARTIFACT_VERSION,
        "root": None,
        "nodes": [],
        "edges": [],
        "clusters": [],
        "meta": {
            "kind": "conference",
            "generator": _PRODUCER_NAME,
            "source": "none",
            "conference": conference,
            "note": _EMPTY_LINEAGE_NOTE,
        },
    }
    issues = validate_lineage_artifact(lineage, kind="conference")
    if issues:
        detail = "; ".join(f"{issue.code}:{issue.path}" for issue in issues[:8])
        raise ValueError(f"empty lineage stub violates {LINEAGE_ARTIFACT_VERSION}: {detail}")
    return lineage


def scaffold(conference: str, display: str, lede: str, *, docs_root: Path | None = None) -> Path:
    """Write docs/<conference>/index.html (+ empty lineage.json). Returns the html path."""
    docs = docs_root if docs_root is not None else DOCS
    if not _CONFERENCE_RE.fullmatch(conference):
        raise ValueError(
            "conference slug must be 2-40 lowercase letters/digits/hyphens "
            "and start/end with a letter or digit"
        )
    if conference in _RESERVED_CONFERENCE_PATHS:
        raise ValueError(f"conference slug {conference!r} is a reserved public path")

    out_dir = docs / conference
    if (out_dir / "index.html").exists() or (out_dir / "lineage.json").exists():
        raise FileExistsError(f"refusing to overwrite an existing conference page: {conference}")

    template = (docs / TEMPLATE_CONF / "index.html").read_text(encoding="utf-8")
    # TEMPLATE_DISPLAY occurs in both text and quoted attribute values. Escaping
    # quotes therefore matters even when a future template adds another context.
    display_html = html_module.escape(display, quote=True)
    lede_html = html_module.escape(lede, quote=True)
    html = template.replace(TEMPLATE_DISPLAY, display_html).replace(TEMPLATE_CONF, conference)

    # A callable replacement keeps backslashes such as ``\g<1>`` in operator
    # input literal instead of interpreting them as regex backreferences.
    html, n = _LEDE_RE.subn(
        lambda match: f"{match.group(1)}\n      {lede_html}\n    {match.group(2)}", html
    )
    if n != 1:
        raise RuntimeError(f"expected exactly one hero__lede block in template, replaced {n}")

    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "index.html").write_text(html, encoding="utf-8")

    lineage = _empty_lineage(conference)
    (out_dir / "lineage.json").write_text(
        json.dumps(lineage, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    return out_dir / "index.html"


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--conference", required=True, help="slug, e.g. neurips-2026")
    ap.add_argument("--display", required=True, help='display name, e.g. "NeurIPS 2026"')
    ap.add_argument("--lede", required=True, help="hero lede sentence(s), plain text")
    args = ap.parse_args()

    out = scaffold(args.conference, args.display, args.lede)
    print(f"✅ wrote {out} (+ lineage.json)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
