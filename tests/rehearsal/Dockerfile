# Rehearsal image for the gen3 live-switch migration (item f).
# Builds the full toolchain, installs+builds the repo, then rehearse.sh simulates
# an OLD (pre-gen3) deployed runtime under $HOME/.knowledge-assistant and runs the
# owner's 5-step migration end-to-end. Fully isolated — it is the container's own
# $HOME, never a real machine.
FROM node:22-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
        tmux python3 git build-essential curl ca-certificates procps util-linux jq \
    && rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack prepare pnpm@10 --activate

WORKDIR /src
COPY . /src

# Full workspace install + build. Native better-sqlite3 (opennutrition) has build
# tools available; if anything non-essential fails to build, the rehearsal does not
# depend on it (it validates ka/daemon/config/hooks/skills + switch), so `|| true`.
RUN pnpm install --no-frozen-lockfile 2>&1 | tail -5
RUN pnpm -r run build 2>&1 | tail -20 || true

CMD ["bash", "/src/tests/rehearsal/rehearse.sh"]
