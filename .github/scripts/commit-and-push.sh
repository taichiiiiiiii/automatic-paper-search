#!/usr/bin/env bash
# Commit staged changes and push to origin/develop with retry on race.
#
# Why this script exists:
#   theme-on-demand.yml is triggered by workflow_dispatch which can fire up
#   to 5 times in parallel from a single IP (see worker/response.js
#   RATE_LIMIT_PER_HOUR). When two runs finish their compute phase and try
#   to push develop within the same few seconds, only one wins — the others
#   see `! [rejected] develop -> develop (fetch first)` and lose their
#   generated lineage.json silently. This script wraps the commit + push
#   sequence in a fetch + rebase + push retry loop so contended pushes
#   eventually converge instead of being discarded. Closes #121.
#
# Usage:
#   bash .github/scripts/commit-and-push.sh "<commit-message>" "<stage-glob>"
#
# Env vars (test hooks):
#   COMMIT_PUSH_NO_SLEEP=1       — skip jitter between retries (CI tests)
#   COMMIT_PUSH_MAX_ATTEMPTS=N   — override default 5 attempts
#   COMMIT_PUSH_BRANCH=name      — override default "develop"

set -euo pipefail

msg=${1:?usage: commit-and-push.sh "<message>" "<stage-path>" ["<stage-path>" ...]}
shift
if [ "$#" -eq 0 ]; then
  echo "::error::commit-and-push.sh: at least one stage path required"
  echo "usage: commit-and-push.sh \"<message>\" \"<stage-path>\" [\"<stage-path>\" ...]" >&2
  exit 2
fi

branch=${COMMIT_PUSH_BRANCH:-develop}
max_attempts=${COMMIT_PUSH_MAX_ATTEMPTS:-5}

# Stage the target files. We intentionally do not `git add -A` so that
# untracked files outside the stage paths (e.g. lineage-cache contents,
# ad-hoc logs) never leak into the public repo. Multiple stage paths are
# accepted (#123 followup — collect-* workflows commit several dirs at
# once: paperpilot/output, paperpilot/data, docs). `git add -- <path>`
# returns 128 if the pathspec doesn't exist; we treat that as "nothing
# to stage from this path" rather than a hard failure so a workflow
# whose previous step produced a subset of the expected paths still
# exits cleanly.
staged_any=0
for path in "$@"; do
  if [ ! -e "$path" ]; then
    echo "skip: stage path '$path' does not exist"
    continue
  fi
  git add -- "$path"
  staged_any=1
done
if [ "$staged_any" -eq 0 ]; then
  echo "nothing changed — none of the stage paths existed"
  exit 0
fi

# If nothing changed (e.g. theme already exists and the build was a no-op
# rerun), exit cleanly so the workflow doesn't fail.
if git diff --cached --quiet; then
  echo "nothing changed — skipping commit"
  exit 0
fi

# Commit via env so the message is a literal string — a payload like
# `"$(rm -rf /)"` from the upstream input lands in the commit subject
# verbatim and never reaches `eval`/expansion.
git commit -m "$msg"

attempt=1
while [ "$attempt" -le "$max_attempts" ]; do
  echo "::group::push attempt $attempt/$max_attempts"
  # Fetch + rebase before each push. --autostash protects against an
  # accidentally dirty index (shouldn't happen mid-script, but cheap to set).
  # We do NOT swallow rebase failure: if a rebase conflicts, we abort and
  # retry — `git pull --rebase` alone would silently leave the repo in a
  # MERGING state and the next attempt would fail in a confusing way.
  if git fetch origin "$branch" \
     && git rebase --autostash "origin/$branch" \
     && git push origin "HEAD:$branch"; then
    echo "push succeeded on attempt $attempt"
    echo "::endgroup::"
    exit 0
  fi

  # Recover from a failed rebase so the next iteration starts clean. Leave
  # stderr unredirected — abort messages should appear in the CI log so
  # operators can spot pathological cases (genuine conflict vs. fast-forward
  # only collision).
  git rebase --abort || true

  if [ "$attempt" -eq "$max_attempts" ]; then
    echo "::endgroup::"
    break
  fi

  if [ "${COMMIT_PUSH_NO_SLEEP:-0}" != "1" ]; then
    # Jittered backoff so two competing runs don't lock-step on the same
    # retry instant. $RANDOM is fine here — this is not a security-sensitive
    # delay, just contention avoidance.
    delay=$(( attempt * 3 + RANDOM % 5 ))
    echo "push rejected, sleeping ${delay}s before retry"
    sleep "$delay"
  else
    echo "push rejected (sleep disabled by COMMIT_PUSH_NO_SLEEP)"
  fi

  echo "::endgroup::"
  attempt=$(( attempt + 1 ))
done

echo "::error::push failed after $max_attempts attempts — see attempt logs above"
exit 1
