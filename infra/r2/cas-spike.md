# R2 `If-None-Match: *` CAS Spike (Phase 0b no-go gate)

## Purpose

The theme-pipeline v2 design (`/root/.claude/plans/theme-pipeline-v2.md`)
assumes Cloudflare R2 honors S3-style optimistic concurrency on object
create:

```
PUT /<key>
If-None-Match: *
```

Expected behavior under N concurrent writers racing for the **same**
key:

- exactly **1** PUT succeeds (HTTP 200)
- the remaining **N-1** PUTs return HTTP 412 `PreconditionFailed`

If R2 does NOT honor this header, the producer-side dedup (`jobs/active/<slug>.lock`)
and the manifest upsert retry loop (`upsert_manifest_entry`) both need a
different design. The fallback is:

- producer dedup → KV-based with TTL (slower, but available today)
- manifest upsert → Modal `concurrency_limit=1` + read-modify-write,
  which serialises throughput

Phase A **must not** start until this spike has produced a clear
PASS/FAIL.

## Prerequisites

1. A Cloudflare account with R2 enabled.
2. A **disposable** R2 bucket (e.g. `paperpilot-themes-spike`). Empty.
3. An R2 API token with object read/write on that bucket. Cloudflare
   dashboard → R2 → Manage R2 API Tokens → "Object Read & Write".
4. The 3 env vars exported in the shell that runs the spike:

   ```bash
   export R2_ACCOUNT_ID=...           # 32-char hex
   export R2_ACCESS_KEY_ID=...
   export R2_SECRET_ACCESS_KEY=...
   ```

Endpoint is derived: `https://<R2_ACCOUNT_ID>.r2.cloudflarestorage.com`.

`boto3` is pulled on-demand via `uv run --with boto3 ...`; nothing is
added to `pyproject.toml` because this script is a one-off.

## Execution

```bash
uv run --with boto3 python scripts/spike_r2_cas.py \
    --bucket paperpilot-themes-spike \
    --concurrency 8
```

Optional:

- `--concurrency N` (default 8) — number of racing PUTs. >= 2.
- `--key <name>` — race target key. Default `spike-cas-test-<ts>`.

The script cleans up the spike object on exit.

## Interpreting the result

The script prints one line per worker, then a verdict:

| Verdict line | Meaning | Phase A action |
|---|---|---|
| `PASS — exactly 1 success + (N-1) 412 PreconditionFailed` | R2 honors CAS as expected | proceed with v2 design as written |
| `FAIL — N successes (expected 1) ...` | R2 does NOT honor `If-None-Match: *` for create | switch producer dedup to KV TTL; switch manifest upsert to Modal `concurrency_limit=1` + RMW |
| `FAIL — unexpected non-412 errors: [...]` | Permission / signing / endpoint issue | fix the bucket / token / env vars and re-run |

Script exit codes:
- `0` PASS — gate clears
- `1` FAIL — Phase A blocked, plan v3 needed
- `2` Operator error (missing env, bad args, boto3 not present)

## Why this is a hard gate

Two CRITICAL design assumptions ride on CAS:

- **C3 producer race**: `acquireProducerLock(env, slug)` short-circuits
  duplicate POSTs by PUT-ing a lock object with `If-None-Match: *`. If
  R2 returns 200 for both racing writers, multi-tab dedup is broken.
- **C4 manifest CAS**: `upsert_manifest_entry` writes the new manifest
  with `If-Match: <etag>`. The retry loop assumes that concurrent
  writers see a precondition failure on the etag and re-read. If
  preconditions are silently ignored, two concurrent Modal jobs could
  clobber each other's manifest entries.

Both are observable by users if broken (lost theme entries, double
runs), so we eat the spike cost before wiring 1,500+ lines of code that
depends on it.

## Documenting the outcome

After running the spike:

1. Save the full console output to a paste / comment on issue tracking
   Phase 0b (file one if not present).
2. If PASS: update this doc with the test date and the bucket used.
3. If FAIL: open an issue `[blocker] R2 CAS does not behave per S3 spec`
   referencing the v2 plan, and write a brief plan v3 amendment
   describing the fallback path.
