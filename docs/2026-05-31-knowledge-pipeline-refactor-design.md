# Knowledge Pipeline Refactor Design — centralized capture / compact / distill config + fail-closed

> Date: 2026-05-31 ｜ Author: ka-dev2 ｜ Status: ✅ implemented and deployed to runtime (core 92 unit tests + capture-hook/config-cli fail-closed e2e + ka doctor all green)

## Background

The "scope" and "target pane" of the three stages capture / compact / distill are scattered across multiple places and contain hardcoded logic, making them hard to see at a glance and wasteful of tokens:

- The capture whitelist `capture_channels` lives in config.yaml, defaulting to `['main']` (fail-open).
- The compact-hook is registered on `PostCompact` and does two things: archive the current session + inject a `/kb distill` prompt.
  In practice **the PostCompact event does not receive `additionalContext`**, so that distill prompt never took effect;
  and the archive logic is fully duplicated with capture (Stop) — capture reads the full transcript `.jsonl`,
  while a compact only compresses the context window and doesn't touch that file, so the compact's archive is redundant.
- The target of cron inject-prompt tasks (daily-brief / kb-distill): cron.yaml has a
  `target_pane` field, but **when `cron-run.sh` calls `inject-prompt.sh` it only passes the prompt, not the
  target_pane**, and `inject-prompt.sh` in turn hardcodes a call to `detect-main-pane.sh` to probe for
  `@ka_channel=main`. So the config is a no-op and the target is hardcoded.

## Goals

The same functionality, but clearer and more token-frugal, and following the owner's design principles:

1. **Centralized config**: channel-related config converges to one place in config.yaml.
2. **fail-closed** (better to do nothing than do the wrong thing): only act when there's config; do nothing if there's no config / the config is wrong.
3. **Misconfiguration visible**: if configured but the name is wrong (no matching pane is found), `ka doctor` flags it.

## Config Shape (new `channels` block in config.yaml)

```yaml
channels:
  capture: [main]   # array: only the listed channels have their conversations captured
  inject:  [main]   # array: scheduled inject-type tasks inject into these channels
```

- Both are string arrays whose values are channel names (= tmux `@ka_channel` = process `KA_CHANNEL`).
- **fail-closed**: a missing key or an empty array → the corresponding feature does not work (no capture / no inject). No more
  `['main']` default fallback.
- The install config template explicitly writes `capture: [main]` / `inject: [main]` by default, so "usually"
  it's main, but that is explicit config, not a code fallback.

## Per-Component Changes

### 1. `@ka/core` config schema
- Remove the existing top-level `capture_channels`, replace with `channels: { capture: string[], inject: string[] }`.
- Change the default to "missing means empty" semantics (fail-closed), no more `.default(['main'])`.
- Keep `.catch` tolerance: a type error → fall back to an empty array (= do nothing), never let `loadConfig` throw.
- helper `isCaptureChannelAllowed(channel, config)`: true only if the whitelist is non-empty and matches; empty/missing/malformed → false (fail-closed). Add `injectTargets(config): string[]` to read `channels.inject`.

### 2. Cut the compact-hook
- Delete `packages/adapters/claude-code/src/hooks/compact-hook.ts` + its dist artifact.
- `deploy_hooks` naturally no longer bundles it (the source is gone).
- **Delete the `PostCompact` block in `~/.claude/settings.json`** (this item only; Stop→capture is kept).
  ⚠️ settings.json is the owner's territory — before implementing this step, confirm the deletion method with the owner (manual delete / install takes over hook registration).
- Archiving is fully handled by capture(Stop); the auto-distill reminder is removed, and distill relies entirely on cron.

### 3. Make capture-hook fail-closed
- Read `channels.capture` (via `isCaptureChannelAllowed`) instead of the old `capture_channels`.
- No config / empty → don't capture any channel.
- Swallow all errors, `exit 0`, no UI popup (keep the status quo).

### 4. Make cron inject read from config (find pane by channel name)
- Refactor `inject-prompt.sh`: remove the hardcoded `detect-main-pane` call; instead accept an explicit target
  pane (resolved by the caller). No target → no inject (fail-closed).
- Add "resolve pane by channel name" logic (replacing detect-main-pane): `tmux list-panes -a -F
  '...|#{@ka_channel}'`, match the given channel name → output the pane target; not found → empty (no inject).
- The inject-prompt branch of `cron-run.sh`: read config.yaml `channels.inject` (inline python3,
  the same way it currently reads settings.json), resolve a pane for each channel in the array, and for each found pane call
  `inject-prompt.sh <pane> <prompt>`. Empty array / all not found → no inject.
- Remove the `target_pane` field from each job in `cron.yaml` (no longer scattered).
- Retire `detect-main-pane.sh` (superseded by "find pane by channel name").

### 5. `ka doctor` hints
- `channels.capture` empty/missing → ⚠️ "currently capturing no conversations (channels.capture not configured)".
- `channels.inject` empty/missing → ⚠️ "scheduled distill/daily-brief will not inject (channels.inject not configured)".
- Configured but some channel name isn't found among the running workshop panes (`@ka_channel`) → ⚠️ "the 'xxx' in inject/capture
  has no matching pane (name misconfigured?)".

### 6. install / release
- The config template (the default config.yaml install writes) contains `channels.capture:[main]` /
  `channels.inject:[main]`.
- After changes pass tests → deploy with `./install.sh --only hooks` (capture-hook) + `--only ka` (ops/cron/
  inject/doctor); confirm scope with `--dry-run` first, don't touch MCP registration without `--switch`.

## Untouched
- The distill logic itself (Distiller / `/kb distill`).
- shell-type cron (the `<your-workspace>` backup job).
- The telegram-channel daemon.

## Test Plan
- core: the new config schema structure (missing→empty, explicit array, type error→empty without throwing); `isCaptureChannelAllowed`
  fail-closed; `injectTargets`.
- capture-hook: fake-HOME isolated e2e — no config→don't archive, config [main] match→archive, no match→don't archive, bad config→don't throw, exit 0.
- cron/inject: "find pane by channel name" unit test (match / not found); cron-run inject-branch reading config
  expansion (mock tmux).
- doctor: all three hint types trigger.

## Risks / To Confirm
- **Deleting PostCompact from settings.json** (a territory red line) — confirm the deletion method with the owner before implementing §2.
- When the inject array contains multiple channels, distill will inject `/kb distill` into multiple panes (multiple CCs
  running at once, reading the same raw/) — the capability is open but defaults to just [main]; the configurer is responsible for the
  sanity of it, not blocked in code.
