# Workshop Codex stop reliability

## Failure and fix plan

Closing a pane does not prove that its foreground TUI, sidecar or registrar has
exited. A remaining owner lock blocks the next start while Channel still reports
the old sidecar alive.

For Codex, resolve the configured channel alias and persisted owner PID before
removing the pane. Validate the wrapper command, mate name and isolated process
group. Signal the entire group with TERM, wait with a deadline, then escalate to
KILL if necessary. Verify no non-zombie group member remains, remove only the
unchanged owner lock, unregister Channel and verify absence. Keep thread records,
rollouts and workspace data. Missing panes/sessions must not prevent this path.
Restart must abort on stop failure. CC keeps its existing lifecycle.

No broad process-name kill, daemon restart, live workspace mutation or deployment
is part of development/testing. Concurrent external starts are not serialized by
this change; unexpected replacement owner records fail visibly.

## Isolated test plan

Use a temporary KA_HOME, a loopback fake Channel API, and real subprocess groups
launched with a new session. Never use production port, tmux session or owner PIDs.

- Stop wrapper, sidecar and registrar together, including TERM-resistant children.
- Keep an unrelated sentinel process alive.
- Handle no-pane residuals, stale owner PID and repeated stop.
- Reject a lock pointing at an unrelated process without signalling it.
- Remove the target registration only; preserve sibling registration.
- Preserve canonical thread and workspace marker.
- Keep dry-run inert; retain CC stop behavior and abort restart on stop failure.
- Run reliability and full package regression before deployment approval.

## Deployment gate

This patch is design-time only. Install and production recovery require a
separate confirmation after review of test results.
