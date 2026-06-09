# ops/

Operational plumbing for the Knowledge Assistant **workshop** — a set of
independent Claude Code (CC) processes, each running in its own tmux pane + cwd,
talking to the owner and to each other through the **telegram-channel daemon**.

Everything here is driven by the `ka` CLI (`shared/bin/ka` → each part's `*/ops/*.sh`). The
canonical entry point is `ka workshop`. The whole tree is deployed to
`~/.knowledge-assistant/runtime/` by the top-level `install.sh`.

## What lives here

| Path                          | Purpose                                                                          |
| ----------------------------- | -------------------------------------------------------------------------------- |
| `cli/workshop.sh`             | Single entry for `ka workshop` (`start` / `stop` / `restart` / `spawn-mates`).   |
| `cli/daemon.sh`               | `ka channel` (`start`/`stop`/`restart`/`status`/`config`) — the channel daemon (internal script keeps the daemon.sh name). |
| `cli/status.sh`               | `ka status` — <1s health summary (config / session / mates / daemon).            |
| `cli/doctor.sh`               | `ka doctor` — deeper consistency diagnostics + fix hints (incl. daemon connection coverage: online panes vs who's actually connected to the channel / kb daemons). |
| `cli/wait-ready.sh`           | Internal: poll a tmux pane until its CC runtime is idle-ready (not a `ka` verb). |
| `cli/cron.sh` + `cli/cron/`   | `ka cron` — declarative cron (list/add/remove/enable/disable/run/install/…).     |
| `kb/distill-bg.sh`           | `ka distill` — spawn a headless `/kb distill` worker.               |
| `kb/distill-status.sh`       | `ka distill status` — state of the last/current background distill.             |
| `cli/help.sh`                 | `ka help`.                                                                       |
| `cli/common.sh`               | Shared helpers (logging, glyphs, config resolution) sourced by every subcommand. |
| `lib/start-pane.sh`           | A pane's first process — validates cwd, loads env, binds channel, execs claude.  |
| `lib/yaml-parse.sh`           | Minimal YAML parser (python3) — flattens `workshop.yaml` to tab records.         |
| `lib/yaml-upsert-mate.py`     | Text-preserving upsert of a mate into `workshop.yaml` (used by `spawn-mates`).   |
| `lib/tmux-helpers.sh`         | Shared tmux shell helpers (incl. `tmux_pane_for_channel` — find a pane by `@ka_channel`). |
| `lib/inject-prompt.sh`        | Send a prompt + Enter into an explicit target pane (used by the cron `inject-prompt` kind). |
| `lib/runtimes/cc/`            | The CC runtime adapter (`launch.sh` / `ready-signals.sh` / `send-prompt.sh`).    |
| `lib/runtimes/dispatch.sh`    | Runtime-adapter loader (`runtime_load <name>`); only `cc` is implemented.         |
| `lib/cron/`                   | Cron internals — yaml parse, schedule parse, plist gen, backend adapter.         |
| `scripts/cron-run.sh`         | Unified trigger entrypoint launchd invokes for each cron job.                    |
| `panes/<name>.env`            | Optional per-pane env file; sourced by `start-pane.sh`.                          |
| `workshop.example.yaml`       | Template — copy to `~/.knowledge-assistant/workshop.yaml`.                       |
| `tests/`                      | Docker-based integration tests — never touches your live session.                |

## Quick start

```bash
mkdir -p ~/.knowledge-assistant
cp ops/workshop.example.yaml ~/.knowledge-assistant/workshop.yaml
$EDITOR ~/.knowledge-assistant/workshop.yaml

# Validate without touching tmux (prints the planned tmux/daemon commands):
ka workshop --dry-run

# Bring the workshop up (split-pane layout, one screen):
ka workshop
tmux attach -t workshop

# Confirm health:
ka status
```

`ka workshop` reads `workshop.yaml`, warns if the channel daemon is down (it does
NOT start it — that's `ka channel start`), then launches each CC into its own tmux
pane (or window with `--window`). The owner routes from Telegram with `to <name>:`
(no prefix → `main`).

Config search order: `$OPS_CONFIG` → `~/.knowledge-assistant/workshop.yaml` →
`ops/workshop.example.yaml` (prints a warning; template only).

### Agent schema

Every agent — the lead and the mates — is one entry under a single `mates:`
list. The lead is the entry marked `main: true`.

```yaml
session: workshop
runtime: cc                # top-level default agent runtime; omit to accept cc.
                           # codex / gemini are reserved names — only cc is built.
mates:
  - name: main
    cwd: ~/workspace/<lead-project>
    main: true             # the lead — bound to the daemon's "main" channel
                           # (the no-prefix Telegram routing target)
  - name: ka-dev2
    cwd: ~/workspace/<mate-project>
    description: project dev/maintenance
  - name: story-maker
    cwd: ~/temp/books
    default: false         # skipped by `ka workshop`; needs --all / --only / start <name>
```

Per-entry keys: `name` / `cwd` / `args` / `description` / `main` (default
**false**) / `default` (default **true**). Exactly one entry sets `main: true`
— it binds to the daemon's `main` channel (no Telegram plugin; all Telegram I/O
goes through the daemon, see below). Every other entry is a mate; each mate's
`name` is sanitized into its own daemon channel.

> Migrating from the legacy two-section schema (`panes:` + `telegram: true`)?
> Run `workshop/ops/migrate-workshop-yaml.py <workshop.yaml>` — it folds `panes:` into
> `mates:` and rewrites `telegram: true` → `main: true` (data-preserving).

## telegram-channel daemon (not a plugin)

All CC↔owner and CC↔CC communication goes through a single long-lived
**telegram-channel daemon** — a node process exposing MCP-over-HTTP on
`127.0.0.1:9877` (override with `KA_CHANNEL_PORT`). It is **not** the retired CC
Telegram plugin.

- **owner → CC**: route in Telegram with `to <name>:` / `to <number>:`
  (no prefix → `main`).
- **CC → owner**: the `reply` tool (back to Telegram).
- **CC → CC**: the `send_to_channel` tool (cc2cc), target = the other channel.

The bot token lives **only** in the daemon; no CC process ever touches it.
`start-pane.sh` binds each pane to its channel by registering a project-local
`telegram-channel` MCP server pointing at `…/mcp?name=$KA_CHANNEL`. `ka workshop`
does NOT manage the daemon (it only warns if it's down); daemon lifecycle is
`ka channel start|stop|restart|status|config`. Full design:
`docs/channels/telegram/ARCHITECTURE.md`. Live state: the `/telegram-channel` skill.

## Three-layer cwd guarantee

Each CC must start in the right project so its cwd-local config (channel
registration, `.claude/settings.json`) applies. Three layers enforce this:

1. **tmux native** — `ka workshop` passes `-c "$cwd"` to `new-session` /
   `split-window` / `new-window`, setting the pane's cwd before any shell spawns.
2. **start-pane.sh** — the pane's first process checks `$PWD` against the
   expected cwd; if it drifted it `cd`s back, or drops to a shell with a loud
   warning if the dir is unreachable.
3. **Verify** — `ka doctor` cross-checks each pane's `#{pane_current_path}` and
   channel uniqueness against config, flagging drift with fix hints.

## Safety

`ka workshop` refuses to (re)build the `workshop` session while you're attached
to it (detach with `Ctrl-b d`, or run from outside tmux, or use `--dry-run`).
Destructive scenarios (existing session, restart
loops, corrupt config) are covered by `tests/` — a Docker harness that
simulates tmux + multi-pane Claude and **never touches your live workshop
session**.

## Env overrides

| Variable           | Default                                  | Effect                                            |
| ------------------ | ---------------------------------------- | ------------------------------------------------- |
| `OPS_CONFIG`       | `~/.knowledge-assistant/workshop.yaml`   | Alternative workshop config path.                 |
| `KA_CHANNEL_PORT`  | `9877`                                   | telegram-channel daemon port.                     |
| `DRY_RUN`          | `0`                                      | `1` = print tmux/daemon commands instead of running. |
| `TMUX_BIN`         | `$(command -v tmux)`                     | Override the tmux binary.                         |
| `NO_COLOR`         | (unset)                                  | Non-empty disables ANSI colors.                   |

## Scheduled triggers

Scheduled jobs are declared in `~/.knowledge-assistant/cron.yaml` and managed via
`ka cron` (`add` / `remove` / `enable` / `disable` / `install` / `list` / …),
which syncs the yaml to the OS scheduler (macOS launchd plists). At fire time
launchd invokes `cron/ops/cron-run.sh <name>`, which resolves the job, takes a
per-name flock, and runs it by `kind`: `shell`, `inject-prompt` (sends a prompt
into a CC pane), or `ka-cli`. Full design: `docs/KA_CRON_DESIGN.md`.

## Deploy

`ops/` is not run from the repo in production. The top-level `install.sh` copies
it (and the daemon, MCP servers, hooks, core-cli, skills) into
`~/.knowledge-assistant/runtime/`:

```bash
./install.sh --dry-run            # preview; confirm it only touches your target
./install.sh --only ka            # deploy just the ka CLI + ops/ copy
```

Per the design/runtime separation rule, runtime artifacts are produced **only**
by `install.sh` — never hand-edited. To change runtime behavior: edit the source
under `ops/` (design side), then `./install.sh --only <component>`.
