#!/usr/bin/env bash
# Promote a validated generated-data candidate from a fresh develop tip.

set -euo pipefail

die() {
  echo "::error::$*" >&2
  exit 1
}

emit_outputs() {
  local source_sha="$1"
  local changed="$2"
  printf 'source_sha=%s\nchanged=%s\n' "$source_sha" "$changed"
  if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
    printf 'source_sha=%s\nchanged=%s\n' "$source_sha" "$changed" >> "$GITHUB_OUTPUT"
  fi
}

[[ "$#" -ge 4 ]] || die \
  "usage: $0 <themes|conference> <candidate-dir> <commit-message> <allowed-path>..."

promotion_kind="$1"
candidate_dir="$2"
commit_message="$3"
shift 3
allowed_paths=("$@")
promotion_as_of="${PROMOTE_AS_OF:-$(date -u +%Y-%m-%dT%H:%M:%SZ)}"
promotion_base_sha="${PROMOTE_BASE_SHA:-}"
[[ "$promotion_as_of" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]] || die \
  "PROMOTE_AS_OF must be a UTC timestamp such as 2026-08-30T00:00:00Z"
shared_paths=()

[[ -d "$candidate_dir" ]] || die "candidate directory does not exist: $candidate_dir"
candidate_dir="$(cd "$candidate_dir" && pwd -P)"

case "$promotion_kind" in
  themes)
    [[ "$promotion_base_sha" =~ ^[0-9a-f]{40}$ ]] || die \
      "PROMOTE_BASE_SHA must identify the 40-character generation base"
    shared_paths=(
      docs/themes/themes-manifest.json
      docs/themes/_quality.json
      docs/lineage-quality-v1.json
      docs/assets/versions.json
    )
    ;;
  conference)
    [[ "$promotion_base_sha" =~ ^[0-9a-f]{40}$ ]] || die \
      "PROMOTE_BASE_SHA must identify the 40-character generation base"
    shared_paths=(
      docs/conferences.json
      docs/identity-aliases-v1.json
      docs/lineage-quality-v1.json
      docs/paper-details-v1
      docs/search-index.json
      docs/search-index-v2.json
      docs/search-paper-ids-v1
      docs/assets/versions.json
      paperpilot/data/identity-coverage-v1.json
    )
    ;;
  test-only)
    [[ "${PAPERPILOT_PROMOTION_TEST_MODE:-}" == "1" ]] || die "test-only mode is disabled"
    origin_url="$(git remote get-url origin)"
    [[ "$origin_url" == /* || "$origin_url" == file://* ]] || die \
      "test-only mode requires a local filesystem remote"
    ;;
  *)
    die "unknown promotion kind: $promotion_kind"
    ;;
esac

python3 - "$candidate_dir" "${allowed_paths[@]}" <<'PY'
import os
import sys
from pathlib import Path, PurePosixPath

root = Path(sys.argv[1])
allowed_raw = sys.argv[2:]
if not allowed_raw:
    raise SystemExit("candidate allowlist is empty")

allowed: list[PurePosixPath] = []
for raw in allowed_raw:
    item = PurePosixPath(raw)
    if item.is_absolute() or not item.parts or ".." in item.parts or ".git" in item.parts:
        raise SystemExit(f"invalid allowlist path: {raw!r}")
    allowed.append(item)

found_file = False
for directory, dirnames, filenames in os.walk(root, followlinks=False):
    directory_path = Path(directory)
    for name in [*dirnames, *filenames]:
        path = directory_path / name
        relative = PurePosixPath(path.relative_to(root).as_posix())
        if path.is_symlink():
            raise SystemExit(f"candidate symlink is forbidden: {relative}")
        if path.is_dir():
            permitted = any(
                relative == prefix
                or prefix in relative.parents
                or relative in prefix.parents
                for prefix in allowed
            )
        else:
            found_file = True
            permitted = any(relative == prefix or prefix in relative.parents for prefix in allowed)
        if not permitted:
            raise SystemExit(f"candidate path is outside allowlist: {relative}")

if not found_file:
    raise SystemExit("candidate contains no files")
PY

max_attempts="${PROMOTE_MAX_ATTEMPTS:-3}"
[[ "$max_attempts" =~ ^[1-9][0-9]*$ ]] || die "PROMOTE_MAX_ATTEMPTS must be positive"

attempt_dir=""
cleanup_attempt() {
  if [[ -n "$attempt_dir" && -d "$attempt_dir" ]]; then
    rm -r "$attempt_dir"
  fi
  git worktree prune >/dev/null 2>&1 || true
  attempt_dir=""
}
on_exit() {
  local status="$?"
  trap - EXIT
  cleanup_attempt
  exit "$status"
}
trap on_exit EXIT

refresh_shared_outputs() {
  local tree="$1"
  case "$promotion_kind" in
    themes)
      (
        cd "$tree"
        uv run --frozen python -m paperpilot.scripts.generate_themes_manifest \
          --themes-dir docs/themes
        uv run --frozen python -m paperpilot.scripts.compute_theme_quality
        if [[ -f paperpilot/scripts/build_lineage_quality.py ]]; then
          uv run --frozen python -m paperpilot.scripts.build_lineage_quality \
            --as-of "$promotion_as_of"
        fi
        uv run --frozen python paperpilot/scripts/sync_asset_versions.py
      )
      ;;
    conference)
      (
        cd "$tree"
        uv run --frozen python paperpilot/scripts/build_pages.py
        if [[ -f paperpilot/scripts/build_identity_lite.py ]]; then
          uv run --frozen python -m paperpilot.scripts.build_identity_lite \
            --as-of "$promotion_as_of"
        fi
        uv run --frozen python -m paperpilot.scripts.build_search_index
        if [[ -f paperpilot/scripts/build_lineage_quality.py ]]; then
          uv run --frozen python -m paperpilot.scripts.build_lineage_quality \
            --as-of "$promotion_as_of"
        fi
        uv run --frozen python paperpilot/scripts/sync_asset_versions.py
      )
      ;;
    test-only)
      ;;
  esac
}

validate_promoted_tree() {
  local tree="$1"
  [[ "$promotion_kind" == "test-only" ]] && return
  (
    cd "$tree"
    uv run --frozen --extra dev ruff check paperpilot/
    uv run --frozen --extra dev --extra unarxive pytest paperpilot/tests -q
    uv run --frozen python -m paperpilot.scripts.audit_theme_seeds
    uv run --frozen python -m paperpilot.scripts.audit_lineage_quality
  )
}

for ((attempt = 1; attempt <= max_attempts; attempt += 1)); do
  cleanup_attempt
  echo "promotion attempt $attempt/$max_attempts: fetch latest develop"
  git fetch --no-tags origin develop
  remote_sha="$(git rev-parse refs/remotes/origin/develop)"

  if [[ -n "$promotion_base_sha" ]]; then
    git cat-file -e "$promotion_base_sha^{commit}" 2>/dev/null || die \
      "generation base is not available: $promotion_base_sha"
    git merge-base --is-ancestor "$promotion_base_sha" "$remote_sha" || die \
      "generation base is not an ancestor of the current develop tip"
    git diff --quiet "$promotion_base_sha" "$remote_sha" -- "${allowed_paths[@]}" || die \
      "candidate paths changed on develop after generation; regenerate instead of overwriting"
  fi

  attempt_dir="$(mktemp -d "${TMPDIR:-/tmp}/paperpilot-promote.XXXXXX")"
  tree="$attempt_dir/tree"
  git worktree add --detach "$tree" "$remote_sha" >/dev/null
  cp -a "$candidate_dir/." "$tree/"

  refresh_shared_outputs "$tree"
  validate_promoted_tree "$tree"

  git -C "$tree" config user.email "actions@users.noreply.github.com"
  git -C "$tree" config user.name "github-actions[bot]"
  git -C "$tree" add -A -- "${allowed_paths[@]}"
  if [[ "${#shared_paths[@]}" -gt 0 ]]; then
    git -C "$tree" add -A -- "${shared_paths[@]}"
  fi
  git -C "$tree" diff --quiet || die \
    "refresh produced tracked changes outside the promotion allowlist"
  if [[ -n "$(git -C "$tree" ls-files --others --exclude-standard)" ]]; then
    die "refresh produced untracked files outside the promotion allowlist"
  fi

  if git -C "$tree" diff --cached --quiet; then
    echo "candidate produced no change at $remote_sha"
    emit_outputs "$remote_sha" false
    exit 0
  fi

  git -C "$tree" commit -m "$commit_message" >/dev/null
  promoted_sha="$(git -C "$tree" rev-parse HEAD)"
  if git -C "$tree" push origin HEAD:develop; then
    echo "promotion succeeded on attempt $attempt: $promoted_sha"
    emit_outputs "$promoted_sha" true
    exit 0
  fi

  echo "promotion lost compare-and-swap race; rebuilding from the new tip" >&2
  if [[ "$attempt" -lt "$max_attempts" && "${PROMOTE_NO_SLEEP:-}" != "1" ]]; then
    sleep $((attempt * 2))
  fi
done

die "promotion failed after $max_attempts compare-and-swap attempts"
