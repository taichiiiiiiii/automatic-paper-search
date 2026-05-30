"""unarXive 2022 citation context lookup (S2-free).

Provides paper-specific citation rationales without requiring a
Semantic Scholar API key. Source: HuggingFace dataset
``saier/unarXive_citrec`` (CC-BY-SA-4.0), pre-extracted from arXiv CS
papers up to 2022-03.

### Architecture

Offline (one-shot, ~5 min): ``paperpilot/scripts/build_unarxive_index.py``
downloads the HF dataset, joins the citrec rows with the
``license_info`` sidecar to recover ``paper_arxiv_id`` per row, and
writes a DuckDB file with this 3-column schema::

    CREATE TABLE citrec (
        paper_arxiv_id TEXT,  -- arXiv id of citing paper
        label          TEXT,  -- 'https://openalex.org/W{ID}' of cited paper
        text           TEXT   -- citation paragraph, truncated to 600 chars
    );
    CREATE INDEX idx_citing_cited ON citrec(paper_arxiv_id, label);

The schema is intentionally narrow so the binary fits the GitHub
Release 2 GB/asset cap once gzipped. Upstream columns we drop:
``sample_id`` (UUID never queried), ``marker`` (e.g. ``"[42]"`` —
implied by ``text`` and unused), ``paper_license`` (per-paper
licence URL — attribution lives in the viewer footer, no per-row
query touches it).

Runtime: ``fetch_contexts()`` reads the DuckDB in read-only mode and
returns paragraphs for a given (citing arXiv id, cited OpenAlex W-id)
pair. The lookup is **O(log n)** thanks to the composite index.

### Graceful degradation

If the DuckDB file is absent (a fresh clone, CI without the artifact
downloaded, or a dev machine that hasn't built the index), every
lookup returns ``[]``. Callers (build_theme_lineage's BFS) treat
empty contexts as "no citation evidence" and fall through to the
existing year/cite heuristic or LLM rescue. **No crash, no warning
spam.**

### License compliance

unarXive 2022 is CC-BY-SA-4.0. Surfacing context paragraphs in
``lineage.json`` and the viewer is treated as academic citation
(short excerpts as evidence for relation classification, well under
fair-use thresholds), but we still add a
"data: unarXive 2022 (Saier et al., CC-BY-SA-4.0)" attribution
footer to ``docs/themes/<slug>/index.html`` so attribution is one
click away from anywhere a context paragraph appears.

References:
- Saier et al., "unarXive 2022: All arXiv Publications Pre-Processed
  for NLP, Including Structured Full-Text and Citation Network",
  JCDL 2023. https://arxiv.org/abs/2303.14957
- HF dataset card: https://huggingface.co/datasets/saier/unarXive_citrec
"""

from __future__ import annotations

import re
from functools import lru_cache
from pathlib import Path
from typing import Any

from paperpilot.utils.logger import get_logger

logger = get_logger(__name__)

_ROOT = Path(__file__).resolve().parents[2]
_DEFAULT_DUCKDB_PATH = (
    _ROOT / "paperpilot" / "data" / "unarxive" / "unarxive.duckdb"
)

# unarXive label format: full OpenAlex URL on the `label` column.
# Strip-and-reattach so callers can pass either the short W-ID or
# the prefixed `openalex:W...` form PaperPilot uses internally.
_OPENALEX_URL_PREFIX = "https://openalex.org/"
_OPENALEX_PAPERID_PREFIX = "openalex:"


def _normalise_openalex_short(value: str | None) -> str | None:
    """Return the bare ``W12345`` short ID from any of: the URL form
    (``https://openalex.org/W12345``), the PaperPilot prefixed form
    (``openalex:W12345``), or the bare short itself. Returns None for
    inputs that don't end in a ``W``-prefixed identifier.
    """
    if not isinstance(value, str) or not value:
        return None
    candidate = value.strip()
    if candidate.startswith(_OPENALEX_URL_PREFIX):
        candidate = candidate[len(_OPENALEX_URL_PREFIX) :]
    elif candidate.startswith(_OPENALEX_PAPERID_PREFIX):
        candidate = candidate[len(_OPENALEX_PAPERID_PREFIX) :]
    return candidate if candidate.startswith("W") else None


# arXiv IDs come in two forms: the pre-2007 ``arXiv:cs.LG/0512345`` style
# (rare in our themes, all post-2017) and the modern ``2010.11929``
# (year.serial) form. unarXive stores the bare modern form when present.
_ARXIV_BARE_RE = re.compile(r"^\d{4}\.\d{4,5}(v\d+)?$")


def _normalise_arxiv_id(value: str | None) -> str | None:
    """Strip any version suffix (``v2``) from an arXiv ID and validate
    the bare year.serial shape. Old-style IDs are dropped — they would
    require a separate lookup table and our corpus is post-2017."""
    if not isinstance(value, str) or not value:
        return None
    bare = value.strip()
    # Tolerate "arXiv:2010.11929" prefix some callers attach.
    if bare.lower().startswith("arxiv:"):
        bare = bare[len("arxiv:"):]
    if not _ARXIV_BARE_RE.match(bare):
        return None
    # Drop version suffix so 2010.11929v3 matches 2010.11929 in unarXive.
    base = bare.split("v", 1)[0] if "v" in bare else bare
    return base


@lru_cache(maxsize=1)
def _get_db_path() -> Path:
    """Single source of truth for the DuckDB location. Wrapping in a
    helper makes the path mock-able in tests."""
    return _DEFAULT_DUCKDB_PATH


@lru_cache(maxsize=1)
def _open_readonly() -> Any:
    """Open a single read-only DuckDB connection for the process.

    Cached because connection setup is ~50ms and we run thousands of
    lookups per regen. Returns None — never raises — when:
      * The DuckDB file is absent (CI without artifact / dev machine
        that hasn't built the index).
      * The ``duckdb`` Python package isn't installed (the project
        treats it as an optional extra so installs stay fast).
      * Any other open failure (locked file, corrupt header).
    Callers must handle ``None`` as "feature disabled".

    Returns ``Any`` (not ``DuckDBPyConnection``) because duckdb is an
    optional dependency: the type stub isn't always present in the
    lockfile, and we don't want mypy to require duckdb just to type-
    check the rest of the project.
    """
    path = _get_db_path()
    if not path.exists():
        logger.info(
            "unarxive: DuckDB index missing at %s; citation contexts "
            "disabled (build via build_unarxive_index.py)",
            path,
        )
        return None
    try:
        import duckdb
    except ImportError:
        logger.info(
            "unarxive: duckdb package not installed; citation contexts "
            "disabled (install `paperpilot[unarxive]` or `uv add duckdb`)"
        )
        return None
    try:
        return duckdb.connect(str(path), read_only=True)
    except Exception as exc:  # pragma: no cover - defensive
        logger.warning("unarxive: failed to open %s: %s", path, exc)
        return None


def fetch_contexts(
    *,
    child_arxiv_id: str | None,
    parent_openalex_id: str,
    limit: int = 5,
) -> list[str]:
    """Return paragraphs where the citing paper (``child_arxiv_id``)
    mentions the cited paper (``parent_openalex_id``) via unarXive.

    ``parent_openalex_id`` accepts any of:
      * Bare short ID: ``"W2962917714"``
      * URL form: ``"https://openalex.org/W2962917714"``
      * PaperPilot internal form: ``"openalex:W2962917714"``

    ``child_arxiv_id`` is the arXiv id of the citing paper, with or
    without an ``arXiv:`` prefix or a ``v2`` version suffix. The
    function is forgiving on shape but rejects non-arXiv inputs (the
    citing side of unarXive only contains arXiv CS papers up to
    2022-03).

    Returns ``[]`` when either id is missing/unparseable, the DuckDB
    is absent, or no matching context exists. Never raises.

    Limit defaults to 5 paragraphs per edge — more than enough for
    the regex classifier to pick a winning relation phrase, and small
    enough that ``lineage.json`` doesn't bloat (each context is up to
    ~660 chars).
    """
    arxiv_id = _normalise_arxiv_id(child_arxiv_id)
    short_id = _normalise_openalex_short(parent_openalex_id)
    if not arxiv_id or not short_id:
        return []
    conn = _open_readonly()
    if conn is None:
        return []
    label = f"{_OPENALEX_URL_PREFIX}{short_id}"
    try:
        rows = conn.execute(
            "SELECT text FROM citrec "
            "WHERE paper_arxiv_id = ? AND label = ? LIMIT ?",
            [arxiv_id, label, limit],
        ).fetchall()
    except Exception as exc:  # pragma: no cover - defensive
        logger.warning(
            "unarxive: query failed (citing=%s, cited=%s): %s",
            arxiv_id, short_id, exc,
        )
        return []
    return [row[0] for row in rows if row and row[0]]


def is_available() -> bool:
    """True iff the DuckDB index is present and openable.

    Used by build_theme_lineage to log whether the unarXive path is
    active for a given run, so audits can attribute coverage gaps to
    "no index" vs "no match"."""
    return _open_readonly() is not None
