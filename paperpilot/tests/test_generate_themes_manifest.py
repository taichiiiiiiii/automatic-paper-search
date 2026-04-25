"""Tests for paperpilot/scripts/generate_themes_manifest.py.

The themes manifest indexes ``docs/themes/<slug>/lineage.json`` files
so the picker in ``docs/themes/index.html`` can populate. It is
generated from filesystem state to avoid lost-update races between
multiple parallel ``build_theme_lineage.py`` runs.
"""

from __future__ import annotations

import json
from pathlib import Path

from paperpilot.scripts import generate_themes_manifest as gm

# ---- fixtures ----


def _write_theme_json(
    themes_dir: Path,
    slug: str,
    *,
    theme: str | None = None,
    nodes: list[dict] | None = None,
    edges: list[dict] | None = None,
    generated_at: str = "2026-04-25T00:00:00+00:00",
    keywords: list[str] | None = None,
    seeds: list[str] | None = None,
) -> Path:
    """Write a minimal but realistic docs/themes/<slug>/lineage.json."""
    payload = {
        "root": (nodes[0]["id"] if nodes else None),
        "nodes": nodes or [
            {
                "id": "p1",
                "title": "Stub paper",
                "year": 2020,
                "venue": "NeurIPS",
                "venue_tier": "A+",
                "authors": ["A"],
                "kinds": [],
                "citation_count": 100,
                "github_stars": 0,
                "tldr": "",
                "is_focus": True,
            }
        ],
        "edges": edges or [],
        "meta": {
            "source": "build_theme_lineage.py",
            "theme": theme if theme is not None else slug.replace("-", " ").title(),
            "slug": slug,
            "keywords": keywords or [],
            "seeds": seeds or [],
            "depth": 1,
            "since_year": None,
            "generated_at": generated_at,
        },
    }
    target_dir = themes_dir / slug
    target_dir.mkdir(parents=True, exist_ok=True)
    path = target_dir / "lineage.json"
    path.write_text(json.dumps(payload, ensure_ascii=False))
    return path


# ---- generate_manifest ----


def test_generate_manifest_empty_dir_returns_empty_list(tmp_path: Path) -> None:
    assert gm.generate_manifest(tmp_path) == []


def test_generate_manifest_single_theme(tmp_path: Path) -> None:
    _write_theme_json(
        tmp_path,
        "mixture-of-experts",
        theme="Mixture of Experts",
        nodes=[
            {
                "id": "p1",
                "title": "Original MoE",
                "year": 2017,
                "venue": "NeurIPS",
                "venue_tier": "A+",
                "authors": ["A"],
                "kinds": [],
                "citation_count": 1000,
                "github_stars": 0,
                "tldr": "",
                "is_focus": True,
            }
        ],
    )
    entries = gm.generate_manifest(tmp_path)
    assert len(entries) == 1
    e = entries[0]
    assert e["slug"] == "mixture-of-experts"
    assert e["theme"] == "Mixture of Experts"
    assert e["paper_count"] == 1
    assert e["year_range"] == [2017, 2017]
    assert e["generated_at"].startswith("2026-04-25")


def test_generate_manifest_multiple_themes_sorted_by_slug(tmp_path: Path) -> None:
    _write_theme_json(tmp_path, "rag", theme="RAG")
    _write_theme_json(tmp_path, "diffusion", theme="Diffusion Models")
    _write_theme_json(tmp_path, "mixture-of-experts", theme="Mixture of Experts")
    entries = gm.generate_manifest(tmp_path)
    assert [e["slug"] for e in entries] == [
        "diffusion",
        "mixture-of-experts",
        "rag",
    ]


def test_generate_manifest_year_range_spans_all_nodes(tmp_path: Path) -> None:
    _write_theme_json(
        tmp_path,
        "moe",
        nodes=[
            {"id": "a", "title": "A", "year": 1991, "is_focus": True},
            {"id": "b", "title": "B", "year": 2017, "is_focus": False},
            {"id": "c", "title": "C", "year": 2024, "is_focus": False},
        ],
    )
    [entry] = gm.generate_manifest(tmp_path)
    assert entry["year_range"] == [1991, 2024]
    assert entry["paper_count"] == 3


def test_generate_manifest_year_range_handles_missing_years(tmp_path: Path) -> None:
    """Nodes with year=None must not crash min/max — they are excluded."""
    _write_theme_json(
        tmp_path,
        "moe",
        nodes=[
            {"id": "a", "title": "A", "year": None, "is_focus": True},
            {"id": "b", "title": "B", "year": 2017, "is_focus": False},
        ],
    )
    [entry] = gm.generate_manifest(tmp_path)
    assert entry["year_range"] == [2017, 2017]


def test_generate_manifest_year_range_null_when_no_years(tmp_path: Path) -> None:
    _write_theme_json(
        tmp_path,
        "moe",
        nodes=[{"id": "a", "title": "A", "year": None, "is_focus": True}],
    )
    [entry] = gm.generate_manifest(tmp_path)
    assert entry["year_range"] is None


def test_generate_manifest_skips_invalid_slug(tmp_path: Path) -> None:
    """meta.slug that contains forbidden characters is rejected — it would
    not satisfy the SLUG_RE check on the client side and could enable path
    traversal."""
    # Write a theme JSON whose meta.slug is hostile but whose dir name is safe.
    target = tmp_path / "moe"
    target.mkdir()
    (target / "lineage.json").write_text(
        json.dumps(
            {
                "root": "p1",
                "nodes": [{"id": "p1", "title": "x", "is_focus": True}],
                "edges": [],
                "meta": {
                    "source": "build_theme_lineage.py",
                    "theme": "Hostile",
                    "slug": "../../escape",
                    "keywords": [],
                    "seeds": [],
                    "depth": 1,
                    "since_year": None,
                    "generated_at": "2026-04-25T00:00:00+00:00",
                },
            }
        )
    )
    entries = gm.generate_manifest(tmp_path)
    # Hostile meta.slug rejected → fall back to dir name "moe" which IS valid.
    assert len(entries) == 1
    assert entries[0]["slug"] == "moe"


def test_generate_manifest_skips_invalid_rel_in_edges(tmp_path: Path) -> None:
    """An edge with a `rel` outside the allowed enum should cause the theme
    to be skipped. This guards against cache-poisoning via committed
    theme JSONs (security review M3)."""
    _write_theme_json(
        tmp_path,
        "moe",
        edges=[
            {
                "src": "p1",
                "dst": "p2",
                "rel": "MALICIOUS_RELATION",
                "conf": 1.0,
                "rationale": "x",
            }
        ],
    )
    _write_theme_json(tmp_path, "rag", theme="RAG")
    entries = gm.generate_manifest(tmp_path)
    # moe is skipped; only rag survives.
    assert [e["slug"] for e in entries] == ["rag"]


def test_generate_manifest_accepts_all_allowed_rel_values(tmp_path: Path) -> None:
    allowed = [
        "supersedes",
        "successor",
        "extends",
        "ablation",
        "baseline_only",
        "contrasts",
    ]
    edges = [
        {"src": "p1", "dst": "p2", "rel": r, "conf": 0.5, "rationale": "x"}
        for r in allowed
    ]
    _write_theme_json(tmp_path, "moe", edges=edges)
    entries = gm.generate_manifest(tmp_path)
    assert len(entries) == 1


def test_generate_manifest_ignores_unrelated_files(tmp_path: Path) -> None:
    _write_theme_json(tmp_path, "moe")
    (tmp_path / "themes-manifest.json").write_text("[]")  # the manifest itself
    (tmp_path / "stray-file.json").write_text("{}")
    (tmp_path / "subdir").mkdir()
    (tmp_path / "subdir" / "not-a-lineage.json").write_text("{}")
    entries = gm.generate_manifest(tmp_path)
    assert [e["slug"] for e in entries] == ["moe"]


def test_generate_manifest_skips_unreadable_json(tmp_path: Path) -> None:
    bad_dir = tmp_path / "bad"
    bad_dir.mkdir()
    (bad_dir / "lineage.json").write_text("not valid json")
    _write_theme_json(tmp_path, "ok", theme="OK")
    entries = gm.generate_manifest(tmp_path)
    assert [e["slug"] for e in entries] == ["ok"]


# ---- write_manifest ----


def test_write_manifest_creates_file(tmp_path: Path) -> None:
    _write_theme_json(tmp_path, "moe", theme="MoE")
    out = gm.write_manifest(tmp_path)
    assert out == tmp_path / "themes-manifest.json"
    data = json.loads(out.read_text())
    assert len(data) == 1
    assert data[0]["slug"] == "moe"


def test_write_manifest_overwrites_existing(tmp_path: Path) -> None:
    (tmp_path / "themes-manifest.json").write_text('[{"stale": true}]')
    _write_theme_json(tmp_path, "moe", theme="MoE")
    gm.write_manifest(tmp_path)
    data = json.loads((tmp_path / "themes-manifest.json").read_text())
    assert len(data) == 1
    assert data[0]["slug"] == "moe"


def test_write_manifest_empty_produces_empty_array(tmp_path: Path) -> None:
    gm.write_manifest(tmp_path)
    data = json.loads((tmp_path / "themes-manifest.json").read_text())
    assert data == []


# ---- CLI ----


def test_main_accepts_themes_dir_argument(tmp_path: Path) -> None:
    _write_theme_json(tmp_path, "moe", theme="MoE")
    rc = gm.main(["--themes-dir", str(tmp_path)])
    assert rc == 0
    assert (tmp_path / "themes-manifest.json").exists()


def test_main_returns_nonzero_when_dir_does_not_exist(tmp_path: Path) -> None:
    missing = tmp_path / "does-not-exist"
    rc = gm.main(["--themes-dir", str(missing)])
    assert rc != 0
