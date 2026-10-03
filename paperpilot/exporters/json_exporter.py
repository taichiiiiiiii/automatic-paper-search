"""JSON exporter — full paper records as a list."""

from __future__ import annotations

import json
from datetime import datetime
from pathlib import Path

from ..models import Paper
from ..utils.atomic import atomic_write_text
from ..utils.logger import get_logger
from .base import AbstractExporter

logger = get_logger(__name__)


def _resolve_export_path(out_dir: Path, ext: str) -> Path:
    """Pick the path this run writes to, without ever destroying an earlier
    same-day export.

    The daily collect workflow runs with `--fail-on-errors` and commits its
    output even on a red run; the failure Slack ping invites a same-day
    re-dispatch. Run 1 writes `papers_<date>.<ext>` and stamps seen_ids for
    its papers. If run 2 that day filtered those papers out (already seen)
    and simply overwrote `papers_<date>.<ext>` with its own (different)
    papers, run 1's output would be marked delivered yet gone from disk.

    So: the first export of the day keeps the plain name. Once that file
    exists, later exports in the same day go to a run-unique sibling
    `papers_<date>-<HHMMSS>.<ext>` (local time), falling back to a numeric
    counter if even that collides (two runs in the same wall-clock second).

    Both the date and the HHMMSS suffix are read off ONE `datetime.now()` call
    (L-3): using local `date.today()` for the date but UTC `datetime.now
    (timezone.utc)` for the suffix let the two clocks disagree right around
    local midnight (one has already rolled to the next day while the other
    hasn't), which could pick a name that doesn't actually sit next to the
    plain file it is meant to avoid clobbering.
    """
    now = datetime.now()
    today = now.date().isoformat()
    plain = out_dir / f"papers_{today}.{ext}"
    if not plain.exists():
        return plain
    stamp = now.strftime("%H%M%S")
    candidate = out_dir / f"papers_{today}-{stamp}.{ext}"
    counter = 2
    while candidate.exists():
        candidate = out_dir / f"papers_{today}-{stamp}-{counter}.{ext}"
        counter += 1
    return candidate


class JSONExporter(AbstractExporter):
    name = "json"

    def export(self, papers: list[Paper]) -> str | None:
        if not papers:
            logger.info("json: no papers to export")
            return None

        out_dir = Path(self.config.get("dir", "./output"))
        out_dir.mkdir(parents=True, exist_ok=True)
        path = _resolve_export_path(out_dir, "json")

        payload = [p.to_dict() for p in papers]
        # Serialise fully before touching the destination, then replace it by
        # rename: `open(path, "w")` truncates the published JSON before the
        # first byte is written, so a failure mid-dump leaves an empty or
        # half-written file for whatever reads it next in the same run.
        text = json.dumps(payload, ensure_ascii=False, indent=2)
        atomic_write_text(path, text)
        logger.info("json: wrote %d records to %s", len(papers), path)
        return str(path)
