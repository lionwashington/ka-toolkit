# Reliability phase 2: durable capture acknowledgements and component releases

For the subsequent real-native canary and primary-worktree reconciliation, see
[the isolated preflight review](RELIABILITY_PREFLIGHT.md).

This document records development and isolated tests. Production installation
was subsequently authorized and completed; see the
[deployment record](RELIABILITY_PREFLIGHT.md#production-deployment-record).
Git integration is a separately authorized step after deployment. Unrelated
primary-worktree changes remain outside this change.

## Codex snapshots

`capture-snapshot-cli.js` is a bundled core CLI, copied by the existing core-cli
installer. Two commands form the agent contract:

```sh
node "$CLI" snapshot --raw-dir "$RAW_DIR" --file synthetic.md --job "$PRIVATE_JOB"
node "$CLI" ack --job "$PRIVATE_JOB" --topics-json '["synthetic-topic"]'
```

- Snapshot jobs are immutable, schema-versioned, mode 600 and contain private
  text. Store them under private KA state, never public source or fixtures.
  Only the explicit snapshot command emits text. Acknowledgement emits status
  and `complete`; errors do not dump input text, paths or environment.
- A snapshot omits an already processed prefix. Acknowledging a prefix after
  an append advances the prefix without marking the new tail distilled.
  `complete: false` means more work remains; it is not a full-raw success.
- Corrections to the snapshot prefix produce conflict (exit 3), not an
  overwrite. Repeated acknowledgement does not rewrite the file.
- Codex capture and acknowledgement use full-file compare-and-swap protected
  by a POSIX advisory lock, then fsync and atomic rename. Conflicts retry at most
  eight times; a five-second writer timeout fails visibly. Older capture
  offsets cannot replace newer captures.
- Python 3 with the standard-library `fcntl` module is required (Linux/macOS).
  The OS releases locks after process death. Lock files are intentionally kept
  to retain inode identity; exclude `raw/*.md.lock` from private Git. They do not
  contain transcript bodies and do not require stale-lock deletion. Also exclude
  `raw/.raw-write-*`: process death before rename can leave a temporary file.
- The background worker explicitly routes Codex raws to snapshot/ack. It does
  not append Claude reader output/offset fields into Codex raws. The CLI rejects
  Claude input; the existing Claude workflow remains separate.
- The Distiller library also returns serializable `capturedVersions`; pass it
  as the third argument of `processResult` after resuming a durable job. Missing
  versions fail closed for versioned captures.

This guarantees raw-capture revision safety for cooperating writers, not
exactly-once LLM topic edits. A crash after editing a topic but before ack may
require retry and knowledge deduplication. Direct manual writes bypass the CAS
protocol. Global transactional topic/distill-job application is a separate task.

## Component publication

The KB MCP/daemon (including native dependencies), Telegram daemon and Lark
daemon now build into `.releases/.stage-*` inside their stable component root.
After script syntax checks and a hash/mode/symlink manifest, publishing renames
the stage to `.releases/r-*` and atomically switches `current`.

- Existing root entrypoints become compatibility launchers. Each invocation
  resolves one physical release; subsequent imports stay with it even if a new
  release is published. The launcher preserves direct-entry guards and args.
- Shell launchers separate stable `KA_COMPONENT_ROOT` from pinned
  `KA_COMPONENT_CODE_ROOT`. Logs, PIDs, locks, attachments and the embedding
  cache remain in the stable root. Releases contain code/dependencies only.
- Build/native-install/validation failure does not change the selected release.
  Failed stages and old releases are retained for inspection and rollback;
  there is no automatic recursive garbage collection.
- Publication is per component, not an all-components transaction. A later
  component failure may leave an earlier component's new release selected for
  its next launch; activation/restarts are skipped on failure.
- First migration from a legacy directory fails closed. Only after arranging
  an offline maintenance window may the operator set `KA_COMPONENT_BOOTSTRAP=1`
  for installation. This flag is an operator assertion, not automatic proof of
  downtime. Legacy entrypoints are backed up; other legacy files are retained.
  Bootstrap itself is not an atomic legacy-to-wrapper migration and must not
  race a startup. Subsequent publications use the atomic pointer.
- A changed entrypoint set requires a maintenance migration; it is rejected
  during ordinary publication. Stop/start is still separately authorized.

Read-only verification and explicit rollback of a selected component:

```sh
python3 shared/ops/component-release.py verify "$COMPONENT_ROOT" "$RELEASE_ID"
python3 shared/ops/component-release.py rollback "$COMPONENT_ROOT" "$RELEASE_ID"
```

Rollback validates the retained release and compatible entrypoints before
switching. It does not restart processes. Native import/runtime compatibility is
not proved by a hash manifest or syntax check; test the actual selected backend
in an authorized canary before production rollout.

## Isolated acceptance

`pnpm test:reliability` includes durable CLI/discovery, immutable jobs, prefix
acknowledgement, correction conflicts, concurrent writers, killed-lock-holder
recovery, component pinning/rollback/tamper checks, entry guards and actual KB
deployment with a deliberately failing native installer.

Build `@ka/core` and `@ka/adapter-codex` before this suite: its subprocess tests
intentionally execute the built CLI and capture hook, not substitutes. The root
`pnpm test` also includes this suite after the existing regressions.

The actual `install.sh --only daemon` was run against a temporary runtime.
Telegram and Lark tests then used those published artifacts via
`KA_TEST_DAEMON_BUNDLE`, with mock external services and temporary state. No real
account, model request or production daemon is used by these checks.

Recorded Linux results (228 tests, excluding duplicate reruns):

| Suite | Passed |
| --- | ---: |
| Reliability, subprocess concurrency and publication | 14 |
| Core capture/distiller/FTS5 | 22 |
| Codex capture adapter | 8 |
| Channel core | 34 |
| Claude/Codex distill runtime isolation | 5 |
| Published Telegram artifact, unit + mock E2E | 98 |
| Published Lark artifact, unit + mock E2E | 47 |

Core/adapter builds, shell syntax and diff whitespace checks passed. Added lines
and new files had zero matches for credential-token, personal-home-path and
email patterns. This targeted scan is not a claim that all historical repository
content has been audited. macOS launchctl execution and actual native embedding
backend installation were not exercised in this initial Linux run. The later
real-native canary in the preflight record supersedes the native-installation
limitation; full embedding-model warmup remains untested.

Before production: review the combined diff against pre-existing local changes,
run a canary with the real KB backend/native closure, install the core snapshot
CLI together with the capture hook/worker, and arrange the one-time bootstrap
maintenance window. Do not roll back capture watermarks merely to roll back code.
