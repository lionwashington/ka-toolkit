# Agent Runtime Adapter Interface

Contract every runtime adapter (`ops/lib/runtimes/<name>/`) must implement so
that `ka` CLI can target it without any runtime-specific code in the top-level
commands.

> **Status**: design stub (phase 1). No code has moved yet — `ops/cli/*.sh`
> still contains the CC-specific logic inline. Phase 2 will pull each of the
> functions below behind a sourced adapter file. Until then this doc is the
> planning-of-record; any new runtime-specific behavior added to `ops/cli/*`
> must be annotated with a pointer to the adapter function it would eventually
> live in.

## Naming convention

Functions live in `ops/lib/runtimes/<runtime>/<topic>.sh` and are named
`runtime::<verb>`. The adapter dispatcher (phase 2) will choose the runtime
from `workshop.yaml`'s `runtime:` field (top-level default, per-pane or
per-mate override) and `source` the matching files before calling.

```
ops/lib/runtimes/
├── interface.md                     (this file)
├── cc/                              (skeleton — code lives in ops/cli/* today)
│   └── README.md
├── codex/   (future)
└── gemini/  (future)
```

## Required functions

### `runtime::launch_pane <cwd> [args...]`
Produce the command line (or directly run it) to start the agent runtime in a
tmux pane with the given working directory. Today this is
`ops/lib/start-pane.sh` — CC-specific (uses `claude --resume …`).

**Returns**: exit 0 if launch was dispatched; non-zero if the binary is missing
or args are invalid.

**CC today**: `claude`. Telegram goes through the daemon (`KA_CHANNEL` env set by `start-pane.sh`), not a CC plugin.

### `runtime::ready_match <captured_text>`
Given the text captured from `tmux capture-pane -p -J`, return exit 0 if the
text indicates the runtime's TUI has finished booting and is accepting input,
exit 1 otherwise. No I/O — pure predicate. Must be fast.

**CC today**: lives in `ops/cli/wait-ready.sh` lines 116–142 — matches `❯` /
`│ >` / bottom status-line hints.

### `runtime::inject_prompt <tmux_target> <text>`
Paste `text` into the runtime's input area at `tmux_target` and submit it.
Must handle runtime-specific quirks (CC needs `send-keys -l` + 0.5s sleep +
`C-m`, because `send-keys Enter` is eaten by the TUI under some locales).

**CC today**: `ops/lib/runtimes/cc/send-prompt.sh`.

### `runtime::launch_binary`
Echo the runtime's executable name (CC: `claude`). **CC today**: `cc/launch.sh`.

### `runtime::launch_pane_script`
Echo the path to the per-pane launch script (guarantees cwd, sets the channel
via `KA_CHANNEL`, resolves `--resume`). **CC today**: `ops/lib/start-pane.sh`.

> **P2 (startup convergence)**: the following team/plugin verbs were RETIRED
> together with the CC team mechanism — `spawn_mate_prompt_template`,
> `list_registered_mates`, `describe_registered_mates`, `settings_path`,
> `telegram_status`, `flock_patch_status`. Mates are now independent CC
> processes in their own tmux panes (`ka workshop`), not Agent-spawned team
> subagents; Telegram goes through the daemon (not the plugin); there is no
> flock guard. See `docs/P2_STARTUP_CONVERGENCE.md`.

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

## Adding a new runtime (phase 3 onwards)

1. `mkdir ops/lib/runtimes/<name>`
2. Implement each required function in files at conventional paths (`launch.sh`,
   `ready-signals.sh`, `send-prompt.sh`, `mates.sh`, `telegram.sh`).
3. Add contract tests (phase 2+) under `ops/tests/cases/<NN>-runtime-<name>-contract.sh`:
   for each function, assert that calling it against a known fixture produces
   the expected output.
4. Document in `docs/KA_CLI_RUNTIME_DESIGN.md` §Migration Path which runtime
   version / CLI version the adapter was validated against, and any gaps
   (e.g. "Gemini has no mate registry — `list_registered_mates` always empty").
