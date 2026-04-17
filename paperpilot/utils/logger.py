"""Centralized logger setup.

Per design doc §8.1 / Table 19:
  - format : %(asctime)s [%(levelname)s] %(name)s: %(message)s
  - console: INFO or above
  - file   : DEBUG or above, daily rotation, 7-day retention
  - file naming: paperpilot_YYYYMMDD.log (rotation suffix: %Y%m%d)
"""

from __future__ import annotations

import logging
import sys
from logging.handlers import TimedRotatingFileHandler
from pathlib import Path

_FMT = "%(asctime)s [%(levelname)s] %(name)s: %(message)s"
_DATEFMT = "%Y-%m-%d %H:%M:%S"
_RETENTION_DAYS = 7


def setup_logging(level: str = "INFO", log_file: str | None = None) -> None:
    """Configure the root logger. Idempotent — safe to call multiple times."""
    root = logging.getLogger()
    root.setLevel(logging.DEBUG)  # file handler needs DEBUG to surface everything
    for h in list(root.handlers):
        root.removeHandler(h)

    formatter = logging.Formatter(_FMT, datefmt=_DATEFMT)

    console_level = getattr(logging, level.upper(), logging.INFO)
    console = logging.StreamHandler(sys.stdout)
    console.setLevel(console_level)
    console.setFormatter(formatter)
    root.addHandler(console)

    if log_file:
        path = Path(log_file)
        path.parent.mkdir(parents=True, exist_ok=True)
        fh = TimedRotatingFileHandler(
            path,
            when="midnight",
            interval=1,
            backupCount=_RETENTION_DAYS,
            encoding="utf-8",
            utc=False,
        )
        fh.suffix = "%Y%m%d"
        fh.setLevel(logging.DEBUG)
        fh.setFormatter(formatter)
        root.addHandler(fh)


def get_logger(name: str) -> logging.Logger:
    return logging.getLogger(name)
