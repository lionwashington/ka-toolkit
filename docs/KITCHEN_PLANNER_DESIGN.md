# Ingredient knowledge and kitchen reality separation

## Scope and authorization

This branch implements the approved separation and isolated acceptance. It does
not authorize production migration, installation, service restart or Git pushes.
No private ingredient/health records were used for public fixtures. Production
has not been changed by this development task.

| Domain | Owner |
| --- | --- |
| Ingredient facts, brands, aliases, labels, revisions and pure nutrition math | kitchen-planner: internal nutrition module |
| Actual lots, seasonings, equipment, recipes, menus, profile and meal history | kitchen-planner: reality module |

There is one discoverable Skill and one installable package. Its internal modules
retain separate data ownership without a cross-Skill dependency. There is one
nutrition formula implementation. Legacy recipe/meal algorithms moved without changing
their snapshot arithmetic. Public Skill directories contain code, references
and synthetic tests only; both data roots belong to the private workspace.

## Operational model

- No resident service, scheduler, network request or model API is introduced.
  The existing agent drafts recipes; deterministic CLI evaluation checks declared
  stock, equipment and nutrient constraints. It is not a global optimizer or a
  guarantee that a generated cooking method is sensible or safe.
- Querying ingredient facts or calculating nutrition does not initialize
  reality directories, write caches or create pending-review entries. Calculations
  read one in-memory catalogue snapshot; current facts and explicit historic
  ingredient revisions are supported.
- Planner state uses a short-lived Python POSIX lock supervisor, a Node worker,
  buffered writes and a durable replay journal. Both reader and writer CLI calls
  serialize. This favors simple consistency at household scale over concurrency.
  It is Linux/macOS-oriented; native Windows locking is not supported.
- File I/O is not fully incremental: stock/audit state and an affected monthly
  meal file are rewritten. Computation and date/week derived updates are scoped
  to affected records. A future storage change requires measurements, not an
  unsubstantiated claim of constant memory or zero I/O.
- Planning never decrements stock or logs intake. Confirmed cooking decrements
  actual input lots and can create a measured prepared yield. Confirmed eating
  of prepared food decrements the cooked lot only. Other meal logging does not
  infer stock usage. Stable operation IDs, inventory revision checks and immutable
  versions prevent duplicate confirmations and history rewrites.
- Fixed recipes resolve stored ingredient revisions. Newly drafted recipes use
  current facts unless explicitly pinned. Changing a nutrition label does not
  rewrite saved menus, recipes or logged intake.

## Compatibility and migration

Legacy nutrition CLI commands forward into the unified package. The compatibility
directory has no SKILL.md or discovery metadata, only the old executable path.
Missing unified code is an error, never permission to resume writes at old paths. Mixed
ingredient/recipe imports must be split before application. Public JS internals
are not a supported API; only CLI compatibility is maintained.

Migration defaults to a dry run. Apply merges immutable IDs into the destination,
blocks conflicts before writes, retains exact source bytes in a private backup
and leaves the source untouched. Inventory is never inferred. Only explicitly
classified reality pending entries are copied; ambiguous entries need review.
After migration, validate and rebuild missing consumption caches. Numeric legacy
goals are preserved; planning bounds require explicit agreement rather than an
invented tolerance.

At production cutover, deploy kitchen-planner and prevent old
writers during migration. Preserve source backups and exact private paths;
ignore only lock/journal/temp files. Confirm remote privacy before a separately
authorized private Git commit/push. Core/channel daemons do not need restarting
for these on-demand scripts; Skill discovery refresh may depend on the client.

## Acceptance

After consolidation: 38 tests passed. Isolated installation uses one package,
the retired install name aliases to kitchen-planner, and both discovery roots
see only its SKILL.md while historical executable paths still work. Unified
ingredient queries/calculations do not initialize kitchen state. The unified
Skill passed `quick_validate`; shell/JS syntax, whitespace checks and targeted
sensitive-pattern scanning passed (zero matches). No production installation or
data migration was performed by the consolidation task.

Pre-consolidation development acceptance: 36 tests passed (17 retained nutrition/legacy arithmetic
tests and 19 kitchen/isolation tests). Both original definitions passed `quick_validate`;
changed JS/Python syntax and diff whitespace checks passed. Changed-file scans
for personal-home paths, credential-token and email patterns returned zero hits.
This is a targeted scan, not a claim of exhaustive historical repository audit.
The final run used synthetic data only and did not install into production.

Run `pnpm test:kitchen` or the equivalent Node test command. Existing nutrition
tests keep their formula/source/idempotence assertions but route recipe/meal
storage assertions to kitchen. New tests exercise:

- read-only nutrition, source priority, label rounding, units and edible weights;
- actual stock versus plan versus intake, unknown quantities and wrong states;
- hard constraints, absent equipment, unmet/unknown nutrient targets;
- concurrent confirmations, idempotence, stale revisions and compensating undo;
- prepared food yield/consumption without duplicate raw deduction;
- fixed recipe revision pinning and independent new-draft calculation;
- date-scoped incremental caches and controlled rebuild/version refusal;
- migration dry-run, exact historical snapshots, conflicts and repeated unchanged;
- transaction recovery after an interrupted real subprocess;
- public-root rejection including an installed copy and symlink aliases;
- isolated real scoped installation and both discovery symlink entrypoints.

Skill `quick_validate`, JS syntax, Python compilation and changed-file sensitive
pattern scanning are additional checks. They do not prove semantic food safety,
all possible schema corruption cases, Windows portability or actual production
data migration. No live user-data migration is claimed by the synthetic tests.

## Review notes before production

- Confirm the proposed private kitchen root and migration counts from a separately
  approved local dry-run. Do not print personal labels, goals or histories.
- Confirm whether to commit/push this branch; development approval alone is not
  deployment or Git authorization.
- Explicit limitations: no purchasing automation, no OCR, no automatic nutrition
  lookup, no cross-menu stock reservation, and no automatic expiry/safety verdict.
  Prepared-lot recounts can change remaining quantity but cannot rewrite original
  yield or nutrients; correcting the original yield requires explicit review.
