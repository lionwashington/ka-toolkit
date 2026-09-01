# Runtime hook isolation and bounded transcript reads

## Contract

Lifecycle hooks are registered by runtime. They are not a shared pool:

| Runtime | Stop hooks |
| --- | --- |
| Codex | `codex-capture-hook.js` |
| Claude Code | `capture-hook.js`, `reply-safety-hook.py` |

The installer removes known KA hooks for the other runtime while preserving
unrelated third-party hooks. Re-running the switch is idempotent. Codex hook
trust remains an explicit Codex operation after the installed definition
changes.

## Codex capture algorithm

Codex rollouts are append-only JSONL during a turn. A Stop hook snapshots the
current file size, scans backwards in 64 KiB chunks for the requested
`task_started` boundary, then scans forward only through that turn. Repeated
`task_started` records with the same turn ID are treated as Stop continuations.

The backwards search is bounded to 64 MiB. If the turn boundary is not found,
capture fails closed; it never falls back to reading the complete rollout.
Diagnostic offsets and bytes read are stored with the captured turn.

Session-wide distillation remains a separate offset/watermark pipeline. The
Stop hook provides immediate per-turn capture; distillation advances the
canonical cross-turn session watermark and catches content produced while the
hook was disabled or unavailable.

## Reply safety algorithm

Reply safety starts with the final 1 MiB of a Claude transcript and doubles the
window until the current owner turn is present, capped at 64 MiB. Existing
state files retain cross-turn nudge and notice history. It never scans a Codex
rollout because it is not installed in Codex.

## Failure and rollout behavior

- Hook commands have short timeouts (Codex capture 10 seconds; Claude capture
  10 seconds; Claude reply safety 5 seconds).
- Capture errors do not block the model response.
- Configuration writes are atomic and backed up by the installer.
- A hook definition change requires Codex trust review. Production automation
  may use the official `hooks/list` then `config/batchWrite` trust handshake
  only after verifying the discovered command and current hash.

## Required validation

1. Unit-test turn boundaries, continuations, missing files, malformed records,
   and bounded lookback failure.
2. Spawn the built hook against a large sparse rollout and require JSON stdout,
   one captured file, bounded bytes read, and bounded elapsed time.
3. Run an isolated installer switch and assert the runtime matrix above.
4. On production, verify `hooks/list` trust and run one controlled end-to-end
   turn; record model completion time, capture bytes read, and absence of
   lingering hook processes.
