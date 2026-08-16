import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  ALGORITHM_VERSION,
  addRecipe,
  calculateMeal,
  importBundle,
  logMeal,
  rebuild,
  resolvePaths,
  runCli,
  searchIngredients,
  upsertIngredient,
  validate,
} from '../kb/skills/nutrition-ledger/scripts/nutrition-ledger.mjs';

const script = fileURLToPath(new URL('../kb/skills/nutrition-ledger/scripts/nutrition-ledger.mjs', import.meta.url));

function ledger() {
  const workspace = mkdtempSync(join(tmpdir(), 'nutrition-ledger-test-'));
  return { workspace, paths: resolvePaths({ workspace }) };
}

function ingredient(overrides = {}) {
  return {
    id: 'synthetic-grain',
    name: 'Synthetic grain',
    aliases: ['pantry anchor'],
    basis: 'per_100g',
    weight_state: 'cooked',
    source_type: 'packaging_label',
    nutrients: { kcal: 120, protein_g: 4, carbs_g: 22, fat_g: 2, fiber_g: 3, sodium_mg: 8 },
    verified_at: '2031-01-01',
    ...overrides,
  };
}

function seed(paths) {
  assert.equal(upsertIngredient(paths, ingredient()).changed, true);
  assert.equal(upsertIngredient(paths, ingredient({
    id: 'synthetic-drink', name: 'Synthetic drink', aliases: ['blue liquid'],
    basis: 'per_100ml', weight_state: 'liquid',
    nutrients: { kcal: 40, protein_g: 1, carbs_g: 8, fat_g: 0 },
  })).changed, true);
  assert.equal(upsertIngredient(paths, ingredient({
    id: 'synthetic-unit', name: 'Synthetic unit', aliases: ['round unit'],
    basis: 'per_unit', weight_state: 'whole', unit_grams: 42,
    nutrients: { kcal: 55, protein_g: 3, carbs_g: 5, fat_g: 2 },
  })).changed, true);
}

test('1 packaging labels cannot be silently replaced by generic estimates', () => {
  const { paths } = ledger();
  upsertIngredient(paths, ingredient());
  const result = upsertIngredient(paths, ingredient({ source_type: 'generic_estimate', nutrients: { kcal: 999 } }));
  assert.equal(result.changed, false);
  assert.equal(result.pending_review.type, 'source_priority_conflict');
  assert.equal(searchIngredients(paths, 'pantry anchor')[0].nutrients.kcal, 120);
});

test('2 kJ converts to kcal while preserving label energy and rounding metadata', () => {
  const { paths } = ledger();
  const result = upsertIngredient(paths, ingredient({ nutrients: { kj: 418.4, protein_g: 2, carbs_g: 3, fat_g: 4 } }));
  assert.equal(result.ingredient.nutrients.kj, 418.4);
  assert.equal(result.ingredient.nutrients.kcal, 100);
  assert.equal(result.ingredient.nutrients.kcal_derived_from_kj, true);
  assert.equal(result.ingredient.nutrients.macro_kcal_check, 56);
  assert.equal(result.ingredient.nutrients.label_macro_kcal_delta, 44);
});

test('3 per-100g, per-100ml and per-unit quantities calculate deterministically', () => {
  const { paths } = ledger(); seed(paths);
  const result = calculateMeal(paths, { items: [
    { ingredient_id: 'synthetic-grain', grams: 50 },
    { ingredient_id: 'synthetic-drink', ml: 250 },
    { ingredient_id: 'synthetic-unit', units: 2 },
  ] });
  assert.equal(result.nutrition.kcal, 270);
  assert.deepEqual(result.items.map(row => row.consumed), [
    { gross_g: 50, edible_g: 50 }, { ml: 250 }, { units: 2, estimated_grams: 84 },
  ]);
});

test('4 edible fraction is applied to gross with-pit or with-bone weight', () => {
  const { paths } = ledger();
  upsertIngredient(paths, ingredient({ edible_fraction: 0.6, weight_state: 'with_pit', nutrients: { kcal: 100 } }));
  const result = calculateMeal(paths, { items: [{ ingredient_id: 'synthetic-grain', grams: 200 }] });
  assert.equal(result.items[0].consumed.edible_g, 120);
  assert.equal(result.nutrition.kcal, 120);
});

test('5 raw, cooked, frozen and drained states do not cross-match silently', () => {
  const { paths } = ledger();
  upsertIngredient(paths, ingredient({ id: 'state-raw', name: 'State sample raw', aliases: ['state sample'], weight_state: 'raw' }));
  upsertIngredient(paths, ingredient({ id: 'state-cooked', name: 'State sample cooked', aliases: ['state sample'], weight_state: 'cooked' }), { force: true });
  assert.equal(searchIngredients(paths, 'state sample', { weightState: 'raw' })[0].id, 'state-raw');
  assert.throws(() => calculateMeal(paths, { items: [{ ingredient_id: 'state-raw', grams: 10, weight_state: 'drained' }] }), /weight_state mismatch/);
  assert.throws(() => calculateMeal(paths, { items: [{ ingredient: 'state sample', grams: 10 }] }), /requires review/);
});

test('6 recipes retain total and per-serving snapshots', () => {
  const { paths } = ledger(); seed(paths);
  const result = addRecipe(paths, {
    id: 'synthetic-bowl', name: 'Synthetic bowl', version: 1, servings: 2,
    items: [{ ingredient_id: 'synthetic-grain', grams: 100 }, { ingredient_id: 'synthetic-unit', units: 1 }],
  });
  assert.equal(result.recipe.nutrition_total.kcal, 175);
  assert.equal(result.recipe.nutrition_per_serving.kcal, 87.5);
});

test('7 recipe comparisons report deterministic substitution deltas', async () => {
  const { paths } = ledger(); seed(paths);
  addRecipe(paths, { id: 'option-a', name: 'Option A', version: 1, items: [{ ingredient_id: 'synthetic-grain', grams: 100 }] });
  addRecipe(paths, { id: 'option-b', name: 'Option B', version: 1, items: [{ ingredient_id: 'synthetic-drink', ml: 100 }] });
  const result = await runCli(['recipe', 'compare', '--json', JSON.stringify({ recipes: [{ id: 'option-a' }, { id: 'option-b' }] })], { dataRoot: paths.root });
  assert.equal(result.recipes[1].delta_from_baseline.kcal, -80);
});

test('8 logging a meal incrementally updates only one daily row', () => {
  const { paths } = ledger(); seed(paths);
  logMeal(paths, { date: '2031-04-05', name: 'Synthetic meal', items: [{ ingredient_id: 'synthetic-grain', grams: 100 }] });
  logMeal(paths, { date: '2031-04-06', name: 'Second meal', items: [{ ingredient_id: 'synthetic-drink', ml: 100 }] });
  const before = readFileSync(paths.dailyTotals, 'utf8').trim().split('\n').map(JSON.parse);
  logMeal(paths, { date: '2031-04-05', name: 'Extra meal', items: [{ ingredient_id: 'synthetic-unit', units: 1 }] });
  const after = readFileSync(paths.dailyTotals, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(after.length, 2);
  assert.equal(after.find(row => row.date === '2031-04-06').nutrition.kcal, before.find(row => row.date === '2031-04-06').nutrition.kcal);
  assert.equal(after.find(row => row.date === '2031-04-05').meal_count, 2);
});

test('9 private aliases resolve exact local anchors', () => {
  const { paths } = ledger(); upsertIngredient(paths, ingredient());
  const match = searchIngredients(paths, 'pantry anchor');
  assert.equal(match.length, 1);
  assert.equal(match[0].id, 'synthetic-grain');
});

test('10 conflicting aliases enter pending review', () => {
  const { paths } = ledger(); upsertIngredient(paths, ingredient());
  const result = upsertIngredient(paths, ingredient({ id: 'other-grain', name: 'Other grain', aliases: ['pantry anchor'] }));
  assert.equal(result.changed, false);
  assert.equal(result.pending_review.type, 'alias_conflict');
  assert.equal(validate(paths).counts.pending, 1);
});

test('11 repeated ingredient, recipe and meal mutations are idempotent', () => {
  const { paths } = ledger();
  const firstIngredient = upsertIngredient(paths, ingredient());
  const secondIngredient = upsertIngredient(paths, ingredient());
  assert.equal(firstIngredient.changed, true); assert.equal(secondIngredient.changed, false);
  const recipe = { id: 'idempotent-bowl', name: 'Idempotent bowl', version: 1, items: [{ ingredient_id: 'synthetic-grain', grams: 80 }] };
  assert.equal(addRecipe(paths, recipe).changed, true); assert.equal(addRecipe(paths, recipe).changed, false);
  const meal = { date: '2031-05-01', name: 'Stable meal', items: [{ recipe_id: 'idempotent-bowl' }] };
  assert.equal(logMeal(paths, meal).changed, true); assert.equal(logMeal(paths, meal).changed, false);
  assert.equal(validate(paths).counts.meals, 1);
});

test('12 offline local cache works with credential and network variables absent', () => {
  const { paths } = ledger(); seed(paths);
  const result = spawnSync(process.execPath, [script, 'ingredient', 'search', '--query', 'blue liquid', '--data-root', paths.root], {
    encoding: 'utf8', env: { PATH: process.env.PATH }, timeout: 5000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout)[0].id, 'synthetic-drink');
});

test('13 compact output omits evidence while details and full JSON expose increasing audit depth', () => {
  const { paths } = ledger();
  upsertIngredient(paths, ingredient({ evidence: { kind: 'synthetic-transcript', ref: 'fixture-1' }, provenance: { source: 'synthetic' } }));
  const base = [script, 'ingredient', 'show', '--id', 'synthetic-grain', '--data-root', paths.root];
  const compact = JSON.parse(execFileSync(process.execPath, base, { encoding: 'utf8' }));
  const details = JSON.parse(execFileSync(process.execPath, [...base, '--details'], { encoding: 'utf8' }));
  const full = JSON.parse(execFileSync(process.execPath, [...base, '--full-json'], { encoding: 'utf8' }));
  assert.equal(compact.provenance, undefined);
  assert.deepEqual(details.provenance, { source: 'synthetic' });
  assert.deepEqual(full.evidence, { kind: 'synthetic-transcript', ref: 'fixture-1' });
  assert.ok(JSON.stringify(compact).length < JSON.stringify(details).length);
});

test('14 schema or algorithm watermark mismatch triggers a controlled rebuild requirement', () => {
  const { paths } = ledger(); upsertIngredient(paths, ingredient());
  writeFileSync(paths.state, JSON.stringify({ schema_version: 0, algorithm_version: 0 }));
  assert.equal(validate(paths).needs_rebuild, true);
  const result = rebuild(paths);
  assert.equal(result.rebuilt, true);
  assert.equal(validate(paths).needs_rebuild, false);
  assert.equal(JSON.parse(readFileSync(paths.state)).algorithm_version, ALGORITHM_VERSION);
});

test('15 public source roots are rejected and imports queue unresolved migration records', () => {
  assert.throws(() => resolvePaths({ dataRoot: resolve('kb/skills/nutrition-ledger/private-data') }), /public Skill source repository/);
  const { paths } = ledger();
  const result = importBundle(paths, { pending: [{ subject: 'ambiguous synthetic item', reason: 'cooked state missing' }] });
  assert.equal(result.pending_added, 1);
  assert.equal(validate(paths).counts.pending, 1);
  const repeated = importBundle(paths, { pending: [{ subject: 'ambiguous synthetic item', reason: 'cooked state missing' }] });
  assert.equal(repeated.pending_added, 0);
  assert.equal(repeated.unchanged, 1);
});

test('16 Codex and Claude discovery symlink entrypoints both emit compact JSON', () => {
  const { paths } = ledger();
  for (const discovery of ['codex-discovery', 'claude-discovery']) {
    const link = join(paths.workspace, discovery, 'nutrition-ledger.mjs');
    mkdirSync(dirname(link), { recursive: true });
    symlinkSync(script, link);
    const result = spawnSync(process.execPath, [link, 'validate', '--data-root', paths.root], { encoding: 'utf8', timeout: 5000 });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).ok, true);
  }
});

test('17 workspace discovery uses a generic configured root outside the current directory', () => {
  const { workspace } = ledger();
  mkdirSync(join(workspace, 'memory'), { recursive: true });
  const unrelated = mkdtempSync(join(tmpdir(), 'nutrition-ledger-cwd-'));
  const result = spawnSync(process.execPath, [script, 'validate'], {
    cwd: unrelated, encoding: 'utf8', timeout: 5000,
    env: { PATH: process.env.PATH, OPENCLAW_WORKSPACE_ROOT: workspace },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).ok, true);
  assert.equal(validate(resolvePaths({ workspace })).ok, true);
});
