# Kitchen data and CLI contract

## Storage and ownership

`state/kitchen.json` contains schema/algorithm versions, monotonically increasing
inventory revision, lots, equipment, immutable menus and operation audit events.
Recipes remain `recipes/recipes.jsonl`; meals remain monthly `logs/meals/*.jsonl`;
profile, pending review and daily/weekly caches retain their legacy relative paths
under the new kitchen root. Ingredient records/index/evidence remain in nutrition.

Each kitchen CLI invocation acquires an OS file lock, including reads. Mutations
buffer file changes, persist a fsynced transaction journal, then atomically replace
each affected file. On the next invocation the journal replays idempotently before
any read. Failed validation discards buffered writes. The supervisor passes its
lock FD to the worker so a killed supervisor cannot unlock a living writer.
Do not call low-level internal JS mutation functions concurrently: only the CLI
is the supported transactional mutation boundary.

This is incremental **calculation**, not zero-copy storage: kitchen state/audit
JSON and an affected monthly file are rewritten as whole files. Daily/weekly
calculations change only affected dates/weeks. Explicit rebuild recalculates all
consumption caches. Ingredient revisions never rewrite historical meal snapshots.

Ignore `.kitchen.lock`, `state/.transaction.json` and `*.tmp-*` in the private
repository. A journal may contain private data and must not be committed. Do not
remove a pending journal or recreate a lock inode while a writer is active.

## Payloads

Pass JSON via `--file`; examples here are synthetic. Stock `add`:

```json
{"operation_id":"stock-1","id":"batch-1","ingredient_id":"synthetic-food","quantity":300,"unit":"g","weight_state":"raw","certainty":"measured","location":"freezer"}
```

Units: `g`, `ml`, `unit`. Certainty: `measured`, `estimated`, `unknown`; unknown
quantity is null. Optional `ingredient_revision` pins a nutrition revision;
otherwise current verified data is used at calculation and then snapshotted.
Use separate lots for different observed states. Do not claim safety based only
on the optional `expiry_label` or `checked_at` fields.

Stock `adjust` is an absolute recount of the named lot and requires
`expected_revision`. Cooking also requires that revision; profile/menu/equipment
mutations advance it conservatively so an old confirmation cannot be replayed
against changed constraints unnoticed.

Recipe add/update uses the legacy ingredient item format, plus `steps`,
`equipment` and `estimated_minutes`. Equipment requirements may be IDs or
`{"id":"pot","capacity_ml":1000}`. Confirm actual capacity at equipment setup.
Recipes persist ingredient snapshots, raw inputs and a request fingerprint.
Recipe `compare` uses total-batch deltas; normalize servings before interpreting
two differently sized batches as equivalent meals.

Planning input:

```json
{"people":2,"dishes":[{"recipe_id":"synthetic-bowl","version":1,"factor":1}],"constraints":{"targets":{"kcal":{"min":400,"max":500}},"max_minutes":30,"allow_purchase":false}}
```

Alternatively provide `items` directly with optional equipment/time. Targets
apply per person; numeric min/max bounds are explicit, never inferred tolerance.
Profile `planning_defaults` supply defaults; `exclude_ingredient_ids` cannot be
removed by a draft. No-purchase is the default. The agent is responsible for
declaring relevant ingredient exclusions, utensil needs and cooking steps.

Prepared food can be used by `{"lot_id":"prepared-1","grams":100}` or `units`
matching its confirmed yield unit. Nutrients scale its immutable batch snapshot,
not today's ingredient values. `menu save` adds `id`, `version`, `operation_id`
and stores the evaluated plan without deducting stock. No reservation system:
two future menus may compete for the same stock; re-evaluate before cooking.

Actual cooking:

```json
{"operation_id":"cook-1","expected_revision":1,"allocations":[{"lot_id":"batch-1","quantity":100}],"output":{"id":"prepared-1","quantity":90,"unit":"g","location":"fridge"}}
```

Allocations are actual gross quantities in each lot's unit. Only measured,
sufficient stock can be deducted. `output` is optional and must be a measured
whole cooked yield; it is not assumed from raw weight. If only some of the yield
was retained, record the whole yield then the portions consumed or recounted.
Nutrients assume the declared ingredients were retained; discarded oil/liquid
or uncertain retention must be clarified before treating the result as exact.

Actual prepared-food consumption:

```json
{"id":"meal-1","operation_id":"eat-1","expected_revision":2,"date":"2031-04-05","prepared":[{"lot_id":"prepared-1","quantity":45}]}
```

Generic `meal log` instead accepts legacy `items` and an explicit unique `id`.
It records intake only and never guesses stock consumption. Dates are explicit
local calendar dates; do not derive a meal day using UTC when the user means local
time. `day/week summary --date YYYY-MM-DD` are read-only; weekly average is over
logged days, not assumed zero intake on missing days.

## Validation and evidence

`validate` reports malformed core records, duplicate identities, negative stock
and missing daily caches. It is not a food-safety or comprehensive schema proof.
Unknown kitchen schema versions fail closed; an algorithm mismatch can be
reconciled by explicit `rebuild` when this implementation supports the schema.
Default recipe/meal output omits evidence; full JSON exposes local snapshots.
Read errors remain errors; corrupted JSON is never reset to an empty inventory.
