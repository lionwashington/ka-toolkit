import { dirname, join, resolve } from 'node:path';
import { existsSync, mkdirSync, realpathSync } from 'node:fs';
import { resolvePaths, assertPrivateDataRoot, atomicWrite, dataExists } from './nutrition.mjs';

export function kitchenPaths(nutrition, dataRoot) {
  let root = resolve(dataRoot || process.env.KITCHEN_DATA_ROOT || join(dirname(nutrition.root), 'kitchen'));
  let parent=root;const suffix=[];
  while(!existsSync(parent)){suffix.unshift(parent.slice(dirname(parent).length+1));parent=dirname(parent);}
  root=join(realpathSync(parent),...suffix);
  assertPrivateDataRoot(root);
  if (root === nutrition.root || root.startsWith(nutrition.root + '/') || nutrition.root.startsWith(root + '/')) throw Error('kitchen and nutrition roots must be separate');
  return { ...nutrition, nutritionRoot: nutrition.root, root,
    recipes: join(root, 'recipes/recipes.jsonl'), mealsDir: join(root, 'logs/meals'),
    profile: join(root, 'profile/nutrition-profile.json'), dailyTotals: join(root, 'derived/daily-totals.jsonl'),
    weeklySummary: join(root, 'derived/weekly-summary.json'), state: join(root, 'state/state.json'),
    pending: join(root, 'state/pending-review.json'), kitchen: join(root, 'state/kitchen.json') };
}
export function resolveKitchen(options = {}) {
  return kitchenPaths(resolvePaths({ workspace: options.workspace, dataRoot: options.nutritionRoot }), options.dataRoot);
}
export function ensureKitchenLayout(p) {
  for (const dir of [dirname(p.recipes), p.mealsDir, dirname(p.profile), dirname(p.dailyTotals), dirname(p.state)]) mkdirSync(dir, { recursive: true });
  for (const file of [p.recipes, p.dailyTotals]) if (!dataExists(file)) atomicWrite(file, '');
  if (!dataExists(p.pending)) atomicWrite(p.pending, '[]\n');
  if (!dataExists(p.state)) atomicWrite(p.state, JSON.stringify({ schema_version: 1, algorithm_version: 1 }));
}
