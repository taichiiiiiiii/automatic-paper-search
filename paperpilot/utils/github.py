"""Shared GitHub stars resolvers.

Used by both ``paperpilot/scripts/build_theme_lineage.py`` (theme
family-tree builder) and ``paperpilot/signals/github_signal.py`` (Stage 2
conference pipeline). Centralising the curated map + GitHub Search +
star-fetch primitives here avoids the divergent re-implementations the
codebase used to carry, keeps the SSRF / path-traversal hardening in
one place, and makes the Papers with Code 2026 shutdown a one-PR
fix instead of fixing every consumer separately.

Public API:
    ``load_curated_map(path=None) -> dict[str, str]``
        Read paper_repos.json and return a clean ``arxiv_id -> 'owner/repo'``
        mapping with the ``_meta`` documentation key filtered out and
        malformed entries dropped.
    ``title_similarity(a, b) -> float``
        Token-Jaccard similarity in [0, 1] used to filter GitHub Search
        hits whose title doesn't match the paper title.
    ``search_repo_by_title(title, *, github_token=None) -> str | None``
        Best-effort ``owner/repo`` from GitHub /search/repositories.
    ``fetch_repo_stars(repo_full, *, github_token=None) -> int | None``
        ``GET /repos/{owner}/{repo}`` -> stargazer count.
    ``parse_github_repo_url(url) -> tuple[str, str] | None``
        Strict parse of a GitHub URL into ``(owner, repo)``; returns
        ``None`` on any deviation (scheme, host, slug, segment count).

Dependencies:
    Only ``paperpilot.utils.http`` and ``paperpilot.utils.logger`` —
    deliberately no imports from ``paperpilot.signals`` or
    ``paperpilot.scripts`` to keep the dependency direction clean.
"""

from __future__ import annotations

import json
import re
from pathlib import Path
from urllib.parse import urlparse

from .http import request_with_retry
from .logger import get_logger

logger = get_logger(__name__)

# Repo root sits three levels above this file:
#   paperpilot/utils/github.py
#   paperpilot/utils/
#   paperpilot/
#   <repo root>
_ROOT = Path(__file__).resolve().parent.parent.parent
_PAPER_REPOS_FILE = _ROOT / "paperpilot" / "data" / "paper_repos.json"

# Title-similarity threshold for accepting a GitHub Search hit. Above
# this the paper title and the repo name/description are similar enough
# that the match is treated as authoritative; below this we skip rather
# than risk a false positive.
TITLE_SIM_THRESHOLD = 0.55

# GitHub URL slug allowlist — owner / repo segments must start with an
# alphanumeric character (so values like ``..`` or ``.git`` cannot slip
# in) and otherwise stay inside the standard GitHub identifier set.
_GH_SLUG_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*$")
_GH_NETLOC = {"github.com", "www.github.com"}

# Token regex for Jaccard similarity. ASCII alnum runs of length >= 3.
_TOKEN_RE = re.compile(r"[a-z0-9]{3,}")


# ---------- curated map ----------


def load_curated_map(path: Path | None = None) -> dict[str, str]:
    """Read paper_repos.json and return ``arxiv_id -> 'owner/repo'``.

    The ``_meta`` key (if present) is documentation for human readers
    and is filtered out before returning. Malformed entries (non-string
    values, missing slash, or owner/name failing the slug regex) are
    dropped silently so a typo never breaks the build.
    """
    p = path or _PAPER_REPOS_FILE
    if not p.exists():
        return {}
    try:
        raw = json.loads(p.read_text())
    except (OSError, json.JSONDecodeError) as exc:
        logger.warning("paper_repos.json unreadable (%s); skipping curated layer", exc)
        return {}
    if not isinstance(raw, dict):
        return {}
    out: dict[str, str] = {}
    for ax, repo in raw.items():
        if ax.startswith("_"):
            continue
        if not isinstance(repo, str) or "/" not in repo:
            continue
        owner, _, name = repo.partition("/")
        if not _GH_SLUG_RE.match(owner) or not _GH_SLUG_RE.match(name):
            continue
        out[ax] = repo
    return out


# ---------- title similarity ----------


def title_similarity(paper_title: str, candidate: str) -> float:
    """Token-overlap similarity in [0, 1] for filtering GitHub search hits.

    Tokens are ASCII alnum runs of length >= 3, lowercased. Returns the
    Jaccard index between the two token sets; substring containment in
    the alnum-normalised forms is treated as a perfect 1.0 to handle
    cases like a repo named exactly ``segment-anything`` matching the
    paper title ``Segment Anything``.

    The substring shortcut requires both sides to have >= 6 alnum chars
    so a curt repo name like ``fcn`` doesn't match an unrelated long
    title like ``fullyconvolutionalnetworks`` with a 1.0 false positive.
    """
    pt = (paper_title or "").lower()
    ct = (candidate or "").lower()
    if not pt or not ct:
        return 0.0
    pn = re.sub(r"[^a-z0-9]", "", pt)
    cn = re.sub(r"[^a-z0-9]", "", ct)
    if len(pn) >= 6 and len(cn) >= 6 and (pn in cn or cn in pn):
        return 1.0
    pa = set(_TOKEN_RE.findall(pt))
    pb = set(_TOKEN_RE.findall(ct))
    if not pa or not pb:
        return 0.0
    return len(pa & pb) / len(pa | pb)


# ---------- search ----------


def search_repo_by_title(
    title: str, *, github_token: str | None = None
) -> str | None:
    """Best-effort ``owner/repo`` resolution via GitHub /search/repositories.

    Returns ``None`` when no candidate clears ``TITLE_SIM_THRESHOLD``.
    Skips empty / very short titles to avoid noise. The query is the
    bare title trimmed to 80 chars — quoting the whole string would
    over-constrain the search; we let GitHub's own ranking surface the
    best candidates and filter via the similarity check.

    Each returned ``full_name`` is re-validated against the slug regex
    so a malformed API response can never reach the consumer.
    """
    cleaned = (title or "").strip()
    if len(cleaned) < 8:
        return None
    headers = {"Accept": "application/vnd.github+json"}
    if github_token:
        headers["Authorization"] = f"Bearer {github_token}"
    r = request_with_retry(
        "GET",
        "https://api.github.com/search/repositories",
        params={
            "q": cleaned[:80],
            "sort": "stars",
            "order": "desc",
            "per_page": 5,
        },
        headers=headers,
        timeout=10,
    )
    if r is None or r.status_code != 200:
        return None
    items = (r.json() or {}).get("items") or []
    for item in items:
        full_name = item.get("full_name") or ""
        if "/" not in full_name:
            continue
        owner, _, name = full_name.partition("/")
        if not _GH_SLUG_RE.match(owner) or not _GH_SLUG_RE.match(name):
            continue
        sim = max(
            title_similarity(cleaned, item.get("name") or ""),
            title_similarity(cleaned, item.get("description") or ""),
        )
        if sim >= TITLE_SIM_THRESHOLD:
            return full_name
    return None


# ---------- fetch stars ----------


def fetch_repo_stars(
    repo_full: str, *, github_token: str | None = None
) -> int | None:
    """``GET /repos/{owner}/{repo}`` -> stargazer count.

    Returns ``None`` on any failure mode (network error, non-200
    response, malformed JSON, slug regex rejection). The slug regex is
    re-applied here even when callers think they validated the repo
    string — defence-in-depth keeps a future refactor that moves the
    upstream guard from breaking SSRF / path-traversal protection.
    """
    if not repo_full or "/" not in repo_full:
        return None
    owner, _, name = repo_full.partition("/")
    if not _GH_SLUG_RE.match(owner) or not _GH_SLUG_RE.match(name):
        return None
    headers = {"Accept": "application/vnd.github+json"}
    if github_token:
        headers["Authorization"] = f"Bearer {github_token}"
    r = request_with_retry(
        "GET",
        f"https://api.github.com/repos/{owner}/{name}",
        headers=headers,
        timeout=10,
    )
    if r is None or r.status_code != 200:
        return None
    try:
        return int((r.json() or {}).get("stargazers_count") or 0)
    except (ValueError, TypeError, AttributeError):
        return None


# ---------- URL parsing ----------


def parse_github_repo_url(url: str | None) -> tuple[str, str] | None:
    """Strict parse of a GitHub URL -> ``(owner, repo)``.

    Returns ``None`` on any deviation: missing URL, non-http(s) scheme,
    non-github host (full netloc match against ``_GH_NETLOC``), fewer
    than two path segments, or any segment failing the slug regex.

    A trailing ``.git`` on the repo segment is stripped; subsequent
    path segments (e.g. ``/tree/main``) are ignored.
    """
    if not url:
        return None
    try:
        parsed = urlparse(url)
    except ValueError:
        return None
    if parsed.scheme not in {"http", "https"}:
        return None
    if parsed.netloc.lower() not in _GH_NETLOC:
        return None
    segments = [s for s in parsed.path.split("/") if s]
    if len(segments) < 2:
        return None
    owner = segments[0]
    repo = segments[1].removesuffix(".git")
    if not (_GH_SLUG_RE.match(owner) and _GH_SLUG_RE.match(repo)):
        return None
    return owner, repo
