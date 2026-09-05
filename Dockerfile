# syntax=docker/dockerfile:1.7@sha256:a57df69d0ea827fb7266491f2813635de6f17269be881f696fbfdf2d83dda33e

# Canonical builds are admitted only by docker/paperpilot-compose. Docker must
# resolve FROM before RUN, so the wrapper validates approved local digests,
# platform and tool versions without pulling before this file is evaluated.
ARG PYTHON_BASE
ARG UV_BASE

FROM ${UV_BASE} AS uv-bin

FROM ${PYTHON_BASE} AS python-base

RUN --network=none python -I -c \
      'import sys; assert sys.version_info[:2] == (3, 12), sys.version'

FROM python-base AS python-runtime

ENV HOME=/tmp \
    PATH=/usr/local/bin:/usr/bin:/bin \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_NO_INDEX=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONHASHSEED=0 \
    PYTHONUNBUFFERED=1

# The approved Python builder may contain bootstrap packaging tools. Production
# targets do not: remove global entrypoints, modules and the stdlib bootstrap.
RUN rm -f /usr/local/bin/pip /usr/local/bin/pip3 /usr/local/bin/pip3.12 \
 && rm -rf /usr/local/lib/python3.12/site-packages/pip \
      /usr/local/lib/python3.12/site-packages/pip-*.dist-info \
      /usr/local/lib/python3.12/ensurepip \
 && ! command -v pip \
 && ! command -v pip3 \
 && ! command -v uv \
 && ! python -I -m pip --version >/dev/null 2>&1 \
 && ! python -I -m ensurepip --version >/dev/null 2>&1

FROM python-base AS collector-build

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    UV_LINK_MODE=copy \
    UV_PROJECT_ENVIRONMENT=/opt/paperpilot

WORKDIR /build

COPY --from=uv-bin /uv /usr/local/bin/uv
COPY pyproject.toml uv.lock README.md ./
COPY paperpilot/ ./paperpilot/

RUN --network=none uv --version | grep -E '^uv 0\.12\.7([[:space:]]|$)'

# Phase 1 resolves the frozen lock during the build. The release-offline
# wheelhouse and hash-manifest gate remains phase 2 work.
RUN --mount=type=cache,target=/root/.cache/uv,sharing=locked \
    uv sync --frozen --no-editable --no-dev

FROM collector-build AS ops-build

# Operators need an image-owned repository-shaped package tree because legacy
# projectors derive /workspace from __file__. Tests and mutable logs are not
# carried into the final ops target.
RUN rm -rf /build/paperpilot/tests \
      /build/paperpilot/output \
      /build/paperpilot/logs \
      /build/paperpilot/__pycache__ \
 && rm -f /build/paperpilot/.env /build/paperpilot/.env.*

FROM python-runtime AS collector

ENV PATH=/opt/paperpilot/bin:/usr/local/bin:/usr/bin:/bin \
    PIP_NO_INDEX=1 \
    PYTHONDONTWRITEBYTECODE=1

COPY --from=collector-build --chown=0:0 /opt/paperpilot /opt/paperpilot
COPY --from=collector-build --chown=0:0 /build/paperpilot/config.yaml /etc/paperpilot/config.yaml

RUN --network=none rm -f /opt/paperpilot/bin/pip /opt/paperpilot/bin/pip3 /opt/paperpilot/bin/pip3.12 \
 && rm -rf /opt/paperpilot/lib/python3.12/site-packages/pip \
      /opt/paperpilot/lib/python3.12/site-packages/pip-*.dist-info \
 && mkdir -p \
      /workspace/paperpilot/output \
      /workspace/paperpilot/data \
      /workspace/paperpilot/logs \
 && chown 65532:65532 \
      /workspace/paperpilot/output \
      /workspace/paperpilot/data \
      /workspace/paperpilot/logs \
 && ! command -v uv \
 && ! command -v pip \
 && ! /opt/paperpilot/bin/python -I -m pip --version >/dev/null 2>&1 \
 && ! /opt/paperpilot/bin/python -I -m ensurepip --version >/dev/null 2>&1 \
 && /opt/paperpilot/bin/python -I -c \
      'import paperpilot.collector as collector; assert callable(collector.main)'

WORKDIR /workspace
USER 65532:65532

ENTRYPOINT ["/opt/paperpilot/bin/python", "-I", "-m", "paperpilot.collector"]
CMD ["--config", "/etc/paperpilot/config.yaml"]

FROM python-runtime AS ops

ENV PATH=/opt/paperpilot/bin:/usr/local/bin:/usr/bin:/bin

COPY --from=ops-build --chown=0:0 /opt/paperpilot /opt/paperpilot
COPY --from=ops-build --chown=0:0 /build/paperpilot /workspace/paperpilot
COPY --chown=0:0 schemas/ /workspace/schemas/
COPY --chown=0:0 scripts/ /workspace/scripts/

RUN rm -f /opt/paperpilot/bin/pip /opt/paperpilot/bin/pip3 /opt/paperpilot/bin/pip3.12 \
 && rm -rf /opt/paperpilot/lib/python3.12/site-packages/pip \
      /opt/paperpilot/lib/python3.12/site-packages/pip-*.dist-info \
 && mkdir -p \
      /workspace/docs \
      /workspace/paperpilot/data \
      /workspace/paperpilot/output \
 && chown 65532:65532 \
      /workspace/docs \
      /workspace/paperpilot/data \
      /workspace/paperpilot/output \
 && ! find /workspace -type f \( -name '.env' -o -name '.env.*' \) -print -quit | grep -q . \
 && ! command -v uv \
 && ! command -v pip \
 && ! /opt/paperpilot/bin/python -I -m pip --version >/dev/null 2>&1 \
 && ! /opt/paperpilot/bin/python -I -m ensurepip --version >/dev/null 2>&1

WORKDIR /workspace
USER 65532:65532

RUN --network=none /opt/paperpilot/bin/python -B \
    -m paperpilot.scripts.build_search_index --help >/dev/null

ENTRYPOINT ["/opt/paperpilot/bin/python", "-B"]
CMD ["-m", "paperpilot.scripts.build_search_index", "--help"]

FROM python-base AS test-os

ENV DEBIAN_FRONTEND=noninteractive

# Hermetic Git fixture tests require bash and git. Node suites live in the
# separate node-test image; this source-suite target intentionally retains the
# checkout but does not receive a Node binary.
RUN apt-get update \
 && apt-get install -y --no-install-recommends bash git \
 && rm -rf /var/lib/apt/lists/*

FROM test-os AS test-build

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    UV_LINK_MODE=copy \
    UV_PROJECT_ENVIRONMENT=/opt/paperpilot

WORKDIR /workspace

COPY --from=uv-bin /uv /usr/local/bin/uv
COPY . /workspace

RUN --network=none uv --version | grep -E '^uv 0\.12\.7([[:space:]]|$)'
RUN --mount=type=cache,target=/root/.cache/uv,sharing=locked \
    uv sync --frozen --no-editable --extra dev --extra unarxive

FROM test-os AS test

ENV HOME=/tmp \
    PATH=/opt/paperpilot/bin:/usr/local/bin:/usr/bin:/bin \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONHASHSEED=0 \
    PYTHONUNBUFFERED=1 \
    RUFF_CACHE_DIR=/tmp/ruff-cache

COPY --from=test-build --chown=0:0 /opt/paperpilot /opt/paperpilot
COPY --from=test-build --chown=0:0 /workspace /workspace

RUN --network=none \
    ! command -v uv \
 && ! command -v node \
 && git --version \
 && /opt/paperpilot/bin/python -I -c \
      'import paperpilot; import pytest; assert pytest.__version__'

WORKDIR /workspace
USER 65532:65532

# The first check is deliberately outside /workspace: it exercises the
# non-editable installed artifact instead of the source tree used by pytest.
RUN --network=none cd /tmp \
 && /opt/paperpilot/bin/python -I -c \
      'from importlib.resources import files; import paperpilot.collector; assert files("paperpilot").joinpath("config.yaml").is_file()'

CMD ["/bin/sh", "-c", "cd /tmp && /opt/paperpilot/bin/python -I -c 'import paperpilot.collector' && cd /workspace && ruff check paperpilot/ && pytest paperpilot/tests -q -rs -p no:cacheprovider"]

FROM python-runtime AS site-preview

WORKDIR /site
RUN --network=none mkdir -p /site/automatic-paper-search \
 && ! command -v uv \
 && ! command -v pip \
 && ! python -I -m pip --version >/dev/null 2>&1 \
 && ! python -I -m ensurepip --version >/dev/null 2>&1
USER 65532:65532
EXPOSE 8000

ENTRYPOINT ["python", "-I", "-m", "http.server", "8000", "--bind", "0.0.0.0", "--directory", "/site"]
