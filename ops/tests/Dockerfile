FROM debian:bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
        tmux \
        bash \
        python3 \
        procps \
        coreutils \
        grep \
        sed \
        patch \
        util-linux \
        cron \
        ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Build context is the REPO ROOT. We layout /repo to mirror the monorepo so
# SCRIPT_DIR/../.. inside scheduled-tasks scripts resolves ops/ correctly.
WORKDIR /repo

# Fake `claude` binary on PATH — logs stdin and blocks.
COPY ops/tests/fakes/claude /usr/local/bin/claude
RUN chmod +x /usr/local/bin/claude

COPY ops /repo/ops
COPY scheduled-tasks /repo/scheduled-tasks
COPY bin /repo/bin

ENV OPS_DIR=/repo/ops \
    REPO_ROOT=/repo \
    KA_REPO_ROOT=/repo \
    TMUX_TMPDIR=/tmp/tmux-test \
    HOME=/root

RUN mkdir -p /tmp/tmux-test && chmod 700 /tmp/tmux-test

ENTRYPOINT ["/bin/bash", "/repo/ops/tests/entrypoint.sh"]
