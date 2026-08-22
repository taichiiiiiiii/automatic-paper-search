"""Every structured file in the repo must parse as its own format.

Merging to `develop` publishes `docs/**` to production through `pages.yml`,
and the viewers fetch their JSON at runtime — a malformed `papers.json` or
`search-index.json` breaks the page with nothing failing beforehand. No
workflow runs tests (#358), so pytest is the only gate.

This was not hypothetical: #367's first generated `sitemap.xml` embedded a
double hyphen inside an XML comment, which XML forbids. The generator's own
check mode compared strings and reported "up to date" for a file no parser
could read. Same-format comparison cannot answer "is this valid?" — only a
parser can.
"""

from __future__ import annotations

import json
from html.parser import HTMLParser
from pathlib import Path
from xml.etree import ElementTree

import pytest
import yaml

REPO_ROOT = Path(__file__).resolve().parents[2]
SKIP_PARTS = {".git", ".venv", "node_modules", "__pycache__", ".pytest_cache"}

# Elements that never carry an end tag.
VOID_ELEMENTS = {
    "area", "base", "br", "col", "embed", "hr", "img", "input",
    "link", "meta", "param", "source", "track", "wbr",
}


def _iter_files(suffixes: set[str]) -> list[Path]:
    return sorted(
        p
        for p in REPO_ROOT.rglob("*")
        if p.is_file()
        and p.suffix in suffixes
        and not SKIP_PARTS & set(p.parts)
    )


@pytest.mark.parametrize(
    ("suffixes", "parse"),
    [
        pytest.param({".json"}, json.loads, id="json"),
        pytest.param({".yml", ".yaml"}, yaml.safe_load, id="yaml"),
        pytest.param({".xml"}, ElementTree.fromstring, id="xml"),
    ],
)
def test_structured_files_parse(suffixes: set[str], parse) -> None:
    files = _iter_files(suffixes)
    assert files, f"no {suffixes} file found — did the walk break?"
    broken: list[str] = []
    for path in files:
        try:
            parse(path.read_text(encoding="utf-8"))
        except Exception as exc:  # report every failure at once, not just the first
            broken.append(f"{path.relative_to(REPO_ROOT)}: {type(exc).__name__}: {exc}")
    assert not broken, "unparseable files:\n" + "\n".join(broken)


class _StructureCheck(HTMLParser):
    """Reports unclosed tags and crossed nesting.

    Deliberately does *not* silently repair a mismatch: an earlier version
    popped the stack until it found the tag and reported nothing, so
    `<div><span></div>` looked fine. `test_html_checker_detects_broken_markup`
    below pins that it still catches it.
    """

    def __init__(self) -> None:
        super().__init__()
        self.stack: list[str] = []
        self.errors: list[str] = []

    def handle_startendtag(self, tag: str, attrs: object) -> None:
        return  # self-closing: no stack effect

    def handle_starttag(self, tag: str, attrs: object) -> None:
        if tag not in VOID_ELEMENTS:
            self.stack.append(tag)

    def handle_endtag(self, tag: str) -> None:
        if tag in VOID_ELEMENTS:
            return
        if not self.stack:
            self.errors.append(f"</{tag}> with no open tag")
            return
        if self.stack[-1] != tag:
            self.errors.append(f"crossed nesting: </{tag}> while <{self.stack[-1]}> open")
            if tag in self.stack:
                while self.stack and self.stack.pop() != tag:
                    pass
            return
        self.stack.pop()


def _html_errors(source: str) -> list[str]:
    checker = _StructureCheck()
    checker.feed(source)
    return checker.errors + [f"unclosed <{tag}>" for tag in checker.stack]


def test_html_checker_detects_broken_markup() -> None:
    """The checker must fail on known-bad input before its green means anything."""
    assert _html_errors("<div><span></span></div>") == []
    assert _html_errors("<meta charset='utf-8'><br><div>a</div>") == []
    assert len(_html_errors("<div><span></div>")) == 1
    assert len(_html_errors("<div><p>x")) == 2
    assert len(_html_errors("<div></div></p>")) == 1


def test_published_html_is_structurally_sound() -> None:
    pages = sorted((REPO_ROOT / "docs").rglob("*.html"))
    assert pages, "no page found under docs/"
    broken = {
        str(p.relative_to(REPO_ROOT)): errs
        for p in pages
        if (errs := _html_errors(p.read_text(encoding="utf-8")))
    }
    assert not broken, f"structurally broken pages: {broken}"
