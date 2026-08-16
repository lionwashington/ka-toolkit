# Ledger schema and algorithms

## Storage

The private root contains:

```text
raw/ingredients.jsonl
raw/label-evidence/
recipes/recipes.jsonl
logs/meals/YYYY-MM.jsonl
profile/nutrition-profile.json
derived/daily-totals.jsonl
derived/weekly-summary.json
derived/ingredient-index.json
state/state.json
state/pending-review.json
README.md
```

Ingredient revisions, recipe versions, and meal records are append-only audit records. Indexes and daily/weekly totals are derived and rebuildable. Every rewrite uses a temporary sibling followed by atomic rename.

## Ingredient

Required fields are `id`, `name`, `basis`, `weight_state`, `source_type`, and nutrient data. IDs use lowercase letters, numbers, dots, underscores, and hyphens. Valid bases are `per_100g`, `per_100ml`, and `per_unit`.

Nutrients are `kcal`, `kj`, `protein_g`, `carbs_g`, `fat_g`, `fiber_g`, and `sodium_mg`. If only kJ is supplied, kcal is derived as `kJ / 4.184`. If only kcal is supplied, kJ is derived as `kcal * 4.184`. The stored label value is authoritative; `4*protein + 4*carbs + 9*fat` is stored only as a check. Unreported fields are retained in `missing_nutrients`; their zero contribution permits deterministic partial totals, but the affected item is explicitly marked estimated rather than silently claiming that the nutrient is zero.

For `per_100g`, gross grams are multiplied by `edible_fraction` unless explicit `edible_grams` is supplied. For `per_100ml`, use millilitres. For `per_unit`, use units and optionally retain `unit_grams`.

Default source priorities:

| Source | Priority |
|---|---:|
| `packaging_label` | 500 |
| `user_measured` | 450 |
| `private_verified` | 400 |
| `official_database` | 300 |
| `generic_estimate` | 100 |

A lower-priority revision cannot replace a current higher-priority revision without explicit force. Alias collisions, unresolved states, and missing foods are queued in `state/pending-review.json`.

## Recipe and meal snapshots

A recipe key is `id@version`. Each version stores resolved ingredient revisions, quantities, nutrition totals, and optional cooked total weight, servings, or serving weight. Existing versions cannot be altered; an update creates a new version.

A logged meal stores resolved ingredient or recipe snapshots. Its deterministic ID is derived from date/time, name, and requested items unless an explicit ID is supplied. Repeating the same request is a no-op. Reusing an ID with different content is an error.

## Incremental derivation

Logging one meal rewrites only its monthly meal file, that date's daily row, and that ISO week's cached summary. Ingredient changes rebuild only the ingredient lookup index because existing recipe and meal snapshots remain immutable. `rebuild` recalculates all derived rows and updates both version watermarks.

`validate` reports counts, structural problems, and whether the stored `schema_version` or `algorithm_version` requires a controlled rebuild.

## Import bundle

`import-kb --file bundle.json` accepts:

```json
{
  "ingredients": [],
  "recipes": [],
  "pending": [
    {"type": "migration_review", "subject": "item-name", "reason": "weight state is unclear"}
  ]
}
```

Only unambiguous, traceable anchors belong in `ingredients` or `recipes`. Put incomplete or conflicting observations in `pending`; do not infer missing state or edible weight.
