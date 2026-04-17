"""logger setup tests."""

from __future__ import annotations

import logging
from logging.handlers import TimedRotatingFileHandler

from paperpilot.utils.logger import get_logger, setup_logging


def _cleanup_root():
    root = logging.getLogger()
    for h in list(root.handlers):
        root.removeHandler(h)


def test_setup_logging_console_only():
    _cleanup_root()
    setup_logging(level="INFO", log_file=None)
    root = logging.getLogger()
    # Exactly one handler (StreamHandler for console)
    assert len(root.handlers) == 1
    assert root.handlers[0].level == logging.INFO


def test_setup_logging_with_file(tmp_path):
    _cleanup_root()
    log_path = tmp_path / "subdir" / "paperpilot.log"
    setup_logging(level="DEBUG", log_file=str(log_path))
    root = logging.getLogger()
    # Console + file handler
    assert len(root.handlers) == 2
    file_handler = [h for h in root.handlers if isinstance(h, TimedRotatingFileHandler)]
    assert len(file_handler) == 1
    # Directory auto-created
    assert log_path.parent.exists()
    # Rotation config per spec
    fh = file_handler[0]
    assert fh.when == "MIDNIGHT"
    assert fh.backupCount == 7
    assert fh.suffix == "%Y%m%d"


def test_setup_logging_is_idempotent(tmp_path):
    _cleanup_root()
    log_path = tmp_path / "paperpilot.log"
    setup_logging(level="INFO", log_file=str(log_path))
    setup_logging(level="INFO", log_file=str(log_path))
    setup_logging(level="INFO", log_file=str(log_path))
    root = logging.getLogger()
    # Still only 2 handlers after repeat calls
    assert len(root.handlers) == 2


def test_setup_logging_unknown_level_defaults_to_info():
    _cleanup_root()
    setup_logging(level="BOGUS", log_file=None)
    root = logging.getLogger()
    console = root.handlers[0]
    assert console.level == logging.INFO


def test_get_logger_returns_named_logger():
    logger = get_logger("my.module")
    assert logger.name == "my.module"


def test_logger_writes_to_file(tmp_path):
    _cleanup_root()
    log_path = tmp_path / "pp.log"
    setup_logging(level="DEBUG", log_file=str(log_path))
    logger = get_logger("tester")
    logger.info("hello world")
    # Flush handlers so the line is visible.
    for h in logging.getLogger().handlers:
        h.flush()
    assert log_path.exists()
    assert "hello world" in log_path.read_text(encoding="utf-8")


def teardown_module(module):
    """Reset root handlers so other test modules start clean."""
    _cleanup_root()
