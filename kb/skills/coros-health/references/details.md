# Full official data access

`details-sync` archives all supported read-only raw-data tool responses, without
asking a model to interpret them. Initial health range defaults to the earliest
cached wellness day through today. Override `--from`/`--to` for older history.
All known activity IDs are queried for detail and app-visible laps regardless of
the health range. Existing FIT binaries are reused, never downloaded again here.

`--max-calls N` bounds one invocation; repeat to resume. Successful immutable
historical requests are skipped, recent three days and snapshots refresh once
per day. `--refresh` explicitly rechecks settled history. A failure circuit stops
after five failures; cached records survive. A stale `.sync-lock` requires checking
for a live worker before manual recovery. Never delete a live lock.

## Agent discovery

1. `details-schema`: full current official tool descriptions/input schemas and
   local envelope schema, dataset meanings, exclusions and limitations.
2. `details-list --tool <official-name> [--date YYYY-MM-DD] --limit 20 --offset 0`:
   paginated local catalogue, status, scope and acquisition time; no raw contents.
3. `details-read --key <key>`: complete response, including unknown fields, and
   a lossless field index. Read only needed records; do not dump all time series
   into the conversation. `payload` is the source, `fields` is navigation, not a
   guessed numeric interpretation. JSON-encoded text is decoded; no field is
   discarded except credentials. Source lines preserve labels and units verbatim.

The official API often returns prose rather than typed output schemas. Do not
claim a static exhaustive typed output schema exists. The envelope supports all
JSON types and preserves new fields; actual labels/types come from each payload.

## Field meanings and units

| Dataset | Fields to recognize | Units/semantics |
|---|---|---|
| Sleep | Main Sleep, Sleep Score, Deep/Light/REM Ratio, Awake Ratio/Time/Count, Main Sleep Window, Naps Total/windows | source h/min, ratios %, vendor score; dates are wake-up days; retain actual local start/end strings |
| Sleep HRV | HRV Avg, Normal Range, Baseline, evaluation; timestamp, timezone, hrv, status, confidence | assessment ms; raw timestamp seconds as labelled; timezone/status/confidence are vendor codes until documented; do not average raw samples to replace assessment |
| Daily health | Steps, Calories, Exercise, Floors, Stress, Total/Deep/Light/REM/Awake, Sleep HR Avg/Min/Max | counts, kcal, h/min, bpm; sleep Total includes awake |
| Resting/average HR | daily date and value | bpm; resting, daily average and sleep average are different series |
| Stress samples | timestamp, timezone, stress, display score, stress HRV, stress HR | preserve source units/codes; no automatic clinical interpretation |
| Wellness check | timestamp/window, heart rate, HRV, stress, respiration, SpO2 | bpm, ms, vendor score, breaths/min, % where explicitly labelled; most recent complete check per query, not continuous monitoring |
| Recovery | Recovery, Level, Estimated Full Recovery | %, vendor label, duration; current snapshot, not historical backfill |
| Training load | comments, Short-Term/Long-Term Load, Load Ratio | vendor load units, dimensionless ratio; dates as returned |
| Fitness | VO2max, running level, threshold pace, race predictions | device estimates; preserve labelled unit and race distance; never turn predictions into actual results |
| Devices | device ID, firmware type, custom name | private identifiers/string codes; not necessarily firmware version |
| Profile | height, weight, birthday, gender | source units and self-reported values; not an identity verification endpoint |
| Cycles | phase, status, next period, ranges, notes | reported/predicted calendar dates; no-data is not proof of any biological state |
| Schedule | session, Plan ID, idInPlan, scheduled date, workout content | planned not completed; IDs internal, never display unnecessarily |
| Activity detail/laps | sport-dependent pace/speed, HR, elevation, cadence, power, splits and extra fields | units as returned; retain all additional fields, do not impose running schema on other sports |

## Persistence and honesty

`details/raw/<hash>.json` is an immutable content revision; `details/index.json`
points to current revisions. Changed data never deletes the prior revision.
`details/schema.json` contains sanitized public tool metadata, not OAuth state.
`details/state.json` tracks request progress; `complete` means planned calls
finished, NOT that the provider returned every historical datum. A requested date
is not a returned observation date. Check actual response/no-data notices.

Current-only tools cannot recover yesterday's snapshot; recent-only tools cannot
prove unlimited history. Daily Wellness Check queries can still omit multiple
checks on the same day. Activity catalogue uses daily partitions with limit 1000;
if a response reaches that cap, inspect for truncation before claiming coverage.
No arbitrary custom-window enumeration or generated coach summaries are fetched.
Known FIT files already preserve original binary activity data.

Keep all files private. Ignore `.sync-lock/` and `*.tmp-*`, not stable records.
Never copy device/body/activity values into public schemas or tests.
