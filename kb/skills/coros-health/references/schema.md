# COROS local data contract

## Layout

All personal data lives below the configured data root, never in the Skill source tree.

```text
raw/activities.json          merged COROS activity metadata
raw/fit/<activity-id>.fit    immutable, validated binary FIT files
derived/activities.jsonl     normalized activities, one row per activity
derived/running.csv          running summary table
derived/running-splits.csv   normalized lap table
derived/baselines.json       cached comparison groups
state/sync-state.json        watermarks, hashes, schema and algorithm versions
state/annotations.json       optional user annotations keyed by activity ID
README.md                    generated local schema note; contains no credentials
```

Raw FIT files are accepted only when:

1. bytes 8–11 equal ASCII `.FIT`;
2. the declared FIT length matches the downloaded length;
3. the Garmin SDK integrity/CRC check passes;
4. the file is written to the requested activity ID using an atomic rename.

The COROS download endpoint may return JSON containing `data.fileUrl`. Follow that URL and validate the second response; never store the link JSON as FIT.

## Normalized metrics

Prefer FIT session/lap values, then fill absent overview values from COROS metadata. Persist distance, timer and elapsed time, pace, heart rate, cadence, power, temperature, ascent, calories, training load, device and sport fields when available.

FIT running cadence commonly represents one-foot strides per minute. Values below 130 are normalized to total steps per minute by multiplying by two; derived cadence columns always use `spm`.

A complete kilometre lap has distance from 950 through 1050 metres. Sort laps by start time or message order before selecting segments.

### Steady first 5 km

Select the first five complete kilometre laps only.

- `timer_time_s`: sum of lap timer time; fall back to elapsed time per lap.
- `avg_hr`: time-weighted mean of lap average heart rate.
- `pace_s_per_km`: `timer_time_s / 5`.
- `ef`: `(5000 / timer_time_s * 60) / avg_hr`.

### Finishing kilometre

Select the sixth complete kilometre lap only. Preserve its timer time, pace, average/maximum heart rate, average cadence and maximum speed.

User annotations have priority. A local annotation can be represented as:

```json
{
  "activity-id": {
    "finish_1k": "爽跑",
    "note": "optional local note"
  }
}
```

Automatic inference requires all of the following: six complete kilometre laps; sixth-lap pace at least 15% faster than the steady pace; sixth-lap average heart rate at least 10 bpm higher; total activity distance between 5.8 and 6.5 km. Label it `inferred` and retain the rule in output.

## Comparison sets

Build mean and median metrics for:

- prior runs within 60 days of the target;
- prior runs on the same device;
- explicitly annotated finishing efforts;
- inferred finishing efforts, kept distinguishable from annotations;
- each normalized device group, including PACE 2 and PACE 4 when present.

Percent difference is `(target - baseline) / baseline * 100`. For pace, a negative difference means faster. Report sample counts and retain device and temperature alongside performance metrics.

## Versioning

Increment `SCHEMA_VERSION` for incompatible persisted-shape changes and `ALGORITHM_VERSION` whenever derived metric logic changes. `rebuild` regenerates derived data without changing raw FIT files.
