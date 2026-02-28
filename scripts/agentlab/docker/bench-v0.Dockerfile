# Bench v0 container image for AgentLab experiments.
# Build context: the Experiments repo root.
#
#   docker build -f scripts/agentlab/docker/bench-v0.Dockerfile \
#     -t bench-v0:latest ../Experiments/
#
FROM python:3.11.8-slim-bookworm

# ── Determinism defaults (match Experiments/bench/docker/base.Dockerfile) ─────
ENV PYTHONHASHSEED=0 \
    TZ=UTC \
    LC_ALL=C.UTF-8 \
    LANG=C.UTF-8 \
    SOURCE_DATE_EPOCH=1700000000 \
    PYTEST_DISABLE_PLUGIN_AUTOLOAD=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1

# ── System dependencies ──────────────────────────────────────────────────────
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    patch \
    ripgrep \
    zstd \
    curl \
    unzip \
    && rm -rf /var/lib/apt/lists/*

# ── Bun (hidden test runners shell out to `bun -e`) ─────────────────────────
ARG BUN_VERSION=1.1.42
RUN curl -fsSL https://bun.sh/install | BUN_INSTALL=/usr/local bash -s "bun-v${BUN_VERSION}"

# ── Install bench Python package ─────────────────────────────────────────────
COPY pyproject.toml /opt/bench-src/pyproject.toml
COPY bench/ /opt/bench-src/bench/
RUN pip install --no-deps /opt/bench-src && pip install /opt/bench-src

# ── Copy task data & helper scripts ──────────────────────────────────────────
COPY schemas/ /opt/bench/schemas/
COPY tasks/v0/ /opt/bench/tasks/v0/
COPY scripts/bench/ /opt/bench/scripts/bench/
COPY repos/jesus/src.tar.zst /opt/bench/repos/jesus/src.tar.zst

# ── Pre-unpack repo snapshot → /workspace-base/ ─────────────────────────────
# Avoids per-trial decompression. The agent wrapper copies this directory.
RUN mkdir -p /workspace-base \
    && zstd -d /opt/bench/repos/jesus/src.tar.zst -o /tmp/src.tar \
    && tar xf /tmp/src.tar -C /workspace-base \
    && rm /tmp/src.tar \
    && cd /workspace-base \
    && git init \
    && git add -A \
    && git -c user.name=bench -c user.email=bench@local commit -m "baseline" --allow-empty \
    && echo "workspace-base ready"

# ── Bench root env (grade_task resolves tasks/schemas/repos relative to this)
ENV BENCH_ROOT=/opt/bench

WORKDIR /workspace
