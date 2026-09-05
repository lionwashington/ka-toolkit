# Reliability phase 1: implementation and acceptance boundary

This is the phase-1 historical acceptance record. The snapshot and component
deployment limitations below are superseded by [phase 2](RELIABILITY_PHASE2.md).
The subsequently authorized deployment is recorded in the
[production acceptance record](RELIABILITY_PREFLIGHT.md#production-deployment-record).

This change is developed in an isolated worktree. It does not authorize a
production installation, restart, model change, or thread migration.

## Implemented behavior

| Area | Change | Compatibility |
| --- | --- | --- |
| Workshop models | Per-runtime `models.cc` / `models.codex`, overridden by mate `model`, then explicit CLI model arguments | No configured model retains existing defaults; Claude and Codex have separate defaults |
| Codex bridge | Model travels through sidecar configuration, registration, thread creation/resume and channel turns | Status distinguishes configured model from a model actually returned by the server; missing observed model means unknown |
| Thread selection | Explicit thread, then persisted mate owner, then existing cwd fallback | Saved thread cwd is checked before resume; a mismatch fails closed |
| FTS5 | Versioned SHA-256 fingerprints identify changed sources independently of timestamp ordering | Legacy databases refresh once; unchanged text does not rebuild rows or embed |
| Codex capture | Identical content is not rewritten; continuation resets distilled state and preserves the processed prefix length | Full browse still reads all messages; only unprocessed enumeration omits the processed prefix |
| Distiller library | Versioned captures require acknowledgement of the content hash supplied to the distiller | Legacy unversioned Claude captures keep their existing acknowledgement behavior |
| Installer | Reported component failures produce nonzero exit and block subsequent activation | Selected JS bundles are staged and syntax-checked before atomic replacement |

## Important limits — not complete solutions

- FTS fingerprints require reading topic text to detect equal-size, same-mtime
  changes. This is incremental **index computation**, not zero source-file I/O.
  Rows and fingerprints share a SQLite transaction, but the external manifest
  is not part of that transaction. A failed manifest write can cause safe extra
  work on retry.
- Snapshot acknowledgement in the Distiller library is not a cross-process
  compare-and-swap. Background distillation prompts currently permit direct raw
  frontmatter edits and bypass the library. A shared snapshot/acknowledgement
  command and writer coordination need a separate integration change before
  claiming concurrent distillation is fully safe. Do not deploy the capture
  watermark changes as a complete concurrency fix.
- The library snapshot map belongs to a Distiller instance. Recreating it between
  prompt generation and result processing cannot acknowledge versioned captures;
  those remain pending. Durable job snapshots are not implemented here.
- Artifact replacement is atomic per selected JS bundle, **not per component or
  entire release**. Native dependency installation and multi-file deployments can
  still leave mixed versions. A component release directory plus a verified
  manifest/atomic activation pointer remains the recommended next step.
- A fallback to the latest cwd thread remains when there is no saved owner; this
  patch does not introduce a registry that allocates fresh threads for all mates.
- Isolated channel tests use mock Telegram/Lark APIs and a fake App Server. They
  validate routing/streaming/registration contracts, not live provider model
  availability or real-account delivery.

## Repeatable checks

Run from the repository root:

```sh
pnpm --filter @ka/core build
pnpm test:reliability
pnpm --filter @ka/core exec vitest run tests/capture.test.ts tests/distiller.test.ts src/retrieval/fts5-indexer.test.ts src/retrieval/fts5-engine.test.ts
pnpm --filter @ka/adapter-codex test
node --experimental-strip-types --test tests/channel-core/*.test.ts
pnpm --filter ./channels/telegram test
pnpm --filter ./channels/lark test
bash -n install.sh workshop/ops/yaml-parse.sh workshop/ops/runtimes/codex/bin/start-pane.sh
git diff --check
```

Fault tests exercise the actual installer functions with synthetic compilers and
temporary runtime roots. Selector subprocess tests inject a fake WebSocket and
verify ownership, explicit overrides, wrong-cwd rejection and fresh selection.
Public fixtures must remain synthetic; tests must not read private transcripts,
credentials, or health data.

## Production review gate

### Isolated acceptance results

- Core build: passed (including declaration generation).
- FTS5 and capture/distiller targeted checks: 21 passed.
- Codex capture adapter: 8 passed.
- Channel core: 34 passed. A prior run concurrent with the core build hit the
  fixture's 500 ms request timeout; the isolated targeted rerun and subsequent
  full channel-core run passed without increasing that timeout.
- Workshop selector/model and installer fault checks: 7 passed.
- Telegram unit and mock E2E: 98 passed.
- Lark unit and mock E2E: 47 passed across its two test commands.

These results do not certify the deferred concurrency or whole-release
activation behavior described above.

Before proposing installation, finish the snapshot/acknowledgement integration
or explicitly split it out, compare this branch with any existing local changes,
and review component-level activation limitations. Preserve unrelated local
work. Back up runtime configuration and ownership metadata before a separately
authorized canary deployment. Never delete or shrink existing rollout files as
part of this change.
