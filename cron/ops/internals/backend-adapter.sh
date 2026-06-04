#!/bin/bash
# backend-adapter.sh — dispatch cron operations to the OS-native backend.
#
# Phase 1: macOS/launchd only. Linux/systemd is stubbed and errors out with a
# clear message. The adapter is sourced by ka cron subcommands.
#
# Backend API (every backend must implement these):
#   backend::name                      → echoes "launchd" | "systemd"
#   backend::plist_path <name>         → echoes full unit path
#   backend::install <name> <plist>    → moves plist into place + bootstrap
#   backend::uninstall <name>          → bootout + rm
#   backend::list_installed            → echo names of installed ka cron units
#   backend::is_loaded <name>          → exit 0 if loaded, 1 otherwise

set -euo pipefail

KA_CRON_LABEL_PREFIX="com.knowledge-assistant.ka.cron"

detect_backend() {
    # Explicit override (KA_CRON_BACKEND=crontab|launchd|systemd) for tests / WSL.
    if [ -n "${KA_CRON_BACKEND:-}" ]; then echo "$KA_CRON_BACKEND"; return; fi
    case "$(uname -s)" in
        Darwin) echo "launchd" ;;
        Linux)  echo "crontab" ;;   # Linux/WSL: crontab backend（systemd 双路是 future）
        *)      echo "unknown" ;;
    esac
}

load_backend() {
    local be="${1:-$(detect_backend)}"
    case "$be" in
        launchd)
            # --- launchd impl (inline) ---
            backend::name() { echo "launchd"; }
            backend::plist_path() {
                printf '%s/Library/LaunchAgents/%s.%s.plist\n' \
                    "$HOME" "$KA_CRON_LABEL_PREFIX" "$1"
            }
            backend::install() {
                local name="$1" plist_src="$2"
                local dst; dst="$(backend::plist_path "$name")"
                mkdir -p "$(dirname "$dst")"
                cp "$plist_src" "$dst"
                local label="${KA_CRON_LABEL_PREFIX}.${name}"
                # bootout before bootstrap to make it idempotent (ignore error if not loaded)
                launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || true
                launchctl bootstrap "gui/$(id -u)" "$dst"
            }
            backend::uninstall() {
                local name="$1"
                local dst; dst="$(backend::plist_path "$name")"
                local label="${KA_CRON_LABEL_PREFIX}.${name}"
                launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || true
                rm -f "$dst"
            }
            backend::list_installed() {
                local dir="$HOME/Library/LaunchAgents"
                [ -d "$dir" ] || return 0
                # shellcheck disable=SC2012
                ls "$dir" 2>/dev/null | awk -v pfx="$KA_CRON_LABEL_PREFIX." '
                    $0 ~ "^" pfx {
                        n = $0
                        sub("^" pfx, "", n)
                        sub(/\.plist$/, "", n)
                        if (n != "") print n
                    }'
            }
            backend::is_loaded() {
                local name="$1"
                local label="${KA_CRON_LABEL_PREFIX}.${name}"
                launchctl print "gui/$(id -u)/$label" >/dev/null 2>&1
            }
            ;;
        crontab)
            # Linux/WSL: a single per-user crontab table. Each job = one line tagged
            # `# ka-cron:<name>` (idempotent upsert by marker). The install flow's
            # plist is ignored — we build the line from KA_CRON_* it exports.
            backend::name() { echo "crontab"; }
            # plist_path only feeds the install flow's cmp pre-check; return a
            # sentinel (never a file) so it skips cmp → calls install (idempotent).
            backend::plist_path() { printf '(crontab:%s)\n' "$1"; }
            # schedule string → 5-field crontab expr (natural forms + cron pass-through).
            _ka_crontab_expr() {
                python3 - "$1" <<'PY'
import sys, re
s = sys.argv[1].strip()
def out(e): print(e); sys.exit(0)
m = re.fullmatch(r'every\s+(\d+)\s*m(?:in)?', s)
if m: out(f"*/{int(m.group(1))} * * * *")
m = re.fullmatch(r'every\s+(\d+)\s*h(?:our)?s?', s)
if m: out(f"0 */{int(m.group(1))} * * *")
m = re.fullmatch(r'daily\s+(\d{1,2}):(\d{2})', s)
if m: out(f"{int(m.group(2))} {int(m.group(1))} * * *")
m = re.fullmatch(r'hourly\s+:(\d{1,2})', s)
if m: out(f"{int(m.group(1))} * * * *")
if len(s.split()) == 5: out(s)
sys.stderr.write(f"unsupported schedule for crontab: {s}\n"); sys.exit(2)
PY
            }
            backend::install() {
                local name="$1"   # $2 (plist tmpfile) intentionally ignored
                local expr; expr="$(_ka_crontab_expr "${KA_CRON_SCHEDULE:-}")" \
                    || { echo "ka cron: cannot map schedule '${KA_CRON_SCHEDULE:-}' to crontab" >&2; return 1; }
                local runner="${KA_ROOT:?KA_ROOT required}/cron/ops/cron-run.sh"
                local logf="${KA_CRON_LOG:-/tmp/ka-cron-${name}.log}"
                local line="${expr} /bin/bash ${runner} ${name} >> ${logf} 2>&1 # ka-cron:${name}"
                local cur; cur="$(crontab -l 2>/dev/null | grep -vE "# ka-cron:${name}\$" || true)"
                { [ -n "$cur" ] && printf '%s\n' "$cur"; printf '%s\n' "$line"; } | crontab -
            }
            backend::uninstall() {
                local name="$1"
                local cur; cur="$(crontab -l 2>/dev/null | grep -vE "# ka-cron:${name}\$" || true)"
                if [ -n "$cur" ]; then printf '%s\n' "$cur" | crontab -; else crontab -r 2>/dev/null || true; fi
            }
            backend::list_installed() {
                crontab -l 2>/dev/null | sed -n 's/.*# ka-cron:\([A-Za-z0-9_-]*\)$/\1/p'
            }
            backend::is_loaded() {
                crontab -l 2>/dev/null | grep -qE "# ka-cron:$1\$"
            }
            ;;
        systemd)
            backend::name() { echo "systemd"; }
            backend::plist_path() { printf '%s/.config/systemd/user/ka-cron-%s.timer\n' "$HOME" "$1"; }
            backend::install()   { echo "ka cron: systemd backend not implemented (use KA_CRON_BACKEND=crontab)" >&2; return 1; }
            backend::uninstall() { echo "ka cron: systemd backend not implemented" >&2; return 1; }
            backend::list_installed() { return 0; }
            backend::is_loaded() { return 1; }
            ;;
        *)
            echo "ka cron: unsupported platform ($(uname -s))" >&2
            return 1
            ;;
    esac
}
