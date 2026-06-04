#!/bin/bash
# ka cron — dispatcher for cron subcommands.
#
# Subcommands:
#   list      show all jobs from cron.yaml with status
#   add       --name N --schedule S --kind K --command C [--description D]
#             [--target-pane P] [--env K=V] [--disabled]
#   remove    <name>
#   enable    <name>
#   disable   <name>
#   run       <name>            — trigger immediately, foreground
#   install   [--dry-run]       — sync yaml → OS units (idempotent)
#   uninstall                   — remove all ka cron units from OS (yaml intact)
#   import                      — import legacy com.knowledge-assistant.ka.{kb-distill,daily-brief}.plist
#   status                      — one-line summary for ka status

set -euo pipefail

KA_REPO_ROOT="${KA_REPO_ROOT:-$(_d="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; until [ -e "$_d/bin/ka" ] || [ "$_d" = / ]; do _d="$(dirname "$_d")"; done; printf %s "$_d")}"
source "$KA_REPO_ROOT/ops/cli/common.sh"

SUB="${1:-help}"
[ $# -gt 0 ] && shift || true

case "$SUB" in
    list|add|remove|enable|disable|run|install|uninstall|import|status)
        exec "$KA_CRON_DIR/${SUB}.sh" "$@"
        ;;
    -h|--help|help|'')
        cat <<'EOF'
ka cron — manage KA's declarative cron jobs (~/.knowledge-assistant/cron.yaml)

USAGE
    ka cron <subcommand> [args]

SUBCOMMANDS
    list                        Show all jobs with schedule / kind / last-run / status
    add --name N --schedule S --kind K --command C [opts]
                                Add a job (also installs unless --disabled)
    remove <name>               Remove a job from yaml + uninstall OS unit
    enable  <name>              Mark enabled + install
    disable <name>              Mark disabled + uninstall (yaml kept)
    run <name>                  Trigger a job immediately (foreground, for debugging)
    install [--dry-run]         Sync yaml → OS (idempotent; fixes drift)
    uninstall                   Remove all ka cron units from OS (yaml intact)
    import                      Import legacy com.knowledge-assistant.ka.{kb-distill,daily-brief}.plist
    status                      One-line health used by `ka status`

EXAMPLES
    ka cron list
    ka cron add --name backup --schedule "0 3 * * *" --kind shell --command 'tar czf ~/b.tgz ~/.knowledge-assistant'
    ka cron disable daily-brief
    ka cron run kb-distill

See docs/KA_CRON_DESIGN.md for full design.
EOF
        ;;
    *)
        echo "ka cron: unknown subcommand '$SUB' (try 'ka cron help')" >&2
        exit 2
        ;;
esac
