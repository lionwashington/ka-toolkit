import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync, mkdirSync, existsSync, symlinkSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { spawnSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolvePaths, upsertIngredient, calculateNutrition, fingerprint } from '../kb/skills/nutrition-ledger/scripts/nutrition-ledger.mjs';
import { kitchenPaths } from '../kb/skills/kitchen-planner/scripts/paths.mjs';
import { addRecipe, logMeal } from '../kb/skills/kitchen-planner/scripts/legacy-meals.mjs';

const script=fileURLToPath(new URL('../kb/skills/kitchen-planner/scripts/kitchen-planner.mjs',import.meta.url));
const source=resolve(dirname(script),'nutrition.mjs');
const synthetic={id:'sample',name:'Synthetic sample',basis:'per_100g',weight_state:'raw',source_type:'packaging_label',nutrients:{kcal:100,protein_g:10,carbs_g:10,fat_g:2,fiber_g:1,sodium_mg:2}};
function setup(){const root=mkdtempSync(join(tmpdir(),'kitchen-test-'));const nutrition=resolvePaths({workspace:root});upsertIngredient(nutrition,synthetic);const p=kitchenPaths(nutrition);return {root,nutrition,p};}
function command(f,group,action,input,flags=[]){const args=[script,group,...(action?[action]:[]),'--nutrition-root',f.nutrition.root,'--data-root',f.p.root,...flags];if(input)args.push('--json',JSON.stringify(input));return args;}
function call(f,group,action,input,flags=[]){const r=spawnSync(process.execPath,command(f,group,action,input,flags),{encoding:'utf8',timeout:10000,env:{PATH:process.env.PATH}});assert.equal(r.status,0,r.stderr);return JSON.parse(r.stdout);}
function fail(f,group,action,input){const r=spawnSync(process.execPath,command(f,group,action,input),{encoding:'utf8',timeout:10000});assert.notEqual(r.status,0);assert.doesNotThrow(()=>JSON.parse(r.stderr));return r.stderr;}
function stock(f){return call(f,'inventory','add',{operation_id:'add-one',id:'lot-one',ingredient_id:'sample',weight_state:'raw',quantity:500,unit:'g',certainty:'measured'});}
const recipe={id:'bowl',name:'Synthetic bowl',version:1,servings:2,estimated_minutes:15,equipment:['pot'],items:[{ingredient_id:'sample',grams:100,weight_state:'raw'}],steps:['Heat the synthetic example.']};
function snapshot(dir){const result={};if(!existsSync(dir))return result;for(const ent of readdirSync(dir,{withFileTypes:true})){const path=join(dir,ent.name);if(ent.isDirectory())Object.assign(result,snapshot(path));else result[path]=fingerprint(readFileSync(path,'utf8'));}return result;}

test('pure nutrition calculations and failures do not write any files',()=>{
 const f=setup(),before=snapshot(f.nutrition.root);
 assert.equal(calculateNutrition(f.nutrition,{items:[{ingredient_id:'sample',grams:100}]}).nutrition.kcal,100);
 assert.throws(()=>calculateNutrition(f.nutrition,{items:[{ingredient:'missing',grams:1}]}));
 assert.deepEqual(snapshot(f.nutrition.root),before);
 assert.equal(existsSync(join(f.nutrition.root,'recipes')),false);
 assert.equal(existsSync(join(f.nutrition.root,'profile')),false);
});
test('inventory batches, planning and consumption stay separate',()=>{
 const f=setup();stock(f);call(f,'equipment','set',{operation_id:'pot-op',id:'pot',capacity_ml:1000,available:true});
 call(f,'recipe','add',recipe);
 const before=snapshot(f.p.root),request={dishes:[{recipe_id:'bowl',version:1}],people:2,constraints:{targets:{kcal:{min:40,max:60}}}};
 const result=call(f,'plan','evaluate',request);assert.equal(result.feasible,true);assert.equal(result.per_person.kcal,50);
 assert.deepEqual(snapshot(f.p.root),before);
 call(f,'menu','save',{...request,id:'dinner',version:1,operation_id:'save-menu'});
 assert.equal(call(f,'inventory','list').lots[0].quantity,500);
 assert.equal(call(f,'validate').counts.meals,0);
});
test('hard constraints, uncertainty and impossible targets are explicit',()=>{
 const f=setup();stock(f);
 for(const constraints of [{exclude_ingredient_ids:['sample']},{targets:{kcal:{min:500,max:600}}},{max_minutes:1}]){
  assert.equal(call(f,'plan','evaluate',{items:recipe.items,estimated_minutes:15,constraints}).feasible,false);
 }
 assert.equal(call(f,'plan','evaluate',{items:recipe.items,equipment:['absent']}).feasible,false);
 assert.equal(call(f,'plan','evaluate',{items:[{ingredient_id:'sample',grams:501}]}).feasible,false);
 upsertIngredient(f.nutrition,{...synthetic,id:'unknown',name:'Unknown synthetic',nutrients:{kcal:100}});
 const r=call(f,'plan','evaluate',{items:[{ingredient_id:'unknown',grams:100}],constraints:{allow_purchase:true,targets:{protein_g:{min:0,max:50}}}});
 assert.equal(r.feasible,false);assert.equal(r.targets.protein_g.status,'unknown');
});
test('actual cooking is idempotent, stale revisions rejected, undo audited',()=>{
 const f=setup();stock(f);const v={operation_id:'cook-one',expected_revision:1,allocations:[{lot_id:'lot-one',quantity:100}]};
 assert.equal(call(f,'cook','confirm',v).changed,true);
 assert.equal(call(f,'cook','confirm',v).changed,false);
 assert.equal(call(f,'inventory','list').lots[0].quantity,400);
 fail(f,'cook','confirm',{...v,operation_id:'cook-two'});
 assert.equal(call(f,'validate').counts.meals,0);
 call(f,'operation','undo',{operation_id:'undo-one',target_id:'cook-one',expected_revision:2});
 assert.equal(call(f,'inventory','list').lots[0].quantity,500);
 fail(f,'operation','undo',{operation_id:'undo-two',target_id:'cook-one',expected_revision:3});
});
test('concurrent confirmations cannot overspend the same inventory revision',async()=>{
 const f=setup();stock(f);
 const results=await Promise.all(['one','two'].map(id=>new Promise(resolve=>{
  const c=spawn(process.execPath,command(f,'cook','confirm',{operation_id:`cook-${id}`,expected_revision:1,allocations:[{lot_id:'lot-one',quantity:400}]}),{stdio:'ignore'});c.on('exit',code=>resolve(code));
 })));
 assert.equal(results.filter(c=>c===0).length,1);assert.equal(call(f,'inventory','list').lots[0].quantity,100);
});
test('meal logging changes only the affected daily row and not stock',()=>{
 const f=setup();stock(f);
 const meal=(id,date)=>({id,date,name:'Synthetic meal',items:recipe.items});
 call(f,'meal','log',meal('first','2031-04-05'));call(f,'meal','log',meal('second','2031-04-06'));
 const before=JSON.parse(readFileSync(f.p.dailyTotals,'utf8').trim().split('\n')[1]);
 call(f,'meal','log',meal('third','2031-04-05'));
 const after=JSON.parse(readFileSync(f.p.dailyTotals,'utf8').trim().split('\n')[1]);assert.deepEqual(before,after);
 upsertIngredient(f.nutrition,{...synthetic,nutrients:{...synthetic.nutrients,kcal:200}});
 assert.equal(call(f,'meal','log',meal('first','2031-04-05')).changed,false);
 assert.equal(call(f,'inventory','list').lots[0].quantity,500);
});
test('migration dry-run, exact history, repeatability and no inferred inventory',()=>{
 const f=setup();addRecipe(f.nutrition,recipe);logMeal(f.nutrition,{date:'2031-04-05',items:recipe.items});
 mkdirSync(dirname(f.nutrition.profile),{recursive:true});writeFileSync(f.nutrition.profile,JSON.stringify({goals:{}}));
 const before=snapshot(f.nutrition.root);
 const dry=call(f,'migrate');assert.equal(dry.dry_run,true);assert.equal(dry.counts.recipes,1);assert.equal(existsSync(f.p.recipes),false);
 const imported=call(f,'migrate',null,null,['--apply']);assert.equal(imported.changed,true);
 assert.equal(readFileSync(f.p.recipes,'utf8'),readFileSync(f.nutrition.recipes,'utf8'));
 const again=call(f,'migrate',null,null,['--apply']);assert.equal(again.changed,false);
 assert.deepEqual(snapshot(f.nutrition.root),before);assert.equal(call(f,'validate').counts.lots,0);
 assert.equal(call(f,'recipe','calculate',null,['--id','bowl']).nutrition_total.kcal,100);
});
test('migration conflicts fail without partial writes',()=>{
 const f=setup();addRecipe(f.nutrition,recipe);call(f,'recipe','add',{...recipe,items:[{ingredient_id:'sample',grams:300}]});
 const before=snapshot(f.p.root);assert.equal(call(f,'migrate',null,null,['--apply']).ok,false);assert.deepEqual(snapshot(f.p.root),before);
});
test('pending journal recovery is idempotent and prevents outside writes',()=>{
 const f=setup();stock(f);const value=JSON.parse(readFileSync(f.p.kitchen));value.revision=2;
 const journal=join(f.p.root,'state/.transaction.json');writeFileSync(journal,JSON.stringify([[f.p.kitchen,JSON.stringify(value)]]));
 assert.equal(call(f,'inventory','list').revision,2);assert.equal(existsSync(journal),false);
 const forbidden=join(f.root,'outside.json');writeFileSync(journal,JSON.stringify([[forbidden,'{}']]));fail(f,'validate');assert.equal(existsSync(forbidden),false);
});
test('runtime copy and both discovery symlinks run without source dependencies or credentials',()=>{
 const f=setup(),runtime=join(f.root,'runtime/skills');mkdirSync(runtime,{recursive:true});
 cpSync(resolve(dirname(script),'..'),join(runtime,'kitchen-planner'),{recursive:true});
 for(const name of ['codex','claude']){
  const discovery=join(f.root,name);mkdirSync(discovery);symlinkSync(join(runtime,'kitchen-planner'),join(discovery,'kitchen-planner'));
  const args=command(f,'validate');args[0]=join(discovery,'kitchen-planner/scripts/kitchen-planner.mjs');
  const r=spawnSync(process.execPath,args,{encoding:'utf8',env:{PATH:process.env.PATH},timeout:10000});assert.equal(r.status,0,r.stderr);assert.equal(JSON.parse(r.stdout).ok,true);
 }
});
test('public repo roots and root overlap are refused',()=>{
 assert.throws(()=>kitchenPaths(resolvePaths({dataRoot:mkdtempSync(join(tmpdir(),'nutrition-safe-'))}),resolve('private-kitchen')),/public/);
 const f=setup();assert.throws(()=>kitchenPaths(f.nutrition,f.nutrition.root),/separate/);
 const link=join(f.root,'public-link');symlinkSync(resolve('.'),link);assert.throws(()=>kitchenPaths(f.nutrition,join(link,'private-kitchen')),/public/);
});

test('prepared yield and actual portion preserve nutrition without double raw deduction',()=>{
 const f=setup();stock(f);
 call(f,'cook','confirm',{operation_id:'cook-yield',expected_revision:1,allocations:[{lot_id:'lot-one',quantity:100}],output:{id:'leftover',quantity:80,unit:'g'}});
 upsertIngredient(f.nutrition,{...synthetic,nutrients:{...synthetic.nutrients,kcal:900}});
 const plan=call(f,'plan','evaluate',{items:[{lot_id:'leftover',grams:40}]});assert.equal(plan.nutrition.kcal,50);
 const meal={id:'portion',operation_id:'portion-eat',expected_revision:2,date:'2031-04-05',prepared:[{lot_id:'leftover',quantity:40}]};
 call(f,'meal','log',meal);assert.equal(call(f,'meal','log',meal).changed,false);
 const lots=call(f,'inventory','list').lots;assert.equal(lots.find(l=>l.id==='lot-one').quantity,400);assert.equal(lots.find(l=>l.id==='leftover').quantity,40);
 assert.equal(call(f,'day','summary',null,['--date','2031-04-05']).nutrition.kcal,50);
 fail(f,'operation','undo',{operation_id:'undo-yield',target_id:'cook-yield',expected_revision:3});
});
test('fixed recipes pin ingredient revisions while new drafts use current facts',()=>{
 const f=setup();stock(f);call(f,'recipe','add',{...recipe,equipment:[]});
 upsertIngredient(f.nutrition,{...synthetic,nutrients:{...synthetic.nutrients,kcal:200}});
 assert.equal(call(f,'recipe','add',{...recipe,equipment:[]}).changed,false);
 assert.equal(call(f,'plan','evaluate',{dishes:[{recipe_id:'bowl',version:1}]}).nutrition.kcal,100);
 assert.equal(call(f,'plan','evaluate',{items:recipe.items}).nutrition.kcal,200);
});
test('unknown quantities and unit/state mismatch are not silently converted',()=>{
 const f=setup();call(f,'inventory','add',{operation_id:'unknown-op',id:'unknown',ingredient_id:'sample',weight_state:'raw',quantity:null,unit:'g',certainty:'unknown'});
 assert.equal(call(f,'plan','evaluate',{items:recipe.items}).feasible,false);
 fail(f,'inventory','add',{operation_id:'bad-op',id:'bad',ingredient_id:'sample',weight_state:'cooked',quantity:1,unit:'g',certainty:'measured'});
 fail(f,'inventory','add',{operation_id:'units-op',id:'bad-unit',ingredient_id:'sample',weight_state:'raw',quantity:1,unit:'ml',certainty:'measured'});
});
test('schema, damaged state and controlled rebuild do not reset inventory silently',()=>{
 const f=setup();stock(f);const value=JSON.parse(readFileSync(f.p.kitchen));value.algorithm_version=0;writeFileSync(f.p.kitchen,JSON.stringify(value));
 assert.equal(call(f,'validate').needs_rebuild,true);call(f,'rebuild');assert.equal(call(f,'validate').needs_rebuild,false);
 assert.equal(call(f,'inventory','list').lots[0].quantity,500);
 value.schema_version=99;writeFileSync(f.p.kitchen,JSON.stringify(value));fail(f,'rebuild');
 writeFileSync(f.p.kitchen,'{');fail(f,'inventory','list');assert.equal(readFileSync(f.p.kitchen,'utf8'),'{');
});
test('actual scoped installer deploys a unified skill and retires old discovery',()=>{
 const f=setup(),runtime=join(f.root,'installed');
 mkdirSync(join(runtime,'kb/skills/nutrition-ledger/scripts'),{recursive:true});
 writeFileSync(join(runtime,'kb/skills/nutrition-ledger/SKILL.md'),'old instructions');
 for(const name of ['kitchen-planner']){
  const r=spawnSync('bash',['install.sh','--only','skills','--skill',name],{cwd:resolve(dirname(script),'../../../..'),encoding:'utf8',env:{...process.env,KA_HOME:runtime},timeout:30000});assert.equal(r.status,0,r.stderr);
 }
 const installed=join(runtime,'kb/skills/kitchen-planner/scripts/kitchen-planner.mjs');
 assert.equal(existsSync(installed),true);
 assert.equal(existsSync(join(runtime,'kb/skills/nutrition-ledger/SKILL.md')),false);
 const legacy=join(runtime,'kb/skills/nutrition-ledger/scripts/nutrition-ledger.mjs');
 const old=spawnSync(process.execPath,[legacy,'validate','--data-root',f.nutrition.root],{encoding:'utf8'});assert.equal(old.status,0,old.stderr);assert.equal(JSON.parse(old.stdout).ok,true);
 const args=command(f,'inventory','list');args[0]=installed;
 const r=spawnSync(process.execPath,args,{encoding:'utf8',timeout:10000});assert.equal(r.status,0,r.stderr);assert.deepEqual(JSON.parse(r.stdout).lots,[]);
});

test('interrupted transaction worker releases its lock and the next reader recovers',()=>{
 const f=setup();stock(f);const shim=join(f.root,'interrupt.mjs');
 writeFileSync(shim,`import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';const rename=fs.renameSync;let committed=false;fs.renameSync=(from,to)=>{if(committed&&String(to).endsWith('kitchen.json'))process.exit(23);rename(from,to);if(String(to).endsWith('.transaction.json'))committed=true;};syncBuiltinESMExports();`);
 const request={operation_id:'crash-cook',expected_revision:1,allocations:[{lot_id:'lot-one',quantity:100}]};
 const r=spawnSync(process.execPath,command(f,'cook','confirm',request),{encoding:'utf8',env:{...process.env,NODE_OPTIONS:`--import=${shim}`},timeout:10000});assert.notEqual(r.status,0);
 assert.equal(existsSync(join(f.p.root,'state/.transaction.json')),true);
 assert.equal(call(f,'inventory','list').lots[0].quantity,400);
 assert.equal(call(f,'cook','confirm',request).changed,false);
});
test('installed nutrition copy rejects public checkout data roots',()=>{
 const f=setup(),copy=join(f.root,'standalone/kitchen-planner');cpSync(resolve(dirname(source),'..'),copy,{recursive:true});
 const r=spawnSync(process.execPath,[join(copy,'scripts/nutrition.mjs'),'validate','--data-root',resolve('private-root')],{encoding:'utf8'});
 assert.notEqual(r.status,0);assert.equal(existsSync(resolve('private-root')),false);
});

test('prepared recount updates remaining stock without rewriting nutrient density',()=>{
 const f=setup();stock(f);call(f,'cook','confirm',{operation_id:'yield-op',expected_revision:1,allocations:[{lot_id:'lot-one',quantity:100}],output:{id:'prepared',unit:'g',quantity:80}});
 call(f,'inventory','adjust',{operation_id:'recount-op',id:'prepared',expected_revision:2,quantity:40,certainty:'measured'});
 assert.equal(call(f,'plan','evaluate',{items:[{lot_id:'prepared',grams:40}]}).nutrition.kcal,50);
 fail(f,'inventory','adjust',{operation_id:'rewrite-op',id:'prepared',expected_revision:3,quantity:40,nutrition_total:{kcal:0}});
});

test('unified ingredient and nutrition commands never initialize kitchen reality',()=>{
 const f=setup(),before=snapshot(f.nutrition.root);
 assert.equal(call(f,'ingredient','show',null,['--id','sample']).id,'sample');
 assert.equal(call(f,'nutrition','calculate',{items:recipe.items}).nutrition.kcal,100);
 assert.equal(call(f,'nutrition','validate').counts.ingredients,1);
 assert.equal(existsSync(f.p.root),false);
 assert.deepEqual(snapshot(f.nutrition.root),before);
});

test('retired installer alias produces just one discovery Skill on both clients',()=>{
 const f=setup(),runtime=join(f.root,'alias-runtime'),codex=join(f.root,'codex-skills'),claude=join(f.root,'claude-skills');
 for(const d of [codex,claude]){mkdirSync(d);symlinkSync(join(runtime,'kb/skills/nutrition-ledger'),join(d,'nutrition-ledger'));}
 const r=spawnSync('bash',['install.sh','--only','skills','--skill','nutrition-ledger','--switch'],{cwd:resolve(dirname(script),'../../../..'),encoding:'utf8',timeout:30000,
  env:{...process.env,KA_HOME:runtime,KA_CODEX_SKILLS:codex,KA_CLAUDE_SKILLS:claude,KA_CLAUDE_JSON:join(f.root,'claude.json'),KA_BIN_LINK:join(f.root,'bin/ka'),KA_LAUNCHAGENTS:join(f.root,'launchagents'),KA_CLAUDE_SETTINGS:join(f.root,'claude-settings.json'),KA_CODEX_HOOKS:join(f.root,'codex-hooks.json')}});
 assert.equal(r.status,0,r.stderr);
 for(const d of [codex,claude]){
  assert.equal(existsSync(join(d,'kitchen-planner/SKILL.md')),true);
  assert.equal(existsSync(join(d,'nutrition-ledger/SKILL.md')),false);
  const old=spawnSync(process.execPath,[join(d,'nutrition-ledger/scripts/nutrition-ledger.mjs'),'validate','--data-root',f.nutrition.root],{encoding:'utf8'});assert.equal(old.status,0,old.stderr);
 }
});
