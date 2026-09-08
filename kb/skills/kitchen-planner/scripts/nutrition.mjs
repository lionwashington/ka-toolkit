#!/usr/bin/env node
import { createHash } from 'node:crypto';
import {
  existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync,
  writeFileSync, openSync, closeSync, fsyncSync, unlinkSync,
} from 'node:fs';
import { homedir } from 'node:os';
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

export function canonicalPath(root) {
  root = resolve(root);
  let ancestor = root;
  const suffix = [];
  while (!existsSync(ancestor)) { suffix.unshift(basename(ancestor)); ancestor = dirname(ancestor); }
  return join(realpathSync(ancestor), ...suffix);
}

function assertPrivateDataRoot(root) {
  root = canonicalPath(root);
  if (root === dirname(root) || root === canonicalPath(homedir())) throw cliError('unsafe broad data root', 4);
  // Installed copies must also reject another checkout of the public source.
  for (let parent=root;;parent=dirname(parent)) {
    if (existsSync(join(parent,'.git')) && existsSync(join(parent,'kb/skills/kitchen-planner/SKILL.md'))) throw cliError('refusing data root inside a public Skill source repository',4);
    if(parent===dirname(parent)) break;
  }
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
  const candidates = [
    process.env.OPENCLAW_WORKSPACE_ROOT,
    process.env.KA_WORKSPACE_ROOT,
    join(homedir(), 'workspace', 'openclaw-ws'),
  ].filter(Boolean).map(candidate => resolve(candidate));
  const discovered = candidates.find(candidate => existsSync(join(candidate, 'memory')) || existsSync(join(candidate, 'data', 'health')));
  if (discovered) return discovered;
  return resolve(start);
}

export function resolvePaths(options = {}) {
  const workspace = resolve(options.workspace || findWorkspace());
  const root = canonicalPath(options.dataRoot || process.env.NUTRITION_DATA_ROOT || join(workspace, 'data', 'health', 'nutrition'));
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
    else if (['--details', '--full-json', '--force', '--apply'].includes(arg)) out[arg.slice(2)] = true;
    else {
      const equal = arg.indexOf('=');
      if (equal !== -1) out[arg.slice(2, equal)] = arg.slice(equal + 1);
      else out[arg.slice(2)] = argv[++i];
    }
  }
  return out;
}

let batch = null;
export function dataExists(path) { return batch?.has(path) || existsSync(path); }
function durableWrite(path, data) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
  const fd = openSync(temporary, 'w', 0o600);
  try { writeFileSync(fd, data); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temporary, path);
  const dir = openSync(dirname(path), 'r');
  try { fsyncSync(dir); } finally { closeSync(dir); }
}
function atomicWrite(path, data) {
  if (typeof data !== 'string') throw Error('atomic write requires serialized text');
  if (batch) { batch.set(path, data); return; }
  durableWrite(path, data);
}
export function transaction(root, operation) {
  const journal = join(root, 'state', '.transaction.json');
  const replay = writes => {
    for (const [path, data] of writes) {
      if (typeof path !== 'string' || typeof data !== 'string') throw Error('invalid transaction record');
      if (!isWithin(resolve(path), root)) throw Error('transaction path escapes kitchen');
      let ancestor = dirname(path);
      while (!existsSync(ancestor)) ancestor = dirname(ancestor);
      if (!isWithin(realpathSync(ancestor), root)) throw Error('transaction symlink escapes kitchen');
      if (existsSync(path) && !isWithin(realpathSync(path), root)) throw Error('transaction file escapes kitchen');
    }
    for (const [path, data] of writes) durableWrite(path, data);
  };
  if (existsSync(journal)) { replay(readJson(journal, [])); unlinkSync(journal); }
  batch = new Map();
  try {
    const result = operation();
    const writes = [...batch]; batch = null;
    if (writes.length) { durableWrite(journal, JSON.stringify(writes)); replay(writes); unlinkSync(journal); }
    return result;
  } finally { batch = null; }
}
export function listDataFiles(dir) {
  return [...new Set([...(existsSync(dir) ? readdirSync(dir) : []),
    ...[...(batch?.keys() || [])].filter(p => dirname(p) === dir).map(p => basename(p))])];
}

function readJson(path, fallback) {
  if (!existsSync(path) && !batch?.has(path)) return fallback;
  try { return JSON.parse(batch?.get(path) ?? readFileSync(path, 'utf8')); }
  catch { throw cliError(`invalid JSON in ${basename(path)}`, 5); }
}

function readJsonl(path) {
  if (!existsSync(path) && !batch?.has(path)) return [];
  return (batch?.get(path) ?? readFileSync(path, 'utf8')).split('\n').filter(Boolean).map((line, index) => {
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
  for (const dir of [dirname(paths.ingredients), paths.labelEvidenceDir, dirname(paths.state), dirname(paths.ingredientIndex)]) mkdirSync(dir, { recursive: true });
  if (!existsSync(paths.ingredients)) atomicWrite(paths.ingredients, '');
  if (!existsSync(paths.pending)) atomicWrite(paths.pending, '[]\n');
  if (!existsSync(paths.state)) atomicWrite(paths.state, JSON.stringify(defaultState()) + '\n');
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

function rebuildIngredientIndex(paths, persist = true) {
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
  if (persist) atomicWrite(paths.ingredientIndex, `${JSON.stringify(index, null, 2)}\n`);
  return index;
}

function loadIngredientIndex(paths) {
  if (paths.readIndex) return paths.readIndex;
  // Read raw revisions once per calculation. An index left stale after a crash
  // must not silently serve old nutrient values; reads never repair files.
  return rebuildIngredientIndex(paths, false);
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
    id: record.id, revision: record.revision, name: record.name, aliases: record.aliases, basis: record.basis,
    weight_state: record.weight_state, edible_fraction: record.edible_fraction,
    source_type: record.source_type, source_priority: record.source_priority,
    nutrients: Object.fromEntries(NUTRIENTS.map(name => [name, record.nutrients[name]])),
    missing_nutrients: record.nutrients.missing_nutrients,
  };
}

export function searchIngredients(paths, query, options = {}) {
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
  if (reference.ingredient_revision !== undefined) {
    const row = readJsonl(paths.ingredients).find(r => r.id === reference.ingredient_id && r.revision === reference.ingredient_revision);
    if (!row) throw cliError('ingredient revision not found', 3);
    return row;
  }
  const index = loadIngredientIndex(paths);
  if (reference.ingredient_id && index.ingredients[reference.ingredient_id]) return index.ingredients[reference.ingredient_id];
  const query = reference.ingredient || reference.query || reference.name;
  if (!query) throw cliError('ingredient item requires ingredient_id or ingredient query');
  const matches = searchIngredients(paths, query, { weightState: reference.weight_state });
  if (matches.length === 1) return matches[0];
  if (!matches.length) {
    throw cliError('ingredient requires review: missing local record', 3);
  }
  throw cliError('ingredient requires review: ambiguous alias or weight state', 3);
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
    if (!(gross >= 0) || !Number.isFinite(gross)) throw cliError(`grams required for ${ingredient.id}`);
    const edibleGrams = item.edible_grams === undefined ? gross * ingredient.edible_fraction : Number(item.edible_grams);
    if (!Number.isFinite(edibleGrams) || edibleGrams < 0 || edibleGrams > gross) throw cliError('invalid edible weight');
    factor = edibleGrams / 100;
    consumed = { gross_g: gross, edible_g: round(edibleGrams) };
  } else if (ingredient.basis === 'per_100ml') {
    const ml = Number(item.ml ?? item.amount_ml);
    if (!(ml >= 0) || !Number.isFinite(ml)) throw cliError(`ml required for ${ingredient.id}`);
    factor = ml / 100;
    consumed = { ml };
  } else {
    const units = Number(item.units ?? item.amount_units);
    if (!(units >= 0) || !Number.isFinite(units)) throw cliError(`units required for ${ingredient.id}`);
    factor = units;
    consumed = { units, estimated_grams: ingredient.unit_grams === null ? null : round(units * ingredient.unit_grams) };
  }
  return {
    type: 'ingredient', ingredient_id: ingredient.id, ingredient_revision: ingredient.revision,
    name: ingredient.name, basis: ingredient.basis, weight_state: ingredient.weight_state,
    source_type: ingredient.source_type, source_priority: ingredient.source_priority,
    estimated: Boolean(ingredient.uncertainty) || ingredient.source_priority <= SOURCE_PRIORITIES.generic_estimate || ingredient.nutrients.missing_nutrients.length > 0,
    consumed, nutrition: scaleNutrition(ingredient.nutrients, factor),
    missing_nutrients: ingredient.nutrients.missing_nutrients,
    evidence: ingredient.evidence, provenance: ingredient.provenance, uncertainty: ingredient.uncertainty,
  };
}

export function calculateNutrition(paths, input) {
  if (!Array.isArray(input.items) || !input.items.length) throw cliError('ingredient items are required');
  if (input.items.some(i => i.recipe_id)) throw cliError('recipe references belong to kitchen-planner');
  const readPaths = { ...paths, readIndex: loadIngredientIndex(paths) };
  const items = input.items.map(item => calculateIngredientItem(readPaths, item));
  return { item_count: items.length, estimated_items: items.filter(i => i.estimated).length,
    nutrition: sumNutrition(items.map(i => i.nutrition)), items,
    missing_nutrients: [...new Set(items.flatMap(i => i.missing_nutrients))] };
}

export function rebuild(paths) {
  ensureLayout(paths);
  const index = rebuildIngredientIndex(paths);
  updateState(paths, { schema_version: SCHEMA_VERSION, algorithm_version: ALGORITHM_VERSION, last_rebuild_at: nowIso() });
  return { rebuilt: true, ingredient_count: Object.keys(index.ingredients).length };
}

export function validate(paths) {
  const ingredients = currentIngredients(paths);
  const pending = readJson(paths.pending, []);
  return { ok: true, ...versionStatus(paths), counts: { ingredients: ingredients.size, ingredient_revisions: readJsonl(paths.ingredients).length, pending: pending.filter(r => r.status === 'pending').length } };
}

export function importBundle(paths, bundle) {
  if (bundle.recipes?.length) throw cliError('recipe imports belong to kitchen-planner; split the import bundle', 3);
  ensureLayout(paths);
  const result = { ingredients_added: 0, recipes_added: 0, pending_added: 0, unchanged: 0 };
  for (const ingredient of bundle.ingredients || []) {
    const added = upsertIngredient(paths, ingredient);
    if (added.changed) result.ingredients_added++;
    else if (added.pending_review?._created) result.pending_added++;
    else result.unchanged++;
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

function pendingList(paths, level) {
  const rows = readJson(paths.pending, []).filter(row => row.status === 'pending' && !/recipe|meal|goal|menu/.test(row.type || ''));
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
  if (['recipe', 'meal', 'day', 'week'].includes(group)) {
    const { runCli: planner } = await import('./kitchen-planner.mjs');
    return planner(argv, { nutritionRoot: paths.root, legacyRoot: true });
  }
  if (group === 'nutrition' && action === 'calculate') {
    const result = calculateNutrition(paths, readInput(args));
    return level === 'compact' ? { nutrition: result.nutrition, item_count: result.items.length, estimated_items: result.estimated_items, missing_nutrients: result.missing_nutrients } : result;
  }
  if (group === 'pending-review') {
    if (action === 'list') return pendingList(paths, level);
    if (action === 'resolve') return resolvePending(paths, args.id || args._[2], args);
  }
  if (group === 'import-kb') return importBundle(paths, readInput(args));
  if (group === 'rebuild') return rebuild(paths);
  if (group === 'validate') return validate(paths);
  throw cliError('usage: nutrition-ledger.mjs <ingredient|nutrition|pending-review|import-kb|rebuild|validate> ...', 2);
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

// Shared pure primitives: kitchen-planner owns all recipe/meal persistence.
export { NUTRIENTS, cliError, readJson, readJsonl, atomicWrite, writeJsonl, appendJsonl, stableString, fingerprint, round, nowIso, validateId, calculateIngredientItem, sumNutrition, scaleNutrition, zeroNutrition, addPending, updateState, parseArgs, readInput, isWithin, assertPrivateDataRoot };
