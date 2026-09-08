import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { atomicWrite, readJson, readJsonl, writeJsonl, stableString, fingerprint } from './nutrition.mjs';

export function migrate(p, {apply=false}={}) {
  const source=p.nutritionRoot, writes=[], conflicts=[];
  const counts={recipes:0,meals:0,pending:0,profile:0,unchanged:0};
  function rows(relative,key,type,filter=()=>true) {
    const from=join(source,relative),to=join(p.root,relative);
    const old=readJsonl(from).filter(filter),current=readJsonl(to);
    for(const row of old){
      const prior=current.find(r=>key(r)===key(row));
      if(prior){if(stableString(prior)!==stableString(row))conflicts.push(type);else counts.unchanged++;}
      else {current.push(row);counts[type]++;}
    }
    if(old.some(r=>!readJsonl(to).some(c=>key(c)===key(r))))writes.push([to,current.map(r=>JSON.stringify(r)).join('\n')+'\n']);
  }
  rows('recipes/recipes.jsonl',r=>`${r.id}@${r.version}`,'recipes');
  const meals=join(source,'logs/meals');
  if(existsSync(meals))for(const name of readdirSync(meals).filter(n=>/^\d{4}-\d{2}\.jsonl$/.test(n)))rows('logs/meals/'+name,r=>r.id,'meals');
  const sourceProfile=join(source,'profile/nutrition-profile.json');
  if(existsSync(sourceProfile)){
    const value=readJson(sourceProfile,{}),existing=readJson(p.profile,null);
    if(existing && stableString(existing)!==stableString(value))conflicts.push('profile');
    else if(!existing){counts.profile++;writes.push([p.profile,JSON.stringify(value)]);}else counts.unchanged++;
  }
  const pending=readJson(join(source,'state/pending-review.json'),[]).filter(r=>/recipe|meal|goal|menu/.test(r.type||''));
  const current=readJson(p.pending,[]);
  for(const row of pending){const old=current.find(r=>r.id===row.id);if(old){if(stableString(old)!==stableString(row))conflicts.push('pending');else counts.unchanged++;}else{current.push(row);counts.pending++;}}
  if(counts.pending)writes.push([p.pending,JSON.stringify(current)]);
  // Keep a destination-owned byte backup. No source file is changed or removed.
  if(apply && !conflicts.length && writes.length){
    for(const [to,data] of writes)atomicWrite(to,data);
    const tracked=['recipes/recipes.jsonl','profile/nutrition-profile.json','state/pending-review.json'];
    if(existsSync(meals))tracked.push(...readdirSync(meals).filter(n=>/^\d{4}-\d{2}\.jsonl$/.test(n)).map(n=>'logs/meals/'+n));
    for(const rel of tracked)if(existsSync(join(source,rel))){const raw=readFileSync(join(source,rel),'utf8');atomicWrite(join(p.root,'migration-backup',fingerprint(rel),fingerprint(raw)+'.json'),raw);}
    atomicWrite(join(p.root,'state/migration.json'),JSON.stringify({schema_version:1,algorithm_version:1,counts,source_unchanged:true}));
  }
  return {ok:!conflicts.length,dry_run:!apply,changed:apply && !conflicts.length && !!writes.length,counts,conflicts};
}
