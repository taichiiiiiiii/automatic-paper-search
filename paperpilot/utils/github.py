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
    Only ``paperpilot.utils.http``, ``paperpilot.utils.logger`` and
    ``paperpilot.utils.payload`` — deliberately no imports from
    ``paperpilot.signals`` or ``paperpilot.scripts`` to keep the
    dependency direction clean.
"""

from __future__ import annotations

import json
import re
from pathlib import Path
from urllib.parse import urlparse

from .http import request_with_retry
from .logger import get_logger
from .payload import first_unusable, gh_repo_slug, gh_search_item_ok

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
_TITLE_SIM_THRESHOLD = 0.55

# GitHub URL slug allowlist — owner / repo segments must start with an
# alphanumeric character (so values like ``..`` or ``.git`` cannot slip
# in) and otherwise stay inside the standard GitHub identifier set.
class GitHubUnavailableError(RuntimeError):
    """The GitHub API could not answer — throttled, erroring, or down.

    Distinct from a successful answer of "no such repository" / "zero
    stars", which is a fact about the paper and is safe to cache.
    """


#: Statuses that mean "GitHub could not answer", as opposed to "GitHub
#: answered, and the answer is no". A 404 on ``/repos/{owner}/{repo}`` is
#: the latter: the repository is absent or private, which is a real fact
#: about the paper. 403 is how GitHub reports both the unauthenticated
#: rate limit and abuse detection, and 429/5xx speak for themselves.
_GH_UNAVAILABLE_STATUSES = frozenset({403, 429})


def _github_unavailable(resp: object) -> bool:
    if resp is None:
        return True
    status = getattr(resp, "status_code", None)
    if status in _GH_UNAVAILABLE_STATUSES:
        return True
    return isinstance(status, int) and status >= 500


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
        if gh_repo_slug(repo) is None:
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

    Returns ``None`` when no candidate clears ``_TITLE_SIM_THRESHOLD``.
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
    if _github_unavailable(r):
        # A throttled or unavailable Search API is not evidence that the
        # paper has no repository. Raising lets the caller skip caching
        # instead of recording "no repo" for the whole TTL window.
        raise GitHubUnavailableError(
            f"github repo search failed (status={getattr(r, 'status_code', None)})"
        )
    if r.status_code != 200:
        # The Search API expresses "nothing matched" as 200 with an
        # empty `items` array, so NO status here is a statement about
        # the paper: a 401 is a bad credential and a 422 is a rejected
        # query. Returning None let the caller record "this paper has
        # no repository" for the whole TTL window. Same split already
        # drawn for Semantic Scholar's 404-vs-the-rest.
        raise GitHubUnavailableError(
            f"github repo search answered {r.status_code}, which says nothing "
            "about whether a repository exists"
        )
    try:
        payload = r.json()
    except ValueError as exc:
        raise GitHubUnavailableError("github repo search returned a malformed body") from exc
    items = payload.get("items") if isinstance(payload, dict) else None
    if not isinstance(items, list):
        # A 200 from the Search API always carries an `items` array,
        # empty when nothing matched. A body without one — an error
        # envelope, an interstitial that happens to parse — says nothing
        # about whether a repository exists, and the caller caches
        # "no repo" for the whole TTL window.
        raise GitHubUnavailableError(
            "github repo search returned no items array "
            f"(keys={sorted(payload)[:5] if isinstance(payload, dict) else type(payload).__name__})"
        )
    # The elements carry the answer. `{"items": [{"message": "rate
    # limit"}]}` and `{"items": [null]}` used to fall through the loop
    # and return None, which the caller stores as "this paper has no
    # repository" for the whole TTL window.
    bad = first_unusable(items, gh_search_item_ok)
    if bad is not None:
        index, item = bad
        raise GitHubUnavailableError(
            f"github repo search returned a malformed item at index {index} "
            f"(type={type(item).__name__})"
        )
    for item in items:
        # `gh_search_item_ok` is the predicate the guard above used, so
        # this loop can no longer skip or crash on an accepted item.
        full_name = item["full_name"]
        sim = max(
            title_similarity(cleaned, item.get("name") or ""),
            title_similarity(cleaned, item.get("description") or ""),
        )
        if sim >= _TITLE_SIM_THRESHOLD:
            return full_name
    return None


# ---------- fetch stars ----------


def fetch_repo_stars(
    repo_full: str, *, github_token: str | None = None
) -> int | None:
    """``GET /repos/{owner}/{repo}`` -> stargazer count.

    Returns ``None`` when the answer is genuinely negative — an unusable
    slug, or a 404 (no public repository). A network error, a 403/429
    throttle, a 5xx, or a 200 whose body is not a repo object raises
    ``GitHubUnavailableError`` instead: "the API was down" is not the
    same fact as "this repo has no stars", and the caller caches the
    latter.

    The slug regex is re-applied here even when callers think they
    validated the repo string — defence-in-depth keeps a future refactor
    that moves the upstream guard from breaking SSRF / path-traversal
    protection.
    """
    slug = gh_repo_slug(repo_full)
    if slug is None:
        return None
    owner, name = slug
    headers = {"Accept": "application/vnd.github+json"}
    if github_token:
        headers["Authorization"] = f"Bearer {github_token}"
    r = request_with_retry(
        "GET",
        f"https://api.github.com/repos/{owner}/{name}",
        headers=headers,
        timeout=10,
    )
    if _github_unavailable(r):
        raise GitHubUnavailableError(
            f"github repo lookup failed for {repo_full} "
            f"(status={getattr(r, 'status_code', None)})"
        )
    if r.status_code == 404:
        # The one status that is a fact about the DATA: there is no
        # public repository at that slug.
        return None
    if r.status_code != 200:
        raise GitHubUnavailableError(
            f"github repo lookup for {repo_full} answered {r.status_code}, which "
            "says nothing about whether the repository exists"
        )
    try:
        payload = r.json()
    except ValueError as exc:
        raise GitHubUnavailableError(
            f"github repo lookup for {repo_full} returned a malformed body"
        ) from exc
    stars = payload.get("stargazers_count") if isinstance(payload, dict) else None
    if not isinstance(stars, int) or isinstance(stars, bool):
        # A repo object always carries an integer `stargazers_count`.
        # Rounding anything else down to 0 wrote "this repo has no
        # stars" into a fresh TTL entry, which is the outage-as-fact
        # bug wearing the 200 status code.
        raise GitHubUnavailableError(
            f"github repo lookup for {repo_full} returned no stargazers_count "
            f"(keys={sorted(payload)[:5] if isinstance(payload, dict) else type(payload).__name__})"
        )
    return stars


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
    return gh_repo_slug(f"{owner}/{repo}")
