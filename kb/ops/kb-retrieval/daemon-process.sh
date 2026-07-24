#!/bin/bash
# Shared, conservative KB daemon PID handling for start/stop supervision.
# Callers must set ROOT and KA_HOME before sourcing this file.

kb_pid_file() {
  printf '%s/state/kb-retrieval.pid\n' "$KA_HOME"
}

kb_validate_daemon_pid() {
  local pid="${1:-}" args
  case "$pid" in ''|*[!0-9]*) return 1 ;; esac
  kill -0 "$pid" 2>/dev/null || return 1
  args="$(ps -p "$pid" -o args= 2>/dev/null || true)"
  case "$args" in
    *"$ROOT/dist/daemon.mjs"*) printf '%s\n' "$pid"; return 0 ;;
    *) return 1 ;;
  esac
}

kb_daemon_pid() {
  local pid=""
  if command -v lsof >/dev/null 2>&1; then
    pid="$(lsof -nP -t -iTCP:"$1" -sTCP:LISTEN 2>/dev/null | head -n 1 || true)"
    [ -z "$pid" ] || { kb_validate_daemon_pid "$pid"; return; }
  fi
  pid="$(cat "$(kb_pid_file)" 2>/dev/null || true)"
  kb_validate_daemon_pid "$pid"
}

kb_pid_age_seconds() {
  local file mtime now
  file="$(kb_pid_file)"
  [ -f "$file" ] || { echo 0; return; }
  mtime="$(stat -c %Y "$file" 2>/dev/null || stat -f %m "$file" 2>/dev/null || echo 0)"
  now="$(date +%s)"
  case "$mtime" in ''|*[!0-9]*) echo 0 ;; *) echo $((now - mtime)) ;; esac
}

kb_wait_pid_exit() {
  local pid="$1" tenths="${2:-100}" i
  for i in $(seq 1 "$tenths"); do
    kill -0 "$pid" 2>/dev/null || return 0
    sleep 0.1
  done
  return 1
}

kb_stop_daemon_pid() {
  local pid
  pid="$(kb_validate_daemon_pid "$1")" || return 1
  kill -TERM "$pid" 2>/dev/null || true
  if ! kb_wait_pid_exit "$pid" "${KA_KB_STOP_GRACE_TENTHS:-100}"; then
    kill -KILL "$pid" 2>/dev/null || true
    kb_wait_pid_exit "$pid" 50 || return 1
  fi
}
