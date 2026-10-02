"""Build static GitHub Pages site from summary.csv.

Converts `output/<conference>/summary.csv` -> `docs/<conference>/papers.json`,
which the static viewer (`docs/<conference>/index.html`) consumes. Running
without --conference rebuilds every conference directory that has a
summary.csv.

Run:
    python paperpilot/scripts/build_pages.py                    # all conferences
    python paperpilot/scripts/build_pages.py --conference iclr-2026

summary.csv cells carry a spreadsheet formula guard — a leading apostrophe on a cell that
would otherwise open with = + - @ tab or CR. The reader removes it, so the guard protects
the CSV a human opens without ever becoming catalog text. A conference index entry's
"generated" date comes from summary.meta.json, the collection build_summary_csv actually
read, and falls back to the newest papers_*.csv when that sidecar is absent, unreadable or
names no file in the conference directory.

A build that loses catalog content is refused and exits non-zero with every published
file unchanged: fewer rows, fewer Oral rows, a published paper_id missing from the new
rows, or a published abstract / author list that came back empty. Pass --allow-shrink
once the smaller collection has been checked by hand, or --allow-shrink-for CONF to
acknowledge the loss for that one conference while the others keep the gate.

An unscoped build is also refused when the published conferences.json lists a conference
it cannot rebuild (its output/<conf>/summary.csv is gone): that index rewrite would take
the conference's catalog card offline, and there is no new catalog to compare to notice.
Every --allow-shrink-for entry is validated as a slug and must name a conference this run
publishes or one the published index still lists, so a typo fails loudly instead of being
a silent no-op.

A build scoped with --conference that produces nothing is a failure, not a skip: the
catalog it was asked to rebuild is not there, so it exits non-zero instead of reporting
success. An unscoped build keeps skipping a directory without summary.csv.

A multi-conference build is all-or-nothing: every selected conference is prepared and
validated in memory first, so a conference that is refused leaves the other catalogs,
the landing index and the detail shards describing the same, previous site.
"""

from __future__ import annotations

import argparse
import csv
import html
import json
import re
import unicodedata
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

from paperpilot.identity import IdentityError, identity_from_url, normalize_alias
from paperpilot.scripts import scaffold_conference_page
from paperpilot.scripts._common import validate_conference_slug
from paperpilot.scripts.build_summary_csv import SUMMARY_META_FILENAME
from paperpilot.utils.atomic import atomic_write_text
from paperpilot.utils.csv_safety import unneutralize

ROOT = Path(__file__).resolve().parents[2]
PROJECT = Path(__file__).resolve().parents[1]
DOCS_ROOT = ROOT / "docs"

# Output dirs that have a summary.csv but are NOT conferences and must not
# appear in the conference index / catalog. "daily" is the daily-watch
# collection output (config.daily-watch.yaml); rendering it as a conference
# card would link to docs/daily/ which has no catalog page.
# Public, not _private: build_search_index.py has to exclude the same set,
# and a second copy of it would drift.
NON_CONFERENCE = {"daily"}


# papers.json ships in full to every catalog visitor, so storing complete
# 1,400-char abstracts for a multi-thousand-paper proceedings (e.g. ICLR's
# 5k+ accepted set) would be a ~10 MB download per page. The list view only
# needs a teaser; the full paper is one click away via the card's OpenReview /
# arXiv link. Previewing here keeps every catalog page light.
_ABSTRACT_PREVIEW_CHARS = 320
_PAPER_ID_RE = re.compile(r"^[0-9a-f]{40}$")

# scaffold_conference_page refuses to overwrite these docs/ paths with a catalog
# page, so a build writing docs/<slug>/ there would collide with a static route.
# That set is the one list of reserved public paths; the template slug in it is
# scaffold's overwrite guard, not a public path — docs/cvpr-2026/ is a real
# published catalog this build must keep producing.
_RESERVED_PUBLIC_PATHS = scaffold_conference_page._RESERVED_CONFERENCE_PATHS - {
    scaffold_conference_page.TEMPLATE_CONF
}

# A no-JS fallback is deliberately a bounded emergency view, not a second copy
# of the full interactive application. These ceilings cover the current largest
# catalog (5,351 rows / roughly 2.5 MiB) while making growth an explicit review
# decision instead of allowing an unbounded checked-in HTML artifact.
NOJS_MAX_PAPERS = 6_000
NOJS_MAX_RENDERED_BYTES = 3 * 1024 * 1024


class CatalogShrinkError(RuntimeError):
    """Refused to publish a catalog that would lose content from the one already online.

    Every upstream collector degrades to a *valid but thinner* result when a fetch fails,
    when the upstream listing page changes, or when the arXiv oral overlay is skipped, so
    losing rows, Oral labels, published identities or field content is the signature of a
    silent regression rather than of a venue that genuinely changed. The row count alone
    cannot see the last three: a partial oral-overlay loss keeps every row, a
    re-collection can return a different set of papers at the same count, and an upstream
    markup change can empty a field while keeping the row. Publishing any of them strips
    the live catalog with nothing left to compare against, so the build stops and demands
    an explicit ``--allow-shrink`` / ``--allow-shrink-for`` acknowledgement.
    """


def _abstract_preview(text: str | None) -> str:
    """Trim an abstract to a short, word-boundary preview with an ellipsis."""
    text = (text or "").strip()
    if len(text) <= _ABSTRACT_PREVIEW_CHARS:
        return text
    head = text[:_ABSTRACT_PREVIEW_CHARS]
    # Cut back to the last word boundary so we don't slice a word in half;
    # fall back to the hard cut if there's no space (one very long token).
    cut = head.rsplit(" ", 1)[0].rstrip() or head.rstrip()
    return f"{cut}…"


def _maybe_int(value: str | None) -> int | None:
    """Parse a numeric field from the CSV. Empty / missing / unparseable -> None."""
    if value is None:
        return None
    value = value.strip()
    if not value:
        return None
    try:
        return int(float(value))  # handles "17.0" etc from pandas-exported CSVs
    except ValueError:
        return None


def _safe_http_url(value: object) -> str | None:
    """Return an absolute HTTP(S) URL without credentials, else ``None``."""

    if not isinstance(value, str):
        return None
    candidate = value.strip()
    if not candidate or any(
        ord(character) < 33 or ord(character) == 127 for character in candidate
    ):
        return None
    try:
        parsed = urlsplit(candidate)
        port = parsed.port
    except (TypeError, ValueError):
        return None
    if (
        parsed.scheme not in {"http", "https"}
        or not parsed.hostname
        or parsed.username is not None
        or parsed.password is not None
        or (port is not None and not 1 <= port <= 65535)
    ):
        return None
    return candidate


def _validate_conference_slug(value: object) -> str:
    """Return a conference slug or fail before any filesystem access.

    Uses the collectors' own ``_common.validate_conference_slug`` so a name one of
    them was allowed to write under ``output/<slug>/`` is always buildable here,
    plus the public paths ``scaffold_conference_page`` reserves under ``docs/``.
    """

    if not isinstance(value, str):
        raise ValueError("conference must be a lowercase slug and not a reserved public path")
    if value in _RESERVED_PUBLIC_PATHS:
        raise ValueError(f"conference {value!r} is a reserved public path under docs/")
    return validate_conference_slug(value)


def _contained_path(root: Path, *parts: str) -> Path:
    """Join below ``root`` and reject symlink/path escapes fail-closed."""

    candidate = root.joinpath(*parts)
    resolved_root = root.resolve()
    resolved_candidate = candidate.resolve()
    if not resolved_candidate.is_relative_to(resolved_root):
        raise ValueError(f"conference path escapes configured root: {candidate}")
    return candidate


def _paper_title(paper: dict[str, Any]) -> str:
    return str(paper.get("title") or "Untitled paper")


def _paper_title_sort_key(paper: dict[str, Any]) -> tuple[str, str]:
    """Human-readable deterministic order, with paper identity as the tie-break."""

    normalized = unicodedata.normalize("NFKC", _paper_title(paper))
    return " ".join(normalized.split()).casefold(), str(paper["paper_id"])


def render_paper_links_page(
    conference: str,
    papers: list[dict[str, Any]],
) -> str:
    """Render the bounded original-paper-only no-JavaScript fallback.

    Reviewed slide links remain absent until the SD4 promotion owner can pass a
    verified immutable public-index bundle. A caller-provided path mapping is
    intentionally not accepted as a substitute for that trust boundary.
    """

    conference = _validate_conference_slug(conference)
    if len(papers) > NOJS_MAX_PAPERS:
        raise ValueError(f"no-JS projection exceeds row limit: {len(papers)} > {NOJS_MAX_PAPERS}")
    by_id: dict[str, dict[str, Any]] = {}
    for ordinal, paper in enumerate(papers):
        paper_id = paper.get("paper_id")
        if not isinstance(paper_id, str) or not _PAPER_ID_RE.fullmatch(paper_id):
            raise IdentityError(f"invalid paper_id in no-JS projection at row {ordinal}")
        if paper_id in by_id:
            raise IdentityError(f"duplicate paper_id in no-JS projection: {paper_id}")
        by_id[paper_id] = paper

    rows: list[str] = []
    for paper in sorted(by_id.values(), key=_paper_title_sort_key):
        paper_id = str(paper["paper_id"])
        title = html.escape(_paper_title(paper), quote=True)
        source_url = _safe_http_url(paper.get("arxiv_url")) or _safe_http_url(paper.get("pdf_url"))
        if source_url is None:
            title_markup = title
            status = (
                '          <p class="paper__detail-status">原論文リンクを利用できません。</p>\n'
            )
        else:
            title_markup = (
                f'<a href="{html.escape(source_url, quote=True)}" target="_blank" '
                f'rel="noopener noreferrer">{title}</a>'
            )
            status = ""
        rows.append(
            f'      <li class="paper" id="paper-{paper_id}" data-paper-id="{paper_id}">\n'
            '        <div class="paper__body">\n'
            f'          <h2 class="paper__title">{title_markup}</h2>\n'
            f"{status}"
            "        </div>\n"
            "      </li>"
        )

    conference_label = html.escape(conference, quote=True)
    list_body = "\n".join(rows) or (
        '      <li class="empty-state">掲載できる論文はありません。</li>'
    )
    rendered = f"""<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>{conference_label} 論文リンク一覧 — PaperPilot</title>
  <meta name="robots" content="noindex" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; frame-ancestors 'none'; base-uri 'self'; object-src 'none'" />
  <style>
    :root {{ color-scheme: light; font-family: system-ui, sans-serif; line-height: 1.5; }}
    body {{ margin: 0; color: #202020; background: #fbf9f5; }}
    a {{ color: #9d341f; }}
    a:focus-visible {{ outline: 2px solid #bd4b32; outline-offset: 3px; }}
    .skip-link {{ position: absolute; left: .5rem; top: .5rem; transform: translateY(-200%); }}
    .skip-link:focus {{ transform: none; }}
    .site-nav, .hero, main, .footer {{ padding: 1rem max(1rem, 5vw); }}
    .site-nav {{ display: flex; gap: 1rem; border-bottom: 1px solid #d8d3ca; }}
    .site-nav__links {{ display: flex; flex-wrap: wrap; gap: 1rem; margin: 0; list-style: none; }}
    .paper-list {{ padding: 0; list-style: none; }}
    .paper {{ padding: 1rem 0; border-top: 1px solid #d8d3ca; overflow-wrap: anywhere; }}
    .paper__title {{ margin: 0 0 .5rem; font-size: 1.05rem; }}
  </style>
</head>
<body>
  <a class="skip-link" href="#main-content">本文へスキップ</a>
  <nav class="site-nav" aria-label="グローバル">
    <a class="site-nav__brand" href="../">PaperPilot</a>
    <ul class="site-nav__links">
      <li><a href="../" aria-current="page">探す</a></li>
      <li><a href="../themes/">系譜</a></li>
      <li><a href="../how-it-works/">仕組み</a></li>
    </ul>
  </nav>
  <header class="hero hero--compact">
    <h1 class="hero__title">{conference_label} <em>論文リンク一覧</em></h1>
    <p class="hero__tagline">JavaScript なしで利用できる簡易一覧です。検索と絞り込みは<a href="./">通常版</a>で利用できます。</p>
  </header>
  <main id="main-content">
    <p class="results-meta" id="paper-links-description">論文タイトルから原論文を開けます。</p>
    <ul class="paper-list" aria-describedby="paper-links-description">
{list_body}
    </ul>
  </main>
  <footer class="footer">
    <span>Generated by <a href="https://github.com/taichiiiiiiii/automatic-paper-search">PaperPilot</a></span>
  </footer>
</body>
</html>
"""
    rendered_bytes = len(rendered.encode("utf-8"))
    if rendered_bytes > NOJS_MAX_RENDERED_BYTES:
        raise ValueError(
            "no-JS projection exceeds rendered byte limit: "
            f"{rendered_bytes} > {NOJS_MAX_RENDERED_BYTES}"
        )
    return rendered


def paper_links_page_path(conference: str) -> Path:
    """Where ``conference``'s no-JS fallback is published (validated, contained)."""

    conference = _validate_conference_slug(conference)
    return _contained_path(DOCS_ROOT, conference, "paper-links.html")


def publish_paper_links_page(output: Path, rendered: str) -> None:
    """Atomically replace the fallback at ``output`` with an already-rendered page.

    Rendering is separate from publishing so ``prepare_conference`` can run every
    no-JS validation before a single byte of the build is published.
    """

    output.parent.mkdir(parents=True, exist_ok=True)
    atomic_write_text(output, rendered)


def write_paper_links_page(
    conference: str,
    papers: list[dict[str, Any]],
) -> Path:
    output = paper_links_page_path(conference)
    publish_paper_links_page(output, render_paper_links_page(conference, papers))
    return output


def load_summary_with_details(
    summary_csv: Path,
) -> tuple[list[dict[str, Any]], dict[str, str]]:
    """Load one catalog projection and its full-abstract detail records.

    Cells come back without the spreadsheet formula guard (``csv_safety``), so the
    published text is the upstream text.
    """

    papers: list[dict[str, Any]] = []
    details: dict[str, str] = {}
    with summary_csv.open(encoding="utf-8", newline="") as f:
        reader = csv.DictReader(f)
        for raw_row in reader:
            # summary.csv cells were formula-neutralized for the spreadsheet a human
            # opens. That guard prefix is not part of the text, and publishing it would
            # put "'-Deep nets" in papers.json, paper-links.html and the search index
            # for the paper actually called "-Deep nets".
            row = {k: unneutralize(v) if isinstance(v, str) else v for k, v in raw_row.items()}
            identity = identity_from_url(row.get("arxiv_url") or "")
            declared_source = (row.get("source") or "").strip()
            declared_source_id = (row.get("source_id") or "").strip()
            if bool(declared_source) != bool(declared_source_id):
                raise IdentityError("source and source_id must be present together")
            if declared_source:
                normalized = normalize_alias(declared_source, declared_source_id)
                if normalized != (identity.source, identity.source_id):
                    raise IdentityError(
                        "declared source/source_id does not match the native source URL"
                    )

            full_abstract = (row.get("abstract") or "").strip()
            existing_abstract = details.get(identity.paper_id)
            if existing_abstract is not None and existing_abstract != full_abstract:
                raise IdentityError(f"conflicting abstracts for paper_id {identity.paper_id}")
            details[identity.paper_id] = full_abstract
            papers.append(
                {
                    "title": row["title"],
                    "type": row["type"],
                    "tags": row["tags"].split() if row["tags"] else [],
                    "venue": row["venue"],
                    "authors": [a.strip() for a in re.split(r"[;,]", row["authors"]) if a.strip()],
                    "arxiv_url": row["arxiv_url"],
                    "pdf_url": row["pdf_url"],
                    "abstract": _abstract_preview(full_abstract),
                    # Stage 2 signal outputs carried forward from summary.csv.
                    # Strings stay as strings (empty="" for missing); numerics
                    # become ints so the viewer skips coercion.
                    "arxiv_id": row.get("arxiv_id", ""),
                    "citation_count": _maybe_int(row.get("citation_count")),
                    "venue_tier": _maybe_int(row.get("venue_tier")),
                    "github_stars": _maybe_int(row.get("github_stars")),
                    "paper_id": identity.paper_id,
                    "source": identity.source,
                    "source_id": identity.source_id,
                }
            )
    return papers, details


def load_summary(summary_csv: Path) -> list[dict[str, Any]]:
    """Compatibility wrapper returning the catalog list projection only."""

    papers, _details = load_summary_with_details(summary_csv)
    return papers


_DATA_DATE_RE = re.compile(r"^papers_(\d{4}-\d{2}-\d{2})\.csv$")


def _latest_data_date(conf_dir: Path) -> str | None:
    """The newest papers_YYYY-MM-DD.csv date — the real data collection date.

    This is the honest "last updated" value for the catalog (the viewer used
    to show the page-load date, which drifts every visit). Returns None if no
    dated papers file exists (legacy conferences built before this convention).

    Only the fallback in :func:`_generated_date`: a summary.csv that recorded
    its own source in the summary sidecar is dated by that file instead.
    """
    dates = sorted(
        m.group(1) for f in conf_dir.glob("papers_*.csv") if (m := _DATA_DATE_RE.match(f.name))
    )
    return dates[-1] if dates else None


def _generated_date(conf_dir: Path) -> str | None:
    """The collection date of the CSV ``conf_dir``'s summary.csv was actually built from.

    ``build_summary_csv`` records the papers_*.csv it read in a sidecar beside the
    summary, because the newest dated CSV in the directory is only a guess: a
    re-collection that wrote a newer CSV without a re-summary would otherwise stamp the
    catalog — and the landing page's "last updated" — with the date of rows the catalog
    does not contain. The sidecar names that file by basename, so it is only trusted when
    a file of that name is really in this conference directory: a name pointing elsewhere
    (another conference's collection, a CSV since moved away) dates this catalog by rows
    this catalog does not hold. A conference summarised before the sidecar existed, one
    whose sidecar cannot be read or names nothing dated, and one whose sidecar names an
    absent file, all keep the previous behaviour — the newest dated CSV — so adding the
    sidecar does not by itself rewrite the published index.
    """
    try:
        meta = json.loads((conf_dir / SUMMARY_META_FILENAME).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return _latest_data_date(conf_dir)
    if isinstance(meta, dict) and isinstance(meta.get("source"), str):
        match = _DATA_DATE_RE.match(meta["source"])
        if match and (conf_dir / meta["source"]).is_file():
            return match.group(1)
    return _latest_data_date(conf_dir)


def _oral_rows(rows: list[Any]) -> int:
    """Count catalog rows the viewer labels Oral (a non-dict row counts as none)."""
    return sum(1 for row in rows if isinstance(row, dict) and row.get("type") == "Oral")


# Fields that must not come back empty while their row survives: an upstream markup
# change (a renamed container class, a new anthology layout) empties one of them for
# every row at once, and the row count cannot see that.
_CONTENT_FIELDS = ("abstract", "authors")


def _override_hint(name: str) -> str:
    """The acknowledgement sentence appended to every refusal, naming both flags."""

    return (
        f"Re-run with --allow-shrink (all conferences) or --allow-shrink-for {name} "
        "(this conference only) once the collection has been checked by hand."
    )


def _field_is_empty(value: object) -> bool:
    """Whether a catalog field carries no content, in whichever shape the row stores it.

    ``load_summary`` publishes ``abstract`` as a string and ``authors`` as a list, and a
    catalog checked in before that shape existed still has to be comparable, so both are
    reduced to "is there any text in here".
    """

    if isinstance(value, str):
        return not value.strip()
    if isinstance(value, list):
        return all(_field_is_empty(item) for item in value)
    return value is None


def _named_ids(ids: list[str], *, limit: int = 3) -> str:
    """Name enough ids to find the loss, capped so a whole-venue loss stays readable."""

    shown = ", ".join(ids[:limit])
    more = len(ids) - limit
    if more > 0:
        shown += f" and {more} more"
    return f"{shown} ({len(ids)} in total)"


def _published_rows_by_id(published: list[Any]) -> dict[str, dict[str, Any]]:
    """Index the published catalog by ``paper_id``, skipping rows that carry none.

    A checked-in catalog predating the ``paper_id`` field cannot be matched to a new row,
    so those rows are left out of the identity and content comparison instead of being
    reported as a loss no build could ever satisfy.
    """

    rows: dict[str, dict[str, Any]] = {}
    for row in published:
        if not isinstance(row, dict):
            continue
        paper_id = row.get("paper_id")
        if isinstance(paper_id, str) and paper_id:
            rows[paper_id] = row
    return rows


def _collapsed_content_ids(
    published_rows: dict[str, dict[str, Any]],
    new_rows: dict[str, dict[str, Any]],
    field: str,
) -> list[str]:
    """Published ids whose ``field`` held content and now holds none.

    Only emptiness counts: ``papers.json`` ships a truncated abstract preview, so its
    length and wording legitimately change between builds while the content is there.
    """

    collapsed: list[str] = []
    for paper_id, published_row in published_rows.items():
        # A paper missing altogether is refused by the identity check before this one,
        # so a row that is not here at all is deliberately not double-reported.
        new_row = new_rows.get(paper_id)
        if new_row is None:
            continue
        had_content = not _field_is_empty(published_row.get(field))
        if had_content and _field_is_empty(new_row.get(field)):
            collapsed.append(paper_id)
    return collapsed


def _refuse_catalog_shrink(
    name: str,
    published_json: Path,
    papers: list[dict[str, Any]],
    *,
    allow_shrink: bool,
) -> None:
    """Raise :class:`CatalogShrinkError` when publishing ``papers`` loses catalog content.

    Compared against the currently published ``papers.json`` *before* anything is
    written, so a refusal leaves the site exactly as it was:

    - no published file -> first publication, there is nothing to lose;
    - a file that exists but cannot be read or is not a JSON array -> refuse; an
      artifact we cannot count must not be overwritten blindly;
    - fewer rows than published, or fewer Oral rows than published -> refuse; a partial
      oral-overlay loss keeps the row count and only empties the labels half-way;
    - a published ``paper_id`` missing from the new rows -> refuse even when the count is
      the same, because a re-collection that returned a *different* set of papers is an
      upstream listing change, not a venue that really moved;
    - a published non-empty ``abstract`` or ``authors`` that came back empty -> refuse.

    ``allow_shrink`` is the operator's acknowledgement (``--allow-shrink`` for every
    conference, ``--allow-shrink-for <name>`` for this one alone) that the loss is
    intended, so it skips every check above.
    """
    if allow_shrink or not published_json.is_file():
        return

    try:
        published = json.loads(published_json.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        # json.JSONDecodeError and UnicodeDecodeError are both ValueError subclasses.
        raise CatalogShrinkError(
            f"{name}: published catalog {published_json} exists but cannot be inspected "
            f"({type(exc).__name__}: {exc}); refusing to overwrite it blindly. Check that "
            f"file by hand. {_override_hint(name)}"
        ) from exc
    if not isinstance(published, list):
        raise CatalogShrinkError(
            f"{name}: published catalog {published_json} is not a JSON array; refusing to "
            f"overwrite it. Check that file by hand. {_override_hint(name)}"
        )

    if len(papers) < len(published):
        raise CatalogShrinkError(
            f"{name}: the new catalog has {len(papers)} row(s) while the published catalog "
            f"{published_json} has {len(published)}; refusing to publish a smaller catalog. "
            f"{_override_hint(name)}"
        )

    published_oral = _oral_rows(published)
    new_oral = _oral_rows(papers)
    if new_oral < published_oral:
        raise CatalogShrinkError(
            f"{name}: the published catalog labels {published_oral} row(s) Oral and the new "
            f"catalog labels {new_oral} (a skipped or partial arXiv oral overlay?); refusing "
            f"to erase Oral labels. {_override_hint(name)}"
        )

    published_rows = _published_rows_by_id(published)
    new_rows: dict[str, dict[str, Any]] = {row["paper_id"]: row for row in papers}
    lost_ids = [paper_id for paper_id in published_rows if paper_id not in new_rows]
    if lost_ids:
        raise CatalogShrinkError(
            f"{name}: {len(lost_ids)} published paper_id(s) are missing from the new "
            f"catalog although the row count did not drop: {_named_ids(lost_ids)}. Refusing "
            f"to publish a different set of papers. {_override_hint(name)}"
        )

    for field in _CONTENT_FIELDS:
        collapsed = _collapsed_content_ids(published_rows, new_rows, field)
        if collapsed:
            raise CatalogShrinkError(
                f"{name}: {len(collapsed)} paper(s) kept their row but lost their "
                f"'{field}' content: {_named_ids(collapsed)}. Refusing to publish empty "
                f"'{field}' fields. {_override_hint(name)}"
            )


def _published_index_names(published_index: Path) -> list[str]:
    """The conference names the currently published landing index lists.

    Returns ``[]`` when there is no published index — a first build has nothing to lose.
    An index that exists but cannot be read or is not a JSON array is refused like an
    uninspectable catalog: the full build is about to replace it, and a file whose
    contents the build cannot count must not be overwritten blindly.
    """
    if not published_index.is_file():
        return []
    try:
        published = json.loads(published_index.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        # json.JSONDecodeError and UnicodeDecodeError are both ValueError subclasses.
        raise CatalogShrinkError(
            f"published catalog index {published_index} exists but cannot be inspected "
            f"({type(exc).__name__}: {exc}); refusing to overwrite it blindly. Check that "
            "file by hand, or re-run with --allow-shrink once the tree has been checked."
        ) from exc
    if not isinstance(published, list):
        raise CatalogShrinkError(
            f"published catalog index {published_index} is not a JSON array; refusing to "
            "overwrite it. Check that file by hand, or re-run with --allow-shrink once the "
            "tree has been checked."
        )
    return [
        entry["name"]
        for entry in published
        if isinstance(entry, dict) and isinstance(entry.get("name"), str) and entry["name"]
    ]


def _refuse_index_shrink(
    published_index: Path,
    building: list[str],
    published_names: list[str],
    *,
    allow_shrink_for: set[str],
) -> None:
    """Refuse a full build that would drop a published conference from the landing index.

    ``conferences.json`` is rewritten from the catalogs this run built, so a published
    conference with no ``output/<conf>/summary.csv`` — a deleted collection dir, an output
    dir the checkout does not carry — silently loses its catalog card along with the
    catalog it links to. The per-catalog gate cannot see that: it compares a new catalog
    against a published one, and here there is no new catalog at all. For a new conference
    there is no baseline either, which is why this gate is not the catalog gate's equal.
    """
    building_set = set(building)
    missing = [
        name
        for name in published_names
        if name not in building_set and name not in allow_shrink_for
    ]
    if not missing:
        return
    raise CatalogShrinkError(
        f"{_named_ids(missing)} conference(s) are listed by the published index "
        f"{published_index} but are not part of this full build; refusing to republish the "
        f"landing index without them. Restore their output/<conference>/summary.csv, or "
        f"re-run with --allow-shrink (all conferences) or --allow-shrink-for <name> (one "
        f"of them) once the tree has been checked by hand."
    )


def _validated_shrink_acks(
    entries: list[str],
    *,
    building: list[str],
    selected: str | None,
    published_names: list[str],
) -> set[str]:
    """Validate every ``--allow-shrink-for`` entry and return the acknowledged slugs.

    Each entry goes through the same validator as a conference build, so a value that
    could never name a catalog is refused instead of quietly doing nothing. An
    acknowledgement must also name something this run can publish: a scoped build
    acknowledges only the conference it selected, a full build any conference it selected
    or any conference the published index still lists. Otherwise a typo ("iclr2026")
    reads as a successful loosening of the gate to the operator while the gate stayed on.
    """
    acknowledged: set[str] = set()
    building_set = set(building)
    for entry in entries:
        try:
            name = _validate_conference_slug(entry)
        except ValueError as exc:
            raise ValueError(f"--allow-shrink-for: {exc}") from exc
        if selected is not None:
            if name != selected:
                raise ValueError(
                    f"--allow-shrink-for {name} acknowledges nothing: this build is scoped "
                    f"to --conference {selected}"
                )
        elif name not in building_set and name not in published_names:
            raise ValueError(
                f"--allow-shrink-for {name} acknowledges nothing: it is neither one of the "
                f"conferences this build publishes ({', '.join(building) or 'none'}) nor a "
                f"conference the published index lists ({', '.join(published_names) or 'none'})"
            )
        acknowledged.add(name)
    return acknowledged


@dataclass(frozen=True)
class PreparedConference:
    """One conference's validated catalog and rendered fallback, staged in memory.

    Produced by :func:`prepare_conference` and consumed by :func:`publish_conference`.
    Holding the finished artifacts lets a multi-conference build decide the whole run
    before touching the live site: publishing conference #1 and only then losing #2
    would ship a catalog whose landing index and detail shards still describe the
    previous build.
    """

    out_json: Path
    papers_json: str
    fallback_output: Path
    rendered_fallback: str
    entry: dict[str, Any]


def prepare_conference(
    name: str,
    *,
    detail_sink: dict[str, str] | None = None,
    allow_shrink: bool = False,
) -> PreparedConference | None:
    """Build and validate ``name``'s artifacts without writing anything.

    Returns ``None`` when the conference has no ``summary.csv``; :func:`main` skips that
    for a full build and fails on it for a scoped one, because only a scoped run was
    asked for exactly this catalog. Every check that can refuse a build runs here — the
    identity merge into ``detail_sink``, the content-loss gate against the live catalog,
    and the no-JS render with its row limit, duplicate-paper_id and byte-budget ceilings —
    so publishing afterwards is only a rename, and a refusal costs the site nothing.
    """
    name = _validate_conference_slug(name)
    summary_csv = _contained_path(PROJECT / "output", name, "summary.csv")
    if not summary_csv.exists():
        print(f"  skip {name}: no summary.csv")
        return None
    conf_dir = summary_csv.parent

    papers, details = load_summary_with_details(summary_csv)
    if detail_sink is not None:
        for paper_id, abstract in details.items():
            existing = detail_sink.get(paper_id)
            if existing is not None and existing != abstract:
                raise IdentityError(f"conflicting abstracts for paper_id {paper_id}")
            detail_sink[paper_id] = abstract
    out_json = _contained_path(DOCS_ROOT, name) / "papers.json"

    # The shrink gate runs against the live catalog, so an incomplete collection
    # cannot quietly replace a complete one.
    _refuse_catalog_shrink(name, out_json, papers, allow_shrink=allow_shrink)

    # Rendering the no-JS fallback is the last validation that can fail, and a
    # catalog whose fallback page the build refused would be unpublishable.
    fallback_output = paper_links_page_path(name)
    rendered_fallback = render_paper_links_page(name, papers)

    tag_counts: dict[str, int] = {}
    type_counts: dict[str, int] = {}
    for p in papers:
        for t in p["tags"]:
            tag_counts[t] = tag_counts.get(t, 0) + 1
        type_counts[p["type"]] = type_counts.get(p["type"], 0) + 1

    return PreparedConference(
        out_json=out_json,
        papers_json=json.dumps(papers, ensure_ascii=False, indent=0),
        fallback_output=fallback_output,
        rendered_fallback=rendered_fallback,
        entry={
            "name": name,
            "papers": len(papers),
            "types": type_counts,
            "top_tags": sorted(tag_counts.items(), key=lambda x: -x[1])[:6],
            # Real collection date (the papers_*.csv summary.csv was built from, per
            # the summary sidecar; else the newest one) so the viewer's "last
            # updated" stat reflects the data, not the page-load time.
            "generated": _generated_date(conf_dir),
        },
    )


def publish_conference(prepared: PreparedConference) -> None:
    """Atomically replace one conference's ``papers.json`` and no-JS fallback."""

    prepared.out_json.parent.mkdir(parents=True, exist_ok=True)
    # The committed catalogs end in one newline, so the payload must too: without it a
    # full rebuild rewrites every unchanged papers.json with a newline-only diff, and
    # the promotion allowlist check dies on those tracked changes.
    atomic_write_text(prepared.out_json, prepared.papers_json + "\n")
    publish_paper_links_page(prepared.fallback_output, prepared.rendered_fallback)


def build_conference(
    name: str,
    *,
    detail_sink: dict[str, str] | None = None,
    allow_shrink: bool = False,
) -> dict[str, Any] | None:
    """Prepare and publish ``name`` in one step, for single-catalog rebuilds."""

    prepared = prepare_conference(name, detail_sink=detail_sink, allow_shrink=allow_shrink)
    if prepared is None:
        return None
    publish_conference(prepared)
    return prepared.entry


def write_index(conferences: list[dict[str, Any]]) -> None:
    index_data = DOCS_ROOT / "conferences.json"
    atomic_write_text(index_data, json.dumps(conferences, ensure_ascii=False, indent=2))


def write_detail_shards(details: dict[str, str]) -> list[Path]:
    """Write 256 deterministic, lazily loaded full-abstract shards."""

    shard_root = DOCS_ROOT / "paper-details-v1"
    shard_root.mkdir(parents=True, exist_ok=True)
    by_prefix: dict[str, list[list[str]]] = {f"{value:02x}": [] for value in range(256)}
    for paper_id, abstract in sorted(details.items()):
        if not re.fullmatch(r"[0-9a-f]{40}", paper_id):
            raise IdentityError(f"invalid paper_id in detail projection: {paper_id!r}")
        by_prefix[paper_id[:2]].append([paper_id, abstract])

    outputs: list[Path] = []
    for prefix, papers in by_prefix.items():
        output = shard_root / f"{prefix}.json"
        atomic_write_text(
            output,
            json.dumps(
                {
                    "schema_version": "paper-details-v1",
                    "prefix": prefix,
                    "papers": papers,
                },
                ensure_ascii=False,
                separators=(",", ":"),
            )
            + "\n",
        )
        outputs.append(output)
    return outputs


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--conference", help="Build only this conference (e.g. iclr-2026)")
    ap.add_argument(
        "--allow-shrink",
        action="store_true",
        help="publish a catalog that loses content against the published one (fewer rows, "
        "fewer Oral rows, a published paper_id missing, an abstract or author list that "
        "came back empty) for every conference (default: refuse and leave the published "
        "site unchanged)",
    )
    ap.add_argument(
        "--allow-shrink-for",
        action="append",
        default=[],
        metavar="CONF",
        help="acknowledge that loss for one conference only; repeatable. Every other "
        "conference keeps the gate and still refuses the run",
    )
    args = ap.parse_args()

    conf_dirs: list[str]
    output_dir = PROJECT / "output"
    if args.conference:
        conf_dirs = [args.conference]
    else:
        conf_dirs = sorted(
            d.name
            for d in output_dir.iterdir()
            if d.is_dir() and d.name not in NON_CONFERENCE and (d / "summary.csv").exists()
        )

    published_index = DOCS_ROOT / "conferences.json"
    # An acknowledgement that names nothing this run can publish loosens the gate for
    # nobody, so the entries are checked before any catalog is prepared. Judging a full
    # build's entries needs the published index, and --allow-shrink alone waives that
    # comparison entirely — including the "cannot be inspected" refusal, because a corrupt
    # index is exactly what this rebuild repairs and the operator already checked the tree.
    inspect_index = not args.conference and bool(args.allow_shrink_for or not args.allow_shrink)
    try:
        published_names = _published_index_names(published_index) if inspect_index else []
        allow_shrink_for = _validated_shrink_acks(
            args.allow_shrink_for,
            building=conf_dirs,
            selected=args.conference,
            published_names=published_names,
        )
    except (ValueError, CatalogShrinkError) as exc:
        print(f"⚠️  {exc}")
        raise SystemExit(1) from exc

    if not conf_dirs:
        print(f"No conferences with summary.csv found under {output_dir}")
        return

    print(f"Building {len(conf_dirs)} conference(s):")
    # Phase 1: prepare the whole selection before a single published file is replaced.
    # Publishing conference by conference would leave the earlier catalogs swapped when
    # a later one is refused, while conferences.json and the detail shards written in
    # phase 2 still describe the old site — an internally inconsistent publication.
    results: list[PreparedConference] = []
    details: dict[str, str] = {}
    for name in conf_dirs:
        try:
            prepared = prepare_conference(
                name,
                detail_sink=details,
                allow_shrink=args.allow_shrink or name in allow_shrink_for,
            )
        except CatalogShrinkError as exc:
            # Stop before anything is written: a refused catalog must leave every
            # published artifact of this run, other conferences included, unchanged.
            print(f"⚠️  {exc}")
            raise SystemExit(1) from exc
        except Exception as exc:
            # An identity or no-JS failure aborts the run the same way; nothing has
            # been written yet, so the live site is untouched either way.
            print(f"⚠️  {name}: {type(exc).__name__}: {exc}")
            raise SystemExit(1) from exc
        if prepared is None:
            if not args.conference:
                # Discovery only selects directories that have a summary.csv, so an
                # unscoped build can only lose one by a race: still a skip, exit 0.
                continue
            expected = _contained_path(PROJECT / "output", name, "summary.csv")
            print(f"⚠️  {name}: nothing to build — {expected} does not exist")
            raise SystemExit(1)
        results.append(prepared)

    # A full build also decides the landing index before publishing: a published
    # conference it cannot rebuild would lose its catalog card with no catalog comparison
    # to notice it. --allow-shrink is the operator's blanket acknowledgement, so it skips
    # the comparison (and skipped the index read) rather than needing an entry per name.
    if not args.conference and not args.allow_shrink:
        try:
            _refuse_index_shrink(
                published_index,
                conf_dirs,
                published_names,
                allow_shrink_for=allow_shrink_for,
            )
        except CatalogShrinkError as exc:
            print(f"⚠️  {exc}")
            raise SystemExit(1) from exc

    # Phase 2: every check passed, so publish the catalogs and then the global
    # artifacts built from the same in-memory data.
    for prepared in results:
        publish_conference(prepared)
        print(f"  {prepared.entry['name']}: {prepared.entry['papers']} papers")

    if args.conference:
        print("\nScoped build complete; global conferences.json and detail shards unchanged.")
    else:
        write_index([prepared.entry for prepared in results])
        write_detail_shards(details)
        print(f"\nWrote conferences.json -> {DOCS_ROOT}/")


if __name__ == "__main__":
    main()
