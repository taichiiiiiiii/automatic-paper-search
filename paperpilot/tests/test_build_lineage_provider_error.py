"""Tests for build_provider() RuntimeError contract and main() exit-3 handling.

These tests pin Phase 0a (closes #110): `build_provider()` must raise
RuntimeError instead of calling `sys.exit()`, so it can be safely imported
from a Modal Function without taking down the worker process. The
`__main__` guard catches the RuntimeError and converts to exit code 3 to
preserve the existing CLI contract.

Why this matters: theme-pipeline-v2 (Modal hybrid) imports build_provider
from the modal/lineage_handler module. `sys.exit` would bring down the
Modal ASGI worker; RuntimeError lets the handler convert it into a 500
+ callback("failed", reason=...) flow without process death.
"""
from __future__ import annotations

import pytest

from paperpilot.scripts import build_lineage


def _patch_no_keys(monkeypatch):
    """Clear every code path that could supply an LLM API key."""
    monkeypatch.setattr(
        "paperpilot.utils.config_loader.load_env",
        lambda *a, **kw: {
            "github_token": None,
            "s2_api_key": None,
            "gemini_api_key": None,
            "claude_api_key": None,
            "groq_api_key": None,
            "groq_model": None,
            "gemini_model": None,
            "smtp": {},
        },
    )
    for v in ("GROQ_API_KEY", "GEMINI_API_KEY"):
        monkeypatch.delenv(v, raising=False)


def test_build_provider_raises_runtime_error_without_any_key(monkeypatch):
    """build_provider() must raise RuntimeError (not SystemExit) when no key is set."""
    _patch_no_keys(monkeypatch)
    with pytest.raises(RuntimeError):
        build_lineage.build_provider()


def test_runtime_error_message_names_both_env_vars(monkeypatch):
    """Operators need to know exactly which env vars to set."""
    _patch_no_keys(monkeypatch)
    with pytest.raises(RuntimeError) as excinfo:
        build_lineage.build_provider()
    msg = str(excinfo.value)
    assert "PAPERPILOT_GROQ_API_KEY" in msg
    assert "PAPERPILOT_GEMINI_API_KEY" in msg


def test_build_provider_does_not_call_sys_exit(monkeypatch):
    """Defensive: explicitly assert sys.exit is never invoked from the provider path.

    If a future refactor accidentally re-introduces sys.exit, this test
    catches it before the Modal import path breaks again.
    """
    _patch_no_keys(monkeypatch)
    called = {"sys_exit": False}

    def _spy_exit(*args, **kwargs):
        called["sys_exit"] = True
        raise AssertionError("sys.exit was called from build_provider")

    monkeypatch.setattr("paperpilot.scripts.build_lineage.sys.exit", _spy_exit)
    with pytest.raises(RuntimeError):
        build_lineage.build_provider()
    assert called["sys_exit"] is False


def test_main_catches_runtime_error_and_exits_3(monkeypatch, capsys):
    """main() must wrap RuntimeError from build_provider into exit code 3."""
    monkeypatch.setattr("sys.argv", ["build_lineage.py"])

    def _raise(*args, **kwargs):
        raise RuntimeError(
            "No LLM key found. Set PAPERPILOT_GROQ_API_KEY (preferred) "
            "or PAPERPILOT_GEMINI_API_KEY."
        )

    monkeypatch.setattr(build_lineage, "build_provider", _raise)

    with pytest.raises(SystemExit) as excinfo:
        build_lineage.main()
    assert excinfo.value.code == 3
    captured = capsys.readouterr()
    assert "PAPERPILOT_GROQ_API_KEY" in captured.err
