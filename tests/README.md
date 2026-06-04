# ops/tests

Docker-based integration tests. **Never** touches your live tmux session —
everything runs in a throwaway container.

## Run locally

```bash
ops/tests/run.sh
```

Requires Docker. Build context is `ops/` (not the whole monorepo).

## What's covered

| Case                          | Exercises                                                 |
| ----------------------------- | --------------------------------------------------------- |
| 01-yaml-parse                 | `lib/yaml-parse.sh` emits correct flat records.           |
| 02-bootstrap-happy-path       | 3-pane session creation + cwd verification.               |
| 03-inject-prompt              | `inject-prompt.sh` delivers text into fake claude.        |
| 05-bootstrap-idempotent       | Re-running bootstrap preserves existing panes.            |

## Fake claude

`tests/fakes/claude` is a shell script put on `$PATH` in the container. It
logs its stdin to `/tmp/claude-<pane>.log` and blocks — enough to simulate
an interactive process for tmux + process-tree detection.

## CI

Drop-in for GitHub Actions:

```yaml
- run: ops/tests/run.sh
```
