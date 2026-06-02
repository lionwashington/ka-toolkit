#!/bin/bash
# ka help — print usage.
set -euo pipefail

cat <<'EOF'
ka — Knowledge Assistant CLI

USAGE
    ka <command> [args]

COMMANDS
    workshop        Manage the workshop — independent CC processes, each in its
                    own tmux pane + cwd, talking to you via the telegram-channel
                    daemon (route with 'to <name>:' in Telegram). Verbs:
                      ka workshop [--pane|--window] [--restart-daemon]
                          Start every mate with default=true (default layout:
                          pane / split-screen; --window = one window per CC).
                      ka workshop start [<name>]
                          No name: start all default=true. <name>: start one
                          declared mate (already running → just report).
                      ka workshop stop [<name>]
                          No name: stop the whole workshop. <name>: stop one pane.
                      ka workshop spawn-mates <name> [<workdir>]
                          With <workdir>: register the mate into workshop.yaml
                          (default=false) and launch it. Without: alias for
                          `start <name>`. Already running → left untouched.
                    Flags: --dry-run, --all, --only NAME[,...], --skip-daemon,
                           --restart-daemon (redeploy + restart the daemon, then
                           clean-relaunch every CC; refused from inside the
                           session — detach and run from a plain terminal).
    start           Retired → forwards to `ka workshop`.
    stop            Retired → forwards to `ka workshop stop`.
    spawn-mates     Retired → forwards to `ka workshop spawn-mates`.
    restart         stop + short pause + start (via the workshop verb).
    status          Print a <1s health summary (tmux / telegram daemon / mates).
    doctor          Deeper consistency diagnostics + fix hints (daemon / channel
                    uniqueness / pane cwd / mates / cron). Exit 1 if issues found.
    wait-ready      Poll a tmux pane until its CC runtime is idle-ready.
                    Flags: --session NAME, --target PANE, --timeout SEC, --stable SEC
    cron            Manage declarative cron jobs (~/.knowledge-assistant/cron.yaml).
                    Subcommands: list, add, remove, enable, disable, run,
                                 install, uninstall, import, status. See `ka cron help`.
    distill         Spawn a background Opus /kb distill worker (snapshot-bound).
                    Required: --background --jsonl <abs path>
                    Optional: --session-id <uuid>, --dry-run
    distill-status  Show state of last/current background distill run.
                    Flags: --json
    help, -h        Show this help.

ENVIRONMENT
    OPS_CONFIG       Override workshop.yaml path (default: ~/.knowledge-assistant/workshop.yaml)
    KA_CHANNEL_PORT  telegram-channel daemon port (default 9877)
    NO_COLOR=1       Disable ANSI colors in output.

DESIGN
    docs/KA_CLI_USAGE.md   (full ka command manual: workshop verbs, cron, doctor)
    docs/ARCHITECTURE.md   (as-built architecture: daemon + workshop, design/runtime boundary)

EXAMPLES
    ka workshop                            # bring the workshop up (split-pane)
    ka workshop spawn-mates dev2 ~/work/x  # register + launch a new mate
    ka workshop stop dev2                  # stop one mate
    ka status                              # quick health check
    ka restart                             # something's off, reset cleanly
EOF
