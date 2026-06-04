# KA Cron Design v2 (full proposal)

> **✅ as-built (closed out 2026-05-31)**: the CLI is implemented — `cron/ops/cmd/` (list/add/remove/enable/disable/run/install/uninstall/import/status) + `cron/ops/internals/` (parse-yaml/schedule-parser/plist-gen/backend-adapter) + `ka cron`. **Closed out**: `~/.knowledge-assistant/config/cron.yaml` is the single source of truth, and `ka cron install` generates the `com.knowledge-assistant.ka.cron.*` launchd plists from it (currently three jobs: kb-distill / daily-brief / workspace-backup); the old dual-track `scheduled-tasks/` has been ended. The rest of this document is the design proposal for reference; the running reality is governed by `ka cron` + `config/cron.yaml`.
>
> **⚠️ Incremental update (2026-06)**: the `target_pane` field is retired. The target pane of an `inject-prompt` job is no longer specified per-job; instead it is uniformly determined by the `channels.inject` array in `~/.knowledge-assistant/config/config.yaml` — cron-run reads `channels.inject` and, for each channel name, resolves the corresponding tmux pane (`@ka_channel`) to inject into; empty/unconfigured → no injection (fail-closed). The `target_pane` left in the examples below is historical reference only and is in fact no longer effective.

> Related: `docs/ARCHITECTURE.md` §8 (cron as a first-class citizen)
> Date: 2026-04-15 (proposal); 2026-05-31 closed out
> Version: v2 (replaces the scattered §10 Q1-Q5 Q&A of the 2026-04-14 initial version)
> Status: Q1/Q5 = A approved by the user, Q4 pending explanation (see §10 FAQ); Q2/Q3 still pending decision but not blocking Phase 1
> Analogy: abstract the scattered "scheduled tasks" into a first-class-citizen capability

---

## 0. Three-sentence summary

1. `ka cron` abstracts KA's scheduled tasks from **scattered launchd plists** into a **first-class-citizen CLI + declarative yaml**; data and scheduling are all local, conforming to KA design principles §1-5
2. The user edits `~/.knowledge-assistant/config/cron.yaml` (or uses `ka cron add/remove`), and a backend adapter translates it into native launchd/systemd units, auto-installed to the OS
3. The two existing hardcoded plists (kb-distill / daily-brief) are auto-imported into yaml entries on the first `ka cron install`, and the old scripts `scheduled-tasks/scripts/*.sh` can be deleted

---

## 1. Background and motivation

### Current state

KA currently has two hardcoded launchd jobs:

| Plist | Trigger | Script | Purpose |
|---|---|---|---|
| `~/Library/LaunchAgents/com.knowledge-assistant.ka.kb-distill.plist` | every 2h (odd hour:03) | `scheduled-tasks/scripts/kb-distill.sh` | `/kb distill` |
| `~/Library/LaunchAgents/com.knowledge-assistant.ka.daily-brief.plist` | daily 07:00 | `scheduled-tasks/scripts/daily-brief.sh` | `/daily-brief` |

**Problems**:

1. Every new task means hand-writing a plist, installing it, verifying it
2. `ka status` can't report "what scheduled tasks exist, did the last run succeed, when's the next one"
3. Bound to macOS launchd; Linux users can't reuse it
4. The plist hardcodes the user's absolute home path; moving machines breaks it
5. No first-class-citizen command — adding a task requires knowing plist syntax and launchctl

### Goals

- The user manages tasks with `ka cron add/list/remove`, never touching a plist
- Declarative yaml (versioned, diffable)
- Cross-platform: macOS→launchd / Linux→systemd user units
- cron is installed / managed only via `ka cron install` (idempotent), independent of the workshop / session lifecycle
- **Aligned with KA design principles**: local, runtime-agnostic, reuse the OS-native scheduler, data sovereignty

### KA Cron vs CC CronCreate / Routines (layered positioning)

| | KA cron | CC CronCreate | CC Routines |
|---|---|---|---|
| Run location | the user's local launchd/systemd | inside a CC session | Anthropic cloud |
| Lifecycle | OS-level persistent (runs as long as the machine is on) | stops when the session closes | cloud always-on |
| Can access local FS / tmux | ✅ | only while the session is alive | ❌ |
| Target scenarios | distill / daily-brief / local automation | in-session polling | GitHub / API automation |

**The three are complementary, not overlapping.** Routines violates KA principles (see ARCHITECTURE.md "KA design principles (the five)"), and is not a migration target.

---

## 2. Architecture overview

```
┌──────────────────────────────────────────────────────────────┐
│  user                                                         │
│  $ ka cron add --name foo --schedule "daily 07:00" ...        │
│  $ vim ~/.knowledge-assistant/config/cron.yaml                │
└────────────────────┬─────────────────────────────────────────┘
                     │
                     ▼
┌──────────────────────────────────────────────────────────────┐
│  ka cron CLI  (cron/ops/cron.sh)                             │
│    list / add / remove / enable / disable / run              │
│    install / uninstall / status / import                     │
└────────────────────┬─────────────────────────────────────────┘
                     │ reads/writes
                     ▼
┌──────────────────────────────────────────────────────────────┐
│  cron.yaml   (~/.knowledge-assistant/config/cron.yaml)       │
│  declarative, source of truth, git-friendly                  │
└────────────────────┬─────────────────────────────────────────┘
                     │ parsed by
                     ▼
┌──────────────────────────────────────────────────────────────┐
│  parse-yaml.sh + backend dispatcher                          │
│  (cron/ops/internals/parse-yaml.sh, backend-adapter.sh)      │
│                                                              │
│  three syntaxes for the schedule field:                      │
│    "every 2h" / "daily 07:00"  → natural language            │
│    "0 3 * * *"                  → standard 5-field cron       │
│    "on-event:50turns"           → event trigger (schema only) │
└────────────────────┬─────────────────────────────────────────┘
                     │ dispatches to
          ┌──────────┴──────────┐
          ▼                     ▼
  ┌──────────────┐      ┌──────────────┐
  │ launchd      │      │ systemd user │
  │ adapter      │      │ adapter      │
  │ (macOS)      │      │ (Linux, v2)  │
  └──────┬───────┘      └──────┬───────┘
         │                     │
         ▼                     ▼
  ~/Library/LaunchAgents/  ~/.config/systemd/user/
  com.knowledge-assistant.ka.cron.*.plist ka-cron-*.{timer,service}
         │                     │
         └──────────┬──────────┘
                    │ triggers at scheduled time
                    ▼
┌──────────────────────────────────────────────────────────────┐
│  job wrapper   (cron/ops/cron-run.sh <name>)                 │
│    flock per-name, log to ~/Library/Logs/knowledge-assistant/│
│    cron/<name>.log                                           │
└────────────────────┬─────────────────────────────────────────┘
                     │ executes by kind
     ┌───────────────┼───────────────┐
     ▼               ▼               ▼
 kind: shell    inject-prompt     ka-cli
 bash -c "$cmd" workshop/ops/      ka $cmd
                inject-prompt.sh "$cmd"
```

---

## 3. Data model: cron.yaml

### 3.1 Location

**`~/.knowledge-assistant/config/cron.yaml`** (a peer of the existing `config/workshop.yaml`; the user approved Q1=A on 2026-04-15)

### 3.2 Full schema

```yaml
# ~/.knowledge-assistant/config/cron.yaml
# Declarative cron task list. Source of truth — the plists/units in the OS are generated by ka from this file.

version: 1                          # schema version, bump on future incompatible changes

defaults:                           # default fields for all jobs, overridable per-job
  enabled: true
  log_keep_mb: 20                   # MB to keep per log; rotate when exceeded
  flock: per-name                   # per-name | none — prevents same-named jobs overlapping

jobs:
  - name: kb-distill                # required. Unique id, kebab-case, used for the plist Label
    description: "distill conversations into topics every 2h"
    schedule: "every 2h"            # required. Three syntaxes, see §4
    kind: inject-prompt             # shell | inject-prompt | ka-cli (default shell)
    command: "/kb distill"          # required. Semantics determined by kind
    enabled: true                   # inject target comes from config.yaml channels.inject (target_pane retired)
    env:                            # optional: extra environment variables
      KB_DISTILL_MODE: incremental

  - name: daily-brief
    description: "send daily brief at 7am"
    schedule: "daily 07:00"
    kind: inject-prompt
    command: "/daily-brief"
    enabled: true

  - name: memory-backup
    description: "tarball memory/ nightly at 3am"
    schedule: "0 3 * * *"           # standard 5-field cron: min hour day month weekday
    kind: shell
    command: "tar -czf $HOME/backups/ka-memory-$(date +%F).tgz $HOME/workspace/your-workspace/memory/"
    enabled: true
    env:
      TZ: Asia/Shanghai             # explicit timezone

  - name: weekly-cc-audit
    description: "run CC changelog audit every Monday 9am (T5)"
    schedule: "0 9 * * 1"           # Monday 9:00
    kind: ka-cli
    command: "cc-check"             # assumes a future ka cc-check subcommand
    enabled: false                  # feature not yet shipped, draft first
```

### 3.3 Field reference

| Field | Required | Default | Description |
|---|---|---|---|
| `name` | ✅ | - | unique id; kebab-case; used for plist Label = `com.knowledge-assistant.ka.cron.<name>` |
| `schedule` | ✅ | - | see §4, three syntaxes |
| `command` | ✅ | - | what to execute; semantics determined by `kind` |
| `kind` | - | `shell` | `shell` / `inject-prompt` / `ka-cli` |
| `description` | - | - | for display; shown by `ka cron list` |
| `enabled` | - | `true` | whether to actually install to the OS |
| ~~`target_pane`~~ | - | - | **retired (2026-06)**: the inject target is now determined by `channels.inject` in config.yaml, no longer per-job |
| `env` | - | `{}` | extra environment variables (merged into the job's run environment) |
| `flock` | - | `per-name` | `per-name` prevents concurrency of same-named jobs; `none` disables |
| `log_keep_mb` | - | `20` | log file rotation threshold |

---

## 4. The three syntaxes of the schedule field

### 4.1 Natural language (daily use)

| Syntax | Meaning |
|---|---|
| `every 2h` | every 2 hours (on the hour:00) |
| `every 30m` | every 30 minutes |
| `every 15m` | every 15 minutes |
| `daily 07:00` | every day at 07:00 |
| `daily 23:30` | every day at 23:30 |
| `hourly :03` | minute 3 of every hour |

### 4.2 Standard cron expression (advanced)

5 fields: `min hour day month weekday`
- `0 3 * * *` — every day at 3:00
- `0 9 * * 1` — every Monday at 9:00
- `*/15 * * * *` — every 15 minutes

### 4.3 Event trigger (schema reserved, not implemented in v1)

- `on-event:50turns` — trigger every 50 conversation turns (paired with the Hermes-inspired nudge)
- `on-event:session-end`

**The v1 parser recognizes it but warns + auto-sets `enabled: false`**. Implementation is deferred until after the T1 #1 decision (see the §10 T2-Q4 explanation).

### Parser

`cron/ops/internals/parse-yaml.sh` (bash 3.2 compatible):
- input: a schedule string → output: the canonical structure the backend needs
- launchd: translate into a `StartCalendarInterval` array (`every 2h` → 12 dicts)
- systemd: translate into an `OnCalendar=...` string

---

## 5. Command design

### 5.1 `ka cron list`

```
$ ka cron list
NAME           SCHEDULE          KIND            LAST RUN              STATUS
kb-distill     every 2h          inject-prompt   2026-04-15 15:03      ok
daily-brief    daily 07:00       inject-prompt   2026-04-15 07:00      ok
memory-backup  0 3 * * *         shell           2026-04-15 03:00      ok
weekly-cc-audit 0 9 * * 1        ka-cli          never                 disabled
```

### 5.2 `ka cron add`

```
$ ka cron add \
    --name memory-backup \
    --schedule "0 3 * * *" \
    --kind shell \
    --command "tar -czf ~/backups/ka-memory-\$(date +%F).tgz ~/workspace/your-workspace/memory/"

Added 'memory-backup' to ~/.knowledge-assistant/config/cron.yaml
Installed: ~/Library/LaunchAgents/com.knowledge-assistant.ka.cron.memory-backup.plist
Next run: 2026-04-16 03:00
```

**Behavior** (the user approved Q5=A):
- append a yaml entry
- **install to the OS immediately** (unless `--enabled=false`)
- optional flags such as `--description` / `--target-pane` / `--env KEY=VAL`

### 5.3 `ka cron remove <name>`

- delete from the yaml
- also uninstall the OS unit (launchctl unload + rm plist)
- log cleanup is optional: `--purge-logs`

### 5.4 `ka cron enable / disable <name>`

- `disable`: mark `enabled: false` + uninstall the OS unit (keep the yaml config for recovery)
- `enable`: mark `enabled: true` + install the OS unit
- The benefit of **keeping the config**: draft tasks / temporary pause

### 5.5 `ka cron run <name>`

Manually trigger once immediately, without affecting subsequent schedule:
- use flock to prevent concurrency with a scheduled trigger
- output stdout/stderr to the terminal (rather than the log file) for easier debugging

### 5.6 `ka cron install / uninstall`

- `install`: sync all `enabled: true` jobs in the yaml to the OS (idempotent — no-op if the OS unit already matches the yaml, otherwise rewrite)
- `uninstall`: unload all ka-managed cron units from the OS (the yaml stays unchanged)

Use cases: moving machines / redeploy / drift repair.

### 5.7 `ka cron import`

Auto-triggered on first use or when legacy plists are detected (see §7 migration).

### 5.8 `ka cron status`

```
$ ka cron status
cron: 4 jobs (3 enabled, 1 disabled)
  2 installed / 1 failed to load (weekly-cc-audit: service not found)
  last 24h: kb-distill 12/12 ok, daily-brief 1/1 ok, memory-backup 1/1 ok
```

---

## 6. Runtime behavior: the full chain from add to trigger

**The user runs** `ka cron add --name foo --schedule "daily 07:00" --kind inject-prompt --command "/kb distill"`

1. `cron/ops/cron.sh add` parses the args and appends the entry to `cron.yaml`
2. calls `cron-parse.sh foo` to produce the canonical schedule
3. the backend dispatcher selects launchd (macOS)
4. generates the plist `~/Library/LaunchAgents/com.knowledge-assistant.ka.cron.foo.plist`:
   ```xml
   <key>Label</key><string>com.knowledge-assistant.ka.cron.foo</string>
   <key>ProgramArguments</key>
   <array>
     <string>$HOME/.knowledge-assistant/cron/ops/cron-run.sh</string>
     <string>foo</string>
   </array>
   <key>StartCalendarInterval</key>
   <dict><key>Hour</key><integer>7</integer><key>Minute</key><integer>0</integer></dict>
   <key>StandardOutPath</key>
   <string>$HOME/Library/Logs/knowledge-assistant/cron/foo.log</string>
   <key>StandardErrorPath</key>
   <string>$HOME/Library/Logs/knowledge-assistant/cron/foo.log</string>
   ```
5. `launchctl bootstrap gui/$(id -u) <plist>`
6. verify: `launchctl print gui/$(id -u)/com.knowledge-assistant.ka.cron.foo` confirms it's loaded
7. return the next-run time to the user

**At trigger time** (07:00 daily):

1. launchd starts `cron/ops/cron-run.sh foo`
2. cron-run reads `cron.yaml` and finds `foo`'s entry
3. acquires the flock (per-name, to prevent concurrency)
4. dispatches by `kind`:
   - `shell`: `bash -c "$command"` (with the `env` field added to the environment)
   - `inject-prompt`: cron-run reads config.yaml's `channels.inject` → for each channel name resolves the corresponding pane (`@ka_channel`) → `workshop/ops/inject-prompt.sh <pane> "$command"`
   - `ka-cli`: `shared/bin/ka $command`
5. write the log header `=== 2026-04-16 07:00:00 start ===`
6. execute the command, appending both stdout/stderr to the log
7. write the log footer `=== 2026-04-16 07:00:12 exit=0 ===`
8. release the flock

**At removal time** (`ka cron remove foo`):

1. `launchctl bootout gui/$(id -u) <plist>`
2. `rm <plist>`
3. delete the entry from the yaml
4. (optionally) delete the log file

---

## 7. Migrating the existing hardcoded plists for compatibility

### 7.1 Import flow (auto-triggered on the first `ka cron install`)

1. scan `~/Library/LaunchAgents/com.knowledge-assistant.ka.*.plist` (excluding the `cron.` prefix)
2. for each known task (`kb-distill` / `daily-brief`), read the plist to get its schedule + command
3. if `cron.yaml` doesn't yet have a same-named entry, write it in automatically
4. **uninstall the old plist** (`launchctl bootout` + `rm`)
5. **re-install the new plist per the yaml** (Label prefix `com.knowledge-assistant.ka.cron.` to avoid collision)
6. produce a migration report to stdout

### 7.2 The generated yaml entries align with the current state

```yaml
jobs:
  - name: kb-distill
    schedule: "every 2h"            # auto-derived from the plist's 12 CalendarInterval dicts
    kind: inject-prompt
    command: "/kb distill"
  - name: daily-brief
    schedule: "daily 07:00"
    kind: inject-prompt
    command: "/daily-brief"
```

### 7.3 Retiring the old scripts

- `scheduled-tasks/scripts/kb-distill.sh` and `daily-brief.sh` are **deleted** after Phase 2 verification passes
- their content (`inject-prompt /kb distill`) is already replaced by the `kind: inject-prompt` semantics

### 7.4 Backward-compatibility window

- keep the old scripts for one release with a deprecation comment
- if `~/Library/LaunchAgents/com.knowledge-assistant.ka.{kb-distill,daily-brief}.plist` still exist (non-`cron.` prefix), `ka cron list` flags a red warning

---

## 8. Observability

### Logs

`~/Library/Logs/knowledge-assistant/cron/<name>.log`:

```
=== 2026-04-15 07:00:00 start ===
[inject-prompt] target=main command="/daily-brief"
[inject-prompt] sent to tmux session=workshop pane=main
=== 2026-04-15 07:00:02 exit=0 ===
```

- one log per job
- `log_keep_mb` triggers rotation (simple tail-based rotate)

### last-run / status in `ka cron list`

- **last-run**: read the log file's mtime (launchd exposes no last-run API)
- **status**: grep the last `exit=` line
  - `exit=0` → `ok`
  - non-zero → `failed (rc=N)`
  - log missing → `never`

### Drift detection

`ka cron status` compares:
- in yaml but not in OS → `missing-unit`
- in OS but not in yaml → `orphan-unit`
- the OS plist disagrees with the yaml's translation → `drift`

All three drifts prompt the user to run `ka cron install` to sync (idempotent).

---

## 9. Risks / rollback paths

| # | Risk | Mitigation |
|---|---|---|
| R1 | launchd `StartCalendarInterval` semantics differ from standard cron (`every 2h` must expand into 12 dicts) | `cron-parse.sh` expands it, with test coverage |
| R2 | a systemd user timer needs `loginctl enable-linger` to trigger without login | `ka cron install` detects linger and warns when not enabled |
| R3 | `inject-prompt` depends on the tmux session being online; silently fails when the session is closed | log the failure; add retry-on-next-session in the future (v2 optional) |
| R4 | drift between yaml and OS state (the user hand-edits a plist or yaml) | §8 drift detection + idempotent `ka cron install` sync |
| R5 | the manual `ka cron run` trigger races with the scheduled trigger | per-name flock (enabled by default) |
| R6 | new/old plist Label collision | new Label prefix `com.knowledge-assistant.ka.cron.*`, old `com.knowledge-assistant.ka.*`, physically non-colliding |
| R7 | the user writes a broken yaml (illegal schedule / unknown kind) | `ka cron add` validates; `ka cron install` validates the whole thing and fails fast, **without breaking already-installed units** |
| R8 | the deployed path / home changes, the absolute path in the plist breaks | the plist's ProgramArguments points at `$KA_HOME/cron/ops/cron-run.sh`, and KA_HOME is validated during yaml `version` migration |

### Rollback paths

**Full rollback to hardcoded plists** (worst case):

1. `ka cron uninstall` (clear OS units)
2. `rm ~/.knowledge-assistant/config/cron.yaml`
3. restore `scheduled-tasks/scripts/*.sh` from git (if deleted)
4. manually install the old plists

Cost: 10 minutes. **Extremely low destructiveness.**

**Partial rollback** (disable a specific task):
- `ka cron disable <name>` pauses with one command, yaml unchanged

---

## 10. FAQ (decision-item explanations)

### Q: What are schema / nudge? What is T2-Q4 actually asking?

**schema** = which fields a config file (here `cron.yaml`) is allowed to contain and what the allowed values are — essentially the "table structure."

**nudge** literally means "a gentle push," and here specifically refers to **Hermes's "periodic in-session push" mechanism**: the agent automatically triggers a review / distill every N conversation turns without waiting for the user to ask. This "proactive trigger" is called a nudge (the concept comes from the Hermes research; that document was cleaned up as part of ka-gen2 P0).

**What T2-Q4 is really asking**: should cron.yaml support **event-triggered (non-time)** tasks like `schedule: on-event:50turns`? Two approaches:

- **A (schema only)**: the v1 parser **recognizes** the `on-event:*` syntax but **auto-sets enabled to false + warning**, and the actual event-listening runtime is deferred. Writing such a schedule now won't error, but it also won't run.
- **B (implement in v1)**: v1 also writes a lightweight event listener (e.g. a background process watching the counter file written by the CC hook), triggering once 50 turns are reached. 1-2 extra days of work.

**Recommend A, in one sentence**: the concrete implementation path of the Hermes nudge (T1-Q2: hook+counter vs daemon) isn't decided yet, and implementing the event runtime too early would get reworked once T1-Q2's choice forces a change. Reserving the schema costs 0, and adding the runtime later is also cheap; whereas doing it in v1 might be wasted work.

---

## 11. Implementation phases

**Phase 1 (~2 days) skeleton + migration**
- all commands: `list/add/remove/enable/disable/run/install/uninstall/status/import`
- `cron-parse.sh`: `every Nh` / `daily HH:MM` / standard cron (no on-event)
- launchd backend
- import the two existing plists
- unit tests: cron-parse, import logic

**Phase 2 (~0.5 day) integration**
- `ka cron status` feeds a cron summary line to `ka status`
- update the USAGE docs

**Phase 3 (as needed) extensions**
- systemd backend (leave a stub, don't build, if the user approves Q3=A)
- `on-event:*` runtime (built together with the T1 #1 nudge)
- proactive cron drift detection (a cron job that detects cron jobs, meta)

**Total estimate**: Phase 1+2 = **2.5 days**; Phase 3 as needed.

---

## 12. Acceptance criteria

- [ ] `ka cron add --name test --schedule "every 5m" --kind shell --command "date"` succeeds, and 5 minutes later `~/Library/Logs/knowledge-assistant/cron/test.log` has a record
- [ ] `ka cron list` shows 3 tasks (kb-distill / daily-brief / test)
- [ ] the old plist `com.knowledge-assistant.ka.kb-distill.plist` is uninstalled and deleted
- [ ] the new plist `com.knowledge-assistant.ka.cron.kb-distill.plist` exists and is loaded
- [ ] cron tasks are independent of the workshop / session: scheduled tasks still trigger 5 minutes after the session closes
- [ ] `ka status` output includes `cron: 3 jobs (3 enabled, 3 ok)`
- [ ] `ka cron disable daily-brief && ka cron list` shows disabled
- [ ] `scheduled-tasks/scripts/*.sh` can be deleted while the system works normally
- [ ] after `cron.yaml` is hand-edited, `ka cron install` idempotently syncs to the OS

---

## 13. What it does not do (boundaries)

- ❌ cloud sync / web UI / Zapier
- ❌ task-dependency DAG / retry strategy / failure notifications (v2 later)
- ❌ sub-minute precision (launchd's own limitation)
- ❌ introducing runtime dependencies (pure bash + yq/jq + OS-native)
- ❌ Windows support

---

## 14. Decision status (2026-04-15)

| # | Question | Status | Value |
|---|---|---|---|
| Q1 | cron.yaml location | ✅ approved | A = `~/.knowledge-assistant/config/cron.yaml` |
| Q2 | whether to uninstall cron when the session closes | pending | recommend A = don't uninstall (cron is independent of the session) |
| Q3 | whether to build systemd in v1 | pending | recommend A = v1 launchd only |
| Q4 | `on-event:*` in v1 | pending | recommend A = schema reserved only (explanation in §10) |
| Q5 | auto-install on `add/remove` | ✅ approved | A = auto |

Q2/Q3 don't block Phase 1 — once these two are approved we can start.

---

*Design produced as the ka-dev2 v2 version. The initial version is in git log 2026-04-14 `docs/KA_CRON_DESIGN.md`.*
