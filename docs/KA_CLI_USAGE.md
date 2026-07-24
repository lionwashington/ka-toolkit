# KA CLI User Manual

> This document is for **users** and is the single as-built manual for the `ka` command. Source of truth = `shared/bin/ka` +
> the by-part `*/ops/*.sh`; `ka help` is authoritative, and this doc is maintained in sync with it.

`ka` is the command-line entry point of Knowledge Assistant, used to:

- start/stop the **workshop** — a set of mutually independent Claude Code or Codex
  runtime processes, each running in its own tmux pane + its own cwd and conversing
  through the active Channel daemon;
- run health diagnostics (`ka status` / `ka doctor`);
- manage declarative **cron** scheduled jobs (`ka cron`);
- trigger background knowledge-base distillation (`ka kb distill`).

> **mate = an independent runtime process**, not a subagent inside another agent. Each mate has an independent cwd,
> `KA_CHANNEL`, process and runtime session; they share no context. The pane / window layout is a purely visual choice.
> The user routes a message to a specific mate in Telegram with `to <name>:` or `to <number>:` (no prefix →
> `main`).

---

## Installation

`ka` is a standalone bash script — no compilation, no npm needed. Runtime deployment is handled by the top-level `install.sh`;
after deployment `ka` runs from `~/.knowledge-assistant/shared/bin/ka`. In development you can symlink the
`shared/bin/ka` from the repo directly:

```bash
# symlink into ~/.local/bin
ln -sf <repo>/shared/bin/ka ~/.local/bin/ka

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
| Restart the whole workshop | `ka workshop restart` (run outside the session) |
| Restart the channel daemon (CCs re-adopt) | `ka channel restart` |
| Check / edit the channel daemon | `ka channel status` / `ka channel config` |
| Check / restart the kb retrieval daemon | `ka kb status` / `ka kb restart` |
| Something feels off (<1s) | `ka status` |
| Deep consistency diagnostics | `ka doctor` |

---

## `ka workshop` — workshop lifecycle

`ka workshop` is the sole entry point for managing the workshop panes. It reads `workshop.yaml`, warns
if the channel daemon is down (it does not start it — see `ka channel`), then launches each declared runtime in its own tmux pane (or window).

```
ka workshop [<verb>] [<name> [<workdir>]] [flags]
```

**Verbs**:

| Form | Semantics |
|---|---|
| `ka workshop` (bare) | = `ka workshop start` (no name): start all `default=true` mates |
| `ka workshop start [<name>]` | no name → start all default mates; `<name>` → start a single **declared** mate (if already running, just report, don't rebuild). Pure launcher, won't register a new mate |
| `ka workshop stop [<name>]` | no name → stop the whole workshop (kill the session); `<name>` → stop only that pane |
| `ka workshop status` | backwards-compatible alias for `ka status` |
| `ka workshop restart [<name>]` | no name → restart the **whole** workshop (stop all → start all; run from a plain terminal); `<name>` → restart a single mate's pane. ⚠️ See the warning below |
| `ka workshop spawn-mates <name> [<workdir>]` | with `<workdir>` → register and start; without → equivalent to `start <name>` |
| `ka workshop remove-mate <name>` (alias `remove`) | the inverse of spawn-mates: stop the agent's pane if running, then delete its entry from `workshop.yaml`. An optional `main: true` alias is removable; `--dry-run` previews; interactive `[y/N]` confirm unless `--yes` |

`ka workshop` does **not** manage the channel daemon — it only warns if the daemon is down (the panes don't depend on it to launch). Daemon lifecycle lives in [`ka channel`](#ka-channel--the-channel-daemon).

**Flags** (shared by all verbs):

| Flag | Effect |
|---|---|
| `--dry-run` | only print the tmux / daemon commands that would run, don't actually create anything |
| `--all` | include optional mates with `default: false` |
| `--only NAME[,NAME...]` | start only the specified mates (comma-separated) |
| `--skip-daemon` | don't even check the daemon (workshop never starts/stops it; this just suppresses the down-warning) |
| `--pane` | **default**: arrange all mates as split-panes in **one window** (all on one screen) |
| `--window` | one independent window per mate (switch with `Ctrl-b 0/1/2/w`) |

### Codex session selection and fresh startup

Each Codex mate gets a Workshop-owned loopback App Server. With no explicit
thread ID, Workshop resumes the newest session whose recorded cwd exactly matches
the mate cwd. `args: [resume, <thread-id>]` selects a specific same-cwd thread;
legacy `resume --last` and `resume latest` forms select the latest match.

If that cwd has no prior Codex session, startup does not fail and does not create a
hidden Channel-only conversation. Workshop starts the TUI normally, adopts the
thread created by the TUI, registers it with Channel, and upgrades the same live
registration after its rollout becomes resumable. This transition is what enables
Telegram/Lark text deltas for a brand-new session. Restarting Channel does not
require restarting the Codex pane; the registration loop converges again.

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

restart a single mate = stop that pane + re-start. **Restarting loses that agent runtime's in-memory context**
(`--resume` only restores the on-disk conversation history, not the in-memory working state).

> **If your channel merely dropped** (e.g. the CC went flat after a daemon restart and isn't receiving messages), **don't use
> restart** — in that CC's window, manually trigger one tool call to make it re-init, and you won't lose
> context (see `channels/telegram/ARCHITECTURE.md` A5). restart is only for when a CC is truly stuck / you need to change cwd /
> you need to clear state.

To restart the **whole** workshop use `ka workshop restart` (no name) — run it from a plain terminal, since stopping the session would otherwise kill the invoking pane.

---

## Two resident daemons

The system runs **two** long-lived daemons, each addressed as `ka <subsystem> start|stop|restart|status`:

| Subsystem | Daemon | Port | Command | Config key |
|---|---|---|---|---|
| `ka channel` | telegram/lark comms bus (every CC↔CC and CC↔user message) | `9877` | `ka channel …` | `channels.<kind>.port` |
| `ka kb` | LanceDB retrieval engine (the `kb_search` backend) | `7705` | `ka kb …` | `retrieval.daemon.port` |

Both appear in `ka status` and `ka doctor`. Both self-heal: a 1-minute `ka cron` keepalive
(`channel-daemon-keepalive` / `kb-retrieval-keepalive`) re-runs `ka channel start` / `ka kb start`
(no-ops when already up via the port singleton), so a daemon that dies is back within a minute;
`ka workshop` also ensures the channel daemon at session startup.

> The command face drops the word "retrieval": `ka kb start|stop|restart|status`. The internals keep
> their technical names — config section `retrieval:`, service id `kb-retrieval` in `/api/status`.

---

## `ka channel` — the channel daemon

All channel-daemon operations live here (formerly `ka daemon`; before that `ka workshop --restart-daemon`).
`ka channel` always acts on the **active** daemon — the kind comes from `config/config.yaml`
`channel_kind` (telegram | lark) and the port from that file's
`channels.<kind>.port`. There is no per-command kind override;
to switch kinds, run `./install.sh --channel-kind=telegram|lark` (or edit `config/config.yaml`)
and restart.

| Verb | Effect |
|---|---|
| `ka channel start` | start the active daemon (idempotent) |
| `ka channel stop` | stop it |
| `ka channel restart` | restart it — every CC **re-adopts automatically** (~2s blip, no relaunch needed) |
| `ka channel status` | health check; prints kind + port |
| `ka channel config` | open `config/config.yaml` + `config/secrets.yaml` in `$EDITOR` (bot token / webhook in secrets, port in config); apply with `ka channel restart` |

```bash
ka channel status          # is the active daemon up?
ka channel config          # edit credentials/port, then:
ka channel restart         # reload (CCs re-adopt)
```

> Use `ka channel restart` after deploying new daemon code (`./install.sh --only daemon`).
> The CCs are **not** relaunched — channel-core re-adopts each CC's reconnect (no 404),
> so inbound+outbound recover within the SSE retry window.
>
> **Do not run that restart from a workshop pane while it is answering a Channel
> message.** Re-adopt restores idle connections, but an in-flight Codex stream/final
> belongs to the old daemon process and will be cut off. Let the turn finish, then
> restart from a plain terminal.

> **`ka daemon` is gone** (renamed to `ka channel`, no alias) — "daemon" was too generic once a
> second daemon (`ka kb`) existed. **Top-level `ka start` / `ka stop` / `ka restart` / `ka spawn-mates`
> are also gone** — use the `ka workshop` verbs.

---

## `ka kb` — the kb retrieval daemon (+ index / distill)

`ka kb start|stop|restart|status` operate the shared dual-mode retrieval daemon,
backing `kb_search` over HTTP on port `7705`. `retrieval.mode` selects
`embedding` (existing LanceDB hybrid) or `fts5` (low-memory SQLite lexical) as
the default; `kb_search` may override the mode per call.

| Verb | Effect |
|---|---|
| `ka kb start` | start the daemon (embedding warms the model; FTS5 does not) |
| `ka kb stop` | stop it |
| `ka kb restart` | stop + start |
| `ka kb status` | health check (`/api/status`: pid / ready / engine) |
| `ka kb reindex [--full] [--mode embedding\|fts5\|all]` | rebuild the selected search index |
| `ka kb benchmark <fixture> [embedding\|fts5\|both]` | compare quality, latency, CPU and daemon RSS |
| `ka kb lint [--json / --fix]` | read-only KB structural self-check (dead wikilinks / orphan topics / bad frontmatter / raw↔topic back-refs / undistilled backlog) + full-picture stats; `--fix` only regenerates a catalog INDEX |

```bash
ka kb status               # is the kb retrieval daemon up & ready?
ka kb restart              # reload it (warmup ~10-50s on cold start)
```

> Self-heals via the 1-minute `ka cron` keepalive `kb-retrieval-keepalive` (re-runs `ka kb start`,
> a no-op when already up); `ka status` / `ka doctor` also surface it when down. The daemon + its launch
> scripts are deployed under `~/.knowledge-assistant/kb/mcp/kb` by `./install.sh --only node-mcp`.
> Startup is non-blocking: it serves search as soon as the model loads and runs the index reindex in the
> background (the reader hot-swaps on the manifest version bump).

The same cluster also holds the index + distillation ops:

| Command | Effect |
|---|---|
| `ka kb reindex [--full] [--mode embedding\|fts5\|all]` | update one or both search indexes |
| `ka kb distill [status]` | background distillation (see the dedicated section below) |

---

## telegram-channel daemon

All communication among the CCs in the workshop, and between a CC and the user, goes through a single
**single-process telegram-channel daemon** (MCP-over-HTTP, default port **9877**), **not** the old telegram
plugin. `ka workshop` automatically ensures the daemon is running at startup (unless `--skip-daemon`).

- **CC → CC**: the `send_to_channel` tool, target = the other party's channel.
- **CC → user**: the `reply` tool (replies to Telegram).
- **user → CC**: route in Telegram with `to <name>:` or `to <number>:`.

For the daemon's design, half-open connection diagnostics, and the A5 reconnect mechanism, see `channels/telegram/ARCHITECTURE.md` and
`channels/telegram/ARCHITECTURE.md` (§5). Daemon status can be viewed with the `/telegram-channel` skill.

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
| mates | the `default=true` entries declared in `workshop.yaml` vs the actually-running `@ka_channel` panes | degraded |
| telegram (channel daemon) | daemon liveness probe `http://127.0.0.1:9877/api/status` | degraded |
| kb (retrieval daemon) | daemon liveness probe `http://127.0.0.1:7705/api/status` (ready/warming) | degraded |

**Output example (healthy)**:

```
── ka status ──
  ✔ config:    ~/.knowledge-assistant/config/workshop.yaml
  ✔ runtime:   cc
  ✔ session:   workshop (4 panes)
  ✔ mates:     3 running (declared default: 3)
             - ka-dev2
             - freelancer
             - work-assistant
  ✔ telegram:  daemon up (port 9877)
  ✔ kb:        daemon up (port 7705, pid 23778, ready)

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
2. whether **runtime** is a supported adapter (`cc` or `codex`; Gemini remains reserved)
3. whether the **channel daemon** is up on port 9877 (telegram/lark)
3b. whether the **kb retrieval daemon** is up on port 7705 (ready / warming / `warm_error`); down ⇒ error with a `ka kb start` hint
4. **session + per-pane invariants**:
   - **channel uniqueness** — two panes sharing one channel will cross-talk
   - whether each pane's cwd exists
5. **declared vs running**: are all `default=true` mates in the yaml actually running
6. **cron**: when `cron.yaml` exists, are the launchd plists installed

**Exit codes**: `0` all passed; `1` there are issues (warning or error).

---

## `ka cron` — declarative scheduled jobs

Declare scheduled jobs in `~/.knowledge-assistant/config/cron.yaml`, synced to the OS (macOS launchd).

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

## `ka kb distill` — background knowledge-base distillation

Runs a background `/kb distill` inside a headless Opus claude process, returning immediately after spawning. Synchronous foreground distillation
is still inside the `/kb distill --foreground` skill (`ka kb distill` currently **only** supports `--background`).

```
ka kb distill --jsonl <abs path> [--session-id <uuid>] [--dry-run]
```

| Flag | Effect |
|---|---|
| `--jsonl <path>` | the absolute path to the session's `.jsonl` (required) |
| `--session-id <uuid>` | override (default derived from the jsonl filename) |
| `--dry-run` | print the plan but don't actually spawn |

**Snapshot protection**: before spawning, capture the jsonl's current byte size + the uuid of the last entry; the worker runs with
`--upper-offset <snapshot>` — messages appended after the snapshot are left for the next distillation, avoiding a race.

The worker state is written to `~/.knowledge-assistant/state/distill-current.json`, and each run also leaves a
`distill-<timestamp>.log`. Use `ka kb distill status [--json]` to view the status of the last / current background distillation.
If a worker is already running, it refuses to start another.

---

## Environment variables

| Variable | Default | Effect |
|---|---|---|
| `OPS_CONFIG` | `~/.knowledge-assistant/config/workshop.yaml` | override the workshop config path |
| `KA_CHANNEL_PORT` | `9877` | telegram-channel daemon port |
| `TMUX_BIN` | `$(command -v tmux)` | specify the tmux binary (when multiple versions coexist) |
| `NO_COLOR` | unset | set to non-empty to disable ANSI colors |
| `DRY_RUN` | `0` | `1` is equivalent to `--dry-run` throughout |

---

## workshop.yaml

`workshop.yaml` declares the session name and a single `mates:` list holding
equivalent agents. A `main` channel alias is optional:

```yaml
session: workshop
runtime: cc                # top-level default; can be omitted. cc and codex are implemented
mates:
  - name: project-one
    cwd: ~/workspace/project-one
    # main: true           # optional: bind this agent to channel "main"
    # runtime: codex       # each entry can override individually with cc or codex
  - name: ka-dev2
    cwd: ~/workspace/knowledge-assistant
    description: Development and maintenance of the knowledge-assistant project
  - name: story-maker
    cwd: ~/temp/books
    description: Novel writing (on demand)
    default: false         # not started by default; needs --all or --only / start <name>
```

**entry fields**:

| Field | Required | Default | Description |
|---|---|---|---|
| `name` | ✔ | — | agent name (unique; English / underscore / hyphen); also the channel after sanitization |
| `cwd` | ✔ | — | startup directory (`~` is expanded) |
| `args` | – | `[]` | extra CLI args passed verbatim to the agent |
| `description` | – | `""` | one-line role description |
| `main` | – | `false` | zero or one entry may set `true`; it changes only that entry's channel alias to `main` |
| `default` | – | `true` | when `false`, `ka workshop` skips it unless `--all` / `--only` / `start <name>` |

> Legacy `panes:` + `telegram: true` configs migrate with
> `workshop/ops/migrate-workshop-yaml.py` (folds `panes:` into `mates:`, rewrites
> `telegram: true` → `main: true`).

The repo only ships the template `config/workshop.example.yaml`; your personal layout goes in `~/.knowledge-assistant/config/workshop.yaml`
(naturally per-machine). `ka workshop spawn-mates <name> <workdir>` upserts a new mate into the
yaml (default=false) and then starts it; an already-running mate is not modified — to change its workdir, `stop` it first, then spawn.

---

_Maintained by ka-dev2; kept in sync when `shared/bin/ka` / the by-part `*/ops/*.sh` change._
