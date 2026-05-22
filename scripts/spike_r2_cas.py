"""R2 If-None-Match: * spike — Phase 0b no-go gate for theme-pipeline v2.

Why this exists
---------------
The v2 design (see /root/.claude/plans/theme-pipeline-v2.md) assumes
Cloudflare R2 honors S3-style optimistic concurrency on object create:

    PUT /<key>  If-None-Match: *

Expected behavior under N concurrent writers racing for the same key:
- exactly 1 PUT succeeds (200)
- the remaining N-1 PUTs return 412 PreconditionFailed

If R2 does NOT honor this header (or the semantics differ), we need to
fall back to `Modal concurrency_limit=1 + read-modify-write` for the
manifest update path, which serialises throughput. Better to know before
we wire half of Phase A and rip it out.

This is a one-shot spike, not a regression test — it talks to a real
bucket so the user must supply credentials and a disposable bucket name.

Usage
-----
    export R2_ACCOUNT_ID=...
    export R2_ACCESS_KEY_ID=...
    export R2_SECRET_ACCESS_KEY=...
    uv run --with boto3 python scripts/spike_r2_cas.py \
        --bucket paperpilot-themes-spike --concurrency 8

Pass / Fail rules
-----------------
- PASS: exactly 1 success + (concurrency - 1) 412 PreconditionFailed.
  Phase A may proceed with the CAS design.
- FAIL: any other outcome (multiple successes, or a non-412 error
  storm). Investigate before Phase A. The fallback path is Modal
  concurrency_limit=1 + RMW for manifest upsert, documented in
  infra/r2/cas-spike.md.

The script cleans the spike object on exit so the bucket stays empty
between runs.
"""
from __future__ import annotations

import argparse
import os
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass

try:
    import boto3  # type: ignore[import-not-found]
    from botocore.client import Config  # type: ignore[import-not-found]
    from botocore.exceptions import ClientError  # type: ignore[import-not-found]
except ImportError:
    sys.stderr.write(
        "boto3 not installed. Run with:\n"
        "  uv run --with boto3 python scripts/spike_r2_cas.py ...\n"
    )
    sys.exit(2)


@dataclass(frozen=True)
class Attempt:
    """Outcome of a single concurrent PUT attempt."""

    worker_id: int
    success: bool
    status_code: int | None
    error_code: str | None  # boto3 'Code' field, e.g. PreconditionFailed
    elapsed_ms: float
    raw_error: str | None


def _put_with_cas(client, bucket: str, key: str, worker_id: int) -> Attempt:
    """Single attempt: PUT <key> with If-None-Match: * and capture outcome."""
    payload = f"spike-worker-{worker_id}-{time.time_ns()}".encode()
    started = time.perf_counter()
    try:
        # boto3 doesn't expose If-None-Match on put_object directly, so we
        # use the lower-level event hook to attach the header. Cloudflare
        # R2 accepts the standard S3 conditional header form.
        resp = client.put_object(
            Bucket=bucket,
            Key=key,
            Body=payload,
            IfNoneMatch="*",
        )
        elapsed = (time.perf_counter() - started) * 1000
        return Attempt(
            worker_id=worker_id,
            success=True,
            status_code=resp.get("ResponseMetadata", {}).get("HTTPStatusCode"),
            error_code=None,
            elapsed_ms=elapsed,
            raw_error=None,
        )
    except ClientError as exc:
        elapsed = (time.perf_counter() - started) * 1000
        err = exc.response.get("Error", {}) if hasattr(exc, "response") else {}
        meta = exc.response.get("ResponseMetadata", {}) if hasattr(exc, "response") else {}
        return Attempt(
            worker_id=worker_id,
            success=False,
            status_code=meta.get("HTTPStatusCode"),
            error_code=err.get("Code"),
            elapsed_ms=elapsed,
            raw_error=str(exc),
        )


def _build_client(account_id: str, access_key_id: str, secret_access_key: str):
    endpoint = f"https://{account_id}.r2.cloudflarestorage.com"
    # 'auto' is R2's documented region; signing v4 still requires *some*
    # value here. Path-style addressing avoids the wildcard subdomain
    # cert and is what R2 documents for SDK usage.
    return boto3.client(
        "s3",
        endpoint_url=endpoint,
        aws_access_key_id=access_key_id,
        aws_secret_access_key=secret_access_key,
        region_name="auto",
        config=Config(s3={"addressing_style": "path"}, signature_version="s3v4"),
    )


def _cleanup(client, bucket: str, key: str) -> None:
    try:
        client.delete_object(Bucket=bucket, Key=key)
    except ClientError as exc:
        sys.stderr.write(f"[warn] cleanup failed for {key}: {exc}\n")


def _verdict(attempts: list[Attempt], concurrency: int) -> tuple[bool, str]:
    successes = [a for a in attempts if a.success]
    failures_412 = [a for a in attempts if a.error_code == "PreconditionFailed"]
    other = [a for a in attempts if not a.success and a.error_code != "PreconditionFailed"]

    if other:
        codes = sorted({a.error_code or f"http{a.status_code}" for a in other})
        return False, f"unexpected non-412 errors: {codes}"
    if len(successes) == 1 and len(failures_412) == concurrency - 1:
        return True, "PASS — exactly 1 success + (N-1) 412 PreconditionFailed"
    if len(successes) > 1:
        return False, (
            f"FAIL — {len(successes)} successes (expected 1). "
            "R2 likely does NOT honor If-None-Match: * for create. "
            "Fallback to Modal concurrency_limit=1 + RMW."
        )
    if len(successes) == 0:
        return False, f"FAIL — 0 successes ({len(failures_412)} 412s, {len(other)} other)"
    return False, (
        f"FAIL — {len(successes)} successes / {len(failures_412)} 412s "
        f"(expected 1 / {concurrency - 1})"
    )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("Usage")[0])
    parser.add_argument("--bucket", required=True, help="R2 bucket name (must exist, will be written to)")
    parser.add_argument(
        "--concurrency", type=int, default=8,
        help="Number of concurrent PUT attempts (default 8)",
    )
    parser.add_argument(
        "--key", default=None,
        help="Object key to race for. Default: spike-cas-test-<ts>",
    )
    args = parser.parse_args()

    if args.concurrency < 2:
        sys.stderr.write("--concurrency must be >= 2 (the whole point is the race)\n")
        return 2

    account_id = os.environ.get("R2_ACCOUNT_ID")
    access_key_id = os.environ.get("R2_ACCESS_KEY_ID")
    secret_access_key = os.environ.get("R2_SECRET_ACCESS_KEY")
    missing = [n for n, v in (
        ("R2_ACCOUNT_ID", account_id),
        ("R2_ACCESS_KEY_ID", access_key_id),
        ("R2_SECRET_ACCESS_KEY", secret_access_key),
    ) if not v]
    if missing:
        sys.stderr.write(f"missing env vars: {', '.join(missing)}\n")
        return 2

    key = args.key or f"spike-cas-test-{time.time_ns()}"
    client = _build_client(account_id, access_key_id, secret_access_key)

    print(f"R2 CAS spike: bucket={args.bucket} key={key} concurrency={args.concurrency}")

    with ThreadPoolExecutor(max_workers=args.concurrency) as pool:
        futures = [
            pool.submit(_put_with_cas, client, args.bucket, key, i)
            for i in range(args.concurrency)
        ]
        attempts = [f.result() for f in as_completed(futures)]

    attempts.sort(key=lambda a: a.worker_id)
    for a in attempts:
        if a.success:
            print(f"  worker {a.worker_id}: SUCCESS (HTTP {a.status_code}, {a.elapsed_ms:.0f}ms)")
        else:
            print(
                f"  worker {a.worker_id}: FAILED  (HTTP {a.status_code}, "
                f"code={a.error_code}, {a.elapsed_ms:.0f}ms)"
            )

    _cleanup(client, args.bucket, key)

    passed, verdict = _verdict(attempts, args.concurrency)
    print()
    print(verdict)
    return 0 if passed else 1


if __name__ == "__main__":
    sys.exit(main())
