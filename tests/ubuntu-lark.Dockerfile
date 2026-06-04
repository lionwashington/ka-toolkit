# Ubuntu/Debian verification image for "full ka + lark daemon on Linux".
# Mirrors a fresh Ubuntu install: Node 22 + pnpm + python3 + tmux + cron, repo
# source (node_modules excluded by .dockerignore → rebuilt Linux-native here).
#
# Build (context = repo root):
#   docker build -f ops/tests/ubuntu-lark.Dockerfile -t ka-lark-verify .
# Run verification:
#   docker run --rm ka-lark-verify
FROM node:22-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
        python3 git tmux cron procps curl util-linux ca-certificates \
    && rm -rf /var/lib/apt/lists/*

RUN corepack enable && corepack prepare pnpm@latest --activate

WORKDIR /repo
COPY . /repo
# Linux-native install (esbuild/sdk/express/grammy). pnpm 10 gates native build
# scripts (esbuild/better-sqlite3) behind approval → it exits non-zero on that gate
# even though packages ARE installed. Tolerate that, then explicitly rebuild esbuild
# to fetch its Linux binary (the only native dep the lark daemon build needs;
# better-sqlite3 belongs to the opennutrition MCP, out of scope for lark verify).
RUN pnpm install --no-frozen-lockfile 2>&1 | tail -6 || true
RUN pnpm rebuild esbuild 2>&1 | tail -4 || true

ENTRYPOINT ["/bin/bash", "/repo/tests/verify-ubuntu-lark.sh"]
