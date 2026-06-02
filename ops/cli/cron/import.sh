#!/bin/bash
# ka cron import — import legacy com.knowledge-assistant.ka.{kb-distill,daily-brief}.plist into cron.yaml.
#
# Behaviour:
#   - Scan ~/Library/LaunchAgents/com.knowledge-assistant.ka.*.plist (EXCLUDING com.knowledge-assistant.ka.cron.*)
#   - For each known legacy name (kb-distill, daily-brief), append a yaml entry
#     if not already present, then uninstall the legacy plist and install
#     the new com.knowledge-assistant.ka.cron.<name>.plist via `ka cron install`.
#   - Legacy plists are moved to a backup dir, not deleted, so user can revert.

set -euo pipefail
THIS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_common.sh
source "$THIS_DIR/_common.sh"

load_backend

LA_DIR="$HOME/Library/LaunchAgents"
BACKUP_DIR="$HOME/.knowledge-assistant/state/legacy-plist-backup"
mkdir -p "$BACKUP_DIR"

# Map of known legacy jobs → (schedule, kind, command, target_pane)
legacy_map() {
    case "$1" in
        kb-distill)   echo "every 2h|inject-prompt|/kb distill|main" ;;
        daily-brief)  echo "daily 07:00|inject-prompt|/daily-brief|main" ;;
        *)            return 1 ;;
    esac
}

cron_yaml_init
cron_load_jobs

found=0
imported=0
for plist in "$LA_DIR"/com.knowledge-assistant.ka.*.plist; do
    [ -f "$plist" ] || continue
    base="$(basename "$plist" .plist)"
    # Skip new-style cron.* plists
    case "$base" in
        com.knowledge-assistant.ka.cron.*) continue ;;
    esac
    name="${base#com.knowledge-assistant.ka.}"
    info="$(legacy_map "$name" || true)"
    [ -z "$info" ] && { log_warn "unknown legacy plist: $name (skipping)"; continue; }
    found=$((found+1))

    IFS='|' read -r sched kind cmd tgt <<<"$info"

    if cron_job_exists "$name"; then
        log_dim "$name: already in cron.yaml — will reinstall"
    else
        cron_yaml_append_job "$name" "$sched" "$kind" "$cmd" "target_pane=$tgt"
        log_ok "$name: imported into cron.yaml"
        imported=$((imported+1))
    fi

    # Unload legacy plist (launchctl) and back up file
    label="com.knowledge-assistant.ka.${name}"
    launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || true
    mv -f "$plist" "$BACKUP_DIR/$(basename "$plist").$(date +%s).bak"
    log_dim "$name: legacy plist moved to $BACKUP_DIR"
done

if [ "$found" -eq 0 ]; then
    log_info "no legacy plists to import"
    exit 0
fi

# Reinstall with new cron.* labels
"$THIS_DIR/install.sh"
log_ok "import complete: $imported new entries, $found legacy plists processed"
