# syntax=docker/dockerfile:1.7
# Multi-stage Dockerfile for PaperPilot.
# Build:  docker build -t paperpilot:latest .
# Run:    docker run --rm -v $(pwd)/paperpilot/output:/app/paperpilot/output \
#                   --env-file paperpilot/.env paperpilot:latest

# ---- Stage 1: builder ----
FROM python:3.12-slim AS builder
WORKDIR /app

# Build deps for wheels (cffi, etc. if any future dep needs them)
RUN apt-get update \
    && apt-get install -y --no-install-recommends build-essential \
    && rm -rf /var/lib/apt/lists/*

COPY pyproject.toml README.md ./
COPY paperpilot/ ./paperpilot/

RUN pip install --no-cache-dir --upgrade pip wheel setuptools \
    && pip wheel --no-cache-dir --wheel-dir /wheels -e .

# ---- Stage 2: runtime ----
FROM python:3.12-slim AS runtime
WORKDIR /app

# Non-root user for safety
RUN groupadd -r paperpilot && useradd -r -g paperpilot -d /app paperpilot

COPY --from=builder /wheels /wheels
COPY --from=builder /app/paperpilot /app/paperpilot
COPY --from=builder /app/pyproject.toml /app/README.md /app/

RUN pip install --no-cache-dir --no-index --find-links=/wheels paperpilot \
    && rm -rf /wheels

# Make output / data / logs dirs writable by the paperpilot user
RUN mkdir -p /app/paperpilot/output /app/paperpilot/data /app/paperpilot/logs \
    && chown -R paperpilot:paperpilot /app

USER paperpilot

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1

ENTRYPOINT ["python", "-m", "paperpilot.collector"]
CMD ["--config", "paperpilot/config.yaml"]
