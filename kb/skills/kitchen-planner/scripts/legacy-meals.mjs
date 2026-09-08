// Existing deterministic recipe/meal algorithms, now owned by kitchen-planner.
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { SCHEMA_VERSION, ALGORITHM_VERSION, NUTRIENTS, cliError, readJson, readJsonl, atomicWrite, writeJsonl, appendJsonl, stableString, fingerprint, round, nowIso, validateId, calculateIngredientItem, sumNutrition, scaleNutrition, zeroNutrition, addPending, updateState } from './nutrition.mjs';
import { ensureKitchenLayout as ensureLayout } from './paths.mjs';
import { listDataFiles } from './nutrition.mjs';
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
  const oldRequest = allRecipes(paths).find(r => r.id === id && String(r.version) === String(input.version ?? 1));
  if (oldRequest?.request_fingerprint === fingerprint(input)) return { changed: false, recipe: oldRequest };
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
    notes: input.notes || null, equipment: input.equipment || [], steps: input.steps || [],
    estimated_minutes: input.estimated_minutes ?? null, raw_items: input.items,
    request_fingerprint: fingerprint(input),
    recorded_at: nowIso(),
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
  const parsed = new Date(`${match[1]}T00:00:00Z`);
  if (!Number.isFinite(parsed.valueOf()) || parsed.toISOString().slice(0,10) !== match[1]) throw cliError('invalid calendar date');
  return match[1];
}

function mealFile(paths, date) { return join(paths.mealsDir, `${date.slice(0, 7)}.jsonl`); }

function mealSemantic(row) {
  const { logged_at, ...semantic } = row;
  return semantic;
}

function allMealRows(paths) {
  if (!existsSync(paths.mealsDir)) return [];
  return listDataFiles(paths.mealsDir).filter(name => /^\d{4}-\d{2}\.jsonl$/.test(name)).sort().flatMap(name => readJsonl(join(paths.mealsDir, name)));
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


export { getRecipe, allRecipes, allMealRows, deriveDay, deriveWeek, updateDate, compactRecipe, presentRecipe, presentMeal, recipeComparison };
