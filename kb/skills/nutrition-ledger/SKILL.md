---
name: nutrition-ledger
description: Maintain and query an offline-first, auditable nutrition ledger for ingredients, immutable recipe versions, meals, daily or weekly totals, substitutions, aliases, and pending data review. Use for requests such as “算下这顿热量与营养”, “比较三个晚餐配方”, “记录今天三餐”, “全天碳水够不够”, training/rest-day intake, remembered food labels, fixed recipes, or nutrition-ledger validation and rebuilds.
---

# Nutrition Ledger

Use the deterministic CLI as the only calculation and persistence layer. Prefer the local ledger; do not browse or call an external nutrition service unless the user explicitly asks. Missing or ambiguous data belongs in `pending-review`, never in an invented exact result.

## Locate and run

Set the private data root explicitly when the workspace cannot be discovered:

```bash
node scripts/nutrition-ledger.mjs validate \
  --data-root "$NUTRITION_DATA_ROOT"
```

The default is `data/health/nutrition` under the detected workspace. The CLI refuses a data root inside the public Skill source repository. Runtime, Codex, and Claude discovery symlinks are supported.

All successful commands write one compact JSON value to stdout. Errors write JSON to stderr and return nonzero. Add `--details` for evidence-oriented item summaries or `--full-json` for complete stored snapshots.

## Workflow

1. Search before adding: `ingredient search --query '<alias>'`.
2. Reuse a verified local ingredient or immutable recipe version when it exists.
3. Add or update only when basis, weight state, quantity, and source are explicit.
4. Use `meal calculate` for a dry calculation; use `meal log` only when the user wants persistence.
5. Use `day summary` or `week summary` for totals and configured target deltas.
6. Run `pending-review list` when a lookup is missing, ambiguous, or conflicts with a higher-priority source.
7. Run `validate` after imports or operational changes. Run `rebuild` only for an explicit repair or schema/algorithm watermark change.

Inputs for mutations are JSON supplied with `--json` or `--file`. Prefer `--file` for structured payloads so shell quoting does not alter data.

## Stable commands

```text
ingredient add|update|show|list|search
recipe add|update|calculate|compare
meal calculate|log
day summary
week summary
import-kb
pending-review list|resolve
rebuild
validate
```

Examples:

```bash
node scripts/nutrition-ledger.mjs ingredient search --query 'saved alias'
node scripts/nutrition-ledger.mjs meal calculate --file /path/to/request.json
node scripts/nutrition-ledger.mjs day summary --date 2031-04-05
node scripts/nutrition-ledger.mjs recipe compare --file /path/to/comparison.json
```

## Safety and interpretation

- Keep credentials in the runtime secrets file or environment only. This Skill requires none for offline operation.
- Keep personal labels, goals, evidence, and meal history in the private data root. Never copy them into this Skill, fixtures, logs, or a public commit.
- Source precedence is verified packaging label, user measurement, verified private record, official database, then generic estimate. A lower-priority update becomes pending review unless explicitly forced after user confirmation.
- Treat `raw`, `cooked`, `frozen`, `drained`, and edible/with-pit/with-bone states as distinct. Ask or queue review when conversion is unclear.
- Preserve label kcal and kJ. The 4/4/9 macro result is only a reasonableness check.
- Recipe versions and logged meal snapshots are immutable. A later ingredient or recipe update must not rewrite history.
- Explain estimates and target deltas in prose after reading the CLI result; do not recalculate them mentally.

Read [references/schema.md](references/schema.md) when adding data, diagnosing validation, migrating private anchors, or changing algorithms.
