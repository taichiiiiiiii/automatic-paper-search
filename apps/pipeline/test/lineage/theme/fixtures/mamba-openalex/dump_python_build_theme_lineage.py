"""Parity fixture generator for the TS port of
`build_theme_lineage.py::build_theme_lineage` (OpenAlex-primary, P4d).

Runs the REAL Python `build_theme_lineage()` against the exact canned
OpenAlex `/works` bodies that
apps/pipeline/test/lineage/theme/build.parity.test.ts also defines (kept
in sync by hand — see that file's `work()` helper), with
`request_with_retry` monkeypatched (network never touched), GitHub-stars
enrichment stubbed to 0 (matching the Python test suite's own
`_stub_external_calls` convention: `_enrich_github_stars` has its own
HTTP client, not `request_with_retry`), a fixed clock
(`2026-06-04T00:00:00Z`), and the real
`docs/identity-aliases-v1.json` shadowed by a nonexistent path so the
build sees "absent -> {}" like the TS test's `identityAliasesPath`.
`llm_strict` is left at its "off" default (#53: ignores the provider
entirely), matching the TS test which passes no LLM provider.

Dumps the resulting `docs/themes/mamba/lineage.json` to
`expected-lineage.json` and `generate_themes_manifest.generate_manifest()`'s
output to `expected-manifest.json`.

This script is NOT part of the pipeline or its test suite; its only
consumer is apps/pipeline/test/lineage/theme/build.parity.test.ts, which
reads the committed `expected-*.json` files rather than re-running
Python. `python-requests.json` (the recorded Python request
sequence/params) is a separate, already-committed fixture this script
does not regenerate.

Run with:
    uv run --extra dev python apps/pipeline/test/lineage/theme/fixtures/mamba-openalex/dump_python_build_theme_lineage.py
    uv run --extra dev python apps/pipeline/test/lineage/theme/fixtures/mamba-openalex/dump_python_build_theme_lineage.py --out-dir /tmp/regen
"""

from __future__ import annotations

import argparse
import json
import shutil
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

HERE = Path(__file__).resolve().parent
REPO_ROOT = HERE.parents[6]
sys.path.insert(0, str(REPO_ROOT))

from paperpilot.scripts import build_lineage as bl  # noqa: E402
from paperpilot.scripts import build_theme_lineage as btl  # noqa: E402
from paperpilot.scripts import generate_themes_manifest as gtm  # noqa: E402

FIXED_NOW = datetime(2026, 6, 4, 0, 0, 0, tzinfo=timezone.utc)

W_SEED = "W1001"
W_PARENT = "W1002"
W_CHILD = "W1003"


def _work(
    short_id: str,
    *,
    title: str,
    year: int,
    cites: int,
    referenced_works: list[str] | None = None,
    arxiv_id: str | None = None,
) -> dict:
    """Mirror of build.parity.test.ts's `work()` helper, translated to the
    Python dict shape OpenAlex itself returns."""
    words = "we present a research contribution in this area".split(" ")
    inverted_index = {w: [i] for i, w in enumerate(words)}
    w: dict = {
        "id": f"https://openalex.org/{short_id}",
        "title": title,
        "display_name": title,
        "publication_year": year,
        "cited_by_count": cites,
        "authorships": [{"author": {"display_name": "A. Author"}}],
        "abstract_inverted_index": inverted_index,
        "primary_location": {"source": {"display_name": "NeurIPS"}},
    }
    if referenced_works is not None:
        w["referenced_works"] = [f"https://openalex.org/{r}" for r in referenced_works]
    if arxiv_id:
        w["ids"] = {"arxiv_id": arxiv_id}
    return w


SEED_WORK = _work(
    W_SEED,
    title="Mamba Sequence Modeling Paper",
    year=2023,
    cites=500,
    referenced_works=[W_PARENT],
    arxiv_id="2301.00001",
)
PARENT_WORK = _work(
    W_PARENT,
    title="Earlier Foundational Sequence Work",
    year=2018,
    cites=300,
    referenced_works=[],
)
CHILD_WORK = _work(
    W_CHILD,
    title="Later Extension Of Mamba",
    year=2024,
    cites=50,
    referenced_works=[],
)

BY_SHORT_ID = {W_SEED: SEED_WORK, W_PARENT: PARENT_WORK, W_CHILD: CHILD_WORK}


def _resp(status: int, body: object) -> SimpleNamespace:
    return SimpleNamespace(status_code=status, json=lambda: body)


def _fake_request_with_retry(method, url, *, params=None, timeout=None, headers=None, **_kw):  # noqa: ANN001
    params = params or {}
    base = url.split("?", 1)[0]
    if base == btl._OPENALEX_WORKS_URL and "search" in params:
        return _resp(200, {"results": [SEED_WORK]})
    if base.startswith(f"{btl._OPENALEX_WORKS_URL}/"):
        short_id = base.rsplit("/", 1)[-1]
        work = BY_SHORT_ID.get(short_id)
        if work is None:
            raise AssertionError(f"no canned work for short_id={short_id!r}")
        return _resp(200, work)
    filter_value = params.get("filter", "")
    if base == btl._OPENALEX_WORKS_URL and filter_value.startswith("openalex:"):
        ids = filter_value[len("openalex:") :].split("|")
        return _resp(200, {"results": [BY_SHORT_ID[i] for i in ids if i in BY_SHORT_ID]})
    if base == btl._OPENALEX_WORKS_URL and filter_value.startswith("cites:"):
        cited = filter_value[len("cites:") :]
        return _resp(200, {"results": [CHILD_WORK] if cited == W_SEED else []})
    raise AssertionError(f"no canned response for url={url!r} params={params!r}")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--out-dir", type=Path, default=HERE)
    args = parser.parse_args()
    args.out_dir.mkdir(parents=True, exist_ok=True)

    with tempfile.TemporaryDirectory(dir=REPO_ROOT) as tmp:
        tmp_path = Path(tmp)
        docs_root = tmp_path / "docs"
        docs_root.mkdir(parents=True)
        cache_dir = tmp_path / "lineage-cache"
        cache_dir.mkdir(parents=True)

        with (
            patch.object(btl, "DOCS_ROOT", docs_root),
            patch.object(btl, "CACHE_DIR", cache_dir),
            # `fetch_related` (called by the BFS and cross-node passes) is
            # defined in build_lineage.py and reads ITS OWN module-global
            # `CACHE_DIR`, not build_theme_lineage's re-exported name —
            # patching only `btl.CACHE_DIR` leaves it pointed at the real
            # `paperpilot/data/lineage-cache/` and would both pollute the
            # production cache and read stale entries back as cache hits.
            patch.object(bl, "CACHE_DIR", cache_dir),
            patch.object(btl, "_IDENTITY_ALIASES_PATH", docs_root / "identity-aliases-v1.json"),
            patch.object(btl, "request_with_retry", _fake_request_with_retry),
            patch.object(btl, "_enrich_github_stars", lambda *a, **kw: 0),
            patch.object(btl, "_utc_now", lambda: FIXED_NOW),
        ):
            out_path = btl.build_theme_lineage(
                theme="Mamba",
                depth=1,
                seeds_count=1,
                width=4,
                since_year=None,
                primary_source="openalex",
            )
            lineage = json.loads(out_path.read_text(encoding="utf-8"))
            manifest = gtm.generate_manifest(docs_root / "themes")

    # Canonicalised (sort_keys, no trailing newline) rather than a raw
    # copy of the builder's own on-disk bytes: the committed fixtures
    # are a human-diffable snapshot consumed by `JSON.parse(...).toEqual`
    # in build.parity.test.ts, not a byte-exact-output contract (that
    # contract is pythonParity.test.ts's job, for the classify fixtures).
    # Values below come entirely from the real `build_theme_lineage()` /
    # `generate_manifest()` call above.
    lineage_out = args.out_dir / "expected-lineage.json"
    lineage_out.write_text(
        json.dumps(lineage, ensure_ascii=True, indent=2, sort_keys=True), encoding="utf-8"
    )
    print(f"wrote {lineage_out}")

    manifest_out = args.out_dir / "expected-manifest.json"
    manifest_out.write_text(
        json.dumps(manifest, ensure_ascii=True, indent=2, sort_keys=True), encoding="utf-8"
    )
    print(f"wrote {manifest_out}")


if __name__ == "__main__":
    main()
