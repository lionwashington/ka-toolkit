---
name: coros-health
description: Synchronize COROS activities into a persistent local cache and analyze running trends, splits, devices, efficiency factor, and finishing-kilometre efforts. Use for requests such as “拉今天运动数据”, “横向对比”, “最后一公里爽跑”, COROS sync/repair, FIT validation, running comparisons, or PACE 2/PACE 4 analysis.
---

# COROS Health

Use the deterministic CLI in `scripts/coros-health.mjs`. Treat its JSON output as the source of truth; do not re-download all activities, reparse unchanged FIT files, or calculate metrics manually.

## Resolve paths

Run from the personal workspace when possible. The CLI discovers the workspace from the current directory and defaults the data root to `data/health/coros` under it.

Override only when needed:

```bash
export COROS_WORKSPACE_ROOT=/path/to/personal-workspace
export COROS_DATA_ROOT=/path/to/coros-data
export COROS_SECRETS_FILE=/path/to/private-secrets.yaml
```

Never print credential values. The CLI reads `coros.api_url`, `coros.email`, and `coros.password` from the private YAML file, or accepts `COROS_API_URL`, `COROS_EMAIL`, and `COROS_PASSWORD` from the environment.

## Protect private data

- Keep only the reusable skill code, synthetic tests, schemas, and locked dependency metadata in the skill repository.
- Keep raw FIT files, activity metadata, annotations, sync state, and derived health metrics under the private data root. Never copy them into the skill directory or a public repository.
- Keep the private data root in a dedicated private repository when durable Git backup is desired. Track immutable FIT files and rebuildable metadata/derived/state assets there, while using precise ignore rules only for credentials, temporary downloads, locks, and test debris. Never place the data root in a public repository. The CLI refuses any data root inside the skill source checkout as a final guardrail.
- Keep credentials only in the private runtime secrets file or process environment; never write them into the data root, logs, fixtures, or command output.

## Choose the command

- For “拉今天运动数据” or any request that requires current remote data, run `sync`, then `analyze-latest` or `compare`.
- For ordinary comparisons, run `compare` directly. It reads persistent derived data without networking.
- For the latest cached activity, run `analyze-latest`.
- After an algorithm/schema upgrade, run `rebuild` to regenerate all derived files from valid cached FIT files.
- To audit cached files and state, run `validate`.
- During legacy migration, run `migrate --legacy-dir <path>` once, followed by `sync --repair` if credentials are available.

Commands:

```bash
node scripts/coros-health.mjs sync
node scripts/coros-health.mjs analyze-latest
node scripts/coros-health.mjs compare
node scripts/coros-health.mjs rebuild
node scripts/coros-health.mjs validate
node scripts/coros-health.mjs migrate --legacy-dir /path/to/legacy/coros-data
```

`sync` is incremental. `sync --repair` checks every known activity for a missing or invalid FIT but does not redownload valid files. If remote access fails, report `remote.status`, `remote.error`, and `data_through` from the output while continuing to use local results.

## Interpret results

- Use only the first five complete 1 km laps for `steady_5k`.
- Use only the sixth complete 1 km lap for `finish_1k`; never mix it into the steady baseline.
- Treat `timer_time_s` as primary and `elapsed_time_s` only as fallback.
- Define EF as speed in metres/minute divided by time-weighted average heart rate. For the steady segment: `(5000 / timer_seconds * 60) / weighted_avg_hr`.
- Treat `finish_classification: user` as explicitly annotated and `inferred` as a transparent heuristic, not a fact. Never call every sixth lap a爽跑.
- Keep device and temperature visible as explanatory variables. Do not claim an absolute fitness gain from cross-device or cross-temperature differences.
- Prefer comparisons with a non-zero sample count and state the sample size.

Read [references/schema.md](references/schema.md) when changing the data format, metric definitions, or annotation behavior.
