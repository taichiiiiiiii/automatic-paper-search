# Paper slide PDF worker image contract

This directory defines the dedicated, credential-free Linux image for
`paper-slide-worker-v1`. It only runs
`paperpilot.paper_slides.extract_worker`; it is not a general PaperPilot image.
Building, approving, and allowlisting the resulting image digest are external
release gates. No image was built here; the base, wheels, SBOM, signatures, and
provenance are not verified locally by these source-only tests.

The release target in the commands below is consistently `linux/arm64/v8`.
Changing the platform is a new approval decision and requires new base,
candidate, filesystem, SBOM, and provenance evidence.

## Reproducible offline inputs

Prepare a build context containing this directory plus a `wheelhouse/` directory
with exactly the reviewed PaperPilot wheel and reviewed pypdf 6.x wheel. Record
their lowercase SHA-256 values. Select an OCI Python base by an independently
approved immutable reference, never by tag:

```text
registry.example/team/python@sha256:<64-lowercase-hex>
wheelhouse/paperpilot-0.1.0-py3-none-any.whl
wheelhouse/pypdf-6.16.2-py3-none-any.whl
```

The Dockerfile cannot validate `PYTHON_BASE` before the builder resolves its
`FROM` instruction. A trusted preflight wrapper or release job must complete the
following three independent gates before invoking `docker build`.

## Pre-build base-image preflight

Confirm that the approved base digest and digest-pinned Dockerfile frontend are
already present locally. Run this on a network-disabled or physically air-gapped
builder: `docker build --network=none` limits only `RUN` instructions and does
not stop frontend or `FROM` resolution from contacting a registry.

Export the exact local base config and validate it against release-policy hashes:

```sh
docker image inspect \
  registry.example/team/python@sha256:<approved-base-digest> \
  > base.inspect.json
python containers/paper-slide-worker/inspect_base.py \
  --inspect-json base.inspect.json \
  --expected-base registry.example/team/python@sha256:<approved-base-digest> \
  --expected-platform linux/arm64/v8 \
  --expected-environment-sha256 <approved-base-environment-sha256> \
  --expected-labels-sha256 <approved-base-labels-sha256>
```

The two expected hashes are approved canonical hashes of the complete base
environment and label maps. They must come from release policy, not from an
unreviewed inspect result copied merely to make validation pass. The pre-build
inspector rejects config drift, nonempty `Config.Volumes`, live `ONBUILD`,
entrypoint/command/healthcheck changes, secret-shaped fields, digest mismatch,
and platform mismatch.

The same preflight must check the original, unfiltered wheelhouse. This matters
because `.dockerignore` can omit an unwanted entry from the build context:

```sh
python containers/paper-slide-worker/verify_wheels.py \
  --base-ref registry.example/team/python@sha256:<approved-base-digest> \
  --wheelhouse containers/paper-slide-worker/wheelhouse \
  --paperpilot-wheel paperpilot-0.1.0-py3-none-any.whl \
  --paperpilot-sha256 <approved-paperpilot-wheel-sha256> \
  --pypdf-wheel pypdf-6.16.2-py3-none-any.whl \
  --pypdf-sha256 <approved-pypdf-wheel-sha256>
```

Only after those checks pass may an operator perform the offline build:

```sh
docker build --pull=false --network=none --platform=linux/arm64/v8 \
  --build-arg PYTHON_BASE="registry.example/team/python@sha256:<approved-base-digest>" \
  --build-arg PAPERPILOT_WHEEL="paperpilot-0.1.0-py3-none-any.whl" \
  --build-arg PAPERPILOT_WHEEL_SHA256="<approved-paperpilot-wheel-sha256>" \
  --build-arg PYPDF_WHEEL="pypdf-6.16.2-py3-none-any.whl" \
  --build-arg PYPDF_WHEEL_SHA256="<approved-pypdf-wheel-sha256>" \
  --tag paper-slide-worker:candidate \
  containers/paper-slide-worker
```

There is deliberately no base default. The verifier rejects mutable/tagged
bases, noncanonical wheel names, pypdf outside major version 6, missing wheels,
hash mismatches, and every extra or non-regular wheelhouse entry. BuildKit mounts
`wheelhouse/` read-only; pip receives only the two verified paths with
`--no-index --no-deps --no-cache-dir`. The `.dockerignore` is an allowlist. The
runtime stage receives the installed virtual environment, not the wheelhouse,
build verifier, repository checkout, test tree, or raw fixture.

## Post-build candidate inspection

Retain the build command, immutable base digest, both wheel filenames and hashes,
Docker/BuildKit version, and produced candidate digest. Export the exact digest,
never a tag, and validate all arguments including the two approved map hashes:

```sh
docker image inspect \
  registry.example/team/paper-slide-worker@sha256:<approved-candidate-digest> \
  > candidate.inspect.json
python containers/paper-slide-worker/inspect_candidate.py \
  --inspect-json candidate.inspect.json \
  --expected-image registry.example/team/paper-slide-worker@sha256:<approved-candidate-digest> \
  --expected-base registry.example/team/python@sha256:<approved-base-digest> \
  --expected-platform linux/arm64/v8 \
  --expected-environment-sha256 <approved-candidate-environment-sha256> \
  --expected-labels-sha256 <approved-candidate-labels-sha256>
```

The candidate environment hash must be derived from the already approved base
plus the documented Dockerfile overrides. The label hash must cover exactly the
fixed worker labels and approved base reference. The helper rejects nonempty
volumes, entrypoint/user/workdir changes, healthchecks, live on-build triggers,
secret-shaped or proxy environment names, unexpected or sensitive labels,
inherited `Config.Env` drift, platform/digest mismatch, and label drift. Its accepted OCI
description is an exact canonical fixed value even though it contains the word
“credential”; arbitrary credential-shaped label content remains rejected.

The expected candidate configuration includes `Config.User=65532:65532`,
`Config.WorkingDir=/tmp`, empty `Config.Volumes`, and the fixed entrypoint
`/opt/paper-slide-worker/bin/python -I -m paperpilot.paper_slides.extract_worker`.
The image-local check requires that pypdf reports major version 6 and that the
worker imports without `pip`, `sitecustomize`, or `usercustomize` on its Python
import path.

## Filesystem and provenance gates

Config inspection is necessary but not a filesystem or ancestry attestation. In
particular, candidate inspect JSON cannot reveal consumed `ONBUILD` instructions
from an ancestor, prove that the base runtime filesystem is pip-free, find all
startup hooks such as `sitecustomize` or `usercustomize`, or find credential files
elsewhere in inherited layers. An empty current `Config.OnBuild` only proves that
no trigger remains for a future child; it cannot detect `ONBUILD` instructions that were already consumed
while building this candidate.

A separate release gate must therefore scan the approved base and final candidate
filesystems, reject pip/build tooling, startup hooks, credential files, private
keys, `.env`, `.netrc`, tests, fixtures, and unexpected executables, and record
the complete layer inventory. It must also verify the base and wheel SBOMs,
signatures, provenance, license policy, known-vulnerability policy, Dockerfile
frontend digest, candidate digest, and `linux/arm64/v8` platform. Filename and
SHA pinning identify an artifact; they do not prove that it is safe.

## Runtime compatibility

The fixed entrypoint accepts the worker resource-policy JSON and extraction-
options JSON as its two arguments and reads one bounded PDF from standard input.
The job runner must use a digest reference and container controls equivalent to:

```sh
docker run --rm --pull=never --interactive \
  --platform=linux/arm64/v8 \
  --network=none --ipc=none --read-only --log-driver=none \
  --cap-drop=ALL --security-opt=no-new-privileges \
  --pids-limit=32 --memory=768m --cpus=1 \
  --memory-swap=768m \
  --ulimit cpu=15:15 --ulimit nofile=32:32 \
  --ulimit core=0:0 --ulimit fsize=0:0 \
  --user 65532:65532 --workdir /tmp \
  --tmpfs /tmp:rw,noexec,nosuid,nodev,size=64m,mode=1777 \
  registry.example/team/paper-slide-worker@sha256:<approved-candidate-digest> \
  '<resource-policy-json>' '<extraction-options-json>' < paper.pdf
```

Do not add host mounts, a Docker socket, devices, credentials, environment files,
proxy settings, or `--privileged`. The Python audit hook and rlimits remain
defense in depth; `--network=none`, seccomp, capability removal, read-only root,
PID/memory/CPU limits, and digest allowlisting are separate production
requirements. Runtime integration, image build, publication, and approval remain
external gates.
