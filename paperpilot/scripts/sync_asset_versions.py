"""Keep the ?v= cache-bust version on every asset reference in sync.

Every HTML page loads shared assets as `assets/<file>?v=<N>`. The N must
agree across all pages, or visitors get different builds of the same file
depending on which page they landed on. It has drifted twice: utils.js
shipped as ?v=75 on ten pages and ?v=82 on four, and before that the themes
page diverged on its own. CLAUDE.md prescribes a manual `grep | sed` sweep
after each edit, which is precisely the step that keeps getting skipped.

This script removes the manual step. It owns the version numbers:

    - the version bumps only when the asset's bytes actually change, so an
      unrelated edit elsewhere does not bust every visitor's cache;
    - every reference is rewritten from one source of truth, so two pages
      cannot disagree;
    - adopting it seeds from the highest version already present in the HTML,
      so the first run does not restart numbering or invalidate live caches.

State lives in docs/assets/versions.json (content hash + current version).

Run:
    python paperpilot/scripts/sync_asset_versions.py
    python paperpilot/scripts/sync_asset_versions.py --check   # CI-style, no writes
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from collections import defaultdict
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
DOCS_ROOT = ROOT / "docs"

ASSETS_DIRNAME = "assets"
VERSIONS_FILENAME = "versions.json"

# Enough hex to make an accidental collision irrelevant at our scale (a
# handful of assets) while keeping versions.json readable in a diff.
HASH_CHARS = 12

# Only these are cache-busted; images and fonts are content-addressed by name
# or served rarely enough not to matter.
_VERSIONED_SUFFIXES = {".css", ".js"}


def asset_hash(path: Path) -> str:
    """Content hash of one asset. Bytes, not mtime — a rebuild must not bump."""
    return hashlib.sha256(path.read_bytes()).hexdigest()[:HASH_CHARS]


def _reference_re(asset_name: str) -> re.Pattern[str]:
    """Match `<anything>/assets/<name>?v=<digits>` so relative depths all hit."""
    return re.compile(rf"({ASSETS_DIRNAME}/{re.escape(asset_name)}\?v=)(\d+)")


def _html_files(docs_root: Path) -> list[Path]:
    return sorted(docs_root.rglob("*.html"))


def _versioned_assets(docs_root: Path) -> list[Path]:
    assets_dir = docs_root / ASSETS_DIRNAME
    if not assets_dir.is_dir():
        return []
    return sorted(
        p for p in assets_dir.iterdir() if p.suffix in _VERSIONED_SUFFIXES and p.is_file()
    )


def observed_versions(docs_root: Path) -> dict[str, set[int]]:
    """Every version each asset is currently referenced at, across all HTML."""
    seen: dict[str, set[int]] = defaultdict(set)
    htmls = [(p, p.read_text(encoding="utf-8")) for p in _html_files(docs_root)]
    for asset in _versioned_assets(docs_root):
        pattern = _reference_re(asset.name)
        for _, text in htmls:
            for _, num in pattern.findall(text):
                seen[asset.name].add(int(num))
    return dict(seen)


def find_divergent(docs_root: Path) -> dict[str, list[int]]:
    """Assets referenced at more than one version — the bug this prevents."""
    return {
        name: sorted(versions)
        for name, versions in observed_versions(docs_root).items()
        if len(versions) > 1
    }


# A reference to a versioned asset that carries no ?v= at all. The rewriter
# only sees `assets/<file>?v=<digits>`, so such a reference is neither
# "divergent" nor "stale" — it is invisible, and the page silently serves
# whatever the browser cached. `(?!\?v=)` is what makes this the blind-spot
# check rather than a duplicate of the divergence check.
_UNVERSIONED_RE = re.compile(rf"({ASSETS_DIRNAME}/[\w.-]+\.(?:css|js))(?!\?v=)")


def find_unversioned(docs_root: Path) -> list[tuple[Path, str]]:
    """Asset references with no ?v= — what the rewriter cannot see or fix."""
    known = {a.name for a in _versioned_assets(docs_root)}
    found: list[tuple[Path, str]] = []
    for html in _html_files(docs_root):
        text = html.read_text(encoding="utf-8")
        for match in _UNVERSIONED_RE.finditer(text):
            ref = match.group(1)
            if ref.split("/", 1)[1] in known:
                found.append((html, ref))
    return found


def _load_state(docs_root: Path) -> dict[str, dict[str, Any]]:
    path = docs_root / ASSETS_DIRNAME / VERSIONS_FILENAME
    if not path.exists():
        return {}
    return json.loads(path.read_text(encoding="utf-8"))


def next_versions(docs_root: Path) -> dict[str, dict[str, Any]]:
    """Resolve the version each asset should carry.

    Seeds from the highest version already in the HTML when there is no
    recorded state, so adopting this script is a no-op for live caches.
    """
    state = _load_state(docs_root)
    observed = observed_versions(docs_root)
    resolved: dict[str, dict[str, Any]] = {}

    for asset in _versioned_assets(docs_root):
        name = asset.name
        sha = asset_hash(asset)
        prior = state.get(name)

        if prior is None:
            # First adoption: take the highest version the site already uses
            # (or 1 if the asset is referenced nowhere yet).
            version = max(observed.get(name, {1}))
        elif prior["sha"] == sha:
            version = int(prior["v"])
        else:
            version = int(prior["v"]) + 1

        resolved[name] = {"v": version, "sha": sha}

    return resolved


def rewrite_html(text: str, versions: dict[str, dict[str, Any]]) -> str:
    """Point every known asset reference at its resolved version.

    References to files that are not in docs/assets/ are left untouched — we
    do not own their versioning and must not invent one.
    """
    for name, info in versions.items():
        text = _reference_re(name).sub(rf"\g<1>{info['v']}", text)
    return text


def sync(docs_root: Path, *, write: bool = True) -> tuple[list[Path], dict[str, dict[str, Any]]]:
    """Rewrite stale references. Returns (changed files, resolved versions)."""
    versions = next_versions(docs_root)
    changed: list[Path] = []

    for path in _html_files(docs_root):
        original = path.read_text(encoding="utf-8")
        updated = rewrite_html(original, versions)
        if updated != original:
            changed.append(path)
            if write:
                path.write_text(updated, encoding="utf-8")

    if write:
        state_path = docs_root / ASSETS_DIRNAME / VERSIONS_FILENAME
        state_path.parent.mkdir(parents=True, exist_ok=True)
        state_path.write_text(
            json.dumps(versions, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
            encoding="utf-8",
        )

    return changed, versions


def main() -> None:
    ap = argparse.ArgumentParser(description="Sync ?v= asset versions across docs/**/*.html")
    ap.add_argument("--docs-root", type=Path, default=DOCS_ROOT)
    ap.add_argument(
        "--check",
        action="store_true",
        help="Report drift and exit non-zero without writing anything",
    )
    args = ap.parse_args()

    if args.check:
        divergent = find_divergent(args.docs_root)
        unversioned = find_unversioned(args.docs_root)
        stale, _ = sync(args.docs_root, write=False)
        if divergent:
            for name, versions in divergent.items():
                print(f"  DIVERGENT {name}: {versions}")
        for path, ref in unversioned:
            print(f"  UNVERSIONED {path.relative_to(args.docs_root)}: {ref} (no ?v=)")
        for path in stale:
            print(f"  STALE {path.relative_to(args.docs_root)}")
        if divergent or unversioned or stale:
            sys.exit(1)
        print("Asset versions are consistent.")
        return

    changed, versions = sync(args.docs_root)
    for name in sorted(versions):
        print(f"  {name} -> v={versions[name]['v']}")
    print(f"\nRewrote {len(changed)} file(s).")
    for path in changed:
        print(f"  {path.relative_to(args.docs_root)}")


if __name__ == "__main__":
    main()
