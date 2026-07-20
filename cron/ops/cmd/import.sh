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
BACKUP_DIR="$KA_STATE_DIR/legacy-plist-backup"
mkdir -p "$BACKUP_DIR"

# Map of known legacy jobs → (schedule, kind, command, target_pane)
legacy_map() {
    case "$1" in
        kb-distill)   echo "every 2h|ka-cli|kb distill --background|" ;;
        daily-brief)  echo "daily 07:00|inject-prompt|/daily-brief|main" ;;
        *)            return 1 ;;
    esac
}

cron_yaml_init
cron_load_jobs

found=0
imported=0
migrated=0

# Early cron generations represented KB maintenance as a prompt injected into
# an online Workshop pane. Migrate that existing YAML entry in place even when
# the legacy plist was already removed; otherwise repeated `ka cron import`
# can never repair the stale job.
if cron_job_exists "kb-distill"; then
    old_kind="$(cron_job_field "kb-distill" kind || true)"
    old_cmd="$(cron_job_field "kb-distill" command || true)"
    if [ "$old_kind" = "inject-prompt" ] && [ "$old_cmd" = "/kb distill" ]; then
        CRON_YAML_PATH="$CRON_YAML" python3 - <<'PY'
import os

path = os.environ["CRON_YAML_PATH"]
lines = open(path).read().splitlines()
inside = False
for index, line in enumerate(lines):
    stripped = line.strip()
    if stripped == "- name: kb-distill":
        inside = True
        continue
    if inside and stripped.startswith("- name:"):
        inside = False
    if not inside:
        continue
    indent = line[:len(line) - len(line.lstrip())]
    if stripped.startswith("kind:"):
        lines[index] = f"{indent}kind: ka-cli"
    elif stripped.startswith("command:"):
        lines[index] = f'{indent}command: "kb distill --background"'
with open(path, "w") as output:
    output.write("\n".join(lines) + "\n")
PY
        migrated=$((migrated + 1))
        cron_load_jobs
        log_ok "kb-distill: migrated inject-prompt to direct ka-cli execution"
    fi
fi

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

if [ "$found" -eq 0 ] && [ "$migrated" -eq 0 ]; then
    log_info "no legacy plists to import"
    exit 0
fi

# Reinstall with new cron.* labels
"$THIS_DIR/install.sh"
log_ok "import complete: $imported new entries, $migrated existing entries migrated, $found legacy plists processed"
