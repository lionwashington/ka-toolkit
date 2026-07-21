# Agent Runtime Adapter Interface

Contract every runtime adapter (`workshop/ops/runtimes/<name>/`) must implement so
that the `ka` CLI can target it without any runtime-specific code in the top-level
commands.

> **Status**: implemented for **cc** and **codex**. The CC-specific logic lives behind sourced
> adapter files in `workshop/ops/runtimes/cc/` (`launch.sh`, `ready-signals.sh`,
> `send-prompt.sh`, `post-launch.sh`) plus `cc/bin/start-pane.sh`;
> `workshop/ops/runtimes/dispatch.sh` loads them. Codex uses a Workshop-owned App
> Server sidecar, selects the most recent thread whose cwd exactly matches the
> mate cwd, and connects both its TUI and Channel to that canonical thread;
> `args: [resume, <thread-id>]` is the validated override. If no matching session
> exists, the TUI creates a fresh canonical thread and Workshop adopts it instead
> of creating a separate Channel-only thread. `gemini` remains reserved. This doc is the contract
> the cc adapter satisfies and any new runtime must implement.

## Naming convention

Functions live in `workshop/ops/runtimes/<runtime>/<topic>.sh` and are named
`runtime::<verb>`. The dispatcher (`workshop/ops/runtimes/dispatch.sh`) chooses the
runtime from `workshop.yaml`'s `runtime:` field (top-level default, per-pane or
per-mate override) and `source`s the matching files before calling.

```
workshop/ops/runtimes/
├── dispatch.sh                      (the adapter loader)
├── cc/                              (the implemented CC adapter)
│   ├── launch.sh · ready-signals.sh · send-prompt.sh · post-launch.sh
│   ├── bin/start-pane.sh
│   └── (doc: docs/components/workshop-runtime-cc.md)
├── codex/                          (interactive TUI adapter)
└── gemini/  (reserved, not implemented)
```

## Required functions

### `runtime::ready_match <captured_text>`
Given the text captured from `tmux capture-pane -p -J`, return exit 0 if the
text indicates the runtime's TUI has finished booting and is accepting input,
exit 1 otherwise. No I/O — pure predicate. Must be fast.

**CC**: `workshop/ops/runtimes/cc/ready-signals.sh` (used by `workshop/ops/wait-ready.sh`) — matches `❯` /
`│ >` / bottom status-line hints.

### `runtime::inject_prompt <tmux_target> <text>`
Paste `text` into the runtime's input area at `tmux_target` and submit it.
Must handle runtime-specific quirks (CC needs `send-keys -l` + 0.5s sleep +
`C-m`, because `send-keys Enter` is eaten by the TUI under some locales).

**CC**: `workshop/ops/runtimes/cc/send-prompt.sh`.

### `runtime::launch_binary`
Echo the runtime's executable name (CC: `claude`). **CC**: `workshop/ops/runtimes/cc/launch.sh`.

### `runtime::launch_pane_script`
Echo the path to the per-pane launch script (guarantees cwd, sets the channel
via `KA_CHANNEL`, resolves `--resume`). The top-level `start-pane.sh` is only a
dispatcher. **CC**: `workshop/ops/runtimes/cc/bin/start-pane.sh`.

The Codex implementation also owns the App Server sidecar lifecycle. While the
pane is alive it registers the socket with Channel's loopback API and retries
registration after Channel restarts. Pane exit unregisters the target and stops
the sidecar.

For an existing session, the selector resumes either the explicit validated
thread ID or the latest exact-cwd thread (`resume --last` and `resume latest` are
accepted compatibility aliases). For a fresh cwd, Workshop launches the TUI
without `resume`, waits for its `thread/started`/`thread/list` result, and registers
that ID immediately. Because the rollout may not yet be resumable, the first
registration carries `allow_unpersisted_thread`; after persistence the registrar
reposts the same runtime identity without that flag. Channel promotes the existing
client with `thread/resume`, preserving the active WebSocket and enabling delta
notifications used by platform streaming.

Channel completion snapshots are a fallback, not a progress transport. It polls
`thread/read` only after notification inactivity and briefly waits for queued
deltas before accepting a polled completion. Runtime adapters must not introduce
eager polling that can starve or overtake the notification stream.

### `runtime::post_launch <tmux_target> <name>` (optional)

Run runtime-specific convergence after a pane is created. The CC adapter uses
this hook to confirm the development-channel gate after its marker appears.

> **Startup convergence (gen2)**: the old team/plugin verbs were RETIRED together
> with the CC team mechanism — `spawn_mate_prompt_template`,
> `list_registered_mates`, `describe_registered_mates`, `settings_path`,
> `telegram_status`, `flock_patch_status`. Mates are now independent CC
> processes in their own tmux panes (`ka workshop`), not Agent-spawned team
> subagents; Telegram goes through the daemon (not the plugin); there is no
> flock guard.

## Conventions

- **No side effects in predicates** (`ready_match`, `telegram_status`). They
  must be callable from `ka status` without touching tmux state.
- **Fail soft for optional capabilities**: if a runtime does not implement a
  concept (e.g. Gemini has no plugin system, no `telegram_status`), its
  adapter returns "none" / "n/a" or exits 0 quietly — not an error.
- **bash 3.2 compatible**. Target shell is the macOS default; adapters must
  avoid bash 4+ features (`mapfile`, associative arrays unless guarded, `**`
  globstar).
- **Stateless**: adapters read files / tmux state, but do not cache anything
  between invocations. Each `ka` command is a cold start.

## Adding a new runtime

1. `mkdir workshop/ops/runtimes/<name>`
2. Implement each required function in files at conventional paths (`launch.sh`,
   `ready-signals.sh`, `send-prompt.sh`).
3. Add contract tests under `tests/cases/<NN>-runtime-<name>-contract.sh`:
   for each function, assert that calling it against a known fixture produces
   the expected output.
4. Note which runtime / CLI version the adapter was validated against, and any
   gaps (e.g. "Gemini has no mate registry").
