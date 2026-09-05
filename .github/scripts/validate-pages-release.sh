#!/usr/bin/env bash
# Validate the local Pages bundle or smoke-test one deployed exact-SHA bundle.

set -euo pipefail

die() {
  echo "::error::$*" >&2
  exit 1
}

validate_sha() {
  [[ "$1" =~ ^[0-9a-f]{40}$ ]] || die "source SHA must be 40 lowercase hex"
}

validate_json_bundle() {
  local docs_root="$1"
  python3 - "$docs_root" <<'PY'
import json
import sys
from pathlib import Path
from xml.etree import ElementTree

root = Path(sys.argv[1])
errors: list[str] = []
for path in sorted(root.rglob("*.json")):
    try:
        json.loads(path.read_text(encoding="utf-8"))
    except Exception as exc:
        errors.append(f"invalid JSON {path.relative_to(root)}: {exc}")
try:
    ElementTree.parse(root / "sitemap.xml")
except Exception as exc:
    errors.append(f"invalid sitemap.xml: {exc}")
try:
    conferences = json.loads((root / "conferences.json").read_text(encoding="utf-8"))
except Exception as exc:
    errors.append(f"invalid conferences.json: {exc}")
    conferences = []
if not isinstance(conferences, list) or not conferences:
    errors.append("conferences.json must be a non-empty array")
else:
    for conference in conferences:
        slug = conference.get("name") if isinstance(conference, dict) else None
        if not isinstance(slug, str) or not (root / slug / "papers.json").is_file():
            errors.append(f"missing catalog for conference {slug!r}")
if errors:
    raise SystemExit("\n".join(errors))
PY
}

validate_local() {
  local expected_sha="$1"
  local docs_root="$2"
  validate_sha "$expected_sha"
  [[ -d "$docs_root" ]] || die "docs root does not exist: $docs_root"
  local actual_sha
  actual_sha="$(git rev-parse HEAD)"
  [[ "$actual_sha" == "$expected_sha" ]] || die "checkout SHA $actual_sha != $expected_sha"

  local required
  for required in \
    index.html \
    404.html \
    conferences.json \
    search-index.json \
    search-index-v2.json \
    lineage-quality-v1.json \
    sitemap.xml \
    assets/versions.json; do
    [[ -f "$docs_root/$required" ]] || die "missing Pages artifact: $required"
  done
  validate_json_bundle "$docs_root"
}

fetch() {
  local url="$1"
  local output="$2"
  curl \
    --fail \
    --location \
    --silent \
    --show-error \
    --connect-timeout 5 \
    --max-time 15 \
    --retry 2 \
    --retry-all-errors \
    --output "$output" \
    "$url"
}

smoke_remote() {
  local base_url="${1%/}"
  local expected_sha="$2"
  validate_sha "$expected_sha"
  [[ "$base_url" =~ ^https:// ]] || die "Pages URL must use https"

  local smoke_dir
  smoke_dir="$(mktemp -d "${TMPDIR:-/tmp}/paperpilot-pages-smoke.XXXXXX")"
  trap 'rm -r "$smoke_dir"' EXIT

  fetch "$base_url/" "$smoke_dir/index.html"
  fetch "$base_url/_paperpilot-deployment.json" "$smoke_dir/deployment.json"
  fetch "$base_url/conferences.json" "$smoke_dir/conferences.json"
  fetch "$base_url/search-index-v2.json" "$smoke_dir/search-index-v2.json"
  fetch "$base_url/lineage-quality-v1.json" "$smoke_dir/lineage-quality-v1.json"

  python3 - "$smoke_dir" "$expected_sha" "$base_url" <<'PY'
import json
import sys
import urllib.parse
from pathlib import Path

root = Path(sys.argv[1])
expected_sha = sys.argv[2]
base_url = sys.argv[3].rstrip("/") + "/"
if "<!doctype html" not in (root / "index.html").read_text(encoding="utf-8").lower():
    raise SystemExit("root page is not HTML")
deployment = json.loads((root / "deployment.json").read_text(encoding="utf-8"))
if deployment.get("source_sha") != expected_sha:
    raise SystemExit("deployed marker does not match requested source SHA")
conferences = json.loads((root / "conferences.json").read_text(encoding="utf-8"))
if not conferences:
    raise SystemExit("deployed conferences.json is empty")
representative = conferences[0].get("name")
if not isinstance(representative, str):
    raise SystemExit("representative conference has no name")
search = json.loads((root / "search-index-v2.json").read_text(encoding="utf-8"))
if not isinstance(search, list) or not search:
    raise SystemExit("deployed search-index-v2.json is empty")
quality = json.loads((root / "lineage-quality-v1.json").read_text(encoding="utf-8"))
lineage_paths = [
    row.get("path")
    for row in quality.get("collections", [])
    if row.get("availability") == "ready" and row.get("audit_status") == "passed"
]
paths = [f"{representative}/"]
if lineage_paths:
    paths.append(lineage_paths[0])
for relative in paths:
    parts = urllib.parse.urlsplit(relative) if isinstance(relative, str) else None
    if (
        parts is None
        or parts.scheme
        or parts.netloc
        or parts.query
        or parts.fragment
        or relative.startswith("/")
        or ".." in parts.path.split("/")
    ):
        raise SystemExit(f"unsafe smoke path: {relative!r}")
    encoded_path = urllib.parse.quote(parts.path, safe="/-._~")
    url = urllib.parse.urljoin(base_url, encoded_path)
    with (root / "smoke-urls.txt").open("a", encoding="utf-8") as handle:
        handle.write(url + "\n")
PY

  local route_index=0
  while IFS= read -r url; do
    route_index=$((route_index + 1))
    fetch "$url" "$smoke_dir/route-$route_index"
  done < "$smoke_dir/smoke-urls.txt"
}

case "${1:-}" in
  local)
    [[ "$#" -eq 3 ]] || die "usage: $0 local <source-sha> <docs-root>"
    validate_local "$2" "$3"
    ;;
  smoke)
    [[ "$#" -eq 3 ]] || die "usage: $0 smoke <page-url> <source-sha>"
    smoke_remote "$2" "$3"
    ;;
  *)
    die "usage: $0 {local <source-sha> <docs-root>|smoke <page-url> <source-sha>}"
    ;;
esac
