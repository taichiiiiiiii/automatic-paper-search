"""Pin: the CSP `connect-src` host in docs/themes/index.html must equal
the host of the `paperpilot-api-base` meta tag in the same file.

GH Pages strips `_headers`, so docs/themes/index.html declares its CSP via
a <meta http-equiv="Content-Security-Policy"> tag instead. `connect-src`
must allow exactly the Worker host the page actually fetches (the origin
in `paperpilot-api-base`) and nothing broader (e.g. a `https://*.workers.dev`
wildcard would also let the page talk to any other workers.dev-hosted
origin — see the comment above the CSP meta tag in index.html). A silent
drift between the two — a stale host left over from a Worker rename, or a
`paperpilot-api-base` update that forgets the CSP — means the page's own
`POST /api/themes` fetch is either blocked by its own CSP (silent
degraded mode, no obvious error) or the CSP is wider than intended.
"""

from __future__ import annotations

import re
from pathlib import Path
from urllib.parse import urlparse

REPO_ROOT = Path(__file__).resolve().parents[2]
THEMES_INDEX_HTML = REPO_ROOT / "docs" / "themes" / "index.html"


def _api_base_origin(html: str) -> str:
    m = re.search(r'<meta\s+name="paperpilot-api-base"\s+content="([^"]*)"', html)
    assert m is not None, "paperpilot-api-base meta tag not found in docs/themes/index.html"
    content = m.group(1)
    assert content, "paperpilot-api-base meta content is empty (degraded mode) in this checkout"
    parsed = urlparse(content)
    assert parsed.scheme and parsed.netloc, (
        f"paperpilot-api-base content is not an absolute URL: {content!r}"
    )
    return f"{parsed.scheme}://{parsed.netloc}"


def _csp_connect_src_hosts(html: str) -> list[str]:
    m = re.search(r'<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]*)"', html)
    assert m is not None, "Content-Security-Policy meta tag not found in docs/themes/index.html"
    csp = m.group(1)
    directive_m = re.search(r"connect-src\s+([^;]+)", csp)
    assert directive_m is not None, "connect-src directive not found in the CSP meta content"
    return directive_m.group(1).split()


def test_csp_connect_src_host_matches_api_base_host() -> None:
    html = THEMES_INDEX_HTML.read_text(encoding="utf-8")
    api_origin = _api_base_origin(html)
    hosts = _csp_connect_src_hosts(html)
    assert api_origin in hosts, (
        f"CSP connect-src {hosts} does not include the paperpilot-api-base origin "
        f"{api_origin!r} — the page's own POST /api/themes fetch would be blocked "
        "by its own CSP"
    )
    # 'self' plus exactly the one pinned API origin — no third entry, and in
    # particular no wildcard host that would defeat the point of pinning a
    # single origin (CLAUDE.md §14: the meta comment explicitly calls out
    # that a `https://*.workers.dev` wildcard must not be reintroduced).
    assert "'self'" in hosts
    assert len(hosts) == 2, (
        f"connect-src should list exactly 'self' and the paperpilot-api-base "
        f"origin, got {hosts}"
    )
