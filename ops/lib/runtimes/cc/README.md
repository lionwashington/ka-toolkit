# CC Runtime Adapter

The CC-specific logic for the agent-runtime abstraction. Each runtime-facing
function in `../interface.md` is implemented by one of the files below.
`ops/cli/*.sh` source `../dispatch.sh` + `runtime_load "cc"` and then call
`runtime::<verb>` instead of inlining CC-specific behavior.

> **P2 (startup convergence)**: the team/plugin adapter files (`mates.sh`,
> `telegram.sh`, `spawn-template.sh`) were removed with the CC team mechanism.
> The remaining adapter is launch / ready-detection / prompt-injection only.

```
cc/
├── README.md           (this file)
├── launch.sh           # runtime::launch_pane_script + ::launch_binary + ::telegram_channel_args
├── ready-signals.sh    # runtime::ready_match
└── send-prompt.sh      # runtime::inject_prompt
```

## Notes

- `ops/lib/start-pane.sh` (the pane entrypoint) stays under `ops/lib/` — tmux
  invokes it directly as an executable. `cc/launch.sh` exposes its path via
  `runtime::launch_pane_script` so phase-3 adapters can ship their own.
- Mates are independent CC processes in their own tmux panes (`ka workshop`),
  not Agent-spawned team subagents. See `docs/P2_STARTUP_CONVERGENCE.md`.
