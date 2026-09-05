# syntax=docker/dockerfile:1.7@sha256:a57df69d0ea827fb7266491f2813635de6f17269be881f696fbfdf2d83dda33e

# No default is intentional. The caller must approve and provide an immutable
# Python base reference in the form repository@sha256:<64 lowercase hex>.
ARG PYTHON_BASE

FROM ${PYTHON_BASE} AS build

ARG PYTHON_BASE
ARG PAPERPILOT_WHEEL
ARG PAPERPILOT_WHEEL_SHA256
ARG PYPDF_WHEEL
ARG PYPDF_WHEEL_SHA256

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONHASHSEED=0 \
    PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_NO_INDEX=1

COPY verify_wheels.py /usr/local/libexec/paper-slide-verify-wheels.py

# wheelhouse is a BuildKit read-only bind mount: its contents never become an
# image layer. Hash and filename verification happens before either wheel is
# passed to pip. --no-deps makes the two approved wheels the complete install.
RUN --network=none --mount=type=bind,source=wheelhouse,target=/wheelhouse,readonly \
    python /usr/local/libexec/paper-slide-verify-wheels.py \
      --base-ref "${PYTHON_BASE}" \
      --wheelhouse /wheelhouse \
      --paperpilot-wheel "${PAPERPILOT_WHEEL}" \
      --paperpilot-sha256 "${PAPERPILOT_WHEEL_SHA256}" \
      --pypdf-wheel "${PYPDF_WHEEL}" \
      --pypdf-sha256 "${PYPDF_WHEEL_SHA256}" \
      --staging-directory /verified-wheelhouse \
 && python -m venv /opt/paper-slide-worker \
 && /opt/paper-slide-worker/bin/python -m pip install \
      --no-index --no-deps --no-cache-dir --no-compile \
      "/verified-wheelhouse/${PAPERPILOT_WHEEL}" \
      "/verified-wheelhouse/${PYPDF_WHEEL}" \
 && /opt/paper-slide-worker/bin/python -I -c \
      'import pypdf; import paperpilot.paper_slides.extract_worker as worker; assert pypdf.__version__.split(".", 1)[0] == "6"; assert callable(worker.main)' \
 && /opt/paper-slide-worker/bin/python -m pip uninstall --yes pip setuptools wheel \
 && /opt/paper-slide-worker/bin/python -I -c \
      'import importlib.util; import pypdf; import paperpilot.paper_slides.extract_worker as worker; assert importlib.util.find_spec("pip") is None; assert importlib.util.find_spec("sitecustomize") is None; assert importlib.util.find_spec("usercustomize") is None; assert pypdf.__version__.split(".", 1)[0] == "6"; assert callable(worker.main)'

FROM ${PYTHON_BASE} AS runtime

ARG PYTHON_BASE

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONHASHSEED=0 \
    PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_NO_INDEX=1

LABEL org.opencontainers.image.title="PaperPilot PDF extraction worker" \
      org.opencontainers.image.description="Credential-free isolated parser for the paper-slide-worker-v1 contract" \
      org.opencontainers.image.source="https://github.com/taichiiiiiiii/automatic-paper-search" \
      io.paperpilot.worker.contract="paper-slide-worker-v1" \
      io.paperpilot.worker.module="paperpilot.paper_slides.extract_worker" \
      io.paperpilot.worker.base="${PYTHON_BASE}"

COPY --from=build --chown=65532:65532 /opt/paper-slide-worker /opt/paper-slide-worker

WORKDIR /tmp
USER 65532:65532

# Reject unexpected packaging material in the only application tree copied
# from the build stage. Run the final import and absence checks with the exact
# unprivileged identity used by the worker. The base is inspected separately.
RUN --network=none /opt/paper-slide-worker/bin/python -I -c \
      'from pathlib import Path; root = Path("/opt/paper-slide-worker"); forbidden = {".env", ".netrc", "credentials", "fixtures", "id_rsa", "sitecustomize.py", "tests", "usercustomize.py"}; assert not any(path.name.lower() in forbidden for path in root.rglob("*")); import importlib.util; import pypdf; import paperpilot.paper_slides.extract_worker as worker; assert importlib.util.find_spec("pip") is None; assert importlib.util.find_spec("sitecustomize") is None; assert importlib.util.find_spec("usercustomize") is None; assert pypdf.__version__.split(".", 1)[0] == "6"; assert callable(worker.main)'

ENTRYPOINT ["/opt/paper-slide-worker/bin/python", "-I", "-m", "paperpilot.paper_slides.extract_worker"]
