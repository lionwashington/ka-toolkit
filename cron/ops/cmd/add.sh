#!/bin/bash
# ka cron add — append a job to cron.yaml and install.
set -euo pipefail
THIS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_common.sh
source "$THIS_DIR/_common.sh"

NAME=""; SCHEDULE=""; KIND="shell"; COMMAND_STR=""
DESCRIPTION=""; ENABLED="true"
declare -a EXTRA=()
declare -a ENVS=()

while [ $# -gt 0 ]; do
    case "$1" in
        --name)         NAME="$2"; shift 2 ;;
        --schedule)     SCHEDULE="$2"; shift 2 ;;
        --kind)         KIND="$2"; shift 2 ;;
        --command)      COMMAND_STR="$2"; shift 2 ;;
        --description)  DESCRIPTION="$2"; shift 2 ;;
        --env)          ENVS+=("$2"); shift 2 ;;
        --disabled)     ENABLED="false"; shift ;;
        --enabled)      ENABLED="true"; shift ;;
        -h|--help)
            cat <<'EOF'
ka cron add --name N --schedule S --kind K --command C [opts]

Required:
  --name N           Unique kebab-case identifier
  --schedule S       "every 2h" | "daily 07:00" | "0 3 * * *"
  --kind K           shell | inject-prompt | ka-cli
  --command C        Command or slash-command to run

Optional:
  --description D
  --env KEY=VAL      May repeat
  --disabled         Add but don't install
EOF
            exit 0
            ;;
        *) echo "ka cron add: unknown flag '$1'" >&2; exit 2 ;;
    esac
done

[ -n "$NAME" ]        || { echo "ka cron add: --name required" >&2; exit 2; }
[ -n "$SCHEDULE" ]    || { echo "ka cron add: --schedule required" >&2; exit 2; }
[ -n "$COMMAND_STR" ] || { echo "ka cron add: --command required" >&2; exit 2; }

case "$KIND" in
    shell|inject-prompt|ka-cli) ;;
    *) echo "ka cron add: invalid --kind '$KIND' (shell|inject-prompt|ka-cli)" >&2; exit 2 ;;
esac

# Validate schedule BEFORE mutating yaml
if ! bash "$CRON_SCHED_PARSE" "$SCHEDULE" >/dev/null 2>&1; then
    echo "ka cron add: invalid --schedule '$SCHEDULE'" >&2
    bash "$CRON_SCHED_PARSE" "$SCHEDULE" >/dev/null
    exit 2
fi

cron_yaml_init
cron_load_jobs
if cron_job_exists "$NAME"; then
    log_info "job '$NAME' already exists — re-installing (idempotent)"
    # For idempotency we rewrite the schedule/kind/command via set_field, but
    # simpler: bail if signature differs, otherwise just reinstall below.
else
    EXTRA=()
    [ -n "$DESCRIPTION" ] && EXTRA+=("description=$DESCRIPTION")
    [ "$ENABLED" = "false" ] && EXTRA+=("enabled=false")
    for kv in "${ENVS[@]+"${ENVS[@]}"}"; do
        k="${kv%%=*}"; v="${kv#*=}"
        EXTRA+=("env_$k=$v")
    done
    cron_yaml_append_job "$NAME" "$SCHEDULE" "$KIND" "$COMMAND_STR" "${EXTRA[@]+"${EXTRA[@]}"}"
    log_ok "added '$NAME' to $CRON_YAML"
fi

# Install (unless explicitly disabled)
if [ "$ENABLED" = "false" ]; then
    log_info "job added as disabled — not installing"
    exit 0
fi

"$THIS_DIR/install.sh" --only "$NAME"
