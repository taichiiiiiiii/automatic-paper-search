"""Static contracts for theme request correlation and dormant status."""

from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def test_worker_dispatch_preserves_server_request_id() -> None:
    # M-5b moved the whole POST /api/themes chain out of worker/index.ts
    # into worker/themes-post.js, a plain-JS module Node 20 can import for
    # tests (index.ts cannot be, with no TS-strip step). index.ts is now
    # thin wiring: it only binds the real global fetch and re-exports the
    # route table; handleStatusGet's dormant GET stays here unchanged.
    index_source = (ROOT / "worker/index.ts").read_text(encoding="utf-8")
    assert 'from "./themes-post.js"' in index_source
    assert "createThemesPostHandler({" in index_source
    assert "requestId = createRequestId()" not in index_source
    assert "dispatchInputs(theme, requestId)" not in index_source
    assert 'searchParams.get("theme")' not in index_source
    assert "findRecentRun" not in index_source
    assert "isStatusRateLimited" not in index_source

    status = index_source[
        index_source.index("async function handleStatusGet") : index_source.index(
            "const handlePost"
        )
    ]
    assert "themeStatusUnavailable()" in status
    assert "fetch(" not in status
    assert "env." not in status
    assert "GH_DISPATCH_PAT" not in status

    themes_post_source = (ROOT / "worker/themes-post.js").read_text(encoding="utf-8")
    assert "requestId = createRequestId()" in themes_post_source
    assert "dispatchInputs(theme, requestId)" in themes_post_source
    assert "request_id: requestId" in themes_post_source
    assert 'searchParams.get("theme")' not in themes_post_source
    assert "findRecentRun" not in themes_post_source
    assert "isStatusRateLimited" not in themes_post_source
    # GH_DISPATCH_PAT must only ever be read to build the Authorization
    # header, never echoed into a logged or user-facing string.
    assert "GH_DISPATCH_PAT" in themes_post_source
    pat_uses = [
        line for line in themes_post_source.splitlines() if "GH_DISPATCH_PAT" in line
    ]
    assert len(pat_uses) == 1
    assert "authorization" in pat_uses[0].lower()


def test_dormant_status_contract_is_non_cacheable_cross_origin_json() -> None:
    source = (ROOT / "worker/response.js").read_text(encoding="utf-8")
    status = source[
        source.index("export function themeStatusUnavailable") : source.index("// Today's UTC")
    ]
    assert 'status: "error"' in status
    assert "status: 503" in status
    assert "completion continues through the public manifest" in status

    json_helper = source[
        source.index("export function json") : source.index(
            "export function themeStatusUnavailable"
        )
    ]
    assert '"cache-control": "no-store"' in json_helper
    # M-1: fixed-origin CORS (PAGES_ORIGIN), not a blanket "*", paired
    # with Vary: Origin.
    assert '"access-control-allow-origin": PAGES_ORIGIN' in json_helper
    assert '"vary": "Origin"' in json_helper
    assert '"content-type": "application/json; charset=utf-8"' in json_helper
    assert 'PAGES_ORIGIN = "https://taichiiiiiiii.github.io"' in source


def test_frontend_retains_request_id_for_status_polling() -> None:
    source = (ROOT / "docs/assets/theme.js").read_text(encoding="utf-8")
    assert "data.request_id" in source
    assert "startProgress(slug, raw, requestId)" in source
    assert "requestId," in source
    assert "?request_id=" in source
    assert "/api/themes/status?theme=" not in source


def test_frontend_manifest_poll_remains_the_completion_source_of_truth() -> None:
    source = (ROOT / "docs/assets/theme.js").read_text(encoding="utf-8")
    polling = source[
        source.index("async function pollForCompletion") : source.index("function startProgress")
    ]
    assert 'fetch("themes-manifest.json", { cache: "no-store" })' in polling
    assert "data.some((e) => e?.slug === slug)" in polling
    assert "if (sr.ok)" in polling
    assert "Non-fatal — manifest poll + timeout" in polling


def test_workflow_and_release_preserve_original_request_id() -> None:
    source = (ROOT / ".github/workflows/theme-on-demand.yml").read_text(encoding="utf-8")
    assert "inputs.request_id" in source
    assert "request_id: ${{ inputs.request_id }}" in source
    assert "inputs.theme || 'manual' }} / ${{ inputs.request_id" in source
