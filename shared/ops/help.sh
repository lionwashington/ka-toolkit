#!/bin/bash
# ka help — print usage.
set -euo pipefail

cat <<'EOF'
ka — Knowledge Assistant CLI

USAGE
    ka <command> [args]

COMMANDS
    workshop        Manage the workshop — independent CC processes, each in its
                    own tmux pane + cwd, talking to you via the channel daemon
                    (route with 'to <name>:' in Telegram). Does NOT manage the
                    daemon (that's `ka channel`); only warns if it's down. Verbs:
                      ka workshop [--pane|--window]
                          Start every mate with default=true (default layout:
                          pane / split-screen; --window = one window per CC).
                      ka workshop start [<name>]
                          No name: start all default=true. <name>: start one
                          declared mate (already running → just report).
                      ka workshop stop [<name>]
                          No name: stop the whole workshop. <name>: stop one pane.
                      ka workshop restart [<name>]
                          No name: restart the WHOLE workshop (stop all → start
                          all; run from a plain terminal). <name>: restart one pane.
                      ka workshop spawn-mates <name> [<workdir>]
                          With <workdir>: register the mate into workshop.yaml
                          (default=false) and launch it. Without: alias for
                          `start <name>`. Already running → left untouched.
                    Flags: --dry-run, --all, --only NAME[,...], --skip-daemon
    channel         Operate on the channel daemon (telegram|lark, from config.yaml
                    channel_kind; port from channels.<kind>.port). Verbs:
                      ka channel start | stop | restart | status | config
                    `restart` re-adopts every CC automatically (~2s blip);
                    `config` opens config.yaml + secrets.yaml in $EDITOR.
    kb              Knowledge-base subsystem. Verbs:
                      ka kb start | stop | restart | status
                          The shared LanceDB retrieval daemon (kb_search backend,
                          port 7705) — the 2nd resident daemon; shown by status/doctor.
                      ka kb reindex [--full]
                          (Re)build the kb_search index (incremental | full).
                      ka kb distill [status]
                          Spawn a background runtime-selected /kb distill worker; `status` shows
                          the last run. Full form:
                          ka kb distill --jsonl <abs path> [--session-id <uuid>] [--dry-run]
    status          Print a <1s health summary (tmux / channel + kb daemons / mates).
    doctor          Deeper consistency diagnostics + fix hints (channel + kb daemons /
                    channel uniqueness / pane cwd / mates / cron). Exit 1 if issues found.
    cron            Manage declarative cron jobs (~/.knowledge-assistant/cron.yaml).
                    Subcommands: list, add, remove, enable, disable, run,
                                 install, uninstall, import, status. See `ka cron help`.
    help, -h        Show this help.

ENVIRONMENT
    OPS_CONFIG       Override workshop.yaml path (default: ~/.knowledge-assistant/workshop.yaml)
    NO_COLOR=1       Disable ANSI colors in output.

    The daemon kind + port are NOT env vars — they come from config.yaml
    channel_kind and channels.<kind>.port (set the kind with
    ./install.sh --channel-kind=telegram|lark).

DESIGN
    docs/KA_CLI_USAGE.md   (full ka command manual: workshop verbs, channel, kb, cron, doctor)
    docs/ARCHITECTURE.md   (as-built architecture: daemon + workshop, design/runtime boundary)

EXAMPLES
    ka workshop                            # bring the workshop up (split-pane)
    ka workshop spawn-mates dev2 ~/work/x  # register + launch a new mate
    ka workshop stop dev2                  # stop one mate
    ka workshop restart                    # reset the whole workshop cleanly
    ka channel status                      # is the channel daemon up?
    ka channel restart                     # reload the channel daemon (CCs re-adopt)
    ka kb status                           # is the kb retrieval daemon up?
    ka status                              # quick health check (both daemons)
EOF
