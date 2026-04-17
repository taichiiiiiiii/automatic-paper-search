"""JSON exporter — full paper records as a list."""

from __future__ import annotations

import json
from datetime import date
from pathlib import Path

from ..models import Paper
from ..utils.logger import get_logger
from .base import AbstractExporter

logger = get_logger(__name__)


class JSONExporter(AbstractExporter):
    name = "json"

    def export(self, papers: list[Paper]) -> str | None:
        if not papers:
            logger.info("json: no papers to export")
            return None

        out_dir = Path(self.config.get("dir", "./output"))
        out_dir.mkdir(parents=True, exist_ok=True)
        path = out_dir / f"papers_{date.today().isoformat()}.json"

        payload = [p.to_dict() for p in papers]
        with path.open("w", encoding="utf-8") as f:
            json.dump(payload, f, ensure_ascii=False, indent=2)
        logger.info("json: wrote %d records to %s", len(papers), path)
        return str(path)
