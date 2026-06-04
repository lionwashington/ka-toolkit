# CC Runtime Adapter

The CC-specific logic for the agent-runtime abstraction (source at
`workshop/ops/runtimes/cc/`). Each runtime-facing function in the adapter
interface ([`workshop-runtime-interface.md`](./workshop-runtime-interface.md)) is
implemented by one of the files there. The workshop ops scripts source
`workshop/ops/runtimes/dispatch.sh` + `runtime_load "cc"` and then call
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

- `workshop/ops/start-pane.sh` (the pane entrypoint) stays under `workshop/ops/` — tmux
  invokes it directly as an executable. `cc/launch.sh` exposes its path via
  `runtime::launch_pane_script` so future adapters can ship their own.
- Mates are independent CC processes in their own tmux panes (`ka workshop`),
  not Agent-spawned team subagents. See `docs/P2_STARTUP_CONVERGENCE.md`.
