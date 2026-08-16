---
name: coros-health
description: Synchronize COROS health, recovery, and activity data into a persistent local cache and analyze HRV, sleep, resting heart rate, stress, recovery, training load, running trends, splits, efficiency factor, and finishing-kilometre efforts. Use for requests such as “拉今天运动数据”, “最近恢复怎么样”, “HRV/睡眠趋势”, “横向对比”, “最后一公里爽跑”, COROS sync/repair, FIT validation, or PACE 2/PACE 4 analysis.
---

# COROS Health

Use the deterministic CLI in `scripts/coros-health.mjs`. Treat its JSON output as the source of truth. The official COROS MCP is the primary health/recovery source; the existing validated FIT cache remains the source for deterministic split and running analysis. Do not re-download all activities, reparse unchanged FIT files, or calculate metrics manually.

## Resolve paths

Run from the personal workspace when possible. The CLI discovers the workspace from the current directory and defaults the data root to `data/health/coros` under it.

Override only when needed:

```bash
export COROS_WORKSPACE_ROOT=/path/to/personal-workspace
export COROS_DATA_ROOT=/path/to/coros-data
export COROS_SECRETS_FILE=/path/to/private-secrets.yaml
export COROS_MCP_CACHE_ROOT=/path/to/private-ka-config/coros-mcp
```

Never print credential values. Official health/recovery access uses COROS OAuth only. The official helper stores access/refresh tokens below `COROS_MCP_CACHE_ROOT` with mode `0600`, and refreshes an expired access token on the next MCP call; that directory must remain outside the data root and Git. The older Training Hub credentials are read only by the retained activity/FIT synchronizer and are never an OAuth fallback or a health-data source.

## Protect private data

- Keep only the reusable skill code, synthetic tests, schemas, and locked dependency metadata in the skill repository.
- Keep raw FIT files, activity metadata, wellness observations, annotations, sync state, and derived health metrics under the private data root. Never copy them into the skill directory or a public repository.
- Keep the private data root in a dedicated private repository when durable Git backup is desired. Track immutable FIT files and rebuildable metadata/derived/state assets there, while using precise ignore rules only for credentials, temporary downloads, locks, and test debris. Never place the data root in a public repository. The CLI refuses any data root inside the skill source checkout as a final guardrail.
- Keep credentials and OAuth state only in the private runtime config/keyring or process environment; never write them into the data root, logs, fixtures, or command output.

## Choose the command

- For current health/recovery plus activity data, run `sync`. It calls official OAuth wellness tools first and retains the existing incremental FIT synchronizer for activity continuity.
- For HRV, sleep, resting-HR, stress, recovery or training-load questions, run `wellness-sync`, then `wellness-trend`. If the remote call fails, use the local trend and state its `data_through` watermark.
- For ordinary comparisons, run `compare` directly. It reads persistent derived data without networking.
- For the latest cached activity, run `analyze-latest`.
- After an algorithm/schema upgrade, run `rebuild` to regenerate all derived files from valid cached FIT files.
- To audit cached files and state, run `validate`.
- During legacy migration, run `migrate --legacy-dir <path>` once, followed by `sync --repair` if credentials are available.
- For first-time official access, run `oauth-start`, have the owner open the returned COROS URL, then run `oauth-finish`. Never use the helper's legacy username/password login.

Commands:

```bash
node scripts/coros-health.mjs sync
node scripts/coros-health.mjs wellness-sync
node scripts/coros-health.mjs wellness-trend --days 28
node scripts/coros-health.mjs wellness-rebuild
node scripts/coros-health.mjs oauth-status
node scripts/coros-health.mjs analyze-latest
node scripts/coros-health.mjs compare
node scripts/coros-health.mjs rebuild
node scripts/coros-health.mjs validate
node scripts/coros-health.mjs migrate --legacy-dir /path/to/legacy/coros-data
```

Both channels are incremental. Wellness sync overlaps the last two cached days because sleep and recovery records can settle late, then replaces matching observations idempotently. `sync --repair` checks every known activity for a missing or invalid FIT but does not redownload valid files. If either remote call fails, report its status/error and cached `data_through` while continuing to use local results. Do not request official MCP FIT files merely to answer wellness questions; COROS caps them at 50 per calendar day.

## Interpret results

- Use only the first five complete 1 km laps for `steady_5k`.
- Use only the sixth complete 1 km lap for `finish_1k`; never mix it into the steady baseline.
- Treat `timer_time_s` as primary and `elapsed_time_s` only as fallback.
- Define EF as speed in metres/minute divided by time-weighted average heart rate. For the steady segment: `(5000 / timer_seconds * 60) / weighted_avg_hr`.
- Treat `finish_classification: user` as explicitly annotated and `inferred` as a transparent heuristic, not a fact. Never call every sixth lap a爽跑.
- Keep device and temperature visible as explanatory variables. Do not claim an absolute fitness gain from cross-device or cross-temperature differences.
- Prefer comparisons with a non-zero sample count and state the sample size.
- Treat HRV as an individual trend, not a cross-person score. Associate daily wellness rows with cached activity training load by date, but describe association rather than causation.

Read [references/schema.md](references/schema.md) when changing the data format, metric definitions, or annotation behavior.
