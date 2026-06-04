#!/bin/bash
# cron/_common.sh — shared helpers for all ka cron subcommands.
# Sourced, not executed.

# shellcheck disable=SC2034
: "${KA_HOME:=$HOME/.knowledge-assistant}"
# shellcheck source=../common.sh
source "$KA_HOME/shared/ops/common.sh"
# shellcheck source=../../lib/cron/backend-adapter.sh
source "$KA_CRON_INTERNALS_DIR/backend-adapter.sh"

CRON_YAML_DEFAULT="$KA_CONFIG_DIR/cron.yaml"
CRON_YAML="${KA_CRON_CONFIG:-$CRON_YAML_DEFAULT}"

CRON_LOG_DIR="${KA_CRON_LOG_DIR:-$HOME/Library/Logs/knowledge-assistant/cron}"
CRON_PARSE="$KA_CRON_INTERNALS_DIR/parse-yaml.sh"
CRON_SCHED_PARSE="$KA_CRON_INTERNALS_DIR/schedule-parser.sh"
CRON_PLIST_GEN="$KA_CRON_INTERNALS_DIR/plist-gen.sh"
CRON_RUNNER="$KA_CRON_OPS_DIR/cron-run.sh"

cron_yaml_exists() { [ -f "$CRON_YAML" ]; }

cron_yaml_init() {
    # Idempotently create an empty-but-valid cron.yaml.
    if [ -f "$CRON_YAML" ]; then return 0; fi
    mkdir -p "$(dirname "$CRON_YAML")"
    cat > "$CRON_YAML" <<'EOF'
# ~/.knowledge-assistant/cron.yaml
# Declarative cron jobs. Managed by `ka cron`. Editable by hand.
# See docs/KA_CRON_DESIGN.md.

version: 1

defaults:
  enabled: true
  log_keep_mb: 20
  flock: per-name

jobs:
EOF
}

# Load all job records into global arrays. Bash 3.2 compatible (no assoc arrays).
# After calling:
#   CRON_JOB_NAMES[@]                  — ordered names
#   cron_job_field <name> <field>      — echoes field value (empty if absent)
CRON_JOB_NAMES=()
declare -a CRON_JOB_REC_KEYS=()
declare -a CRON_JOB_REC_VALS=()

cron_load_jobs() {
    CRON_JOB_NAMES=()
    CRON_JOB_REC_KEYS=()
    CRON_JOB_REC_VALS=()
    cron_yaml_exists || return 0
    local rec_kind a b c
    while IFS=$'\t' read -r rec_kind a b c; do
        [ -z "$rec_kind" ] && continue
        case "$rec_kind" in
            job)
                # track name set (ordered unique)
                local seen=0 n
                for n in "${CRON_JOB_NAMES[@]+"${CRON_JOB_NAMES[@]}"}"; do
                    [ "$n" = "$a" ] && { seen=1; break; }
                done
                [ "$seen" -eq 0 ] && CRON_JOB_NAMES+=("$a")
                CRON_JOB_REC_KEYS+=("$a|$b")
                CRON_JOB_REC_VALS+=("$c")
                ;;
        esac
    done < <(bash "$CRON_PARSE" "$CRON_YAML" 2>/dev/null)
}

cron_job_field() {
    local name="$1" field="$2" i
    local key="$name|$field"
    for i in "${!CRON_JOB_REC_KEYS[@]}"; do
        if [ "${CRON_JOB_REC_KEYS[$i]}" = "$key" ]; then
            printf '%s' "${CRON_JOB_REC_VALS[$i]}"
            return 0
        fi
    done
    return 1
}

cron_job_exists() {
    local name="$1" n
    for n in "${CRON_JOB_NAMES[@]+"${CRON_JOB_NAMES[@]}"}"; do
        [ "$n" = "$name" ] && return 0
    done
    return 1
}

cron_job_is_enabled() {
    local v; v="$(cron_job_field "$1" enabled || true)"
    case "$v" in
        ''|true|yes|1) return 0 ;;
        *) return 1 ;;
    esac
}

# Append a new job stanza to cron.yaml.
# Arguments come as "key=value" pairs; order: name schedule kind command [others]
cron_yaml_append_job() {
    local name="$1" schedule="$2" kind="$3" command="$4"
    shift 4
    cron_yaml_init

    {
        printf '  - name: %s\n' "$name"
        printf '    schedule: "%s"\n' "$schedule"
        printf '    kind: %s\n' "$kind"
        printf '    command: "%s"\n' "$(printf '%s' "$command" | sed 's/"/\\"/g')"
        local have_env=0
        for arg in "$@"; do
            local k="${arg%%=*}" v="${arg#*=}"
            case "$k" in
                description|target_pane|enabled|flock|log_keep_mb)
                    printf '    %s: "%s"\n' "$k" "$v"
                    ;;
                env_*)
                    if [ "$have_env" -eq 0 ]; then
                        printf '    env:\n'; have_env=1
                    fi
                    printf '      %s: "%s"\n' "${k#env_}" "$v"
                    ;;
            esac
        done
    } >> "$CRON_YAML"
}

# Rewrite cron.yaml with a job removed / replaced. Uses python for structural
# safety (the yaml schema is simple and rewriting by regex is fragile).
cron_yaml_rewrite() {
    local op="$1"     # remove | set_field
    local name="$2"
    local field="${3:-}"
    local value="${4:-}"
    cron_yaml_exists || return 0
    python3 - "$CRON_YAML" "$op" "$name" "$field" "$value" <<'PY'
import sys, re, io
path, op, name, field, value = sys.argv[1:6]
with open(path) as f:
    src = f.read()
lines = src.splitlines(keepends=True)

# Find each job's start line (index) and end line (next job start or section end)
out = []
i = 0
def is_job_start(s):
    return re.match(r'^\s{2}-\s+name:\s*(.+)$', s) is not None
def job_name(s):
    m = re.match(r'^\s{2}-\s+name:\s*(.+)$', s)
    v = m.group(1).strip()
    if len(v) >= 2 and ((v[0]==v[-1]=='"') or (v[0]==v[-1]=="'")):
        v = v[1:-1]
    return v
def is_new_section_or_job(s):
    if is_job_start(s): return True
    # top-level key like "defaults:" or "jobs:" with no leading spaces
    if re.match(r'^[a-zA-Z_]', s): return True
    return False

in_target = False
while i < len(lines):
    line = lines[i]
    if is_job_start(line):
        n = job_name(line)
        if n == name:
            # collect full block
            block = [line]
            j = i + 1
            while j < len(lines) and not is_new_section_or_job(lines[j]):
                block.append(lines[j])
                j += 1
            if op == 'remove':
                # drop block
                pass
            elif op == 'set_field':
                # ensure field appears with new value; replace existing or append
                # detect current field line with 4-space indent
                new_block = [block[0]]
                replaced = False
                pat = re.compile(rf'^\s{{4}}{re.escape(field)}:\s*.*$')
                env_pat = re.compile(r'^\s{4}env:\s*$')
                in_env = False
                for b in block[1:]:
                    if env_pat.match(b):
                        in_env = True
                        new_block.append(b); continue
                    if in_env and re.match(r'^\s{6}', b):
                        new_block.append(b); continue
                    if in_env:
                        in_env = False
                    if pat.match(b):
                        new_block.append(f'    {field}: "{value}"\n')
                        replaced = True
                    else:
                        new_block.append(b)
                if not replaced:
                    # Insert before the first non-name, non-field known slot (append at end ok)
                    new_block.append(f'    {field}: "{value}"\n')
                out.extend(new_block)
            i = j
            continue
    out.append(line)
    i += 1

# Handle "jobs: []" when removing the last job — leave as-is
with open(path, 'w') as f:
    f.writelines(out)
PY
}
