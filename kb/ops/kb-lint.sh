#!/bin/bash
# ka kb lint — read-only structural self-check of the knowledge base (Karpathy LLM-Wiki
# "lint" pillar). Five deterministic checks: dead wikilinks, orphan topics, INDEX drift,
# bad/invisible frontmatter, raw↔topic linkage. No LLM, no native deps — a thin node
# wrapper around the self-contained lint-cli bundle. Passes flags through (--json / --fix
# / --kb / --config). Exit codes: 0 clean · 1 warnings · 2 errors.
set -uo pipefail
: "${KA_HOME:=$HOME/.knowledge-assistant}"

LINT_CLI="$KA_HOME/kb/core/dist/lint-cli.js"
[ -f "$LINT_CLI" ] || { echo "ka kb lint: lint bundle missing — run './install.sh --only core-cli' (or 'pnpm --filter @ka/core build' in repo) ($LINT_CLI)" >&2; exit 2; }

exec node "$LINT_CLI" "$@"
