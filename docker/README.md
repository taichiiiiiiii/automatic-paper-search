# Docker-first phase 1

`docker/paperpilot-compose` is the only canonical local entrypoint. Calling the
Compose CLI directly bypasses the supply-chain preflight and is unsupported.
The wrapper never pulls OCI images. An operator must separately approve and
explicitly acquire every image before using it.

The wrapper itself requires host Python 3.10 or newer, using only the standard
library. Project dependencies and integration commands run in containers; a
host `uv` environment is not the Docker gate.

## Immutable local inputs

Copy `docker/docker-env.example` to a git-ignored `.env.docker`, replace every
invalid placeholder with an approved value, then export it into the shell:

```sh
set -a
. ./.env.docker
set +a
```

All base values must use `repository@sha256:<64 lowercase hex>`. The repositories
are code-owned and closed:

- `PAPERPILOT_PYTHON_BASE`: `docker.io/library/python`, exactly Python 3.12,
  Debian-compatible with `/bin/sh`, `apt-get`, and `/etc/debian_version`
- `PAPERPILOT_UV_BASE`: `ghcr.io/astral-sh/uv`, exactly uv 0.12.7
- `PAPERPILOT_NODE_BASE`: `docker.io/library/node`, exactly Node 20
- `PAPERPILOT_PLATFORM`: exactly `linux/amd64` or `linux/arm64/v8`

The pinned Dockerfile frontend image must also already be local. The wrapper
rejects tags, uppercase or short digests, other repositories, locally absent
images, repository-digest mismatch, non-Linux or wrong-architecture images, and
wrong tool versions. Version probes use `--pull=never`, no network, a read-only
filesystem, no capabilities, and no inherited application credentials.

The checked-in example deliberately contains invalid placeholders. This phase
does not ship an approved digest set, so the example must never pass preflight.

## Canonical commands

After an operator supplies an approved digest set and explicitly acquires the
images (neither has occurred in the current local validation), build first.
Later `run`/`up` calls use `pull_policy: never` and cannot fetch a missing image:

```sh
docker/paperpilot-compose build test node-test
docker/paperpilot-compose run --rm --no-deps test
docker/paperpilot-compose run --rm --no-deps node-test

docker/paperpilot-compose build collector
docker/paperpilot-compose run --rm --no-deps collector \
  --config /etc/paperpilot/config.yaml --skip-llm

docker/paperpilot-compose build ops
docker/paperpilot-compose run --rm --no-deps ops \
  -m paperpilot.scripts.build_search_index --help

docker/paperpilot-compose build site-preview
docker/paperpilot-compose --profile preview up --no-build site-preview
```

The wrapper rejects pull/push, alternate Compose files, and `up --build`.
`build` is rewritten with pull disabled. Dependency resolution inside the
approved builders is still networked in phase 1; this is not an offline or
release-reproducible build.

`run` also rejects volume, privileged, user, entrypoint, network and env-file
overrides. A closed set of `PAPERPILOT_*` runtime variables may be forwarded as
`--env VARIABLE_NAME`, without putting the value on the command line. This
wrapper is a project admission policy, not a sandbox against the local Docker
operator: anyone controlling the Docker daemon already has host-equivalent
authority and can bypass the project wrapper.

## Runtime boundaries

The collector has no inbound port. Its root filesystem is read-only and only
the output/data/log named volumes plus bounded `/tmp` are writable. Its phase-1
outbound network is **unrestricted outbound**: Docker Compose cannot enforce a
hostname allowlist. Do not describe it as source-API-only until an egress proxy
or firewall policy exists.

The `ops` service is a credential-free, offline projector for deterministic
site/search/lineage/replay commands that work with the core dependency set. It
does not claim to run API collection, LLM classification, Sheets export,
unarXive download, or PDF-worker orchestration. It mounts only the host
`docs/` and `paperpilot/data/` trees plus the collector's `paperpilot-output`
named volume; it never mounts the repository root or Docker socket. The shared
output volume is read/write because projector commands such as
`build_summary_csv` and `build_pages` consume and update collector artifacts.
The image-owned source is scrubbed of `.env*`, output, log and test content
before the final target. On native Linux, writable bind-mount content must be
owned by or grant write access to numeric UID/GID `65532:65532`. macOS Docker
Desktop applies its own sharing translation. The service fails rather than
silently becoming root.

The Python `test` target is a non-production **source-suite exception**. It
contains the checkout intentionally, retains test tooling, has no network, and
uses an executable bounded `/tmp` because Git-hook fixtures must execute. It
also performs a neutral-working-directory smoke against the non-editable
installed artifact. Node is absent from this target.

The dedicated `node-test` image is based directly on the approved Node image.
Its runner inventories and executes every `worker/*.test.mjs` and
`paperpilot/tests/viewer/test_*.mjs` suite with no network, host mounts, or
writable root filesystem. Python wrappers that require Node skip in the Python
source-suite; the pure Node suites are authoritative in `node-test`.

The preview listens only on `127.0.0.1:${PAPERPILOT_PREVIEW_PORT:-8137}` and
serves the read-only `docs/` bind mount below the real GitHub Pages project
base. Open `http://127.0.0.1:8137/automatic-paper-search/`; the server root may
show a one-directory listing and is not the QA URL. This base path keeps
absolute `/automatic-paper-search/...` assets working locally. It is local QA,
not production hosting. GitHub Pages remains the production static hosting path.

Runtime credentials, when a collector command needs them, must be injected by
the trusted operator. They are visible in container inspection; application
`*_FILE` support does not exist yet. Never add credentials as build arguments,
labels, fixtures, or files in the build context.

## Phase boundary

Current evidence is static-contract only: 28 tests pass. No approved image
pull, image build, or container runtime smoke has been performed.
Existing GitHub Actions also still run their historical host-`uv` commands;
Docker becomes the production/CI canonical path only after the runtime and
shadow-CI equivalence gates in the migration order below pass.

Phase 1 uses `uv sync --frozen --no-editable` against committed `uv.lock`, but
Python dependencies and Debian test tools still download during build. Phase 2
must add reviewed per-platform wheelhouses and system-package manifests, build
with network disabled, and retain SBOM/provenance evidence.

The isolated PDF worker remains under `containers/paper-slide-worker/` and is
not a Compose service. Never mount a Docker socket into collector or ops: socket
access is effectively host-root authority. Its trusted host executor and
digest-approved, credential-free worker stay a separate security boundary.
