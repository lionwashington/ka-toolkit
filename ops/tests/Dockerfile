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
        nodejs \
        ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Build context is the REPO ROOT. We layout /repo to mirror the monorepo so
# SCRIPT_DIR/../.. resolves ops/ correctly inside the ka scripts.
WORKDIR /repo

# Fake `claude` binary on PATH — logs stdin and blocks.
COPY ops/tests/fakes/claude /usr/local/bin/claude
RUN chmod +x /usr/local/bin/claude

COPY ops /repo/ops
COPY bin /repo/bin
# install.sh + config templates: the channel-kind tests run `install.sh --only
# config` in an isolated fake runtime root (never touches a real machine).
COPY install.sh /repo/install.sh
COPY config /repo/config

# @ka/core CLI bundles the distill-bg tests need, placed at the runtime layout
# path (core-cli/) that distill-bg.sh + distill-bg-worker.sh probe first.
# Built on the host by run.sh (tsup → standalone node bundles).
COPY packages/core/dist/jsonl-reader-cli.js /repo/core-cli/jsonl-reader-cli.js
COPY packages/core/dist/distill-result-parser-cli.js /repo/core-cli/distill-result-parser-cli.js
# The bundles are ES modules (@ka/core is "type":"module"); mark this dir so
# node treats the .js as ESM instead of CommonJS.
RUN printf '{"type":"module"}\n' > /repo/core-cli/package.json

ENV OPS_DIR=/repo/ops \
    REPO_ROOT=/repo \
    KA_REPO_ROOT=/repo \
    TMUX_TMPDIR=/tmp/tmux-test \
    HOME=/root

RUN mkdir -p /tmp/tmux-test && chmod 700 /tmp/tmux-test

ENTRYPOINT ["/bin/bash", "/repo/ops/tests/entrypoint.sh"]
