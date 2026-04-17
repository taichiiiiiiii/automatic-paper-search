"""config_loader — YAML + .env merge tests."""

from __future__ import annotations

from pathlib import Path

import pytest

from paperpilot.utils.config_loader import load_config


def _write_config(tmp_path: Path, content: str) -> Path:
    path = tmp_path / "config.yaml"
    path.write_text(content, encoding="utf-8")
    return path


def test_load_config_reads_yaml(tmp_path, monkeypatch):
    monkeypatch.delenv("PAPERPILOT_GITHUB_TOKEN", raising=False)
    monkeypatch.delenv("PAPERPILOT_S2_API_KEY", raising=False)
    monkeypatch.delenv("PAPERPILOT_SLACK_WEBHOOK_URL", raising=False)
    cfg = _write_config(
        tmp_path,
        "search:\n  keywords: [llm, rag]\n  days_back: 5\n",
    )
    loaded = load_config(cfg)
    assert loaded["search"]["keywords"] == ["llm", "rag"]
    assert loaded["search"]["days_back"] == 5


def test_env_values_merged_into_config(tmp_path, monkeypatch):
    monkeypatch.setenv("PAPERPILOT_GITHUB_TOKEN", "ghp_token123")
    monkeypatch.setenv("PAPERPILOT_S2_API_KEY", "s2key")
    monkeypatch.setenv("PAPERPILOT_SLACK_WEBHOOK_URL", "http://hook")
    cfg = _write_config(tmp_path, "search: {}")
    loaded = load_config(cfg)
    assert loaded["env"]["github_token"] == "ghp_token123"
    assert loaded["env"]["s2_api_key"] == "s2key"
    assert loaded["env"]["slack_webhook_url"] == "http://hook"


def test_env_none_when_not_set(tmp_path, monkeypatch):
    monkeypatch.delenv("PAPERPILOT_GITHUB_TOKEN", raising=False)
    monkeypatch.delenv("PAPERPILOT_S2_API_KEY", raising=False)
    monkeypatch.delenv("PAPERPILOT_SLACK_WEBHOOK_URL", raising=False)
    cfg = _write_config(tmp_path, "search: {}")
    loaded = load_config(cfg)
    assert loaded["env"]["github_token"] is None
    assert loaded["env"]["s2_api_key"] is None
    assert loaded["env"]["slack_webhook_url"] is None


def test_dotenv_file_next_to_config_is_loaded(tmp_path, monkeypatch):
    # Ensure process env doesn't pre-leak the value.
    monkeypatch.delenv("PAPERPILOT_GITHUB_TOKEN", raising=False)
    cfg = _write_config(tmp_path, "search: {}")
    (tmp_path / ".env").write_text("PAPERPILOT_GITHUB_TOKEN=dotenv_value\n", encoding="utf-8")
    loaded = load_config(cfg)
    assert loaded["env"]["github_token"] == "dotenv_value"


def test_missing_config_raises(tmp_path):
    with pytest.raises(FileNotFoundError):
        load_config(tmp_path / "nonexistent.yaml")


def test_empty_yaml_treated_as_empty_dict(tmp_path, monkeypatch):
    monkeypatch.delenv("PAPERPILOT_GITHUB_TOKEN", raising=False)
    cfg = _write_config(tmp_path, "")
    loaded = load_config(cfg)
    # env always injected, but no 'search'
    assert loaded.get("env") is not None
    assert "search" not in loaded
