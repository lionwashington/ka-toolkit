#!/usr/bin/env node
import { createHash } from 'node:crypto';
import {
  existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SCHEMA_VERSION = 1;
export const ALGORITHM_VERSION = 1;

const SKILL_SOURCE_REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const SOURCE_PRIORITIES = Object.freeze({
  packaging_label: 500,
  user_measured: 450,
  private_verified: 400,
  official_database: 300,
  generic_estimate: 100,
});
const BASES = new Set(['per_100g', 'per_100ml', 'per_unit']);
const NUTRIENTS = ['kcal', 'kj', 'protein_g', 'carbs_g', 'fat_g', 'fiber_g', 'sodium_mg'];

function isWithin(path, parent) {
  const rel = relative(parent, path);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function assertPrivateDataRoot(root) {
  if (existsSync(join(SKILL_SOURCE_REPO, '.git')) && isWithin(root, SKILL_SOURCE_REPO)) {
    throw cliError('refusing nutrition data root inside the public Skill source repository', 4);
  }
}

function findWorkspace(start = process.cwd()) {
  if (process.env.NUTRITION_WORKSPACE_ROOT) return resolve(process.env.NUTRITION_WORKSPACE_ROOT);
  let current = resolve(start);
  while (true) {
    if (existsSync(join(current, 'AGENTS.md')) || existsSync(join(current, 'memory'))) return current;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return resolve(start);
}

export function resolvePaths(options = {}) {
  const workspace = resolve(options.workspace || findWorkspace());
  const root = resolve(options.dataRoot || process.env.NUTRITION_DATA_ROOT || join(workspace, 'data', 'health', 'nutrition'));
  assertPrivateDataRoot(root);
  return {
    workspace,
    root,
    ingredients: join(root, 'raw', 'ingredients.jsonl'),
    labelEvidenceDir: join(root, 'raw', 'label-evidence'),
    recipes: join(root, 'recipes', 'recipes.jsonl'),
    mealsDir: join(root, 'logs', 'meals'),
    profile: join(root, 'profile', 'nutrition-profile.json'),
    dailyTotals: join(root, 'derived', 'daily-totals.jsonl'),
    weeklySummary: join(root, 'derived', 'weekly-summary.json'),
    ingredientIndex: join(root, 'derived', 'ingredient-index.json'),
    state: join(root, 'state', 'state.json'),
    pending: join(root, 'state', 'pending-review.json'),
    readme: join(root, 'README.md'),
  };
}

function cliError(message, exitCode = 2, details) {
  const error = new Error(message);
  error.exitCode = exitCode;
  if (details !== undefined) error.details = details;
  return error;
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) out._.push(arg);
    else if (['--details', '--full-json', '--force'].includes(arg)) out[arg.slice(2)] = true;
    else {
      const equal = arg.indexOf('=');
      if (equal !== -1) out[arg.slice(2, equal)] = arg.slice(equal + 1);
      else out[arg.slice(2)] = argv[++i];
    }
  }
  return out;
}

function atomicWrite(path, data) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(temporary, data);
  renameSync(temporary, path);
}

function readJson(path, fallback) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return fallback; }
}

function readJsonl(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split('\n').filter(Boolean).map((line, index) => {
    try { return JSON.parse(line); }
    catch (error) { throw cliError(`invalid JSONL at ${basename(path)}:${index + 1}`, 5, error.message); }
  });
}

function writeJsonl(path, rows) {
  atomicWrite(path, rows.length ? `${rows.map(row => JSON.stringify(row)).join('\n')}\n` : '');
}

function appendJsonl(path, row) {
  const rows = readJsonl(path);
  rows.push(row);
  writeJsonl(path, rows);
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
  }
  return value;
}

function stableString(value) { return JSON.stringify(stable(value)); }
function fingerprint(value) { return createHash('sha256').update(stableString(value)).digest('hex'); }
function round(value, digits = 6) { return Math.round((Number(value) + Number.EPSILON) * 10 ** digits) / 10 ** digits; }
function nowIso() { return new Date().toISOString(); }
function normalizeTerm(value) { return String(value || '').normalize('NFKC').trim().toLowerCase().replace(/\s+/g, ' '); }

function ensureLayout(paths) {
  for (const dir of [
    join(paths.root, 'raw'), paths.labelEvidenceDir, join(paths.root, 'recipes'), paths.mealsDir,
    join(paths.root, 'profile'), join(paths.root, 'derived'), join(paths.root, 'state'),
  ]) mkdirSync(dir, { recursive: true });
  for (const file of [paths.ingredients, paths.recipes, paths.dailyTotals]) if (!existsSync(file)) atomicWrite(file, '');
  if (!existsSync(paths.profile)) atomicWrite(paths.profile, `${JSON.stringify({ schema_version: SCHEMA_VERSION, goals: {} }, null, 2)}\n`);
  if (!existsSync(paths.pending)) atomicWrite(paths.pending, '[]\n');
  if (!existsSync(paths.weeklySummary)) atomicWrite(paths.weeklySummary, `${JSON.stringify({ schema_version: SCHEMA_VERSION, algorithm_version: ALGORITHM_VERSION, weeks: {} }, null, 2)}\n`);
  if (!existsSync(paths.ingredientIndex)) atomicWrite(paths.ingredientIndex, `${JSON.stringify({ schema_version: SCHEMA_VERSION, generated_at: null, ingredients: {}, aliases: {} }, null, 2)}\n`);
  if (!existsSync(paths.state)) atomicWrite(paths.state, `${JSON.stringify(defaultState(), null, 2)}\n`);
  if (!existsSync(paths.readme)) atomicWrite(paths.readme, [
    '# Private nutrition ledger',
    '',
    'This directory contains private nutrition records. It never stores credentials.',
    '',
    '- `raw/`: append-only ingredient revisions and optional private label evidence.',
    '- `recipes/`: immutable recipe versions and calculated snapshots.',
    '- `logs/meals/`: monthly immutable meal snapshots.',
    '- `profile/`: private goals and training/rest-day targets.',
    '- `derived/`: rebuildable indexes and daily/weekly summaries.',
    '- `state/`: schema/algorithm watermarks and pending review items.',
    '',
  ].join('\n'));
}

function defaultState() {
  return {
    schema_version: SCHEMA_VERSION,
    algorithm_version: ALGORITHM_VERSION,
    last_rebuild_at: null,
    last_incremental_at: null,
    last_incremental_dates: [],
  };
}

function updateState(paths, patch) {
  const current = readJson(paths.state, defaultState());
  atomicWrite(paths.state, `${JSON.stringify({ ...current, ...patch }, null, 2)}\n`);
}

function versionStatus(paths) {
  const state = readJson(paths.state, defaultState());
  return {
    schema_version: state.schema_version,
    algorithm_version: state.algorithm_version,
    needs_rebuild: state.schema_version !== SCHEMA_VERSION || state.algorithm_version !== ALGORITHM_VERSION,
  };
}

function nutrientObject(input = {}) {
  const source = input.nutrients || input;
  const aliases = {
    protein_g: ['protein_g', 'protein'], carbs_g: ['carbs_g', 'carbs', 'carbohydrate'],
    fat_g: ['fat_g', 'fat'], fiber_g: ['fiber_g', 'fiber'], sodium_mg: ['sodium_mg', 'sodium'],
    kcal: ['kcal'], kj: ['kj', 'kJ'],
  };
  const out = {};
  for (const [target, names] of Object.entries(aliases)) {
    const name = names.find(candidate => source[candidate] !== undefined && source[candidate] !== null);
    if (name) {
      const number = Number(source[name]);
      if (!Number.isFinite(number) || number < 0) throw cliError(`invalid nutrient: ${target}`);
      out[target] = round(number);
    }
  }
  if (out.kcal === undefined && out.kj !== undefined) {
    out.kcal = round(out.kj / 4.184);
    out.kcal_derived_from_kj = true;
  }
  if (out.kj === undefined && out.kcal !== undefined) out.kj = round(out.kcal * 4.184);
  out.missing_nutrients = NUTRIENTS.filter(name => out[name] === undefined);
  for (const name of out.missing_nutrients) out[name] = 0;
  const completeMacros = !['protein_g', 'carbs_g', 'fat_g'].some(name => out.missing_nutrients.includes(name));
  const macroKcal = completeMacros ? 4 * out.protein_g + 4 * out.carbs_g + 9 * out.fat_g : null;
  out.macro_kcal_check = macroKcal === null ? null : round(macroKcal);
  out.label_macro_kcal_delta = macroKcal === null || out.missing_nutrients.includes('kcal') ? null : round(out.kcal - macroKcal);
  return out;
}

function validateId(id, label = 'id') {
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(String(id || ''))) throw cliError(`${label} must use lowercase letters, digits, dot, underscore or hyphen`);
  return String(id);
}

function currentIngredients(paths) {
  const current = new Map();
  for (const row of readJsonl(paths.ingredients)) {
    const previous = current.get(row.id);
    if (!previous || Number(row.revision) > Number(previous.revision)) current.set(row.id, row);
  }
  return current;
}

function ingredientSemantic(record) {
  const { revision, recorded_at, ...semantic } = record;
  return semantic;
}

function normalizeIngredient(input, previous) {
  const previousNutrients = { ...(previous?.nutrients || {}) };
  for (const name of previous?.nutrients?.missing_nutrients || []) delete previousNutrients[name];
  const mergedNutrients = previous
    ? { ...previousNutrients, ...(input.nutrients || {}) }
    : { ...(input.nutrients || input) };
  if (input.nutrients?.kcal !== undefined && input.nutrients?.kj === undefined && input.nutrients?.kJ === undefined) delete mergedNutrients.kj;
  if ((input.nutrients?.kj !== undefined || input.nutrients?.kJ !== undefined) && input.nutrients?.kcal === undefined) delete mergedNutrients.kcal;
  const merged = previous ? { ...previous, ...input, nutrients: mergedNutrients } : { ...input, nutrients: mergedNutrients };
  const id = validateId(merged.id, 'ingredient id');
  if (!String(merged.name || '').trim()) throw cliError('ingredient name is required');
  if (!BASES.has(merged.basis)) throw cliError(`unsupported ingredient basis: ${merged.basis}`);
  if (!String(merged.weight_state || '').trim()) throw cliError('ingredient weight_state is required');
  if (!String(merged.source_type || '').trim()) throw cliError('ingredient source_type is required');
  const inheritedPriority = input.source_type !== undefined && input.source_type !== previous?.source_type
    ? undefined
    : previous?.source_priority;
  const sourcePriority = Number(input.source_priority ?? inheritedPriority ?? SOURCE_PRIORITIES[merged.source_type] ?? 0);
  if (!Number.isFinite(sourcePriority)) throw cliError('invalid source_priority');
  const edibleFraction = Number(merged.edible_fraction ?? 1);
  if (!(edibleFraction > 0 && edibleFraction <= 1)) throw cliError('edible_fraction must be > 0 and <= 1');
  const aliases = [...new Set([...(merged.aliases || [])].map(String).map(value => value.trim()).filter(Boolean))];
  const record = {
    schema_version: SCHEMA_VERSION,
    id,
    revision: Number(previous?.revision || 0) + 1,
    name: String(merged.name).trim(),
    aliases,
    brand: merged.brand ? String(merged.brand).trim() : null,
    product: merged.product ? String(merged.product).trim() : null,
    basis: merged.basis,
    nutrients: nutrientObject(merged),
    serving: merged.serving || null,
    unit_grams: merged.unit_grams === undefined || merged.unit_grams === null ? null : Number(merged.unit_grams),
    edible_fraction: edibleFraction,
    weight_state: String(merged.weight_state).trim(),
    source_type: String(merged.source_type).trim(),
    source_priority: sourcePriority,
    evidence: merged.evidence || null,
    provenance: merged.provenance || null,
    uncertainty: merged.uncertainty || null,
    verified_at: merged.verified_at || null,
    recorded_at: nowIso(),
  };
  if (record.basis === 'per_unit' && record.unit_grams !== null && (!(record.unit_grams > 0) || !Number.isFinite(record.unit_grams))) throw cliError('unit_grams must be positive');
  return record;
}

function rebuildIngredientIndex(paths) {
  const ingredients = currentIngredients(paths);
  const aliases = {};
  for (const record of ingredients.values()) {
    const terms = [record.id, record.name, record.brand, record.product, ...record.aliases].filter(Boolean);
    for (const term of terms) {
      const key = normalizeTerm(term);
      aliases[key] ||= [];
      if (!aliases[key].includes(record.id)) aliases[key].push(record.id);
    }
  }
  for (const ids of Object.values(aliases)) ids.sort();
  const index = {
    schema_version: SCHEMA_VERSION,
    generated_at: nowIso(),
    ingredients: Object.fromEntries([...ingredients.entries()].sort(([a], [b]) => a.localeCompare(b))),
    aliases,
  };
  atomicWrite(paths.ingredientIndex, `${JSON.stringify(index, null, 2)}\n`);
  return index;
}

function loadIngredientIndex(paths) {
  const index = readJson(paths.ingredientIndex, null);
  if (!index || index.schema_version !== SCHEMA_VERSION) return rebuildIngredientIndex(paths);
  return index;
}

function addPending(paths, issue) {
  const pending = readJson(paths.pending, []);
  const semantic = { type: issue.type, subject: issue.subject, reason: issue.reason, candidates: issue.candidates || [] };
  const id = `review-${fingerprint(semantic).slice(0, 16)}`;
  const existing = pending.find(row => row.id === id && row.status === 'pending');
  if (existing) return { ...existing, _created: false };
  const row = { id, status: 'pending', created_at: nowIso(), ...issue };
  pending.push(row);
  atomicWrite(paths.pending, `${JSON.stringify(pending, null, 2)}\n`);
  return { ...row, _created: true };
}

function aliasCollisions(index, candidate) {
  const terms = [candidate.name, candidate.brand, candidate.product, ...candidate.aliases].filter(Boolean).map(normalizeTerm);
  return [...new Set(terms.flatMap(term => index.aliases[term] || []).filter(id => id !== candidate.id))];
}

export function upsertIngredient(paths, input, options = {}) {
  ensureLayout(paths);
  const current = currentIngredients(paths);
  const previous = current.get(input.id);
  const candidate = normalizeIngredient(input, previous);
  if (previous && stableString(ingredientSemantic(previous)) === stableString(ingredientSemantic(candidate))) {
    return { changed: false, ingredient: previous, reason: 'identical revision already current' };
  }
  if (previous && candidate.source_priority < previous.source_priority && !options.force) {
    const review = addPending(paths, {
      type: 'source_priority_conflict', subject: candidate.id,
      reason: 'lower-priority source cannot replace the current verified record',
      candidates: [{ source_type: previous.source_type, source_priority: previous.source_priority }, { source_type: candidate.source_type, source_priority: candidate.source_priority }],
    });
    return { changed: false, pending_review: review, reason: 'source priority conflict' };
  }
  const index = loadIngredientIndex(paths);
  const collisions = aliasCollisions(index, candidate);
  if (!previous && collisions.length && !options.force) {
    const review = addPending(paths, {
      type: 'alias_conflict', subject: candidate.id,
      reason: 'name or alias already resolves to another ingredient', candidates: collisions,
    });
    return { changed: false, pending_review: review, reason: 'alias conflict' };
  }
  appendJsonl(paths.ingredients, candidate);
  rebuildIngredientIndex(paths);
  updateState(paths, { last_incremental_at: nowIso() });
  return { changed: true, ingredient: candidate };
}

function compactIngredient(record) {
  if (!record) return null;
  return {
    id: record.id, name: record.name, aliases: record.aliases, basis: record.basis,
    weight_state: record.weight_state, edible_fraction: record.edible_fraction,
    source_type: record.source_type, source_priority: record.source_priority,
    nutrients: Object.fromEntries(NUTRIENTS.map(name => [name, record.nutrients[name]])),
  };
}

export function searchIngredients(paths, query, options = {}) {
  ensureLayout(paths);
  const index = loadIngredientIndex(paths);
  const term = normalizeTerm(query);
  let ids = index.aliases[term] || [];
  if (!ids.length) {
    ids = Object.entries(index.aliases).filter(([key]) => key.includes(term)).flatMap(([, values]) => values);
  }
  ids = [...new Set(ids)];
  let records = ids.map(id => index.ingredients[id]).filter(Boolean);
  if (options.weightState) records = records.filter(record => record.weight_state === options.weightState);
  return records.sort((a, b) => b.source_priority - a.source_priority || a.id.localeCompare(b.id));
}

function resolveIngredient(paths, reference) {
  const index = loadIngredientIndex(paths);
  if (reference.ingredient_id && index.ingredients[reference.ingredient_id]) return index.ingredients[reference.ingredient_id];
  const query = reference.ingredient || reference.query || reference.name;
  if (!query) throw cliError('ingredient item requires ingredient_id or ingredient query');
  const matches = searchIngredients(paths, query, { weightState: reference.weight_state });
  if (matches.length === 1) return matches[0];
  if (!matches.length) {
    const review = addPending(paths, { type: 'missing_ingredient', subject: String(query), reason: 'ingredient not found in local cache', candidates: [] });
    throw cliError(`ingredient requires review: ${review.id}`, 3);
  }
  const review = addPending(paths, { type: 'ambiguous_ingredient', subject: String(query), reason: 'ingredient alias matches multiple records or weight states', candidates: matches.map(row => ({ id: row.id, weight_state: row.weight_state })) });
  throw cliError(`ingredient requires review: ${review.id}`, 3);
}

function zeroNutrition() { return Object.fromEntries(NUTRIENTS.map(name => [name, 0])); }

function sumNutrition(values) {
  const total = zeroNutrition();
  for (const value of values) for (const name of NUTRIENTS) total[name] = round(total[name] + Number(value?.[name] || 0));
  return total;
}

function scaleNutrition(nutrients, factor) {
  return Object.fromEntries(NUTRIENTS.map(name => [name, round(Number(nutrients[name] || 0) * factor)]));
}

function calculateIngredientItem(paths, item) {
  const ingredient = resolveIngredient(paths, item);
  if (item.weight_state && item.weight_state !== ingredient.weight_state) {
    throw cliError(`weight_state mismatch for ingredient ${ingredient.id}`, 3);
  }
  let factor;
  let consumed;
  if (ingredient.basis === 'per_100g') {
    const gross = Number(item.grams ?? item.amount_g);
    if (!(gross >= 0)) throw cliError(`grams required for ${ingredient.id}`);
    const edibleGrams = item.edible_grams === undefined ? gross * ingredient.edible_fraction : Number(item.edible_grams);
    factor = edibleGrams / 100;
    consumed = { gross_g: gross, edible_g: round(edibleGrams) };
  } else if (ingredient.basis === 'per_100ml') {
    const ml = Number(item.ml ?? item.amount_ml);
    if (!(ml >= 0)) throw cliError(`ml required for ${ingredient.id}`);
    factor = ml / 100;
    consumed = { ml };
  } else {
    const units = Number(item.units ?? item.amount_units);
    if (!(units >= 0)) throw cliError(`units required for ${ingredient.id}`);
    factor = units;
    consumed = { units, estimated_grams: ingredient.unit_grams === null ? null : round(units * ingredient.unit_grams) };
  }
  return {
    type: 'ingredient', ingredient_id: ingredient.id, ingredient_revision: ingredient.revision,
    name: ingredient.name, basis: ingredient.basis, weight_state: ingredient.weight_state,
    source_type: ingredient.source_type, source_priority: ingredient.source_priority,
    estimated: Boolean(ingredient.uncertainty) || ingredient.source_priority <= SOURCE_PRIORITIES.generic_estimate || ingredient.nutrients.missing_nutrients.length > 0,
    consumed, nutrition: scaleNutrition(ingredient.nutrients, factor),
    evidence: ingredient.evidence, provenance: ingredient.provenance, uncertainty: ingredient.uncertainty,
  };
}

function recipeKey(row) { return `${row.id}@${row.version}`; }
function allRecipes(paths) { return readJsonl(paths.recipes); }

function compareVersion(a, b) {
  const an = Number(a); const bn = Number(b);
  if (Number.isFinite(an) && Number.isFinite(bn)) return an - bn;
  return String(a).localeCompare(String(b));
}

function latestRecipe(paths, id) {
  return allRecipes(paths).filter(row => row.id === id).sort((a, b) => compareVersion(a.version, b.version)).at(-1);
}

function getRecipe(paths, id, version) {
  const rows = allRecipes(paths).filter(row => row.id === id);
  if (!rows.length) throw cliError(`recipe not found: ${id}`, 3);
  if (version === undefined || version === null) return rows.sort((a, b) => compareVersion(a.version, b.version)).at(-1);
  const row = rows.find(candidate => String(candidate.version) === String(version));
  if (!row) throw cliError(`recipe version not found: ${id}@${version}`, 3);
  return row;
}

function recipeSemantic(row) {
  const { recorded_at, fingerprint: ignored, ...semantic } = row;
  return semantic;
}

export function addRecipe(paths, input, options = {}) {
  ensureLayout(paths);
  const id = validateId(input.id, 'recipe id');
  if (!String(input.name || '').trim()) throw cliError('recipe name is required');
  let version = input.version;
  if ((version === undefined || version === null) && options.update) {
    const latest = latestRecipe(paths, id);
    version = Number.isFinite(Number(latest?.version)) ? Number(latest.version) + 1 : 1;
  }
  if (version === undefined || version === null) version = 1;
  if (!Array.isArray(input.items) || !input.items.length) throw cliError('recipe items are required');
  const items = input.items.map(item => calculateIngredientItem(paths, item));
  const total = sumNutrition(items.map(item => item.nutrition));
  const servings = input.servings === undefined ? null : Number(input.servings);
  const cookedTotalG = input.cooked_total_g === undefined ? null : Number(input.cooked_total_g);
  const servingGrams = input.serving_grams === undefined ? null : Number(input.serving_grams);
  if (servings !== null && (!(servings > 0) || !Number.isFinite(servings))) throw cliError('servings must be positive');
  if (cookedTotalG !== null && (!(cookedTotalG > 0) || !Number.isFinite(cookedTotalG))) throw cliError('cooked_total_g must be positive');
  if (servingGrams !== null && (!(servingGrams > 0) || !Number.isFinite(servingGrams))) throw cliError('serving_grams must be positive');
  const perServingFactor = servings ? 1 / servings : (servingGrams && cookedTotalG ? servingGrams / cookedTotalG : null);
  const record = {
    schema_version: SCHEMA_VERSION, id, name: String(input.name).trim(), version,
    aliases: [...new Set((input.aliases || []).map(String))], items,
    cooked_total_g: cookedTotalG, servings, serving_grams: servingGrams,
    nutrition_total: total,
    nutrition_per_serving: perServingFactor === null ? null : scaleNutrition(total, perServingFactor),
    nutrition_per_100g: cookedTotalG ? scaleNutrition(total, 100 / cookedTotalG) : null,
    notes: input.notes || null, recorded_at: nowIso(),
  };
  record.fingerprint = fingerprint(recipeSemantic(record));
  const existing = allRecipes(paths).find(row => recipeKey(row) === recipeKey(record));
  if (existing) {
    if (existing.fingerprint === record.fingerprint || stableString(recipeSemantic(existing)) === stableString(recipeSemantic(record))) return { changed: false, recipe: existing, reason: 'identical recipe version already exists' };
    const review = addPending(paths, { type: 'recipe_version_conflict', subject: recipeKey(record), reason: 'an immutable recipe version already exists with different contents', candidates: [existing.fingerprint, record.fingerprint] });
    return { changed: false, pending_review: review, reason: 'recipe version conflict' };
  }
  appendJsonl(paths.recipes, record);
  updateState(paths, { last_incremental_at: nowIso() });
  return { changed: true, recipe: record };
}

function compactRecipe(recipe) {
  return {
    id: recipe.id, name: recipe.name, version: recipe.version, item_count: recipe.items.length,
    cooked_total_g: recipe.cooked_total_g, servings: recipe.servings,
    nutrition_total: recipe.nutrition_total, nutrition_per_serving: recipe.nutrition_per_serving,
    nutrition_per_100g: recipe.nutrition_per_100g,
  };
}

function calculateRecipeItem(paths, item) {
  const recipe = getRecipe(paths, item.recipe_id, item.version);
  let factor;
  let consumed;
  if (item.servings !== undefined) {
    factor = Number(item.servings) / Number(recipe.servings || 1);
    consumed = { servings: Number(item.servings) };
  } else if (item.grams !== undefined) {
    if (!recipe.cooked_total_g) throw cliError(`recipe ${recipe.id} has no cooked_total_g for gram scaling`);
    factor = Number(item.grams) / recipe.cooked_total_g;
    consumed = { grams: Number(item.grams) };
  } else {
    factor = 1;
    consumed = { batches: 1 };
  }
  if (!(factor >= 0) || !Number.isFinite(factor)) throw cliError(`invalid recipe quantity: ${recipe.id}`);
  return {
    type: 'recipe', recipe_id: recipe.id, recipe_version: recipe.version, name: recipe.name,
    consumed, nutrition: scaleNutrition(recipe.nutrition_total, factor),
    estimated: recipe.items.some(row => row.estimated), recipe_fingerprint: recipe.fingerprint,
    evidence: recipe.items.map(row => row.evidence).filter(Boolean),
  };
}

export function calculateMeal(paths, input) {
  ensureLayout(paths);
  if (!Array.isArray(input.items) || !input.items.length) throw cliError('meal items are required');
  const items = input.items.map(item => item.recipe_id ? calculateRecipeItem(paths, item) : calculateIngredientItem(paths, item));
  return {
    item_count: items.length,
    estimated_items: items.filter(item => item.estimated).length,
    nutrition: sumNutrition(items.map(item => item.nutrition)),
    items,
  };
}

function dateFromInput(input) {
  const value = input.occurred_at || input.date;
  if (!value) throw cliError('meal occurred_at or date is required');
  const match = String(value).match(/^(\d{4}-\d{2}-\d{2})/);
  if (!match) throw cliError('meal date must begin with YYYY-MM-DD');
  return match[1];
}

function mealFile(paths, date) { return join(paths.mealsDir, `${date.slice(0, 7)}.jsonl`); }

function mealSemantic(row) {
  const { logged_at, ...semantic } = row;
  return semantic;
}

function allMealRows(paths) {
  if (!existsSync(paths.mealsDir)) return [];
  return readdirSync(paths.mealsDir).filter(name => /^\d{4}-\d{2}\.jsonl$/.test(name)).sort().flatMap(name => readJsonl(join(paths.mealsDir, name)));
}

function targetForDay(paths, dayType) {
  const profile = readJson(paths.profile, { goals: {} });
  return profile.goals?.[dayType] || profile.goals?.default || null;
}

function targetDelta(total, target) {
  if (!target) return null;
  const result = {};
  for (const name of NUTRIENTS) if (target[name] !== undefined) result[name] = round(total[name] - Number(target[name]));
  return result;
}

function deriveDay(paths, date) {
  const meals = allMealRows(paths).filter(row => row.date === date);
  const total = sumNutrition(meals.map(row => row.nutrition));
  const dayTypes = [...new Set(meals.map(row => row.day_type).filter(Boolean))];
  const dayType = dayTypes.length === 1 ? dayTypes[0] : (dayTypes.length ? 'mixed' : null);
  const target = dayType && dayType !== 'mixed' ? targetForDay(paths, dayType) : targetForDay(paths, 'default');
  return {
    schema_version: SCHEMA_VERSION, algorithm_version: ALGORITHM_VERSION, date,
    meal_count: meals.length, day_type: dayType, nutrition: total,
    estimated_items: meals.reduce((sum, row) => sum + Number(row.estimated_items || 0), 0),
    target_delta: targetDelta(total, target), calculated_at: nowIso(),
  };
}

function replaceJsonlByKey(path, row, key) {
  const rows = readJsonl(path);
  const index = rows.findIndex(candidate => candidate[key] === row[key]);
  if (index === -1) rows.push(row); else rows[index] = row;
  rows.sort((a, b) => String(a[key]).localeCompare(String(b[key])));
  writeJsonl(path, rows);
}

function weekStart(date) {
  const value = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(value.valueOf())) throw cliError('invalid date');
  const day = value.getUTCDay() || 7;
  value.setUTCDate(value.getUTCDate() - day + 1);
  return value.toISOString().slice(0, 10);
}

function deriveWeek(paths, date) {
  const start = weekStart(date);
  const endDate = new Date(`${start}T00:00:00Z`);
  endDate.setUTCDate(endDate.getUTCDate() + 6);
  const end = endDate.toISOString().slice(0, 10);
  const days = readJsonl(paths.dailyTotals).filter(row => row.date >= start && row.date <= end);
  return {
    schema_version: SCHEMA_VERSION, algorithm_version: ALGORITHM_VERSION,
    week_start: start, week_end: end, days_logged: days.filter(row => row.meal_count > 0).length,
    meal_count: days.reduce((sum, row) => sum + row.meal_count, 0),
    nutrition: sumNutrition(days.map(row => row.nutrition)),
    daily_average: days.length ? scaleNutrition(sumNutrition(days.map(row => row.nutrition)), 1 / days.length) : zeroNutrition(),
    calculated_at: nowIso(),
  };
}

function updateWeek(paths, date) {
  const row = deriveWeek(paths, date);
  const document = readJson(paths.weeklySummary, { schema_version: SCHEMA_VERSION, algorithm_version: ALGORITHM_VERSION, weeks: {} });
  document.schema_version = SCHEMA_VERSION;
  document.algorithm_version = ALGORITHM_VERSION;
  document.weeks ||= {};
  document.weeks[row.week_start] = row;
  atomicWrite(paths.weeklySummary, `${JSON.stringify(document, null, 2)}\n`);
  return row;
}

function updateDate(paths, date) {
  const day = deriveDay(paths, date);
  replaceJsonlByKey(paths.dailyTotals, day, 'date');
  const week = updateWeek(paths, date);
  updateState(paths, { last_incremental_at: nowIso(), last_incremental_dates: [date] });
  return { day, week };
}

export function logMeal(paths, input) {
  ensureLayout(paths);
  const date = dateFromInput(input);
  const calculated = calculateMeal(paths, input);
  const identity = input.id || `meal-${fingerprint({ date, occurred_at: input.occurred_at || date, name: input.name || null, items: input.items }).slice(0, 20)}`;
  const record = {
    schema_version: SCHEMA_VERSION, id: validateId(identity, 'meal id'), date,
    occurred_at: input.occurred_at || `${date}T12:00:00`, name: input.name || null,
    day_type: input.day_type || null, source: input.source || 'manual',
    item_count: calculated.item_count, estimated_items: calculated.estimated_items,
    nutrition: calculated.nutrition, items: calculated.items, evidence: input.evidence || null,
    logged_at: nowIso(),
  };
  const path = mealFile(paths, date);
  const rows = readJsonl(path);
  const existing = rows.find(row => row.id === record.id);
  if (existing) {
    if (stableString(mealSemantic(existing)) === stableString(mealSemantic(record))) return { changed: false, meal: existing, reason: 'identical meal already logged' };
    throw cliError(`meal id already exists with different contents: ${record.id}`, 3);
  }
  rows.push(record);
  rows.sort((a, b) => String(a.occurred_at).localeCompare(String(b.occurred_at)) || a.id.localeCompare(b.id));
  writeJsonl(path, rows);
  const derived = updateDate(paths, date);
  return { changed: true, meal: record, derived };
}

export function rebuild(paths) {
  ensureLayout(paths);
  const index = rebuildIngredientIndex(paths);
  const dates = [...new Set(allMealRows(paths).map(row => row.date))].sort();
  const days = dates.map(date => deriveDay(paths, date));
  writeJsonl(paths.dailyTotals, days);
  const weeks = {};
  for (const date of dates) {
    const start = weekStart(date);
    if (!weeks[start]) weeks[start] = deriveWeek(paths, date);
  }
  atomicWrite(paths.weeklySummary, `${JSON.stringify({ schema_version: SCHEMA_VERSION, algorithm_version: ALGORITHM_VERSION, weeks }, null, 2)}\n`);
  updateState(paths, { schema_version: SCHEMA_VERSION, algorithm_version: ALGORITHM_VERSION, last_rebuild_at: nowIso(), last_incremental_at: nowIso(), last_incremental_dates: dates });
  return { rebuilt: true, ingredient_count: Object.keys(index.ingredients).length, recipe_count: allRecipes(paths).length, meal_count: allMealRows(paths).length, day_count: days.length, week_count: Object.keys(weeks).length };
}

export function validate(paths) {
  ensureLayout(paths);
  const ingredients = currentIngredients(paths);
  const recipes = allRecipes(paths);
  const meals = allMealRows(paths);
  const pending = readJson(paths.pending, []);
  const index = loadIngredientIndex(paths);
  const missingIngredientSnapshots = recipes.flatMap(recipe => recipe.items.filter(item => !item.ingredient_id)).length;
  const duplicateRecipeVersions = recipes.length - new Set(recipes.map(recipeKey)).size;
  return {
    ok: missingIngredientSnapshots === 0 && duplicateRecipeVersions === 0,
    ...versionStatus(paths),
    counts: {
      ingredients: ingredients.size, ingredient_revisions: readJsonl(paths.ingredients).length,
      aliases: Object.keys(index.aliases).length, recipe_versions: recipes.length,
      meals: meals.length, days: readJsonl(paths.dailyTotals).length,
      pending: pending.filter(row => row.status === 'pending').length,
    },
    issues: { missing_ingredient_snapshots: missingIngredientSnapshots, duplicate_recipe_versions: duplicateRecipeVersions },
  };
}

export function importBundle(paths, bundle) {
  ensureLayout(paths);
  const result = { ingredients_added: 0, recipes_added: 0, pending_added: 0, unchanged: 0 };
  for (const ingredient of bundle.ingredients || []) {
    const added = upsertIngredient(paths, ingredient);
    if (added.changed) result.ingredients_added++;
    else if (added.pending_review?._created) result.pending_added++;
    else result.unchanged++;
  }
  for (const recipe of bundle.recipes || []) {
    try {
      const added = addRecipe(paths, recipe);
      if (added.changed) result.recipes_added++;
      else if (added.pending_review?._created) result.pending_added++;
      else result.unchanged++;
    } catch (error) {
      addPending(paths, { type: 'import_recipe_conflict', subject: recipe.id || 'unknown', reason: error.message, candidates: [] });
      result.pending_added++;
    }
  }
  for (const issue of bundle.pending || []) {
    const pending = addPending(paths, { type: issue.type || 'migration_review', subject: issue.subject || 'unknown', reason: issue.reason || 'requires review', candidates: issue.candidates || [] });
    if (pending._created) result.pending_added++; else result.unchanged++;
  }
  return result;
}

function readInput(args) {
  if (args.json !== undefined) {
    try { return JSON.parse(args.json); } catch { throw cliError('invalid --json payload'); }
  }
  if (args.file) {
    try { return JSON.parse(readFileSync(resolve(args.file), 'utf8')); } catch { throw cliError('invalid --file JSON'); }
  }
  throw cliError('provide --json or --file');
}

function detailLevel(args) { return args['full-json'] ? 'full' : (args.details ? 'details' : 'compact'); }

function presentIngredient(record, level) {
  if (level === 'full') return record;
  const compact = compactIngredient(record);
  if (level === 'details') return { ...compact, serving: record.serving, unit_grams: record.unit_grams, uncertainty: record.uncertainty, provenance: record.provenance };
  return compact;
}

function presentRecipe(record, level) {
  if (level === 'full') return record;
  const compact = compactRecipe(record);
  if (level === 'details') return { ...compact, items: record.items.map(item => ({ ingredient_id: item.ingredient_id, ingredient_revision: item.ingredient_revision, consumed: item.consumed, nutrition: item.nutrition, estimated: item.estimated })) };
  return compact;
}

function presentMeal(calculated, level) {
  const compact = { item_count: calculated.item_count, estimated_items: calculated.estimated_items, nutrition: calculated.nutrition };
  if (level === 'compact') return compact;
  if (level === 'details') return { ...compact, items: calculated.items.map(item => ({ type: item.type, name: item.name, consumed: item.consumed, nutrition: item.nutrition, estimated: item.estimated })) };
  return calculated;
}

function recipeComparison(paths, refs, level) {
  if (!Array.isArray(refs) || refs.length < 2) throw cliError('recipe compare requires at least two recipe references');
  const recipes = refs.map(ref => getRecipe(paths, ref.id || ref.recipe_id, ref.version));
  const baseline = recipes[0];
  return {
    baseline: { id: baseline.id, version: baseline.version },
    recipes: recipes.map(recipe => ({
      ...(level === 'full' ? recipe : compactRecipe(recipe)),
      delta_from_baseline: Object.fromEntries(NUTRIENTS.map(name => [name, round(recipe.nutrition_total[name] - baseline.nutrition_total[name])])),
    })),
  };
}

function pendingList(paths, level) {
  const rows = readJson(paths.pending, []).filter(row => row.status === 'pending');
  if (level === 'full') return rows;
  return rows.map(row => ({ id: row.id, type: row.type, subject: row.subject, reason: row.reason }));
}

function resolvePending(paths, id, args) {
  const rows = readJson(paths.pending, []);
  const index = rows.findIndex(row => row.id === id && row.status === 'pending');
  if (index === -1) throw cliError(`pending item not found: ${id}`, 3);
  rows[index] = { ...rows[index], status: 'resolved', resolved_at: nowIso(), resolution: args.action || 'acknowledged' };
  atomicWrite(paths.pending, `${JSON.stringify(rows, null, 2)}\n`);
  return rows[index];
}

function compactMutation(result, presenter, level) {
  const out = { changed: result.changed, reason: result.reason || null };
  if (result.ingredient) out.ingredient = presenter(result.ingredient, level);
  if (result.recipe) out.recipe = presenter(result.recipe, level);
  if (result.pending_review) out.pending_review = { id: result.pending_review.id, type: result.pending_review.type, reason: result.pending_review.reason };
  return out;
}

export async function runCli(argv = process.argv.slice(2), options = {}) {
  const args = parseArgs(argv);
  const paths = resolvePaths({ workspace: args.workspace || options.workspace, dataRoot: args['data-root'] || options.dataRoot });
  ensureLayout(paths);
  const [group, action] = args._;
  const level = detailLevel(args);
  if (group === 'ingredient') {
    if (action === 'add' || action === 'update') return compactMutation(upsertIngredient(paths, readInput(args), { force: args.force }), presentIngredient, level);
    if (action === 'show') {
      const record = loadIngredientIndex(paths).ingredients[args.id || args._[2]];
      if (!record) throw cliError('ingredient not found', 3);
      return presentIngredient(record, level);
    }
    if (action === 'list') return Object.values(loadIngredientIndex(paths).ingredients).map(record => presentIngredient(record, level));
    if (action === 'search') return searchIngredients(paths, args.query || args._.slice(2).join(' '), { weightState: args['weight-state'] }).map(record => presentIngredient(record, level));
  }
  if (group === 'recipe') {
    if (action === 'add' || action === 'update') return compactMutation(addRecipe(paths, readInput(args), { update: action === 'update' }), presentRecipe, level);
    if (action === 'calculate') return presentRecipe(getRecipe(paths, args.id || args._[2], args.version), level);
    if (action === 'compare') return recipeComparison(paths, readInput(args).recipes, level);
  }
  if (group === 'meal') {
    if (action === 'calculate') return presentMeal(calculateMeal(paths, readInput(args)), level);
    if (action === 'log') {
      const result = logMeal(paths, readInput(args));
      return { changed: result.changed, reason: result.reason || null, meal: presentMeal(result.meal, level), date: result.meal.date };
    }
  }
  if (group === 'day' && action === 'summary') {
    const date = args.date || new Date().toISOString().slice(0, 10);
    const row = deriveDay(paths, date);
    return level === 'full' ? { ...row, meals: allMealRows(paths).filter(meal => meal.date === date) } : row;
  }
  if (group === 'week' && action === 'summary') return deriveWeek(paths, args.date || new Date().toISOString().slice(0, 10));
  if (group === 'pending-review') {
    if (action === 'list') return pendingList(paths, level);
    if (action === 'resolve') return resolvePending(paths, args.id || args._[2], args);
  }
  if (group === 'import-kb') return importBundle(paths, readInput(args));
  if (group === 'rebuild') return rebuild(paths);
  if (group === 'validate') return validate(paths);
  throw cliError('usage: nutrition-ledger.mjs <ingredient|recipe|meal|day|week|pending-review|import-kb|rebuild|validate> ...', 2);
}

function isDirectExecution(entrypoint = process.argv[1]) {
  if (!entrypoint) return false;
  const modulePath = fileURLToPath(import.meta.url);
  try { return realpathSync(resolve(entrypoint)) === realpathSync(modulePath); }
  catch { return resolve(entrypoint) === modulePath; }
}

if (isDirectExecution()) {
  runCli().then(result => process.stdout.write(`${JSON.stringify(result)}\n`)).catch(error => {
    process.stderr.write(`${JSON.stringify({ error: error.message, details: error.details || null })}\n`);
    process.exitCode = Number(error.exitCode || 1);
  });
}
