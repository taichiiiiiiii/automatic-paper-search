"""Code-owned local execution profile for the one-paper Sol canary.

This module is intentionally not imported by production provider registries or
workers. The only credential sources are the two documented environment names,
and every other profile field is matched against this module's exact constants.
"""

from __future__ import annotations

import os
import stat
from collections.abc import Mapping
from contextlib import suppress
from datetime import datetime, timezone
from pathlib import Path

from paperpilot.paper_slides.contract import PAPER_SLIDE_PROVIDER_FAILED
from paperpilot.paper_slides.generator_budget import GenerationBudget, PricingSnapshot
from paperpilot.paper_slides.provider_execution import (
    CONFIG_VERSION,
    ApprovedProviderRegistration,
    PreparedProviderExecution,
    ProviderExecutionError,
    ProviderRegistry,
    prepare_provider_execution,
    pricing_snapshot_sha256,
)
from paperpilot.paper_slides.service import PaperSlideSourceConstraint
from paperpilot.paper_slides.sol_provider import (
    SOL_IDENTITY,
    SolHttpTransport,
    SolProvider,
    StdlibSolTransport,
)
from paperpilot.replay import strict_json_loads

SOL_LOCAL_PROFILE_VERSION = "paper-slide-sol-local-profile-v1"
SOL_LOCAL_PROFILE_NAME = "sol-abstract-local-v1"
SOL_LOCAL_PROFILE_PATH = (
    Path(__file__).resolve().parents[1] / "data" / (f"{SOL_LOCAL_PROFILE_NAME}.json")
)
SOL_PILOT_PAPER_ID = "2e768ddeb31010d467bebdd967799aae21a2380b"
SOL_PILOT_SOURCE = "cvf"
SOL_PILOT_SOURCE_ID = "Zhu_Transformers_without_Normalization_CVPR_2025_paper"
SOL_PILOT_TITLE = "Transformers without Normalization"
SOL_PILOT_AUTHORS = (
    "Jiachen Zhu",
    "Xinlei Chen",
    "Kaiming He",
    "Yann LeCun",
    "Zhuang Liu",
)
SOL_PILOT_LANDING_URL = (
    f"https://openaccess.thecvf.com/content/CVPR2025/html/{SOL_PILOT_SOURCE_ID}.html"
)
SOL_PILOT_PDF_URL = (
    f"https://openaccess.thecvf.com/content/CVPR2025/papers/{SOL_PILOT_SOURCE_ID}.pdf"
)
SOL_PILOT_DETAIL_SHARD_SHA256 = "c80bd9aee33607bebdc729a845ff3a749e262c38ebd9dac891275aaed292b436"
SOL_PILOT_ABSTRACT_SHA256 = "921d7287261112eeb5501df680f8c74f3f81c50c42329d747271ce96be2880fd"
SOL_PRICING_SHA256 = "53ab9c013ca89e07d26b89c739b9e4b7fb29a144e9dc46d6bcca38526e115902"
MAX_PROFILE_BYTES = 16 * 1024

SOL_LOCAL_BUDGET = GenerationBudget(
    max_calls=2,
    max_input_tokens=120_000,
    max_output_tokens=6_000,
    max_output_tokens_per_call=4_000,
    max_wall_seconds=180,
    max_cost_micro_units=1_000_000,
)
SOL_LOCAL_PRICING = PricingSnapshot(
    provider=SOL_IDENTITY.provider,
    model=SOL_IDENTITY.model,
    currency="USD",
    input_per_million_micro_units=4_000_000,
    output_per_million_micro_units=20_000_000,
    request_cost_ceiling_micro_units=1_000_000,
    effective_at=datetime(2026, 9, 5, tzinfo=timezone.utc),
    expires_at=datetime(2026, 9, 12, tzinfo=timezone.utc),
    version="openai-gpt-5.6-sol-2026-09-05",
)
if pricing_snapshot_sha256(SOL_LOCAL_PRICING) != SOL_PRICING_SHA256:
    raise RuntimeError("Sol pricing snapshot hash does not match the code-owned profile")

SOL_LOCAL_REGISTRY = ProviderRegistry(
    (
        ApprovedProviderRegistration(
            identity=SOL_IDENTITY,
            adapter_type=SolProvider,
            pricing=SOL_LOCAL_PRICING,
            pricing_snapshot_sha256=SOL_PRICING_SHA256,
            maximum_budget=SOL_LOCAL_BUDGET,
        ),
    )
)
SOL_LOCAL_SOURCE_CONSTRAINT = PaperSlideSourceConstraint(
    paper_id=SOL_PILOT_PAPER_ID,
    language="ja",
    source=SOL_PILOT_SOURCE,
    source_id=SOL_PILOT_SOURCE_ID,
    detail_shard_sha256=SOL_PILOT_DETAIL_SHARD_SHA256,
    abstract_sha256=SOL_PILOT_ABSTRACT_SHA256,
    title=SOL_PILOT_TITLE,
    authors=SOL_PILOT_AUTHORS,
    landing_url=SOL_PILOT_LANDING_URL,
    pdf_url=SOL_PILOT_PDF_URL,
)


def sol_local_profile() -> dict[str, object]:
    """Return a fresh exact profile mapping suitable for validation or fixtures."""

    return {
        "schema_version": SOL_LOCAL_PROFILE_VERSION,
        "profile": SOL_LOCAL_PROFILE_NAME,
        "paper_id": SOL_PILOT_PAPER_ID,
        "language": "ja",
        "coverage": "abstract_only",
        "source": SOL_PILOT_SOURCE,
        "source_id": SOL_PILOT_SOURCE_ID,
        "detail_shard_sha256": SOL_PILOT_DETAIL_SHARD_SHA256,
        "abstract_sha256": SOL_PILOT_ABSTRACT_SHA256,
        "execution": {
            "schema_version": CONFIG_VERSION,
            "provider": SOL_IDENTITY.provider,
            "model": SOL_IDENTITY.model,
            "adapter_version": SOL_IDENTITY.adapter_version,
            "pricing_snapshot_sha256": SOL_PRICING_SHA256,
            "budget": {
                "max_calls": SOL_LOCAL_BUDGET.max_calls,
                "max_input_tokens": SOL_LOCAL_BUDGET.max_input_tokens,
                "max_output_tokens": SOL_LOCAL_BUDGET.max_output_tokens,
                "max_output_tokens_per_call": SOL_LOCAL_BUDGET.max_output_tokens_per_call,
                "max_wall_seconds": SOL_LOCAL_BUDGET.max_wall_seconds,
                "max_cost_micro_units": SOL_LOCAL_BUDGET.max_cost_micro_units,
            },
        },
    }


def _load_profile(path: Path) -> dict[str, object]:
    descriptor: int | None = None
    try:
        if not isinstance(path, Path) or path.is_symlink():
            raise ValueError
        flags = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0)
        descriptor = os.open(path, flags)
        before = os.fstat(descriptor)
        if not stat.S_ISREG(before.st_mode) or not 0 < before.st_size <= MAX_PROFILE_BYTES:
            raise ValueError
        with os.fdopen(descriptor, "rb", closefd=True) as handle:
            descriptor = None
            payload = handle.read(MAX_PROFILE_BYTES + 1)
            after = os.fstat(handle.fileno())
        if (
            len(payload) > MAX_PROFILE_BYTES
            or len(payload) != before.st_size
            or before.st_dev != after.st_dev
            or before.st_ino != after.st_ino
            or before.st_mtime_ns != after.st_mtime_ns
            or before.st_ctime_ns != after.st_ctime_ns
        ):
            raise ValueError
        value = strict_json_loads(payload)
        if type(value) is not dict or value != sol_local_profile():
            raise ValueError
        return value
    except (KeyboardInterrupt, SystemExit):
        raise
    except BaseException:
        raise ProviderExecutionError(
            PAPER_SLIDE_PROVIDER_FAILED, "provider_profile_invalid"
        ) from None
    finally:
        if descriptor is not None:
            with suppress(OSError):
                os.close(descriptor)


def _api_key(environ: Mapping[str, str]) -> str:
    try:
        primary = environ.get("PAPERPILOT_OPENAI_API_KEY")
        fallback = environ.get("OPENAI_API_KEY")
    except BaseException:
        raise ProviderExecutionError(
            PAPER_SLIDE_PROVIDER_FAILED, "provider_credentials_invalid"
        ) from None
    present = [value for value in (primary, fallback) if value is not None]
    if not present:
        raise ProviderExecutionError(PAPER_SLIDE_PROVIDER_FAILED, "provider_credentials_missing")
    if (
        any(
            type(value) is not str
            or not 1 <= len(value) <= 512
            or not value.isascii()
            or any(ord(character) < 0x21 or ord(character) > 0x7E for character in value)
            for value in present
        )
        or len(set(present)) != 1
    ):
        raise ProviderExecutionError(PAPER_SLIDE_PROVIDER_FAILED, "provider_credentials_invalid")
    return present[0]


def load_sol_local_execution(
    profile_path: Path,
    at: datetime,
    *,
    environ: Mapping[str, str] = os.environ,
    transport: SolHttpTransport | None = None,
) -> PreparedProviderExecution:
    """Load the exact local profile and prepare one non-production Sol execution."""

    profile = _load_profile(profile_path)
    provider = SolProvider(
        api_key=_api_key(environ),
        transport=transport if transport is not None else StdlibSolTransport(),
    )
    return prepare_provider_execution(
        profile["execution"],
        registry=SOL_LOCAL_REGISTRY,
        provider=provider,
        at=at,
    )


__all__ = [
    "SOL_LOCAL_BUDGET",
    "SOL_LOCAL_PRICING",
    "SOL_LOCAL_PROFILE_NAME",
    "SOL_LOCAL_PROFILE_PATH",
    "SOL_LOCAL_PROFILE_VERSION",
    "SOL_LOCAL_REGISTRY",
    "SOL_LOCAL_SOURCE_CONSTRAINT",
    "SOL_PILOT_ABSTRACT_SHA256",
    "SOL_PILOT_AUTHORS",
    "SOL_PILOT_DETAIL_SHARD_SHA256",
    "SOL_PILOT_LANDING_URL",
    "SOL_PILOT_PAPER_ID",
    "SOL_PILOT_PDF_URL",
    "SOL_PILOT_SOURCE",
    "SOL_PILOT_SOURCE_ID",
    "SOL_PILOT_TITLE",
    "SOL_PRICING_SHA256",
    "load_sol_local_execution",
    "sol_local_profile",
]
