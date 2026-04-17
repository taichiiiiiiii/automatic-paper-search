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


def load_config(config_path: str | Path = "config.yaml") -> dict[str, Any]:
    """Load YAML config, then merge environment variables under config['env']."""
    config_path = Path(config_path)
    if not config_path.exists():
        raise FileNotFoundError(f"Config file not found: {config_path}")

    with config_path.open("r", encoding="utf-8") as f:
        config = yaml.safe_load(f) or {}

    # Load .env from the config directory (or cwd if no .env exists there).
    env_path = config_path.parent / ".env"
    if env_path.exists():
        load_dotenv(env_path)
    else:
        load_dotenv()  # falls back to cwd / parent search

    config["env"] = {
        "github_token": os.getenv("PAPERPILOT_GITHUB_TOKEN"),
        "s2_api_key": os.getenv("PAPERPILOT_S2_API_KEY"),
        "openalex_email": os.getenv("PAPERPILOT_OPENALEX_EMAIL"),
        "slack_webhook_url": os.getenv("PAPERPILOT_SLACK_WEBHOOK_URL"),
        "gemini_api_key": os.getenv("PAPERPILOT_GEMINI_API_KEY"),
        "smtp": {
            "server": os.getenv("PAPERPILOT_SMTP_SERVER"),
            "port": os.getenv("PAPERPILOT_SMTP_PORT") or 587,
            "user": os.getenv("PAPERPILOT_SMTP_USER"),
            "password": os.getenv("PAPERPILOT_SMTP_PASSWORD"),
            "to": os.getenv("PAPERPILOT_EMAIL_TO"),
            "use_tls": (os.getenv("PAPERPILOT_SMTP_USE_TLS", "true").lower() != "false"),
        },
    }
    return config
