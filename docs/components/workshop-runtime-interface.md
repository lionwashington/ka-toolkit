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
without `resume` in the pane foreground, while a background registrar waits for
its `thread/started`/`thread/list` result and registers that ID immediately.
Foreground ownership is required for reliable terminal input initialization.
Because the rollout may not yet be resumable, the first registration carries
`allow_unpersisted_thread`; after persistence the registrar
reposts the same runtime identity without that flag. Channel promotes the existing
client with `thread/resume`, preserving the active WebSocket and enabling delta
notifications used by platform streaming.

### Codex remote startup: hook review and terminal ownership

Validated against Codex **0.153.4**. Having bypass flags in process argv is not
proof of unattended TUI startup:

- Upstream `tui/src/lib.rs` explicitly disables the startup hook-review bypass
  for persistent `--remote ... resume` connections, because an already-running
  thread can ignore resume overrides. See the
  [0.153.4 implementation](https://github.com/openai/codex/blob/rust-v0.153.4/codex-rs/tui/src/lib.rs#L1662).
- The App Server CLI branch passes `root_config_overrides`, not the interactive
  hook-bypass flag, into the server. Adding the same flag again is insufficient.
- Channel/App Server `alive` or a successful channel reply does **not** establish
  TUI readiness. A hook-review modal must defeat prompt/status readiness hints.

`codex/hook-trust-overrides.mjs` starts a short-lived, terminal-detached Codex
probe with the same workspace/config arguments. It only initializes and calls
`hooks/list`; it never resumes a business thread, submits a turn, or writes trust
through the configuration API. The exact enabled, untrusted/modified hook keys
and hashes become a `hooks.state` **CLI-only** overlay for both the real sidecar
and TUI. Hashes come from Codex, not a duplicated hashing implementation.
Already-trusted, managed and disabled hooks are left alone; no approval or
sandbox setting is changed by this compatibility fix. Discovery errors, invalid
metadata, or a 20-second timeout fail startup explicitly instead of waiting for
an invisible approval. Configuration/plugin error bodies are not copied to the
pane. Do not edit hook definitions concurrently with startup: a changed hash
must be reviewed/resolved again, never silently matched to an old hash.

`codex/detached-process.mjs` starts the real sidecar in a separate POSIX session
and forwards shutdown to its own process group. All three standard descriptors
remain redirected. Redirecting stdin alone does **not** remove access to
`/dev/tty`; the session boundary prevents sidecar/MCP/tool children from changing
the foreground TUI's controlling terminal. The TUI remains in the foreground;
the launcher does not repeatedly force `stty raw` or synthesize trust keystrokes.

The recurring canonical-mode overwrite was reproduced with the full launcher
on Codex 0.154.0 / Node 24.15.0. `strace -f -tt -yy -e ioctl,execve` identifies
the registrar's JSON-building `node -e` process, not the App Server, as the
writer: the TUI sets raw mode with `TCSETS2`; the registrar exits shortly after
and applies its old canonical snapshot with `TCSETS` through **stderr** on the
same PTY. Node restores inherited stdio termios on exit even when the script
never reads keyboard input. This explains why a startup `stty` or stdin-only
redirection is insufficient and why the failure depends on startup timing.

Both background paths (`register_loop` and
`discover_and_register_fresh_thread`) now redirect all three standard
descriptors **before** forking their Node children: stdin is `/dev/null`, stdout
and stderr go to the existing private sidecar log. No registrar Node receives
a pane standard descriptor to snapshot/restore. Sidecar session isolation
remains a separate defensive boundary; it did not isolate the registrar.

Codex **0.154.0** rejects `--dangerously-bypass-approvals-and-sandbox` on
remote resume (`Permission overrides are not supported when resuming a remote
task`). The launcher no longer injects that flag into the TUI and removes the
historical explicit flag/`--yolo` alias. Existing sidecar/thread permissions and
persisted user configuration are unchanged. This does not authorize changing
other explicit permission options.

The temporary startup `stty` mitigation has been removed. Codex owns its own
terminal initialization/restoration; there is no delayed repair or mode
watchdog. Check actual keyboard input after upgrades; channel liveness alone
is insufficient because the sidecar can survive a failed TUI.

Regression checks (isolated, no production daemon/mate restarts):

```sh
node --test tests/workshop-codex-hook-trust.test.mjs tests/workshop-codex-ready.test.mjs tests/workshop-codex-tty.test.mjs
bash tests/cases/17-runtime-codex-contract.sh
pnpm test:reliability
# Opt-in actual Codex remote/resume test (Linux/WSL, Codex + tmux + stty):
node tests/manual/codex-remote-startup.mjs
# Exercise the complete launcher, including its background registrar:
KA_TEST_LAUNCHER=1 node tests/manual/codex-remote-startup.mjs
# Optional isolated syscall evidence (never attach to production processes):
KA_TEST_LAUNCHER=1 KA_TEST_STRACE=/path/to/strace KA_TEST_TRACE_PREFIX=/tmp/ka-tty-test node tests/manual/codex-remote-startup.mjs
```

The PTY checks require Python 3 on POSIX. They demonstrate the old shared-TTY
failure mechanism, reject `/dev/tty` access from the detached child, and verify
raw arrow/Enter bytes without echo. Also verify the actual Codex TUI (not only
RPC status) on a dedicated test instance before rolling out a Codex upgrade.
The registrar regression uses real Node and a deterministic handshake: Node
starts in canonical mode, the foreground switches to raw, then Node exits.
Inherited stderr reproduces the overwrite; both actual redirected launcher
branches preserve raw mode. Merely exercising the detached App Server would
miss this distinct background process.
The opt-in test uses a temporary Codex configuration, a dedicated tmux socket
and a loopback mock model without authentication. It compares flag-only startup
with invocation-local trust (including a changed hook), verifies composer
readiness plus arrow editing and Enter `/status`, and checks that the fixture's
configuration remains byte-identical. It prints only validation indicators.
These launcher changes take effect only on subsequent launches after normal KA
code installation. Existing mates need an owner-approved serial rolling restart;
the channel daemon does not need restarting for this change.

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
