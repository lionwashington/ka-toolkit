# Reliability update: isolated production-readiness review

Current status: production installation and service restart completed after
explicit user approval. See the [deployment record](#production-deployment-record)
below. The preflight sections remain historical evidence, not outstanding work.

## Verified without production changes

- The candidate retains the primary worktree's existing Codex resume/start
  timeout overrides and failed-start watcher cleanup, together with their tests.
  The candidate's selector already implements the same resume timeout behavior.
  Model propagation and per-mate owner preference remain present.
- Unrelated Google-skill, Google-install documentation and research-document
  changes stay in the primary worktree. They were not overwritten, staged or
  bundled into this reliability change. Do not run a blanket skills deployment
  from this worktree; use component-scoped deployment.
- A real native installation was executed in disk-backed scratch space, with
  one CPU affinity, nice 19, idle I/O priority, a 384 MB Node heap setting,
  a private npm cache and CUDA downloads disabled. A Node heap setting is not
  a system-wide/native-memory hard cap. Production shares host resources, so
  these controls minimize contention rather than promising zero resource use.
- The installed native closure passed a LanceDB vector insert/query and ONNX
  CPU inference using a tiny synthetic Identity model. No large embedding
  model was downloaded or loaded, and no private corpus was read.
- The actual published KB entry started on an allocated loopback test port,
  became ready in FTS5 mode and served kb_status, kb_list_topics,
  kb_search(max_results=1) and kb_read_topic through the MCP transport.
  Release integrity still passed afterwards.
- The native test's processes and task-created scratch directory were cleaned
  up. Its deterministic test is `tests/kb-native-release-e2e.mjs`, opt-in with
  `KA_RUN_NATIVE_INSTALL=1`; it is intentionally outside routine lightweight
  tests because it installs real dependencies.
- After reconciliation, channel-core passed 36 tests. The rebuilt published
  artifacts then passed the Telegram Codex bridge test and all five Lark Codex
  bridge tests. Added/new content scanning found no credential-token, personal
  home-path or email pattern matches; diff whitespace validation also passed.

The earlier phase-2 note that actual native installation was untested is now
superseded by this canary. Full e5 embedding warmup/search and macOS launchctl
execution remain outside this Linux, FTS5-first acceptance.

## Production procedure — approval required for each execution

1. Record baseline daemon status, configured models and thread ownership;
   privately back up affected code, configuration and hook registration. Keep
   health/KB data, logs, attachments, locks and embedding caches in place.
2. Prepare and verify complete component artifacts before the maintenance
   window. Avoid npm downloads/builds while services are stopped. Only move
   verified code/dependency artifacts into owned component staging directories.
3. Arrange a short maintenance window and wait for active turns/distillation
   to finish. Pause the relevant keepalive entry during the one-time legacy
   migration so it cannot race the change. Do not kill a running model turn or
   truncate/rotate its rollout to make deployment easier.
4. Stop only the affected daemons. With downtime explicitly confirmed, perform
   the one-time component bootstrap. Install the capture hook, snapshot CLI and
   worker together. Preserve the primary worktree's unrelated changes. Never
   deploy the source worktree wholesale over the runtime or private data tree.
5. Start KB and the selected channel; verify readiness, all four KB tools,
   streaming, duplicate suppression, image batching and normal routing. Confirm
   private data roots and model/owner status. Restore keepalive after health
   checks pass. Workshop/mate restart is not automatic: schedule a targeted mate
   canary only if launcher/model configuration changes require it.
6. On failure, stop only the affected service and restore its prior verified
   release pointer. For the initial legacy bootstrap, restore backed-up legacy
   entrypoints instead. Restore associated configuration/registration if changed;
   do not roll back raw data or distillation watermarks along with code.

Publication is atomic per component, not across all components or LLM topic
edits. No production installation, restart, commit or push was performed during
this readiness review.

## Production deployment record

The owner subsequently authorized installation and restart, including the
temporary interruption of the channel carrying the deployment conversation.
This is separate from the earlier restart that only restarted existing code.

### Installed and activated

- Built the KB native closure and both channel bundles in a separate disk-backed
  staging runtime before stopping production. Built both capture adapters and
  the core CLI. The Claude package name is `@ka/adapter-claude-code`, not
  `@ka/adapter-cc`; a missing-hook check caught that build-selection mistake
  before production changes, and the correct package was built.
- Privately backed up affected code, configuration, hook registration and cron.
  Installed three versioned components: KB, Telegram and Lark. Copied 22 related
  hook/CLI, worker, launcher/helper and template files, without a blanket skills
  deployment or inclusion of unrelated primary-worktree changes.
- Confirmed distillation was finished; temporarily uninstalled only the distill
  and KB/channel keepalive scheduler entries. Stopped KB and Telegram, verified
  their ports were closed, then performed the legacy bootstrap.
- Started the new KB and Telegram releases. Lark code is installed but its
  previously inactive service remains inactive. Workshop launcher changes are
  installed; existing mate sessions were not cleared or recreated. New-launch
  behavior is covered by isolated tests, not by a production mate relaunch.
- Restored the original scheduler entries; compared their contents independent
  of ordering. Live configuration and hook registration hashes stayed unchanged
  (the example template intentionally changed). Secret-file mode remains 0600.
- Kept private health data, raw conversations, watermarks and caches in place.
  Added only local Git exclude rules for `memory/raw/*.md.lock` and
  `memory/raw/.raw-write-*`; persistent Markdown is not excluded by these rules.

### Acceptance and remaining boundaries

- Re-ran all 14 reliability tests: passed. All three deployed release manifests
  verified, and the 22 copied files matched the candidate artifacts.
- Production KB became ready in FTS5 mode. Real MCP calls passed: `kb_status`
  (85 ms), `kb_list_topics` (104 ms), `kb_search(max_results=1)` (31 ms) and
  `kb_read_topic` using a filename identifier (18 ms). These are single smoke
  measurements, not latency guarantees.
- The first read attempt using a display title failed; the filename-identifier
  read succeeded. Display-title resolution remains a separate issue to
  investigate, not a fully validated mapping or a proven new regression.
- All three previously online mates reconnected and reported alive; probe and
  reply failure counters were zero at acceptance. Observed model status was
  available. This does not prove every current registrar adopted new-launch
  configuration without a mate restart.
- Streaming, duplicate suppression and media grouping have isolated artifact
  regression coverage. No fresh end-to-end real Telegram/Lark media conversation
  was injected during this deployment. Normal production use remains the live
  canary. No full embedding-model warmup or macOS live execution was added.

### Rollback and source status

The private deployment directory retains code/config backups, a per-file plan,
release metadata and bounded installation/acceptance logs. It is outside the
public repository; do not publish it because backups include private config.
The exact local location was retained in the deployment session.

For this first bootstrap, rollback means stopping the affected service and
restoring its backed-up legacy entrypoints and the coordinated hook/CLI/worker
files, then starting it again. Retain new releases for inspection; do not roll
back knowledge data or capture watermarks with code. Future rollbacks between
retained releases use the verified component pointer command documented in
phase 2, followed by an explicitly authorized restart.

Installation did not include a commit, push or merge. The owner subsequently
authorized Git integration; this record is included with the reliability source
changes, while unrelated primary-worktree edits remain outside the commit.
