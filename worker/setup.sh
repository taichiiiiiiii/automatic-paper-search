#!/usr/bin/env bash
# One-shot setup for the consolidated Worker (`automatic-paper-search`).
#
# Run this from the repo root after `git pull`:
#
#   bash worker/setup.sh
#
# Performs:
#   1) sanity check (wrangler available)
#   2) wrangler login (if not already authenticated)
#   3) wrangler kv namespace create RATE_LIMIT_KV (idempotent — skips if it
#      sees a non-placeholder id already in wrangler.jsonc)
#   4) splices the new KV id into wrangler.jsonc (in-place)
#   5) wrangler secret put GH_DISPATCH_PAT (interactive paste)
#   6) wrangler deploy
#   7) post-deploy probe (OPTIONS /api/themes → expect 204)
#
# Idempotent: re-running after a successful deploy is a no-op except for
# step 5 (re-prompting for the PAT) and step 6 (re-deploying).
#
# Why not run from CI: KV creation needs an interactive `wrangler login`,
# and the GH_DISPATCH_PAT must come from a human (it's the credential
# that gates workflow_dispatch — never store it in the repo).

set -euo pipefail

# Locate repo root so the script works whether invoked from root or worker/.
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WRANGLER_JSONC="${REPO_ROOT}/wrangler.jsonc"
PLACEHOLDER_ID='00000000000000000000000000000000'

cd "${REPO_ROOT}"

echo "▶ 1/6 wrangler available?"
if ! command -v npx >/dev/null 2>&1; then
  echo "✗ npx not found — install Node.js (https://nodejs.org/) first." >&2
  exit 1
fi
WRANGLER="npx --yes wrangler@latest"

echo "▶ 2/6 wrangler login (interactive — opens browser)"
if ! ${WRANGLER} whoami >/dev/null 2>&1; then
  ${WRANGLER} login
else
  echo "  already authenticated"
fi

echo "▶ 3/6 KV namespace create"
# Skip if the file already has a non-placeholder id (i.e. someone ran this
# before and committed). Detect by absence of the 32-zero string.
if grep -q "\"id\": \"${PLACEHOLDER_ID}\"" "${WRANGLER_JSONC}"; then
  KV_OUTPUT=$(${WRANGLER} kv namespace create RATE_LIMIT_KV 2>&1)
  echo "${KV_OUTPUT}"
  # Extract id from output. wrangler prints lines like:
  #   { binding = "RATE_LIMIT_KV", id = "abc123def..." }
  # or the newer form using JSON. Match a 32-hex string after `id = "..."` or `"id": "..."`.
  KV_ID=$(printf '%s' "${KV_OUTPUT}" | grep -oE '[0-9a-f]{32}' | head -1)
  if [ -z "${KV_ID}" ]; then
    echo "✗ could not parse KV id from wrangler output" >&2
    echo "  paste the id manually into ${WRANGLER_JSONC} (kv_namespaces[0].id)" >&2
    exit 1
  fi
  echo "  parsed KV id: ${KV_ID}"

  echo "▶ 4/6 splice KV id into wrangler.jsonc"
  # macOS sed needs '' after -i; GNU sed does not. Detect.
  if sed --version >/dev/null 2>&1; then
    sed -i "s/\"${PLACEHOLDER_ID}\"/\"${KV_ID}\"/" "${WRANGLER_JSONC}"
  else
    sed -i '' "s/\"${PLACEHOLDER_ID}\"/\"${KV_ID}\"/" "${WRANGLER_JSONC}"
  fi
  echo "  → wrangler.jsonc updated. git diff:"
  git --no-pager diff -- "${WRANGLER_JSONC}" | tail -20 || true
else
  echo "  skipping — wrangler.jsonc already has a real KV id"
  echo "▶ 4/6 splice — already done"
fi

echo "▶ 5/6 wrangler secret put GH_DISPATCH_PAT"
echo "    Paste a fine-grained PAT scoped to this repo with"
echo "    Actions: read & write. The prompt below is interactive."
echo
${WRANGLER} secret put GH_DISPATCH_PAT

echo "▶ 6/6 wrangler deploy"
${WRANGLER} deploy

echo
echo "▶ post-deploy probe"
BASE="https://paperpilot-themes.puuptdbkh082.workers.dev"
sleep 5
HTTP=$(curl -sS -o /dev/null --max-time 15 -w "%{http_code}" -X OPTIONS "${BASE}/api/themes" || echo "ERR")
echo "    OPTIONS ${BASE}/api/themes → HTTP ${HTTP}"
if [ "${HTTP}" = "204" ]; then
  echo "✅ Worker is live. Test the API with:"
  echo
  echo "    curl -i -X POST ${BASE}/api/themes \\"
  echo "      -H 'content-type: application/json' \\"
  echo "      --data '{\"theme\":\"Speculative Decoding\"}'"
  echo
  echo "    # → 200 {\"ok\":true,\"status\":\"queued\",\"slug\":\"speculative-decoding\",\"request_id\":\"theme-…\"}"
else
  echo "⚠ unexpected HTTP code (expected 204). Check the Worker tail:"
  echo
  echo "    ${WRANGLER} tail"
  echo
  echo "  Common causes:"
  echo "    - default branch is still 'main' (workflow_dispatch needs the workflow"
  echo "      file on the default branch). Flip to 'develop' in repo settings."
  echo "    - GH_DISPATCH_PAT lacks Actions:write scope on this repo."
fi

echo
echo "▶ if you swapped wrangler.jsonc, commit + push so future auto-deploys work:"
echo "    git add wrangler.jsonc"
echo "    git commit -m 'chore(worker): wire real KV namespace id'"
echo "    git push origin develop"
