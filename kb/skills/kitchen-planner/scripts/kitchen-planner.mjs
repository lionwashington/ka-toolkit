#!/usr/bin/env node
import { readFileSync, realpathSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { parseArgs, readInput, readJson, readJsonl, atomicWrite, writeJsonl, fingerprint, stableString,
  calculateNutrition, scaleNutrition, sumNutrition, transaction, validateId, runCli as nutritionCli, resolvePaths } from './nutrition.mjs';
import { resolveKitchen, ensureKitchenLayout } from './paths.mjs';
import { addRecipe, getRecipe, allRecipes, calculateMeal, logMeal, allMealRows, deriveDay, deriveWeek,
  updateDate, compactRecipe, presentRecipe, presentMeal, recipeComparison } from './legacy-meals.mjs';
import { migrate } from './migration.mjs';

const entry = fileURLToPath(import.meta.url);
const fresh = () => ({ schema_version: 1, algorithm_version: 1, revision: 0, lots: {}, equipment: {}, menus: {}, events: [] });
function state(p) { return readJson(p.kitchen, fresh()); }
function number(v, label, min = 0) { if (typeof v !== 'number' || !Number.isFinite(v) || v < min) throw Error(`invalid ${label}`); return v; }
function requireVersion(s, request) { if (request.expected_revision !== s.revision) throw Error('inventory revision changed; refresh and confirm again'); }
function itemsForRecipe(r) {
  return r.raw_items?.map((i,n)=>({...i,ingredient_revision:r.items[n].ingredient_revision})) || r.items.map(i => ({ ingredient_id: i.ingredient_id, ingredient_revision: i.ingredient_revision,
    weight_state: i.weight_state, ...(i.consumed.gross_g !== undefined ? { grams: i.consumed.gross_g, edible_grams: i.consumed.edible_g } : i.consumed) }));
}
function lotItem(lot, amount) {
  return { ingredient_id: lot.ingredient_id, ingredient_revision: lot.ingredient_revision,
    weight_state: lot.weight_state, [({ g: 'grams', ml: 'ml', unit: 'units' })[lot.unit]]: amount };
}

function cookingCalculation(p,s,used) {
  const ordinary=Object.entries(used).filter(([id])=>s.lots[id].kind!=='prepared');
  const prepared=Object.entries(used).filter(([id])=>s.lots[id].kind==='prepared').map(([id,n])=>{
    const lot=s.lots[id];return {type:'prepared',lot_id:id,nutrition:scaleNutrition(lot.nutrition_total,n/lot.original_quantity),
      missing_nutrients:lot.missing_nutrients||[],estimated:lot.estimated,consumed:{[lot.unit]:n}};
  });
  const raw=ordinary.length?calculateNutrition(p,{items:ordinary.map(([id,n])=>lotItem(s.lots[id],n))}):{items:[]};
  const items=[...raw.items,...prepared];
  return {items,item_count:items.length,nutrition:sumNutrition(items.map(i=>i.nutrition)),estimated_items:items.filter(i=>i.estimated).length,
    missing_nutrients:[...new Set(items.flatMap(i=>i.missing_nutrients||[]))]};
}

export function evaluate(p, s, input) {
  const profile=readJson(p.profile,{});
  const constraints = { ...(profile.planning_defaults || {}), ...(input.constraints || {}) };
  constraints.exclude_ingredient_ids=[...new Set([...(profile.exclude_ingredient_ids || []),...(constraints.exclude_ingredient_ids || [])])];
  const people = number(input.people ?? 1, 'people', 1);
  const dishes = input.dishes || [{ items: input.items, equipment: input.equipment, estimated_minutes: input.estimated_minutes }];
  const items = [], equipment = [], requirements = {}, issues = [], warnings = [];
  let minutes = 0;
  for (const dish of dishes) {
    const r = dish.recipe_id ? getRecipe(p, dish.recipe_id, dish.version) : dish;
    const factor = number(dish.factor ?? 1, 'dish factor', Number.MIN_VALUE);
    const sourceItems = dish.recipe_id ? itemsForRecipe(r) : r.items;
    if (!Array.isArray(sourceItems) || !sourceItems.length) throw Error('dish items required');
    for (const i of sourceItems) {
      const item = { ...i };
      for (const k of ['grams','ml','units','edible_grams']) if (item[k] !== undefined) item[k] *= factor;
      items.push(item);
    }
    equipment.push(...(r.equipment || []));
    if (r.estimated_minutes == null) warnings.push('cooking_time_unknown');
    else minutes += number(r.estimated_minutes, 'estimated_minutes');
  }
  for (const item of items) {
    if (item.lot_id) {
      const lot=s.lots[item.lot_id];if(!lot || lot.kind!=='prepared')throw Error('prepared lot not found');
      if ((lot.ingredient_ids||[]).some(id=>constraints.exclude_ingredient_ids.includes(id)))issues.push('excluded_ingredient');
      const amount=number(lot.unit==='g'?item.grams:item.units,'prepared quantity');
      const key=`prepared:${lot.id}`;requirements[key]=(requirements[key]||0)+amount;continue;
    }
    if ((constraints.exclude_ingredient_ids || []).includes(item.ingredient_id)) issues.push('excluded_ingredient');
    const unit = item.grams !== undefined ? 'g' : item.ml !== undefined ? 'ml' : 'unit';
    const amount = number(item.grams ?? item.ml ?? item.units, 'ingredient amount');
    const key = `${item.ingredient_id}|${item.weight_state || ''}|${unit}`;
    requirements[key] = (requirements[key] || 0) + amount;
  }
  const allocations = [];
  for (const [key, amount] of Object.entries(requirements)) {
    if(key.startsWith('prepared:')){const lot=s.lots[key.slice(9)];if(lot.quantity===null||lot.quantity<amount)issues.push('stock_shortfall');allocations.push({lot_id:lot.id,quantity:amount});continue;}
    const [id, weight, unit] = key.split('|');
    const matches = Object.values(s.lots).filter(l => l.ingredient_id === id && l.unit === unit && (!weight || l.weight_state === weight));
    let remaining = amount;
    for (const l of matches.sort((a,b) => String(a.expiry_label || 'z').localeCompare(String(b.expiry_label || 'z')) || a.id.localeCompare(b.id))) {
      if (l.quantity === null) { warnings.push('stock_quantity_unknown'); continue; }
      if (l.certainty !== 'measured') warnings.push('stock_quantity_estimated');
      const take = Math.min(remaining,l.quantity); if (take > 0) allocations.push({ lot_id: l.id, quantity: take }); remaining -= take;
      if (l.checked_at && input.date && l.checked_at.slice(0,10) < input.date) warnings.push('stock_not_confirmed_today');
    }
    if (remaining > 0.000001) (constraints.allow_purchase === true ? warnings : issues).push('stock_shortfall');
  }
  for (const required of equipment) {
    const e = s.equipment[typeof required === 'string' ? required : required.id];
    if (!e || e.available === false) issues.push('equipment_unavailable');
    else if (typeof required === 'object' && required.capacity_ml > (e.capacity_ml || 0)) issues.push('equipment_capacity');
  }
  const rawItems=items.filter(i=>!i.lot_id);
  const ordinary=rawItems.length?calculateNutrition(p,{items:rawItems}):{items:[]};
  const preparedUsed=Object.fromEntries(Object.entries(requirements).filter(([k])=>k.startsWith('prepared:')).map(([k,n])=>[k.slice(9),n]));
  const prepared=Object.keys(preparedUsed).length?cookingCalculation(p,s,preparedUsed):{items:[]};
  const allItems=[...ordinary.items,...prepared.items];
  const calculated={items:allItems,nutrition:sumNutrition(allItems.map(i=>i.nutrition)),missing_nutrients:[...new Set(allItems.flatMap(i=>i.missing_nutrients||[]))],estimated_items:allItems.filter(i=>i.estimated).length};
  if(calculated.estimated_items)warnings.push('nutrition_contains_estimates_or_missing_fields');
  const perPerson = scaleNutrition(calculated.nutrition, 1/people);
  const targets = constraints.targets || {};
  const targetStatus = {};
  for (const [nutrient, bounds] of Object.entries(targets)) {
    if (!(nutrient in perPerson)) throw Error('unknown nutrient target');
    if (!bounds || typeof bounds !== 'object' || (bounds.min === undefined && bounds.max === undefined)) throw Error('targets require explicit min/max bounds');
    const min = bounds.min === undefined ? 0 : number(bounds.min,'target min');
    const max = bounds.max === undefined ? Infinity : number(bounds.max,'target max');
    if (min > max) throw Error('target bounds conflict');
    const unknown = calculated.missing_nutrients.includes(nutrient);
    targetStatus[nutrient] = { value: unknown ? null : perPerson[nutrient], status: unknown ? 'unknown' : perPerson[nutrient] < min ? 'below' : perPerson[nutrient] > max ? 'above' : 'within' };
    if (targetStatus[nutrient].status !== 'within') issues.push(unknown ? 'target_unknown' : 'target_unmet');
  }
  if (constraints.max_minutes !== undefined && (warnings.includes('cooking_time_unknown') || minutes > number(constraints.max_minutes,'max_minutes'))) issues.push('time_budget_unverified');
  return { feasible: !issues.length, issues: [...new Set(issues)], warnings: [...new Set(warnings)],
    inventory_revision: s.revision, nutrition: calculated.nutrition, per_person: perPerson,
    estimated_items:calculated.estimated_items,missing_nutrients:calculated.missing_nutrients,
    targets: targetStatus, estimated_minutes: minutes, allocations, calculated, items };
}

function operation(p, s, kind, payload, fn) {
  const id = validateId(payload.operation_id, 'operation_id');
  const hash = fingerprint({ kind, payload });
  const previous = s.events.find(e => e.id === id);
  if (previous) { if (previous.hash !== hash) throw Error('operation id already used with different content'); return { changed: false, result: previous.result }; }
  const result = fn();
  s.revision++;
  s.events.push({ id, kind, hash, payload, result, recorded_at: new Date().toISOString() });
  atomicWrite(p.kitchen, JSON.stringify(s));
  return { changed: true, revision: s.revision, result };
}

function dispatch(p, args) {
  const [group, action] = args._, level = args['full-json'] ? 'full' : args.details ? 'details' : 'compact';
  const input = () => readInput(args), s = state(p);
  if (s.schema_version !== 1 || (s.algorithm_version !== 1 && group !== 'rebuild')) {
    if (group === 'validate') return { ok: false, needs_rebuild: true };
    throw Error('unsupported kitchen version; migration/rebuild required');
  }
  if (group === 'inventory' && action === 'list') return { revision: s.revision, lots: Object.values(s.lots) };
  if (group === 'inventory' && ['add','adjust'].includes(action)) {
    const v=input(); return operation(p,s,`${group}/${action}`,v,()=>{
      const id=validateId(v.id,'lot id');
      if (action==='adjust') { requireVersion(s,v); if (!s.lots[id]) throw Error('lot not found'); }
      else if (s.lots[id]) throw Error('lot already exists');
      const lot={...s.lots[id],...v}; delete lot.operation_id; delete lot.expected_revision;
      if(action==='adjust')for(const key of ['ingredient_id','unit','weight_state','ingredient_revision','kind'])if(v[key]!==undefined&&v[key]!==s.lots[id][key])throw Error('lot identity/state/unit is immutable; record a new batch');
      if(lot.kind==='prepared') {
        if(action!=='adjust')throw Error('prepared lots are created by confirmed cooking yields');
        const allowed=new Set(['id','operation_id','expected_revision','quantity','certainty','location','checked_at','expiry_label']);
        if(Object.keys(v).some(k=>!allowed.has(k)))throw Error('prepared recount may not rewrite yield or nutrition snapshot');
        if(lot.quantity!==null && (number(lot.quantity,'quantity')>lot.original_quantity))throw Error('recount exceeds confirmed prepared yield');
        if(!['measured','estimated','unknown'].includes(lot.certainty) || (lot.quantity===null)!==(lot.certainty==='unknown'))throw Error('invalid prepared recount certainty');
        s.lots[id]=lot;return {id};
      }
      if (!['g','ml','unit'].includes(lot.unit)) throw Error('unit must be g, ml or unit');
      if (!['measured','estimated','unknown'].includes(lot.certainty)) throw Error('quantity certainty required');
      if (lot.quantity === null) { if(lot.certainty!=='unknown')throw Error('null quantity requires unknown certainty'); }
      else { number(lot.quantity,'quantity');if(lot.certainty==='unknown')throw Error('unknown stock must have null quantity'); }
      if (!lot.weight_state) throw Error('weight_state required');
      calculateNutrition(p,{items:[lotItem(lot,1)]});
      s.lots[id]=lot; return { id };
    });
  }
  if(group==='equipment' && action==='list')return Object.values(s.equipment);
  if(group==='equipment' && action==='set') { const v=input();return operation(p,s,'equipment/set',v,()=>{validateId(v.id);if(v.capacity_ml!==undefined)number(v.capacity_ml,'capacity',1);s.equipment[v.id]={...v};delete s.equipment[v.id].operation_id;return {id:v.id};}); }
  if(group==='profile' && action==='show')return readJson(p.profile,{});
  if(group==='profile' && action==='set'){const v=input();return operation(p,s,'profile/set',v,()=>{if(!v.profile||typeof v.profile!=='object'||Array.isArray(v.profile))throw Error('profile object required');atomicWrite(p.profile,JSON.stringify(v.profile));return {saved:true};});}
  if(group==='plan' && action==='evaluate') { const r=evaluate(p,s,input()); if(level!=='full'){delete r.items; delete r.calculated;}return r; }
  if(group==='menu' && action==='list')return Object.values(s.menus).map(m=>({id:m.id,version:m.version,feasible:m.evaluation.feasible}));
  if(group==='menu' && action==='save') {const v=input();return operation(p,s,'menu/save',v,()=>{
    validateId(v.id); const key=`${v.id}@${v.version || 1}`;if(s.menus[key])throw Error('menu version already exists');
    const evaluation=evaluate(p,s,v); if(!evaluation.feasible)throw Error('menu constraints not satisfied');
    s.menus[key]={...v,version:v.version||1,evaluation};return {id:v.id,version:v.version||1};
  });}
  if(group==='cook' && action==='confirm'){ const v=input();return operation(p,s,'cook/confirm',v,()=>{
    requireVersion(s,v);
    if(!Array.isArray(v.allocations)||!v.allocations.length)throw Error('actual allocations required');
    const used={};for(const a of v.allocations)used[a.lot_id]=(used[a.lot_id]||0)+number(a.quantity,'actual quantity',Number.MIN_VALUE);
    for(const [id,n] of Object.entries(used)){const l=s.lots[id];if(!l||l.quantity===null||l.certainty!=='measured'||l.quantity<n)throw Error('insufficient or unconfirmed inventory');}
    const calculation=cookingCalculation(p,s,used);
    let outputId=null;
    if(v.output){
      const o=v.output;validateId(o.id,'prepared lot id');if(s.lots[o.id])throw Error('output lot already exists');
      if(!['g','unit'].includes(o.unit))throw Error('cooked yield needs g or unit');number(o.quantity,'cooked yield',Number.MIN_VALUE);
      outputId=o.id;s.lots[o.id]={id:o.id,kind:'prepared',weight_state:'cooked',quantity:o.quantity,original_quantity:o.quantity,unit:o.unit,certainty:'measured',location:o.location||null,
        cooking_id:v.operation_id,nutrition_total:calculation.nutrition,missing_nutrients:calculation.missing_nutrients,estimated:calculation.estimated_items>0,
        ingredient_ids:[...new Set(Object.keys(used).flatMap(id=>s.lots[id].ingredient_ids||[s.lots[id].ingredient_id]))]};
    }
    for(const [id,n] of Object.entries(used))s.lots[id].quantity-=n;
    return {used,calculation,output_id:outputId};
  });}
  if(group==='operation' && action==='undo'){const v=input();return operation(p,s,'operation/undo',v,()=>{
    requireVersion(s,v);const event=s.events.find(e=>e.id===v.target_id && e.kind==='cook/confirm');if(!event)throw Error('only cooking transactions can be reversed');
    if(s.events.some(e=>e.kind==='operation/undo'&&e.payload.target_id===v.target_id))throw Error('already reversed');
    const later=s.events.slice(s.events.indexOf(event)+1);
    if(later.some(e=>e.kind==='inventory/adjust' && (e.payload.id in event.result.used || e.payload.id===event.result.output_id)))throw Error('inventory was recounted; review before reversal');
    if(event.result.output_id){const lot=s.lots[event.result.output_id];if(!lot || lot.quantity!==lot.original_quantity)throw Error('prepared output already used');delete s.lots[lot.id];}
    for(const [id,n] of Object.entries(event.result.used)) { if(s.lots[id].quantity===null)throw Error('stock needs confirmation');s.lots[id].quantity+=n; }
    return {reversed:v.target_id};
  });}
  if(group==='recipe') {
    if(['add','update'].includes(action)){const v=input();if(action==='update' && v.version===undefined)throw Error('recipe update requires explicit new version');const result=addRecipe(p,v,{update:action==='update'});return level==='full'?result:{changed:result.changed,recipe:result.recipe?presentRecipe(result.recipe,level):null,pending_review:result.pending_review?{id:result.pending_review.id}:null};}
    if(['show','calculate'].includes(action))return presentRecipe(getRecipe(p,args.id||args._[2],args.version),level);
    if(action==='list')return allRecipes(p).map(compactRecipe);
    if(action==='compare')return recipeComparison(p,input().recipes,level);
  }
  if(group==='meal' && action==='calculate')return presentMeal(calculateMeal(p,input()),level);
  if(group==='meal' && action==='log') { const v=input(); if(!v.id)throw Error('explicit meal id required');
    const old=allMealRows(p).find(m=>m.id===v.id);
    if(old?.request_fingerprint===fingerprint(v))return {changed:false,date:old.date};
    if(old)throw Error('meal id already used');
    if(v.prepared){return operation(p,s,'meal/prepared',v,()=>{
      requireVersion(s,v);const used={};for(const a of v.prepared){const l=s.lots[a.lot_id];if(!l||l.kind!=='prepared'||l.certainty!=='measured')throw Error('confirmed prepared lot required');used[l.id]=(used[l.id]||0)+number(a.quantity,'portion',Number.MIN_VALUE);}
      for(const [id,n]of Object.entries(used))if(s.lots[id].quantity<n)throw Error('insufficient prepared food');
      const date=v.date;if(!/^\d{4}-\d{2}-\d{2}$/.test(date||'') || new Date(date+'T00:00:00Z').toISOString().slice(0,10)!==date)throw Error('explicit valid local meal date required');
      const calc=cookingCalculation(p,s,used);ensureKitchenLayout(p);
      const record={...calc,schema_version:1,id:v.id,date,occurred_at:v.occurred_at||date,name:v.name||null,day_type:v.day_type||null,request_fingerprint:fingerprint(v),logged_at:new Date().toISOString()};
      const file=join(p.mealsDir,date.slice(0,7)+'.jsonl');writeJsonl(file,[...readJsonl(file),record]);
      for(const [id,n]of Object.entries(used))s.lots[id].quantity-=n;updateDate(p,date);
      return {date,nutrition:calc.nutrition};
    });}
    const r=logMeal(p,v);if(r.changed){r.meal.request_fingerprint=fingerprint(v);const file=join(p.mealsDir,r.meal.date.slice(0,7)+'.jsonl');writeJsonl(file,readJsonl(file).map(m=>m.id===v.id?r.meal:m));}
    return {changed:r.changed,meal:presentMeal(r.meal,level),date:r.meal.date};
  }
  if(group==='day'&&action==='summary')return deriveDay(p,args.date);
  if(group==='week'&&action==='summary')return deriveWeek(p,args.date);
  if(group==='migrate')return migrate(p,{apply:args.apply===true});
  if(group==='pending-review'&&action==='list')return readJson(p.pending,[]).filter(r=>r.status!=='resolved');
  if(group==='pending-review'&&action==='resolve'){const v=input();return operation(p,s,'pending/resolve',v,()=>{const rows=readJson(p.pending,[]);const row=rows.find(r=>r.id===v.id);if(!row)throw Error('pending item not found');row.status='resolved';row.resolution=v.resolution;atomicWrite(p.pending,JSON.stringify(rows));return {id:v.id};});}
  if(group==='rebuild'){
    ensureKitchenLayout(p);writeJsonl(p.dailyTotals,[]);atomicWrite(p.weeklySummary,JSON.stringify({schema_version:1,algorithm_version:1,weeks:{}}));
    for(const date of new Set(allMealRows(p).map(m=>m.date)))updateDate(p,date);
    s.algorithm_version=1;atomicWrite(p.kitchen,JSON.stringify(s));return {rebuilt:true};
  }
  if(group==='validate'){
    const recipes=allRecipes(p),meals=allMealRows(p),issues=[];
    if(new Set(recipes.map(r=>`${r.id}@${r.version}`)).size!==recipes.length)issues.push('duplicate_recipe_version');
    if(new Set(meals.map(r=>r.id)).size!==meals.length)issues.push('duplicate_meal_id');
    for(const l of Object.values(s.lots))if(l.quantity!==null&&(!Number.isFinite(l.quantity)||l.quantity<0))issues.push('invalid_stock');
    for(const r of recipes)if(!r.id||!r.version||!r.items?.length||!r.nutrition_total)issues.push('invalid_recipe');
    for(const m of meals)if(!m.id||!m.date||!m.nutrition)issues.push('invalid_meal');
    const dates=new Set(readJsonl(p.dailyTotals).map(r=>r.date));
    const needs=meals.some(m=>!dates.has(m.date));
    return {ok:!issues.length,needs_rebuild:needs,issues:[...new Set(issues)],counts:{lots:Object.keys(s.lots).length,equipment:Object.keys(s.equipment).length,recipes:recipes.length,meals:meals.length,menus:Object.keys(s.menus).length,pending:readJson(p.pending,[]).filter(r=>r.status!=='resolved').length}};
  }
  throw Error('unknown kitchen command');
}

export async function runCli(argv=process.argv.slice(2),options={}) {
  const args=parseArgs(argv);
  const [group, action] = args._;
  if (group === 'ingredient' || group === 'import-kb' || group === 'nutrition' || (group === 'pending-review' && args.domain === 'nutrition')) {
    const root = resolvePaths({ workspace: args.workspace, dataRoot: args['nutrition-root'] || options.nutritionRoot }).root;
    let routed = argv;
    if (group === 'nutrition' && ['validate','rebuild'].includes(action)) routed = argv.slice(1);
    return nutritionCli([...routed, '--data-root', root]);
  }
  const p=resolveKitchen({workspace:args.workspace,nutritionRoot:options.nutritionRoot||args['nutrition-root'],dataRoot:options.legacyRoot?undefined:args['data-root']});
  // CLI calls, including readers, share the lock so readers cannot see a partial
  // recovered multi-file transaction. The lock lives in private kitchen data.
  if(process.env.KITCHEN_LOCK_ROOT!==p.root){
    const forwarded=argv.filter((a,i)=>!options.legacyRoot || (a!=='--data-root' && argv[i-1]!=='--data-root'));
    const result=spawnSync('python3',[join(dirname(entry),'locked-run.py'),p.root,process.execPath,entry,...forwarded,'--nutrition-root',p.nutritionRoot,'--data-root',p.root],{encoding:'utf8',maxBuffer:16*1024*1024,timeout:30000});
    if(result.status!==0)throw Error('kitchen command failed: '+(result.stderr?.trim()||'lock timeout or worker failure'));
    return JSON.parse(result.stdout);
  }
  return transaction(p.root,()=>dispatch(p,args));
}
if(process.argv[1] && realpathSync(resolve(process.argv[1]))===realpathSync(entry)) {
  runCli().then(r=>process.stdout.write(JSON.stringify(r)+'\n')).catch(e=>{process.stderr.write(JSON.stringify({error:e.message})+'\n');process.exitCode=1;});
}
