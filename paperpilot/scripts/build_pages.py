"""Build static GitHub Pages site from summary.csv.

Converts `output/<conference>/summary.csv` -> `docs/<conference>/papers.json`,
which the static viewer (`docs/<conference>/index.html`) consumes. Running
without --conference rebuilds every conference directory that has a
summary.csv.

Run:
    python paperpilot/scripts/build_pages.py                    # all conferences
    python paperpilot/scripts/build_pages.py --conference iclr-2026
"""

from __future__ import annotations

import argparse
import csv
import html
import json
import os
import re
import tempfile
import unicodedata
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

from paperpilot.identity import IdentityError, identity_from_url, normalize_alias

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
_CONFERENCE_SLUG_RE = re.compile(r"^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])$")

# A no-JS fallback is deliberately a bounded emergency view, not a second copy
# of the full interactive application. These ceilings cover the current largest
# catalog (5,351 rows / roughly 2.5 MiB) while making growth an explicit review
# decision instead of allowing an unbounded checked-in HTML artifact.
NOJS_MAX_PAPERS = 6_000
NOJS_MAX_RENDERED_BYTES = 3 * 1024 * 1024


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
    """Return a bounded conference slug or fail before any filesystem access."""

    if (
        not isinstance(value, str)
        or _CONFERENCE_SLUG_RE.fullmatch(value) is None
        or value in NON_CONFERENCE
    ):
        raise ValueError("conference must be a 2-40 character lowercase slug and not reserved")
    return value


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


def write_paper_links_page(
    conference: str,
    papers: list[dict[str, Any]],
) -> Path:
    conference = _validate_conference_slug(conference)
    output = _contained_path(DOCS_ROOT, conference, "paper-links.html")
    output.parent.mkdir(parents=True, exist_ok=True)
    rendered = render_paper_links_page(conference, papers)
    temporary: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="w",
            encoding="utf-8",
            dir=output.parent,
            prefix=f".{output.name}.",
            suffix=".tmp",
            delete=False,
        ) as handle:
            temporary = Path(handle.name)
            handle.write(rendered)
            handle.flush()
            os.fsync(handle.fileno())
        assert temporary is not None
        os.chmod(temporary, 0o644)
        os.replace(temporary, output)
        temporary = None
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)
    return output


def load_summary_with_details(
    summary_csv: Path,
) -> tuple[list[dict[str, Any]], dict[str, str]]:
    """Load one catalog projection and its full-abstract detail records."""

    papers: list[dict[str, Any]] = []
    details: dict[str, str] = {}
    with summary_csv.open(encoding="utf-8", newline="") as f:
        reader = csv.DictReader(f)
        for row in reader:
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
    """
    dates = sorted(
        m.group(1) for f in conf_dir.glob("papers_*.csv") if (m := _DATA_DATE_RE.match(f.name))
    )
    return dates[-1] if dates else None


def build_conference(
    name: str,
    *,
    detail_sink: dict[str, str] | None = None,
) -> dict[str, Any] | None:
    name = _validate_conference_slug(name)
    summary_csv = _contained_path(PROJECT / "output", name, "summary.csv")
    if not summary_csv.exists():
        print(f"  skip {name}: no summary.csv")
        return None

    papers, details = load_summary_with_details(summary_csv)
    if detail_sink is not None:
        for paper_id, abstract in details.items():
            existing = detail_sink.get(paper_id)
            if existing is not None and existing != abstract:
                raise IdentityError(f"conflicting abstracts for paper_id {paper_id}")
            detail_sink[paper_id] = abstract
    out_dir = _contained_path(DOCS_ROOT, name)
    out_dir.mkdir(parents=True, exist_ok=True)

    out_json = out_dir / "papers.json"
    out_json.write_text(json.dumps(papers, ensure_ascii=False, indent=0), encoding="utf-8")
    write_paper_links_page(name, papers)

    tag_counts: dict[str, int] = {}
    type_counts: dict[str, int] = {}
    for p in papers:
        for t in p["tags"]:
            tag_counts[t] = tag_counts.get(t, 0) + 1
        type_counts[p["type"]] = type_counts.get(p["type"], 0) + 1

    return {
        "name": name,
        "papers": len(papers),
        "types": type_counts,
        "top_tags": sorted(tag_counts.items(), key=lambda x: -x[1])[:6],
        # Real collection date (newest papers_*.csv) so the viewer's
        # "last updated" stat reflects the data, not the page-load time.
        "generated": _latest_data_date(summary_csv.parent),
    }


def write_index(conferences: list[dict[str, Any]]) -> None:
    index_data = DOCS_ROOT / "conferences.json"
    index_data.write_text(json.dumps(conferences, ensure_ascii=False, indent=2), encoding="utf-8")


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
        output.write_text(
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
            encoding="utf-8",
        )
        outputs.append(output)
    return outputs


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--conference", help="Build only this conference (e.g. iclr-2026)")
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

    if not conf_dirs:
        print(f"No conferences with summary.csv found under {output_dir}")
        return

    print(f"Building {len(conf_dirs)} conference(s):")
    results = []
    details: dict[str, str] = {}
    for name in conf_dirs:
        res = build_conference(name, detail_sink=details)
        if res:
            print(f"  {name}: {res['papers']} papers")
            results.append(res)

    if args.conference:
        print("\nScoped build complete; global conferences.json and detail shards unchanged.")
    else:
        write_index(results)
        write_detail_shards(details)
        print(f"\nWrote conferences.json -> {DOCS_ROOT}/")


if __name__ == "__main__":
    main()
