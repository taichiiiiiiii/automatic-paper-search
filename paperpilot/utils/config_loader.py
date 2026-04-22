"""Load YAML config + .env into a single dict.

Secrets (API keys, webhook URLs) live ONLY in environment variables —
config.yaml never carries them. This separation makes config.yaml safe
to commit while keeping secrets local / in CI Secrets.
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any

import yaml
from dotenv import load_dotenv


def load_env(dotenv_path: str | Path | None = None) -> dict[str, Any]:
    """Load .env (if present) and return a secrets dict.

    Keeps the env-variable → dict mapping in one place so callers
    (`load_config` for the main pipeline, `build_provider` for the
    lineage scripts) share one source of truth. Pipeline and scripts
    used to read `os.getenv` independently, so a renamed key only
    failed at one of the two call sites.

    ``dotenv_path`` overrides the default ``.env`` search (config dir
    then cwd). Pass it when loading from a non-default location — e.g.
    the lineage scripts point at ``paperpilot/.env``.
    """
    if dotenv_path is not None:
        dotenv_path = Path(dotenv_path)
        if dotenv_path.exists():
            load_dotenv(dotenv_path)
    else:
        load_dotenv()  # dotenv's own cwd-upward search

    port_raw = os.getenv("PAPERPILOT_SMTP_PORT")
    try:
        smtp_port = int(port_raw) if port_raw else 587
    except ValueError:
        smtp_port = 587

    return {
        "github_token": os.getenv("PAPERPILOT_GITHUB_TOKEN"),
        "s2_api_key": os.getenv("PAPERPILOT_S2_API_KEY"),
        "openalex_email": os.getenv("PAPERPILOT_OPENALEX_EMAIL"),
        "slack_webhook_url": os.getenv("PAPERPILOT_SLACK_WEBHOOK_URL"),
        "gemini_api_key": os.getenv("PAPERPILOT_GEMINI_API_KEY"),
        "claude_api_key": os.getenv("PAPERPILOT_CLAUDE_API_KEY"),
        "groq_api_key": os.getenv("PAPERPILOT_GROQ_API_KEY"),
        # Model overrides. These are consumed by the lineage scripts;
        # the main pipeline reads them through config.yaml instead.
        "groq_model": os.getenv("PAPERPILOT_GROQ_MODEL"),
        "gemini_model": os.getenv("PAPERPILOT_GEMINI_MODEL"),
        "smtp": {
            "server": os.getenv("PAPERPILOT_SMTP_SERVER"),
            "port": smtp_port,
            "user": os.getenv("PAPERPILOT_SMTP_USER"),
            "password": os.getenv("PAPERPILOT_SMTP_PASSWORD"),
            "to": os.getenv("PAPERPILOT_EMAIL_TO"),
            "use_tls": (os.getenv("PAPERPILOT_SMTP_USE_TLS", "true").lower() != "false"),
        },
    }


def load_config(config_path: str | Path = "config.yaml") -> dict[str, Any]:
    """Load YAML config, then merge environment variables under config['env']."""
    config_path = Path(config_path)
    if not config_path.exists():
        raise FileNotFoundError(f"Config file not found: {config_path}")

    with config_path.open("r", encoding="utf-8") as f:
        config = yaml.safe_load(f) or {}

    # Prefer a co-located .env; fall back to dotenv's cwd search.
    env_path = config_path.parent / ".env"
    config["env"] = load_env(env_path if env_path.exists() else None)
    return config
