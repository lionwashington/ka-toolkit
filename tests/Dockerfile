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

# Build context is the REPO ROOT. /repo mirrors the by-part monorepo layout and
# KA_HOME is set to /repo (below), so the ka scripts resolve everything from
# KA_HOME exactly the way the deployed runtime does — same path, same mechanism.
WORKDIR /repo

# Fake `claude` binary on PATH — logs stdin and blocks.
COPY tests/fakes/claude /usr/local/bin/claude
RUN chmod +x /usr/local/bin/claude

# The four functional parts' sh trees (TS packages are not needed by the ops suite,
# so for kb/channels we copy only their ops/ subtree).
COPY shared /repo/shared
COPY workshop /repo/workshop
COPY cron /repo/cron
COPY channels/ops /repo/channels/ops
COPY kb/ops /repo/kb/ops
COPY tests /repo/tests
# install.sh + config templates: the channel-kind tests run `install.sh --only
# config` in an isolated fake runtime root (never touches a real machine).
COPY install.sh /repo/install.sh
COPY config /repo/config
# Bootstrap marker — every ka script walks up to find it (= repo/runtime root).

# @ka/core CLI bundles the distill-bg tests need, placed at the runtime layout
# path (core-cli/) that distill-bg.sh + distill-bg-worker.sh probe first.
# Built on the host by run.sh (tsup → standalone node bundles).
COPY kb/core/dist/jsonl-reader-cli.js /repo/core-cli/jsonl-reader-cli.js
COPY kb/core/dist/distill-result-parser-cli.js /repo/core-cli/distill-result-parser-cli.js
# The bundles are ES modules (@ka/core is "type":"module"); mark this dir so
# node treats the .js as ESM instead of CommonJS.
RUN printf '{"type":"module"}\n' > /repo/core-cli/package.json

ENV KA_HOME=/repo \
    TMUX_TMPDIR=/tmp/tmux-test \
    HOME=/root

RUN mkdir -p /tmp/tmux-test && chmod 700 /tmp/tmux-test

ENTRYPOINT ["/bin/bash", "/repo/tests/entrypoint.sh"]
