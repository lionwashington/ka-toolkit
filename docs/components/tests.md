# tests/ — Docker integration tests

Docker-based integration tests for the ops layer. **Never** touches your live
tmux session — everything runs in a throwaway container.

## Run locally

```bash
tests/run.sh                  # the case suite inside the container
tests/run-all-in-docker.sh    # build the image + run the whole suite (expect 17/17)
```

Requires Docker. The image is built from `tests/Dockerfile`.

## What's covered

The full suite lives in `tests/cases/<NN>-*.sh` (17 cases). A few examples:

| Case                          | Exercises                                                 |
| ----------------------------- | --------------------------------------------------------- |
| 01-yaml-parse                 | `workshop/ops/yaml-parse.sh` emits correct flat records.  |
| 03-inject-prompt              | `workshop/ops/inject-prompt.sh` delivers text into fake claude. |
| 26-channel-kind               | daemon port/kind resolution from `config.yaml` + fail-closed. |
| 27-ka-daemon                  | `ka daemon` verbs / status / kind targeting.              |
| 28-distill-chunk              | chunked distill over an oversized snapshot (bounded memory). |

## Fake claude

`tests/fakes/claude` is a shell script put on `$PATH` in the container. It
logs its stdin to `/tmp/claude-<pane>.log` and blocks — enough to simulate
an interactive process for tmux + process-tree detection.

## CI

Drop-in for GitHub Actions:

```yaml
- run: tests/run-all-in-docker.sh
```
