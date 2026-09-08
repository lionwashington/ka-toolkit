# Ingredient knowledge module

Own ingredient facts, not real-world state. Use the deterministic CLI as the only ingredient calculation and persistence layer. Prefer the local ledger; do not browse or call an external nutrition service unless the user explicitly asks. Missing or ambiguous data requires review, never an invented exact result. Pure calculations report errors without creating pending records or other files.

## Locate and run

Set the private data root explicitly when the workspace cannot be discovered:

```bash
node scripts/kitchen-planner.mjs nutrition validate \
  --nutrition-root "$NUTRITION_DATA_ROOT"
```

The default is `data/health/nutrition` under the detected workspace. The CLI refuses a data root inside the public Skill source repository. Runtime, Codex, and Claude discovery symlinks are supported.

All successful commands write one compact JSON value to stdout. Errors write JSON to stderr and return nonzero. Add `--details` for evidence-oriented item summaries or `--full-json` for complete stored snapshots.

## Workflow

1. Search before adding: `ingredient search --query '<alias>'`.
2. Reuse a verified local ingredient and its version when it exists.
3. Add or update only when basis, weight state, quantity, and source are explicit.
4. Use `nutrition calculate` with ingredient IDs, quantities and optional `ingredient_revision` for a read-only calculation. Explain missing nutrient fields rather than treating their partial total as zero intake.
5. Use this Skill's kitchen commands for actual stock, recipes, targets and consumption. Never infer stock availability from this catalogue.
6. Run `pending-review list` when a lookup is missing, ambiguous, or conflicts with a higher-priority source.
7. Run `validate` after imports or operational changes. Run `rebuild` only for an explicit repair or schema/algorithm watermark change.

Inputs for mutations are JSON supplied with `--json` or `--file`. Prefer `--file` for structured payloads so shell quoting does not alter data.

## Stable commands

```text
ingredient add|update|show|list|search
nutrition calculate
import-kb
pending-review list|resolve
rebuild
validate
```

Examples:

```bash
node scripts/kitchen-planner.mjs ingredient search --query 'saved alias'
node scripts/kitchen-planner.mjs nutrition calculate --file /path/to/request.json
```

## Safety and interpretation

- Keep credentials in the runtime secrets file or environment only. This Skill requires none for offline operation.
- Keep personal labels and evidence in the private nutrition root. Goals, recipes and meal history belong in the private kitchen root. Neither domain belongs in public fixtures or commits.
- Source precedence is verified packaging label, user measurement, verified private record, official database, then generic estimate. A lower-priority update becomes pending review unless explicitly forced after user confirmation.
- Treat `raw`, `cooked`, `frozen`, `drained`, and edible/with-pit/with-bone states as distinct. Ask or queue review when conversion is unclear.
- Preserve label kcal and kJ. The 4/4/9 macro result is only a reasonableness check.
- Ingredient revisions remain readable. Kitchen-planner snapshots must not be retroactively changed by ingredient updates.
- Explain estimates and target deltas in prose after reading the CLI result; do not recalculate them mentally.

Read [nutrition-schema.md](nutrition-schema.md) when adding data, diagnosing validation, migrating private anchors, or changing algorithms.

The retired nutrition-ledger executable forwards into the unified Skill;
legacy reality commands no longer write old directories under nutrition.
Approve migration before switching production callers.
`import-kb` accepts ingredients/pending only; recipe bundles must be split and
handled by kitchen-planner. Do not import reality records into this catalogue.
