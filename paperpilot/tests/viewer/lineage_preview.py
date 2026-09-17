"""Read-only loopback preview of existing synthetic lineage fixtures, not production."""

import argparse
import hashlib
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[3]
DOCS = ROOT / "docs"
FIXTURE = ROOT / "paperpilot/tests/fixtures/lineage-pilot/positive-release"


def directory_resources(directory: Path) -> dict[str, bytes]:
    from paperpilot.lineage_pilot import validate_pilot_index
    from paperpilot.replay import strict_json_loads

    root = directory.resolve(strict=True)

    def read(relative: str) -> bytes:
        path = (root / relative).resolve(strict=True)
        if not path.is_relative_to(root) or not path.is_file():
            raise ValueError("fixture path escapes directory")
        with path.open("rb") as stream:
            payload = stream.read(8 * 1024 * 1024 + 1)
        if len(payload) > 8 * 1024 * 1024:
            raise ValueError("fixture resource too large")
        return payload

    index_bytes = read("lineage-pilot-index-v1.json")
    index = validate_pilot_index(strict_json_loads(index_bytes))
    if len(index.entries) != 1 or index.entries[0].conference not in {"synthetic-pilot", "synthetic-large"}:
        raise ValueError("only one known synthetic collection is supported")
    entry = index.entries[0]
    resources = {"/lineage-pilot-index-v1.json": index_bytes,
                 f"/{entry.conference}/papers.json": read("catalog.json")}
    for reference in (entry.artifact, entry.fixture, entry.quality):
        payload = read(reference.path)
        if hashlib.sha256(payload).hexdigest() != reference.sha256:
            raise ValueError("fixture hash mismatch")
        resources["/" + reference.path] = payload
    return resources


def comparison_resources() -> dict[str, bytes]:
    # Development-only helper; reuse the regression fixture, never production data.
    from paperpilot.lineage_pilot import build_pilot_index
    from paperpilot.tests.test_lineage_pilot_bundle import build_synthetic_comparison_bundle

    bundle = build_synthetic_comparison_bundle()
    resources = {"/" + path: payload for path, payload in bundle.files.items()}
    resources["/lineage-pilot-index-v1.json"] = build_pilot_index((bundle.index_entry,))
    return resources


def response_for(target: str, resources: dict[str, bytes] | None = None) -> tuple[str, bytes]:
    """Resolve an exact allowlisted URL; never decode paths or list directories."""
    parsed = urlsplit(target)
    if parsed.scheme or parsed.netloc:
        raise FileNotFoundError(target)
    path = parsed.path
    if resources and path in resources:
        return "application/json", resources[path]
    if path == "/preview.css":
        return "text/css", b".preview-warning{position:sticky;top:0;z-index:100;background:#fff2cc;color:#222;padding:8px}"
    routes = {
        "/lineage/": (DOCS / "lineage/index.html", "text/html"),
        "/lineage-pilot-index-v1.json": (FIXTURE / "lineage-pilot-index-v1.json", "application/json"),
        "/synthetic-pilot/papers.json": (FIXTURE / "catalog.json", "application/json"),
    }
    for suffix, mime in [("js", "text/javascript"), ("css", "text/css"), ("svg", "image/svg+xml")]:
        for asset in (DOCS / "assets").glob(f"*.{suffix}"):
            if not asset.is_symlink():
                routes[f"/assets/{asset.name}"] = (asset, mime)
    for artifact in (FIXTURE / "lineage-pilots").rglob("*.json"):
        if artifact.resolve().is_relative_to(FIXTURE.resolve()) and not artifact.is_symlink():
            routes["/" + artifact.relative_to(FIXTURE).as_posix()] = (artifact, "application/json")
    if path not in routes:
        raise FileNotFoundError(target)
    source, mime = routes[path]
    body = source.read_bytes()
    if mime == "text/html":
        body = body.replace(b"</head>", b'<link rel="stylesheet" href="/preview.css"></head>')
        body = body.replace(b'<body class="lineage-focus-page">',
                            b'<body class="lineage-focus-page"><aside class="preview-warning" role="note">'
                            b'SYNTHETIC TEST ONLY - not scientific review or publication approval.</aside>')
    return mime, body


class PreviewHandler(BaseHTTPRequestHandler):
    resources: dict[str, bytes] = {}

    def do_GET(self) -> None:
        try:
            mime, body = response_for(self.path, self.resources)
        except (FileNotFoundError, ValueError):
            self.send_error(404)
            return
        self.send_response(200)
        self.send_header("Content-Type", mime + "; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(body)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=8766)
    source = parser.add_mutually_exclusive_group()
    source.add_argument("--comparison", action="store_true", help="Use a validated synthetic comparison bundle")
    source.add_argument("--fixture-dir", type=Path, help="Read an emitted synthetic fixture directory")
    args = parser.parse_args()
    PreviewHandler.resources = (directory_resources(args.fixture_dir) if args.fixture_dir
                                else comparison_resources() if args.comparison else {})
    with HTTPServer(("127.0.0.1", args.port), PreviewHandler) as server:
        print(f"SYNTHETIC TEST ONLY: http://127.0.0.1:{server.server_port}/lineage/?paper={'1' * 40}", flush=True)
        server.serve_forever()


if __name__ == "__main__":
    main()
