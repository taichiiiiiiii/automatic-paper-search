#!/usr/bin/env bash
# Copy only generated working-tree changes under explicit repository paths.

set -euo pipefail

die() {
  echo "::error::$*" >&2
  exit 1
}

[[ "$#" -ge 2 ]] || die \
  "usage: $0 <candidate-dir> <included-path>..."

candidate_dir="$1"
shift
included_paths=("$@")
repo_root="$(git rev-parse --show-toplevel)"
cd "$repo_root"

[[ "$candidate_dir" == /* ]] || die "candidate directory must be absolute"
[[ "$candidate_dir" != "$repo_root" && "$candidate_dir" != "$repo_root/"* ]] || die \
  "candidate directory must be outside the repository"

for included in "${included_paths[@]}"; do
  [[ -n "$included" && "$included" != /* && "$included" != ".." && \
     "$included" != ../* && "$included" != */../* && "$included" != */.. ]] || die \
    "invalid included path: $included"
done

mkdir -p "$candidate_dir"
copied=0
snapshot_mode="${PAPERPILOT_PACKAGE_INCLUDE_UNCHANGED:-0}"
[[ "$snapshot_mode" == "0" || "$snapshot_mode" == "1" ]] || die \
  "PAPERPILOT_PACKAGE_INCLUDE_UNCHANGED must be 0 or 1"

is_included() {
  local path="$1"
  local included
  for included in "${included_paths[@]}"; do
    if [[ "$path" == "$included" || "$path" == "$included/"* ]]; then
      return 0
    fi
  done
  return 1
}

copy_changed() {
  local path="$1"
  is_included "$path" || return 0
  [[ -e "$path" ]] || die "generated deletion is not supported: $path"
  [[ ! -L "$path" ]] || die "generated symlink is forbidden: $path"
  [[ -f "$path" ]] || return 0
  mkdir -p "$candidate_dir/$(dirname "$path")"
  cp -p -- "$path" "$candidate_dir/$path"
  copied=$((copied + 1))
}

if [[ "$snapshot_mode" == "1" ]]; then
  # A narrowly scoped generator may legitimately reproduce byte-identical
  # output. Snapshot only its exact include path so the promoter can return
  # changed=false without broadening the candidate to shared directories.
  for included in "${included_paths[@]}"; do
    [[ -e "$included" ]] || die "snapshot path does not exist: $included"
    [[ ! -L "$included" ]] || die "generated symlink is forbidden: $included"
    if [[ -f "$included" ]]; then
      copy_changed "$included"
      continue
    fi
    [[ -d "$included" ]] || die "snapshot path is not a file or directory: $included"
    if find "$included" -type l -print -quit | grep -q .; then
      die "generated symlink is forbidden below: $included"
    fi
    while IFS= read -r -d '' path; do
      copy_changed "$path"
    done < <(find "$included" -type f -print0)
  done
else
  while IFS= read -r -d '' path; do
    copy_changed "$path"
  done < <(git diff --name-only --diff-filter=ACMRTUXB -z HEAD)

  while IFS= read -r -d '' path; do
    copy_changed "$path"
  done < <(git ls-files --others --exclude-standard -z)
fi

[[ "$copied" -gt 0 ]] || die "no generated candidate files changed"
echo "packaged $copied generated file(s) in $candidate_dir"
