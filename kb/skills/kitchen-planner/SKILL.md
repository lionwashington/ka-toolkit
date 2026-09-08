---
name: kitchen-planner
description: Look up ingredient nutrition and labels, manage actual kitchen stock, seasonings and cookware, and plan or adjust recipes and menus to nutrition targets. Also use for recording cooking, actual consumption and day/week summaries. Keeps ingredient facts separate from real-world inventory and meal state.
---

# Kitchen Planner

One Skill, two internal domains: ingredient knowledge (facts/revisions/pure
nutrition math) and kitchen reality (stock/equipment/recipes/menus/intake).
Never infer present stock from the ingredient catalogue or historical meals.

Run `node scripts/kitchen-planner.mjs <command>` with `--nutrition-root` and
`--data-root` when workspace discovery is unavailable. Defaults are the private
workspace's `data/health/nutrition` and `data/health/kitchen`. All executable
modules ship in this one Skill; discovery symlinks resolve its real files.
Python 3 supplies a short-lived POSIX lock; no service or API credentials needed.

## Ingredient facts only

Use `ingredient search|show|list|add|update`, `nutrition calculate`,
`nutrition validate|rebuild`, or `import-kb` for ingredient-only work. These use
the nutrition root, not `--data-root` (which selects kitchen reality).
Calculations do not create kitchen directories or acquire its lock.
Read [references/nutrition.md](references/nutrition.md) for fact/source review,
and [references/nutrition-schema.md](references/nutrition-schema.md) for payloads.
Do not load planning/migration references for a simple nutrition lookup.
Use `pending-review list|resolve --domain nutrition` for ingredient review;
without that option the command addresses kitchen review.

## Plan and adjust

1. Read `inventory list`, `equipment list`, `profile show` and relevant saved
   recipes. Search `ingredient` by alias before proposing an ingredient.
   Unknown or stale stock needs confirmation; it is not zero or unlimited.
2. Draft dishes, quantities, seasonings, required equipment and estimated steps/
   time. Prefer available stock; purchases require an explicit allowance.
   Include oil, sugar and sauces in the nutrition input. Do not invent a
   conversion between raw/cooked, grams/ml/units or gross/edible quantities.
3. Call `plan evaluate --file <draft>` for every candidate and adjustment.
   Check `feasible`, `issues`, `warnings`, target statuses and missing nutrients;
   an unknown nutrient cannot satisfy a target. The CLI validates declared
   requirements, not the completeness of the agent's recipe or food safety.
4. Use at most three evaluated revisions per request. If constraints still
   conflict, report the conflict and options instead of claiming success.
   Cooking duration/texture are estimates, not solver guarantees.
5. Give a compact menu, amounts, per-person nutrients, target differences,
   equipment, steps and shortages. Save with `menu save` only when requested.

Use user-specified target ranges. Never invent TDEE or change goals to make a
menu pass. Check `profile` for exclusions and targets; legacy numeric goals are
informational until explicit planning ranges have been agreed.

## Actual events

- `inventory add|adjust`: explicit stock observations, per lot. `adjust` requires
  the latest revision from `inventory list`; never silently convert stock units.
- `equipment set`: actual available tools and capacities.
- `recipe add|update|calculate|compare|list`: immutable versions. An update uses
  an explicit new version. Save ingredient revision references in fixed recipes.
- `cook confirm`: only after actual quantities are confirmed. Requires an
  operation ID and inventory revision. Deducts raw ingredients but logs no meal.
  An optional confirmed yield creates a prepared-food lot, not a new ingredient.
- `meal log`: only actual intake. Ingredient/recipe logging alone does not deduct
  raw stock. `prepared` portions deduct only the prepared lot, not its raw inputs.
- `operation undo`: compensating reversal of a cooking event. Already consumed
  output or recounted inputs require review; never delete audit history.
- `day summary`, `week summary`: actual consumption, never planned menus.

Every inventory mutation uses a stable operation ID. Retry the identical
request with the same ID; a changed request needs a new ID. A stale revision
requires reading and reconfirming, not an automatic retry with a fresh revision.
Do not re-use a cooking ID as proof the food was eaten.

## Data and maintenance

Local/offline first. No external nutrition lookup unless explicitly requested.
Never place inventory, labels, goals, evidence or credentials in public source.
Private stable data is Git-persistable; ignore only locks, transaction journals
and temporary siblings, not the data root. Do not push until remote privacy is
verified. No automatic Git writes or scheduler changes are part of this Skill.

Read [references/schema.md](references/schema.md) for payloads and transactional
semantics. Read [references/migration.md](references/migration.md) before any
legacy migration. `migrate` defaults to dry-run; production application needs
explicit approval. Run `validate`; `rebuild` only when needed or requested.

Successful CLI output is one compact JSON value; `--details`/`--full-json` expand
evidence. Errors are JSON on stderr with nonzero exit status. Unknown fields or
unconfirmed values must not be explained as verified facts.
