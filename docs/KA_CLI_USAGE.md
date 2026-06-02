# KA CLI User Manual

> This document is for **users** and is the single as-built manual for the `ka` command. Source of truth = `bin/ka` +
> `ops/cli/*.sh`; `ka help` is authoritative, and this doc is maintained in sync with it.

`ka` is the command-line entry point of Knowledge Assistant, used to:

- start/stop the **workshop** — a set of **mutually independent CC processes**, each running in its own tmux pane + its own
  cwd, conversing with the user through the **telegram-channel daemon**;
- run health diagnostics (`ka status` / `ka doctor`);
- manage declarative **cron** scheduled jobs (`ka cron`);
- trigger background knowledge-base distillation (`ka distill --background`).

> **mate = an independent CC process**, not a subagent inside CC. Each mate has an independent cwd, an independent
> `KA_CHANNEL`, and an independent process; they share no context. The pane / window layout is a purely visual choice.
> The user routes a message to a specific CC in Telegram with `to <name>:` or `to <number>:` (no prefix →
> `main`).

---

## Installation

`ka` is a standalone bash script — no compilation, no npm needed. Runtime deployment is handled by the top-level `install.sh`;
after deployment `ka` runs from `~/.knowledge-assistant/runtime/bin/ka`. In development you can symlink the
`bin/ka` from the repo directly:

```bash
# symlink into ~/.local/bin
ln -sf <repo>/bin/ka ~/.local/bin/ka

# confirm ~/.local/bin is on PATH
echo "$PATH" | tr ':' '\n' | grep -q "$HOME/.local/bin" \
    || echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zshrc
```

Verify:

```bash
ka help
```

> Dependencies: `bash ≥ 3.2` (the macOS default works), `tmux`, `curl`, `python3`, `node`.

---

## Quick start

```bash
ka workshop        # start the whole workshop (default split-pane layout, all on one screen)
ka status          # confirm overall: ✅ healthy
# …work as usual; the user routes to each CC from Telegram with `to <name>:`…
ka workshop stop   # wrap up
```

**Common-scenario cheat sheet**:

| Scenario | Command |
|---|---|
| Start all default mates (split-pane, one screen) | `ka workshop` |
| Start all default mates (one window per CC) | `ka workshop --window` |
| Start a single already-declared mate | `ka workshop start <name>` |
| Temporarily register and start a new mate | `ka workshop spawn-mates <name> <workdir>` |
| Stop the whole workshop | `ka workshop stop` |
| Stop a single mate | `ka workshop stop <name>` |
| Restart a single stuck mate | `ka workshop restart <name>` |
| Make daemon code changes take effect | `ka workshop --restart-daemon` (must be run outside the workshop) |
| Something feels off (<1s) | `ka status` |
| Deep consistency diagnostics | `ka doctor` |
| Soft-restart the whole workshop | `ka restart` |

---

## `ka workshop` — workshop lifecycle

`ka workshop` is the sole entry point for managing the workshop. It reads `workshop.yaml`, ensures the
telegram-channel daemon is running, then pulls each CC into its own tmux pane (or window).

```
ka workshop [<verb>] [<name> [<workdir>]] [flags]
```

**Verbs**:

| Form | Semantics |
|---|---|
| `ka workshop` (bare) | = `ka workshop start` (no name): start all `default=true` mates |
| `ka workshop start [<name>]` | no name → start all default mates; `<name>` → start a single **declared** mate (if already running, just report, don't rebuild). Pure launcher, won't register a new mate |
| `ka workshop stop [<name>]` | no name → stop the whole workshop (kill the session); `<name>` → stop only that pane |
| `ka workshop restart <name>` | restart a single mate's pane (stop that pane + re-start). ⚠️ See the warning below |
| `ka workshop spawn-mates <name> [<workdir>]` | with `<workdir>` → register and start; without → equivalent to `start <name>` |

**Flags** (shared by all verbs):

| Flag | Effect |
|---|---|
| `--dry-run` | only print the tmux / daemon commands that would run, don't actually create anything |
| `--all` | include optional mates with `default: false` |
| `--only NAME[,NAME...]` | start only the specified CCs (comma-separated) |
| `--skip-daemon` | don't ensure the daemon first (assume it's already running) |
| `--pane` | **default**: arrange all CCs as split-panes in **one window** (all on one screen) |
| `--window` | one independent window per CC (switch with `Ctrl-b 0/1/2/w`) |
| `--restart-daemon` | before starting, redeploy + restart the daemon, then clean-relaunch all CCs (see below) |

### Examples

```bash
# bring up the whole workshop (split-pane, one screen)
ka workshop

# one window per CC
ka workshop --window

# temporarily register and start a new mate (written into workshop.yaml, default=false)
ka workshop spawn-mates dev2 ~/work/x

# stop a mate
ka workshop stop dev2

# restart a stuck mate
ka workshop restart ka-dev2

# dry run: only print the commands, don't touch tmux
ka workshop --dry-run
```

### pane / window layout and isolation

The layout is a **purely visual choice** and does not affect isolation: whether pane or window, each CC still has its own cwd
(tmux `-c`), its own `KA_CHANNEL`, its own independent process, and zero cwd / context sharing.

- **pane (default)**: split-panes tiled into window 0, with the pane border labeled with each one's channel name. Idempotency
  is judged by each pane's `@ka_channel` user-option.
- **window**: one window per CC. Idempotency is judged by the window index.

### The dev-channels confirmation gate

When each new pane / window starts a CC, a dev-channels safety gate pops up (claude enforces it for `server:` channels,
with no bypass). The workshop **passes it automatically, condition-based** — it polls capture-pane and only sends Enter once it detects the gate's
text (not a timed blind send). In the rare case it doesn't auto-pass, attach and press Enter once manually.

### `ka workshop restart <name>` — ⚠️ loses runtime context

restart a single mate = stop that pane + re-start. **Restarting loses that CC's in-memory runtime context**
(`--resume` only restores the on-disk conversation history, not the in-memory working state).

> **If your channel merely dropped** (e.g. the CC went flat after a daemon restart and isn't receiving messages), **don't use
> restart** — in that CC's window, manually trigger one tool call to make it re-init, and you won't lose
> context (see `telegram-channel-design.md` A5). restart is only for when a CC is truly stuck / you need to change cwd /
> you need to clear state.

To restart the **whole** workshop use: `ka workshop stop && ka workshop`, or the top-level `ka restart`.

### `--restart-daemon` — make daemon code changes take effect

Use this when applying source changes to the telegram-channel daemon (inbound images / cleaning up zombie connections / typing, etc.). It will:
redeploy the server + restart the daemon → **kill the old session, freshly bring up all CCs** (clean
relaunch — CCs don't auto-reconnect to a restarted daemon, so merely restarting the daemon would leave dangling CCs).

🔴 **Must be run in a normal terminal after detaching**. Running it inside the workshop session is rejected (to prevent killing your own
channel):

```bash
# first Ctrl-b d to detach, then in a normal terminal:
ka workshop --restart-daemon --pane
```

---

## Top-level forwarding aliases

The three top-level commands below are forwarding aliases for historical muscle memory; they all forward to `ka workshop`:

| Top-level command | Equivalent to |
|---|---|
| `ka start` | `ka workshop` (start all default mates) |
| `ka stop` | `ka workshop stop` |
| `ka spawn-mates` | `ka workshop spawn-mates` |

Arguments are passed through verbatim. The canonical form is still `ka workshop <verb>`.

---

## `ka restart`

`stop` → `sleep 2` → `start`, all going through the `ka workshop` verb dispatcher.

```
ka restart [<workshop start flags>]
```

A non-zero return from `stop` only emits a warning; it doesn't block the subsequent start. When to use it: the workshop is stuck overall and you want a quick reset,
or `ka status` reports broken (the session died).

---

## telegram-channel daemon

All communication among the CCs in the workshop, and between a CC and the user, goes through a single
**single-process telegram-channel daemon** (MCP-over-HTTP, default port **9877**), **not** the old telegram
plugin. `ka workshop` automatically ensures the daemon is running at startup (unless `--skip-daemon`).

- **CC → CC**: the `send_to_channel` tool, target = the other party's channel.
- **CC → user**: the `reply` tool (replies to Telegram).
- **user → CC**: route in Telegram with `to <name>:` or `to <number>:`.

For the daemon's design, half-open connection diagnostics, and the A5 reconnect mechanism, see `telegram-channel-design.md` and
`telegram-channel-design.md` (§5). Daemon status can be viewed with the `/telegram-channel` skill.

---

## `ka status` — <1s health summary

Read-only, no side effects; each item is checked independently without fail-fast.

```
ka status
```

| Check | Data source | Failure level |
|---|---|---|
| config | `resolve_workshop_config` | degraded |
| runtime | the `runtime:` field of `workshop.yaml` (default cc) | informational only, doesn't change the exit code |
| session | `tmux has-session` | broken |
| mates | the `default=true` declared in `workshop.yaml` vs the actually-running `@ka_channel` panes (excluding main) | degraded |
| telegram | daemon liveness probe `http://127.0.0.1:9877/api/status` | degraded |

**Output example (healthy)**:

```
── ka status ──
  ✔ config:    ~/.knowledge-assistant/workshop.yaml
  ✔ runtime:   cc
  ✔ session:   workshop (4 panes)
  ✔ mates:     3 running (declared default: 3)
             - ka-dev2
             - freelancer
             - work-assistant
  ✔ telegram:  daemon up (port 9877)

 overall: ✅ healthy
```

**Exit codes**:

| Code | Meaning |
|---|---|
| `0` | healthy (all green) |
| `1` | degraded (the session is running, but some items failed) |
| `2` | broken (the session never started) |

**Troubleshooting reference**:

| Symptom | Next |
|---|---|
| `✖ session: workshop (not running)` | `ka workshop` |
| `⚠ telegram: daemon down` | `ka workshop` (auto-ensures the daemon), or manually run the daemon `start.sh` |
| `⚠ ... not running: <name>` | a declared mate isn't running → `ka workshop start <name>` |

---

## `ka doctor` — deep consistency diagnostics

Read-only; touches no tmux / daemon / files. Adds cross-cutting invariant checks beyond `ka status` and gives fix hints.

```
ka doctor
```

Checks:

1. **config** exists
2. whether **runtime** is cc (the only implemented adapter; codex/gemini are reserved names only)
3. whether the **telegram daemon** is up on port 9877
4. **session + per-pane invariants**:
   - **channel uniqueness** — two panes sharing one channel will cross-talk
   - whether each pane's cwd exists
5. **declared vs running**: are all `default=true` mates in the yaml actually running
6. **cron**: when `cron.yaml` exists, are the launchd plists installed

**Exit codes**: `0` all passed; `1` there are issues (warning or error).

---

## `ka cron` — declarative scheduled jobs

Declare scheduled jobs in `~/.knowledge-assistant/cron.yaml`, synced to the OS (macOS launchd).

```
ka cron <subcommand> [args]
```

| Subcommand | Effect |
|---|---|
| `list` | list all jobs (schedule / kind / last-run / status) |
| `add --name N --schedule S --kind K --command C [opts]` | add a job (also installs it unless `--disabled`) |
| `remove <name>` | delete from yaml + uninstall the OS unit |
| `enable <name>` / `disable <name>` | mark enabled / disabled and install / uninstall (yaml kept) |
| `run <name>` | trigger once in the foreground immediately (for debugging) |
| `install [--dry-run]` | sync yaml → OS units (idempotent, repairs drift) |
| `uninstall` | remove all ka cron units (yaml untouched) |
| `import` | import legacy `com.knowledge-assistant.ka.{kb-distill,daily-brief}.plist` |
| `status` | a one-line summary used by `ka status` |

`add` also supports `--description D` / `--target-pane P` / `--env K=V` / `--disabled`.

```bash
ka cron list
ka cron add --name backup --schedule "0 3 * * *" --kind shell \
    --command 'tar czf ~/b.tgz ~/.knowledge-assistant'
ka cron disable daily-brief
ka cron run kb-distill
```

For the full design see `KA_CRON_DESIGN.md`.

---

## `ka distill --background` — background knowledge-base distillation

Runs a background `/kb distill` inside a headless Opus claude process, returning immediately after spawning. Synchronous foreground distillation
is still inside the `/kb distill --foreground` skill (`ka distill` currently **only** supports `--background`).

```
ka distill --background --jsonl <abs path> [--session-id <uuid>] [--dry-run]
```

| Flag | Effect |
|---|---|
| `--jsonl <path>` | the absolute path to the session's `.jsonl` (required) |
| `--session-id <uuid>` | override (default derived from the jsonl filename) |
| `--dry-run` | print the plan but don't actually spawn |

**Snapshot protection**: before spawning, capture the jsonl's current byte size + the uuid of the last entry; the worker runs with
`--upper-offset <snapshot>` — messages appended after the snapshot are left for the next distillation, avoiding a race.

The worker state is written to `~/.knowledge-assistant/state/distill-current.json`, and each run also leaves a
`distill-<timestamp>.log`. Use `ka distill-status [--json]` to view the status of the last / current background distillation.
If a worker is already running, it refuses to start another.

---

## Environment variables

| Variable | Default | Effect |
|---|---|---|
| `OPS_CONFIG` | `~/.knowledge-assistant/workshop.yaml` | override the workshop config path |
| `KA_CHANNEL_PORT` | `9877` | telegram-channel daemon port |
| `TMUX_BIN` | `$(command -v tmux)` | specify the tmux binary (when multiple versions coexist) |
| `NO_COLOR` | unset | set to non-empty to disable ANSI colors |
| `DRY_RUN` | `0` | `1` is equivalent to `--dry-run` throughout |

---

## workshop.yaml

`workshop.yaml` declares the session name, panes (including main), and the list of mates:

```yaml
session: workshop
runtime: cc                # top-level default; can be omitted. Only the cc adapter is implemented
panes:
  - name: main
    cwd: ~/workspace/knowledge-assistant
    # runtime: cc          # each pane / mate can override individually (parsed, but nothing beyond cc is implemented yet)
mates:
  - name: ka-dev2
    cwd: ~/workspace/knowledge-assistant
    description: Development and maintenance of the knowledge-assistant project
  - name: story-maker
    cwd: ~/temp/books
    description: Novel writing (on demand)
    default: false         # not started by default; needs --all or --only / start <name>
```

**mate fields**:

| Field | Required | Default | Description |
|---|---|---|---|
| `name` | ✔ | — | mate name (unique; English / underscore / hyphen); also the channel after sanitization |
| `cwd` | ✔ | — | startup directory (`~` is expanded) |
| `description` | – | `""` | one-line role description |
| `default` | – | `true` | when `false`, `ka workshop` skips it unless `--all` / `--only` / `start <name>` |

The repo only ships the template `ops/workshop.example.yaml`; your personal layout goes in `~/.knowledge-assistant/workshop.yaml`
(naturally per-machine). `ka workshop spawn-mates <name> <workdir>` upserts a new mate into the
yaml (default=false) and then starts it; an already-running mate is not modified — to change its workdir, `stop` it first, then spawn.

---

_Maintained by ka-dev2; kept in sync when `bin/ka` / `ops/cli/*.sh` change._
